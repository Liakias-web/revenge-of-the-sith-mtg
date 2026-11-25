/* Old Republic relay transport: talks to the message relay built into OldRepublic.exe
 * (tools/launcher/main.go: GET /mp/events = Server-Sent Events, POST /mp/send).
 *
 *   OF.Net.createHost({transport:'relay', base:'http://127.0.0.1:47853', name})
 *   OF.Net.join({transport:'relay', base:'http://192.168.1.5:47920', room?, name})
 *
 * `base` defaults to the page's own origin. A guest without `room` joins the only (or the
 * oldest) game on that relay. Uses EventSource in browsers (auto-reconnect with
 * Last-Event-ID) and a fetch()-stream reader elsewhere (Node tests). Outgoing messages go
 * through one POST at a time (batched) so their order is preserved.
 */
(function (OF) {
  'use strict';
  const Net = OF.Net;
  if (!Net) throw new Error('js/net/net.js must be loaded before js/net/relay.js');

  /** "192.168.1.5:47920" / "http://host:port/" / "" -> "http://host:port" */
  function normalizeBase(addr) {
    let a = String(addr || '').trim();
    if (!a) {
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin;
      throw new Error('Enter the host address, e.g. 192.168.1.5:47920');
    }
    if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
    a = a.replace(/\/+$/, '');
    try {
      const u = new URL(a);
      if (!u.port && u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) u.port = '47920';
      return u.origin;
    } catch (e) { throw new Error('Not a valid address: ' + addr); }
  }

  async function getJSON(url, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 6000) : null;
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      const txt = await r.text();
      let v = null;
      try { v = JSON.parse(txt); } catch (e) { v = null; }
      if (!r.ok) throw new Error((v && v.error) || ('HTTP ' + r.status));
      return v;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Is a Old Republic relay reachable at base? Resolves {ok, version} or rejects. */
  async function probe(base, timeoutMs) {
    const b = normalizeBase(base);
    const v = await getJSON(b + '/mp/ping', timeoutMs || 2500);
    if (!v || (v.app !== 'revengeofthesith' && v.app !== 'rots')) throw new Error('That address is not a Revenge of the Sith host.');
    return { ok: true, base: b, version: v.version };
  }
  async function listRooms(base) { return getJSON(normalizeBase(base) + '/mp/rooms'); }

  /** Ordered sender: one POST in flight, everything queued meanwhile goes in the next batch. */
  function makeSender(base, room, from, onFatal) {
    const pending = [];
    let busy = false, failures = 0, dead = false;
    async function flush() {
      if (busy || dead || !pending.length) return;
      busy = true;
      const batch = pending.splice(0, 200);
      try {
        const r = await fetch(base + '/mp/send', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // "simple" request: no CORS preflight
          body: JSON.stringify({ room, from, batch }),
        });
        if (r.status === 410 || r.status === 403) {
          dead = true;
          let msg = 'The game has ended.';
          try { const v = await r.json(); if (v && v.error) msg = v.error; } catch (e) { /* ignore */ }
          onFatal(msg);
          return;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        failures = 0;
      } catch (e) {
        pending.unshift(...batch);
        failures++;
        if (failures > 20) { dead = true; onFatal('Could not reach the host (' + (e && e.message || e) + ').'); return; }
        busy = false;
        setTimeout(flush, Math.min(4000, 200 * failures));
        return;
      }
      busy = false;
      if (pending.length) flush();
    }
    return {
      send(to, msg) { if (dead) return; pending.push({ to, msg }); flush(); },
      stop() { dead = true; },
    };
  }

  /**
   * Event stream. Calls onEvent({from, msg}) per message, onState('open'|'reconnecting'),
   * onFatal(reason) when it gives up (e.g. 404 / 410 from the relay).
   */
  function openStream(url, handlers) {
    const useES = typeof EventSource !== 'undefined' && !handlers.forceFetch;
    let closed = false;
    if (useES) {
      const es = new EventSource(url);
      let everOpen = false, errors = 0;
      es.onopen = () => { everOpen = true; errors = 0; handlers.onState('open'); };
      es.onmessage = (e) => { let v; try { v = JSON.parse(e.data); } catch (err) { return; } handlers.onEvent(v); };
      es.onerror = () => {
        if (closed) return;
        errors++;
        if (es.readyState === 2 /* CLOSED: HTTP error, no auto-retry */ ) {
          closed = true;
          handlers.onFatal(everOpen ? 'The connection to the host was closed.' : 'Could not join: the host refused the connection.');
          return;
        }
        handlers.onState('reconnecting');
        if (errors > 40) { closed = true; es.close(); handlers.onFatal('Lost the connection to the host.'); }
      };
      return { close() { closed = true; es.close(); } };
    }
    // fetch() stream fallback (Node, or browsers without EventSource)
    let last = 0, ctl = null, failures = 0;
    async function run() {
      while (!closed) {
        try {
          ctl = new AbortController();
          const r = await fetch(url + (last ? '&last=' + last : ''), { cache: 'no-store', signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const v = await r.json(); if (v && v.error) msg = v.error; } catch (e) { /* ignore */ }
            if (r.status >= 400 && r.status < 500 || r.status === 503) { closed = true; handlers.onFatal(msg); return; }
            throw new Error(msg);
          }
          failures = 0;
          handlers.onState('open');
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let k;
            while ((k = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, k); buf = buf.slice(k + 2);
              let id = null, data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('id:')) id = Number(line.slice(3).trim());
                else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
              }
              if (id) last = id;
              if (data) { let v; try { v = JSON.parse(data); } catch (e) { v = null; } if (v) handlers.onEvent(v); }
            }
          }
        } catch (e) {
          if (closed) return;
        }
        if (closed) return;
        failures++;
        if (failures > 40) { closed = true; handlers.onFatal('Lost the connection to the host.'); return; }
        handlers.onState('reconnecting');
        await new Promise(res => setTimeout(res, Math.min(3000, 300 * failures)));
      }
    }
    run();
    return { close() { closed = true; try { ctl && ctl.abort(); } catch (e) { /* ignore */ } } };
  }

  function leaveBeacon(base, room, peer) {
    const body = JSON.stringify({ room, peer });
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) { navigator.sendBeacon(base + '/mp/leave', new Blob([body], { type: 'text/plain' })); return; }
    } catch (e) { /* fall through */ }
    try { fetch(base + '/mp/leave', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function eventsURL(base, room, peer, role, name) {
    return base + '/mp/events?room=' + encodeURIComponent(room) + '&peer=' + encodeURIComponent(peer) + '&role=' + role + '&name=' + encodeURIComponent((name || '').slice(0, 40));
  }

  function onUnload(fn) {
    if (typeof window === 'undefined' || !window.addEventListener) return () => {};
    window.addEventListener('pagehide', fn);
    return () => window.removeEventListener('pagehide', fn);
  }

  // ------------------------------------------------------------------ host
  function createHost(opts) {
    const s = new Net.HostSession('relay');
    let base;
    try { base = normalizeBase(opts.base); } catch (e) { setTimeout(() => { s.emit('error', e); s._end(e.message); }, 0); return s; }
    const room = opts.room || Net.randomId('r', 6);
    s.info = { base, room };
    const fatal = (reason) => { stream && stream.close(); sender.stop(); s._end(reason); };
    const sender = makeSender(base, room, s.id, fatal);
    const links = new Map();
    function linkFor(pid) {
      let l = links.get(pid);
      if (!l) { l = { send(env) { sender.send(pid, env); }, close() { /* relay has no per-peer close */ } }; links.set(pid, l); }
      return l;
    }
    const stream = openStream(eventsURL(base, room, s.id, 'host', opts.name), {
      forceFetch: opts.forceFetch,
      onState(st) { if (st === 'open') s._markOpen(); s.emit('status', st === 'open' ? 'connected' : 'reconnecting…'); },
      onEvent(ev) {
        if (ev.from === '_relay') {
          const m = ev.msg || {};
          if (m.sys === 'join') s._linkOpen(m.peer, linkFor(m.peer));
          else if (m.sys === 'leave') { s._linkClose(m.peer, 'disconnected'); links.delete(m.peer); }
          return;
        }
        if (!s._links.has(ev.from)) s._linkOpen(ev.from, linkFor(ev.from)); // joined before our stream (re)opened
        s._linkMessage(ev.from, ev.msg);
      },
      onFatal(reason) { s.emit('error', new Error(reason)); fatal(reason); },
    });
    const unhook = onUnload(() => leaveBeacon(base, room, s.id));
    s._driver = { close() { unhook(); stream.close(); setTimeout(() => sender.stop(), 500); leaveBeacon(base, room, s.id); } };
    return s;
  }

  // ------------------------------------------------------------------ guest
  function join(opts) {
    const s = new Net.GuestSession('relay');
    const myId = opts.id || Net.randomId('g', 7);
    let stream = null, sender = null, unhook = () => {};
    const fail = (reason) => { if (stream) stream.close(); if (sender) sender.stop(); s.emit('error', new Error(reason)); s._linkDown(reason); };
    (async () => {
      let base;
      try { base = normalizeBase(opts.base); } catch (e) { fail(e.message); return; }
      let rooms;
      try { await probe(base); rooms = await listRooms(base); } catch (e) {
        fail('Could not reach a Revenge of the Sith host at ' + base + ' (' + (e && e.message || e) + '). Check the address, that the host clicked "Host on LAN", and the firewall.');
        return;
      }
      let rm = null;
      if (opts.room) rm = (rooms || []).find(r => r.room === opts.room);
      else rm = (rooms || [])[0];
      if (!rm) { fail(opts.room ? 'That game is no longer open on ' + base + '.' : 'No game is being hosted at ' + base + ' yet.'); return; }
      s.info = { base, room: rm.room, hostName: rm.hostName };
      sender = makeSender(base, rm.room, myId, fail);
      const hostPeer = rm.hostPeer;
      s._linkUp({ send(env) { sender.send(hostPeer, env); }, close() { /* handled by driver */ } });
      stream = openStream(eventsURL(base, rm.room, myId, 'guest', opts.name), {
        forceFetch: opts.forceFetch,
        onState(st) { s.emit('status', st === 'open' ? 'connected' : 'reconnecting…'); },
        onEvent(ev) {
          if (ev.from === '_relay') {
            const m = ev.msg || {};
            if (m.sys === 'closed' || (m.sys === 'leave' && m.peer === hostPeer)) fail('The host closed the game.');
            return;
          }
          if (ev.from === hostPeer) s._envelope(ev.msg);
        },
        onFatal: fail,
      });
      unhook = onUnload(() => leaveBeacon(base, rm.room, myId));
      s._driver = { close() { unhook(); if (stream) stream.close(); setTimeout(() => sender && sender.stop(), 500); leaveBeacon(base, rm.room, myId); } };
    })();
    s._driver = { close() { if (stream) stream.close(); if (sender) sender.stop(); } };
    return s;
  }

  /** Under RevengeOfTheSith.exe: open the LAN listener. Resolves {port, addrs, urls}. */
  async function startLanHost() {
    if (typeof location === 'undefined' || location.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      throw new Error('LAN hosting needs RevengeOfTheSith.exe (this page is not served by it).');
    }
    const r = await fetch('/__host', { method: 'POST', cache: 'no-store' });
    let v = null;
    try { v = await r.json(); } catch (e) { v = null; }
    if (!r.ok || !v || !v.ok) throw new Error((v && v.error) || ('Could not start LAN hosting (HTTP ' + r.status + ')'));
    return v;
  }

  Net.transports.relay = { createHost, join };
  Net.relay = { normalizeBase, probe, listRooms, startLanHost };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
