/* Old Republic WebRTC transport: direct peer-to-peer data channels with manual
 * "invite code" signaling (no server needed besides public STUN).
 *
 * Host:
 *   const s = OF.Net.createHost({transport:'webrtc', name});
 *   const inv = await s.webrtc.createInvite();     // {slot, code}  -> give code to a friend
 *   await s.webrtc.acceptAnswer(answerCode);       // paste the friend's reply -> 'peer-join'
 * Guest:
 *   const g = OF.Net.join({transport:'webrtc', code, name});
 *   const answer = await g.answerCode;             // give this back to the host -> 'open'
 *
 * Codes are JSON {v, k:'o'|'a', s:sessionKey, n:slot, h:hostName, sdp} deflated and base64url
 * encoded ("TOR1." prefix; "TOR0." = uncompressed fallback). ICE is non-trickle: codes are made
 * after candidate gathering completes (or a timeout). No TURN server: very strict NATs
 * (some mobile / corporate networks) can fail — use LAN / relay or a VPN such as Tailscale.
 */
(function (OF) {
  'use strict';
  const Net = OF.Net;
  if (!Net) throw new Error('js/net/net.js must be loaded before js/net/webrtc.js');

  const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const PREFIX_Z = 'ROTS1.', PREFIX_P = 'ROTS0.';

  function supported() { return typeof RTCPeerConnection !== 'undefined'; }

  // ------------------------------------------------------------------ code encoding
  function b64urlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function bytesFromB64url(s) {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '==='.slice((b.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipeThrough(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }
  async function encodeCode(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    if (typeof CompressionStream !== 'undefined') {
      try { return PREFIX_Z + b64urlFromBytes(await pipeThrough(bytes, new CompressionStream('deflate-raw'))); } catch (e) { /* fall back */ }
    }
    return PREFIX_P + b64urlFromBytes(bytes);
  }
  async function decodeCode(code) {
    const c = String(code || '').replace(/\s+/g, '');
    let bytes;
    try {
      if (c.startsWith(PREFIX_Z)) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed codes.');
        bytes = await pipeThrough(bytesFromB64url(c.slice(PREFIX_Z.length)), new DecompressionStream('deflate-raw'));
      } else if (c.startsWith(PREFIX_P)) bytes = bytesFromB64url(c.slice(PREFIX_P.length));
      else throw new Error('not a Revenge of the Sith code');
      const v = JSON.parse(new TextDecoder().decode(bytes));
      if (!v || v.v !== 1 || !v.sdp) throw new Error('bad code');
      return v;
    } catch (e) {
      throw new Error('That is not a valid Revenge of the Sith code (copy the whole text, starting with "ROTS"). ' + (e && e.message ? '[' + e.message + ']' : ''));
    }
  }

  /** Resolve once ICE gathering is complete, or after `maxMs` (using what was gathered so far). */
  function waitIce(pc, maxMs) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      let done = false, quiet = null;
      const finish = () => { if (done) return; done = true; clearTimeout(cap); clearTimeout(quiet); pc.removeEventListener('icegatheringstatechange', onState); pc.removeEventListener('icecandidate', onCand); resolve(); };
      const onState = () => { if (pc.iceGatheringState === 'complete') finish(); };
      // Once a server-reflexive (public) candidate exists, stop after a short quiet period:
      // unreachable STUN servers can otherwise hold "complete" back for many seconds.
      const onCand = (e) => {
        if (!e.candidate) { finish(); return; }
        if (/ typ srflx/.test(e.candidate.candidate || '')) { clearTimeout(quiet); quiet = setTimeout(finish, 700); }
      };
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('icecandidate', onCand);
      const cap = setTimeout(finish, maxMs || 6000);
    });
  }

  function wireChannel(dc, onEnvelope, onClose) {
    const ch = Net.makeChunker((s) => { if (dc.readyState === 'open') dc.send(s); }, onEnvelope, 16000);
    dc.onmessage = (e) => ch.receive(typeof e.data === 'string' ? e.data : '');
    let closed = false;
    const close = (why) => { if (closed) return; closed = true; onClose(why); };
    dc.onclose = () => close('connection closed');
    dc.onerror = () => { /* followed by close */ };
    return { send: (env) => ch.send(env), close: () => { try { dc.close(); } catch (e) { /* ignore */ } close('closed'); }, _closeCb: close };
  }

  function watchPc(pc, onDead) {
    let timer = null;
    pc.addEventListener('connectionstatechange', () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') onDead('connection ' + st);
      else if (st === 'disconnected') { clearTimeout(timer); timer = setTimeout(() => { if (pc.connectionState === 'disconnected') onDead('connection lost'); }, 15000); }
      else clearTimeout(timer);
    });
  }

  // ------------------------------------------------------------------ host
  function createHost(opts) {
    const s = new Net.HostSession('webrtc');
    const key = Net.randomId('', 6);
    const ice = opts.iceServers || DEFAULT_ICE;
    const slots = new Map(); // slot -> {pc, dc, state}
    let nextSlot = 1;
    s.info = { key };
    setTimeout(() => {
      if (!supported()) { const e = new Error('WebRTC is not available in this browser.'); s.emit('error', e); s._end(e.message); return; }
      s._markOpen();
    }, 0);

    async function createInvite() {
      if (!supported()) throw new Error('WebRTC is not available in this browser.');
      const slot = nextSlot++;
      const pid = 'p' + slot;
      const pc = new RTCPeerConnection({ iceServers: ice });
      const dc = pc.createDataChannel('oldrepublic', { ordered: true });
      const rec = { slot, pid, pc, dc, state: 'waiting' };
      slots.set(slot, rec);
      const dead = (why) => {
        if (rec.state === 'closed') return;
        const was = rec.state;
        rec.state = 'closed';
        try { pc.close(); } catch (e) { /* ignore */ }
        if (was === 'open') s._linkClose(pid, why);
      };
      const link = wireChannel(dc, (env) => s._linkMessage(pid, env), dead);
      dc.onopen = () => { rec.state = 'open'; s._linkOpen(pid, link); };
      watchPc(pc, (why) => link._closeCb(why));
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc, opts.iceTimeoutMs);
      const code = await encodeCode({ v: 1, k: 'o', s: key, n: slot, h: (opts.name || '').slice(0, 40), sdp: pc.localDescription.sdp });
      rec.code = code;
      return { slot, code, peerId: pid };
    }

    async function acceptAnswer(code) {
      const v = await decodeCode(code);
      if (v.k !== 'a') throw new Error('That is an invite code. Paste the reply code your friend sent back.');
      if (v.s !== key) throw new Error('That reply belongs to a different game.');
      const rec = slots.get(v.n);
      if (!rec) throw new Error('No invite with that number is waiting.');
      if (rec.state !== 'waiting') throw new Error('That invite was already used. Create a new one.');
      rec.state = 'connecting';
      rec.guestName = v.g || '';
      await rec.pc.setRemoteDescription({ type: 'answer', sdp: v.sdp });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { if (rec.state !== 'open') { reject(new Error('Could not connect (no route between the two computers). Very strict NATs need the LAN/relay option or a VPN like Tailscale.')); } }, opts.connectTimeoutMs || 20000);
        const check = setInterval(() => {
          if (rec.state === 'open') { clearInterval(check); clearTimeout(t); resolve({ peerId: rec.pid, slot: rec.slot, name: rec.guestName }); }
          else if (rec.state === 'closed') { clearInterval(check); clearTimeout(t); reject(new Error('The connection failed.')); }
        }, 100);
      });
    }

    function cancelInvite(slot) {
      const rec = slots.get(slot);
      if (rec && rec.state !== 'open') { rec.state = 'closed'; try { rec.pc.close(); } catch (e) { /* ignore */ } slots.delete(slot); }
    }
    s.webrtc = { createInvite, acceptAnswer, cancelInvite, slots };
    s._driver = { close() { for (const r of slots.values()) { try { r.pc.close(); } catch (e) { /* ignore */ } } slots.clear(); } };
    return s;
  }

  // ------------------------------------------------------------------ guest
  function join(opts) {
    const s = new Net.GuestSession('webrtc');
    const ice = opts.iceServers || DEFAULT_ICE;
    let pc = null;
    let res, rej;
    s.answerCode = new Promise((a, b) => { res = a; rej = b; });
    s.answerCode.catch(() => {});
    (async () => {
      if (!supported()) throw new Error('WebRTC is not available in this browser.');
      const v = await decodeCode(opts.code);
      if (v.k !== 'o') throw new Error('That is a reply code. Paste the invite code the host gave you.');
      s.info = { hostName: v.h, slot: v.n, key: v.s };
      pc = new RTCPeerConnection({ iceServers: ice });
      let opened = false;
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        const link = wireChannel(dc, (env) => s._envelope(env), (why) => s._linkDown(opened ? 'Connection to the host was lost (' + why + ').' : 'Could not connect to the host.'));
        dc.onopen = () => { opened = true; s._linkUp(link); };
        if (dc.readyState === 'open') { opened = true; s._linkUp(link); }
        watchPc(pc, (why) => link._closeCb(why));
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: v.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc, opts.iceTimeoutMs);
      res(await encodeCode({ v: 1, k: 'a', s: v.s, n: v.n, g: (opts.name || '').slice(0, 40), sdp: pc.localDescription.sdp }));
      setTimeout(() => { if (!s.isOpen && !s.closed) s.emit('status', 'Still waiting for the host to paste your reply code…'); }, 30000);
    })().catch((e) => { rej(e); s.emit('error', e); s._linkDown(e.message); });
    s._driver = { close() { try { pc && pc.close(); } catch (e) { /* ignore */ } } };
    return s;
  }

  Net.transports.webrtc = { createHost, join };
  Net.webrtc = { supported, encodeCode, decodeCode, DEFAULT_ICE };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
