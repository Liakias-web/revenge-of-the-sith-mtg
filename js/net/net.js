/* Old Republic network sessions (multiplayer transport interface).
 *
 *   const s = OF.Net.createHost({ transport: 'relay' | 'webrtc' | 'loopback', name, ... });
 *   const s = OF.Net.join({ transport: 'relay' | 'webrtc' | 'loopback', name, ... });
 *
 * Session object: { id, isHost, hostId, transport, ready (Promise), peers(), send(to, msg),
 *                   on(event, fn), off(event, fn), close() }
 *   events: 'open' ()                    session is usable (guest: welcomed by the host)
 *           'message' (fromPeerId, msg)  msg is a JSON value
 *           'peer-join' (peerId) / 'peer-leave' (peerId, reason)
 *           'status' (text)              transient transport state ("reconnecting…")
 *           'error' (Error)              something failed (the session may still be open)
 *           'close' (reason)             session ended (host left, connection lost, close())
 *   send(to, msg): to = peer id, '*' (everyone except me) or an array of ids. Sending to
 *   your own id delivers locally (asynchronously), which keeps host/guest code uniform.
 *
 * Star topology: guests only talk to the host; the host forwards messages between guests.
 * Transports only provide "links" (host <-> one guest) carrying envelopes:
 *   guest -> host  {t: to, m: msg}           host -> guest  {f: from, t: to, m: msg}
 *   host  -> guest {sys: 'welcome', id, host, peers} / {sys: 'peers', peers}
 * Messages on one link are delivered in order (relay: one POST at a time + SSE ids;
 * WebRTC: ordered reliable data channel; loopback: FIFO).
 */
(function (OF) {
  'use strict';

  const Net = OF.Net = OF.Net || {};
  const transports = Net.transports = Net.transports || {};

  function later(fn) { setTimeout(fn, 0); }

  function randomId(prefix, n) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = prefix || '';
    const len = n || 8;
    let bytes = null;
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) bytes = crypto.getRandomValues(new Uint8Array(len));
    } catch (e) { bytes = null; }
    for (let i = 0; i < len; i++) s += abc[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % abc.length];
    return s;
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev, fn) { const a = this._h[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; }
    emit(ev, ...args) {
      for (const fn of (this._h[ev] || []).slice()) {
        try { fn(...args); } catch (e) { if (typeof console !== 'undefined') console.error('[Net] handler for "' + ev + '" threw', e); }
      }
    }
  }

  /** Common session behaviour (host and guest). */
  class Session extends Emitter {
    constructor(isHost, transport) {
      super();
      this.isHost = isHost;
      this.transport = transport;
      this.id = null;
      this.hostId = null;
      this.isOpen = false;
      this.closed = false;
      this.closeReason = '';
      let res, rej;
      this.ready = new Promise((a, b) => { res = a; rej = b; });
      this.ready.catch(() => {});
      this._readyRes = res; this._readyRej = rej;
    }
    _markOpen() {
      if (this.isOpen || this.closed) return;
      this.isOpen = true;
      this._readyRes(this);
      this.emit('open');
    }
    _deliverLocal(msg) {
      const copy = JSON.parse(JSON.stringify(msg));
      const self = this;
      later(function () { if (!self.closed) self.emit('message', self.id, copy); });
    }
    _end(reason) {
      if (this.closed) return;
      this.closed = true;
      this.isOpen = false;
      this.closeReason = reason || 'closed';
      this._readyRej(new Error(this.closeReason));
      this.emit('close', this.closeReason);
    }
  }

  /** Host side: owns one link per guest and forwards between them. */
  class HostSession extends Session {
    constructor(transport, id) {
      super(true, transport);
      this.id = id || randomId('h', 7);
      this.hostId = this.id;
      this._links = new Map(); // peerId -> {send(env), close()}
      this._driver = null;     // transport-specific object (close(), extras)
    }
    peers() { return Array.from(this._links.keys()); }
    _peerList() { return [this.id].concat(this.peers()); }
    _broadcastPeers(except) {
      const env = { sys: 'peers', peers: this._peerList() };
      for (const [pid, link] of this._links) if (pid !== except) safeSend(link, env);
    }
    /** Transport: a guest link is connected. */
    _linkOpen(peerId, link) {
      if (this.closed) { try { link.close && link.close(); } catch (e) { /* ignore */ } return; }
      const existing = this._links.get(peerId);
      this._links.set(peerId, link);
      safeSend(link, { sys: 'welcome', id: peerId, host: this.id, peers: this._peerList() });
      if (!existing) {
        this._broadcastPeers(peerId);
        this.emit('peer-join', peerId);
      }
    }
    /** Transport: an envelope arrived from a guest. */
    _linkMessage(peerId, env) {
      if (this.closed || !env || typeof env !== 'object' || !this._links.has(peerId)) return;
      if (env.sys) return; // guests never send system envelopes (reserved)
      const to = env.t, msg = env.m;
      const deliverTo = (id) => {
        if (id === this.id) this.emit('message', peerId, msg);
        else if (id !== peerId) { const l = this._links.get(id); if (l) safeSend(l, { f: peerId, t: id, m: msg }); }
      };
      if (to === '*') {
        this.emit('message', peerId, msg);
        for (const [pid, l] of this._links) if (pid !== peerId) safeSend(l, { f: peerId, t: '*', m: msg });
      } else if (Array.isArray(to)) to.forEach(deliverTo);
      else if (typeof to === 'string') deliverTo(to);
    }
    /** Transport: a guest link closed. */
    _linkClose(peerId, reason) {
      if (!this._links.has(peerId)) return;
      this._links.delete(peerId);
      if (this.closed) return;
      this._broadcastPeers();
      this.emit('peer-leave', peerId, reason || 'disconnected');
    }
    send(to, msg) {
      if (this.closed) return false;
      if (to === this.id) { this._deliverLocal(msg); return true; }
      if (to === '*') { for (const l of this._links.values()) safeSend(l, { f: this.id, t: '*', m: msg }); return true; }
      const ids = Array.isArray(to) ? to : [to];
      let ok = true;
      for (const id of ids) {
        if (id === this.id) { this._deliverLocal(msg); continue; }
        const l = this._links.get(id);
        if (l) safeSend(l, { f: this.id, t: id, m: msg }); else ok = false;
      }
      return ok;
    }
    /** Disconnect one guest. */
    kick(peerId, reason) {
      const l = this._links.get(peerId);
      if (!l) return;
      try { l.close && l.close(reason); } catch (e) { /* ignore */ }
      this._linkClose(peerId, reason || 'removed by host');
    }
    close(reason) {
      if (this.closed) return;
      for (const l of this._links.values()) { try { l.close && l.close(); } catch (e) { /* ignore */ } }
      this._links.clear();
      try { this._driver && this._driver.close && this._driver.close(); } catch (e) { /* ignore */ }
      this._end(reason || 'You closed the game.');
    }
  }

  /** Guest side: one link to the host. */
  class GuestSession extends Session {
    constructor(transport) {
      super(false, transport);
      this._link = null;
      this._queue = [];
      this._peers = [];
      this._driver = null;
    }
    peers() { return this._peers.filter(p => p !== this.id); }
    /** Transport: the link to the host is up (welcome still pending). */
    _linkUp(link) { this._link = link; }
    /** Transport: an envelope arrived from the host. */
    _envelope(env) {
      if (this.closed || !env || typeof env !== 'object') return;
      if (env.sys === 'welcome') {
        this.id = env.id; this.hostId = env.host;
        this._setPeers(env.peers || [], true);
        const q = this._queue; this._queue = [];
        for (const [to, msg] of q) this.send(to, msg);
        this._markOpen();
        return;
      }
      if (env.sys === 'peers') { this._setPeers(env.peers || [], false); return; }
      if (env.sys) return;
      this.emit('message', env.f, env.m);
    }
    _setPeers(list, silent) {
      const old = new Set(this._peers);
      const now = new Set(list);
      this._peers = list.slice();
      if (silent) return;
      for (const p of now) if (!old.has(p) && p !== this.id) this.emit('peer-join', p);
      for (const p of old) if (!now.has(p) && p !== this.id) this.emit('peer-leave', p, 'disconnected');
    }
    /** Transport: the link is gone for good. */
    _linkDown(reason) { this._end(reason || 'Connection to the host was lost.'); }
    send(to, msg) {
      if (this.closed) return false;
      if (!this.isOpen || !this._link) { this._queue.push([to, msg]); return true; }
      if (to === this.id) { this._deliverLocal(msg); return true; }
      safeSend(this._link, { t: to, m: msg });
      return true;
    }
    close(reason) {
      if (this.closed) return;
      try { this._link && this._link.close && this._link.close(); } catch (e) { /* ignore */ }
      try { this._driver && this._driver.close && this._driver.close(); } catch (e) { /* ignore */ }
      this._end(reason || 'You left the game.');
    }
  }

  function safeSend(link, env) {
    try { link.send(env); } catch (e) { if (typeof console !== 'undefined') console.error('[Net] send failed', e); }
  }

  // ------------------------------------------------------------------ loopback
  /** In-memory transport (tests, demos): all sessions created from one hub talk to each other. */
  function createHub() {
    const hub = { host: null, nextGuest: 1, latency: 0 };
    const deliver = (fn) => { if (hub.latency) setTimeout(fn, hub.latency); else later(fn); };
    const roundtrip = (v) => JSON.parse(JSON.stringify(v));
    hub.createHost = function (opts) {
      const s = new HostSession('loopback', opts && opts.id);
      hub.host = s;
      s._driver = { close() { hub.host = null; } };
      later(() => s._markOpen());
      return s;
    };
    hub.join = function (opts) {
      const g = new GuestSession('loopback');
      const host = hub.host;
      const pid = (opts && opts.id) || ('p' + hub.nextGuest++);
      if (!host || host.closed) { later(() => { g.emit('error', new Error('No host on this hub')); g._linkDown('No host is running.'); }); return g; }
      let alive = true;
      // Each direction keeps FIFO order because setTimeout with equal delays runs in order.
      const toHost = { send(env) { if (!alive) return; const e = roundtrip(env); deliver(() => { if (alive) host._linkMessage(pid, e); }); }, close() { if (!alive) return; alive = false; deliver(() => host._linkClose(pid, 'left')); } };
      const toGuest = { send(env) { if (!alive) return; const e = roundtrip(env); deliver(() => { if (alive) g._envelope(e); }); }, close() { if (!alive) return; alive = false; deliver(() => g._linkDown('The host closed the game.')); } };
      g._linkUp(toHost);
      g._driver = { close() { toHost.close(); } };
      const origClose = host.close.bind(host);
      host.close = function (reason) { toGuest.close(); origClose(reason); };
      deliver(() => host._linkOpen(pid, toGuest));
      return g;
    };
    return hub;
  }
  transports.loopback = {
    createHost(opts) { if (!opts.hub) throw new Error('loopback transport needs opts.hub (OF.Net.createHub())'); return opts.hub.createHost(opts); },
    join(opts) { if (!opts.hub) throw new Error('loopback transport needs opts.hub'); return opts.hub.join(opts); },
  };

  // ------------------------------------------------------------------ chunking helper
  /** Splits large JSON envelopes for transports with a message size limit (WebRTC). */
  function makeChunker(sendRaw, onEnvelope, limit) {
    const max = limit || 16000;
    let nextId = 1;
    const parts = new Map();
    return {
      send(env) {
        const s = JSON.stringify(env);
        if (s.length <= max) { sendRaw(s); return; }
        const id = nextId++;
        const n = Math.ceil(s.length / max);
        for (let i = 0; i < n; i++) sendRaw(JSON.stringify({ __chunk: id, i, n, d: s.slice(i * max, (i + 1) * max) }));
      },
      receive(raw) {
        let v;
        try { v = JSON.parse(raw); } catch (e) { return; }
        if (v && v.__chunk) {
          let p = parts.get(v.__chunk);
          if (!p) { p = new Array(v.n); p.got = 0; parts.set(v.__chunk, p); }
          if (p[v.i] === undefined) { p[v.i] = v.d; p.got++; }
          if (p.got === v.n) {
            parts.delete(v.__chunk);
            try { onEnvelope(JSON.parse(p.join(''))); } catch (e) { /* ignore corrupt */ }
          }
          return;
        }
        onEnvelope(v);
      },
    };
  }

  // ------------------------------------------------------------------ public API
  function pick(opts) {
    const name = (opts && opts.transport) || 'relay';
    const t = transports[name];
    if (!t) throw new Error('Unknown network transport "' + name + '"' + (name === 'webrtc' || name === 'relay' ? ' (script js/net/' + name + '.js not loaded)' : ''));
    return t;
  }
  Net.createHost = function (opts) { opts = opts || {}; return pick(opts).createHost(opts); };
  Net.join = function (opts) { opts = opts || {}; return pick(opts).join(opts); };
  Net.createHub = createHub;
  Net.Emitter = Emitter;
  Net.HostSession = HostSession;
  Net.GuestSession = GuestSession;
  Net.randomId = randomId;
  Net.makeChunker = makeChunker;
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
