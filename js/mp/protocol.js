/* Revenge of the Sith multiplayer protocol helpers (Node-safe): message constants, state checksum,
 * seeds, small utilities shared by js/mp/*.js. Attaches OF.MP.Proto.
 *
 * Application messages are JSON objects with a type field `t`:
 *   lobby   hello{name,cid,ver} (guest->host) · lobby{state} · chat{text} -> chatb{name,text,ts}
 *           deck{deck:{label,cards}} · cfg (host-only state change) · kick
 *   match   mstart{mid,side,players,bestOf,title,oppPeer} · gready{mid,gno} · gstart{mid,gno,gid,seed,chooser}
 *           ans{gid,did,dt,dp,ck,ans} (peer to peer) · concede{gid,seat} · desync{gid,did,why}
 *           gresult{mid,gno,gid,winner,reason,turns,ck} · mupdate{mid,match,done,note}
 *   event   estate{view} · dpack{round,pick,pack,picks,deadline} · dpick{round,pick,card}
 *           ebuild{pool,deck} · dsubmit{deck} · aimatch{mid,you,opp,bestOf,aiLevel}
 *           mprog{mid,winsA,winsB} · mresult{mid,winsA,winsB,games,winner}
 */
(function (OF) {
  'use strict';
  const MP = OF.MP = OF.MP || {};

  const VERSION = 'rots-1';  // protocol id: Revenge of the Sith and Old Republic ('tor-1') clients refuse each other

  /** All counters of a permanent (+1/+1, charge, verse, tribute...) as a stable string. */
  function counterSig(m) {
    if (!m) return '0';
    return Object.keys(m).filter(k => m[k]).sort().map(k => k + m[k]).join(',') || '0';
  }

  function fnv(h, s) {
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 16777619) >>> 0;
    return h;
  }

  /**
   * Cheap state checksum compared before every relayed answer: turn, step, active player,
   * stack, per-player life and zone sizes, and every permanent's id/tap/damage/counters.
   */
  function checksum(g) {
    let h = 2166136261 >>> 0;
    h = fnv(h, g.turnNumber + '|' + g.activePlayer + '|' + g.step + '|' + g.stack.length + '|' + g.battlefield.length + '|' + (g.over ? 1 : 0));
    for (const p of g.players) {
      h = fnv(h, p.life + ',' + p.library.length + ',' + p.hand.length + ',' + p.graveyard.length + ',' + p.exile.length);
    }
    for (const id of g.battlefield) {
      const c = g.cards[id];
      if (!c) { h = fnv(h, id + '?'); continue; }
      h = fnv(h, id + ':' + (c.tapped ? 1 : 0) + ':' + (c.damage || 0) + ':' + counterSig(c.counters) + ':' + (c.attachedTo || 0) + ':' + c.controller);
    }
    return h.toString(36);
  }

  /** A fresh 31-bit seed (crypto when available). */
  function randomSeed() {
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) return (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1) || 1;
    } catch (e) { /* fall back */ }
    return Math.floor(Math.random() * 2 ** 31) || 1;
  }

  /** Spread k human seats around an n-seat table (2 humans at 0 and n/2: they meet in round 1). */
  function spreadSeats(k, n) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(Math.floor(i * n / k));
    return out;
  }

  function cleanName(s, fallback) {
    const v = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
    return v || fallback || 'Player';
  }

  /** Card names that the engine cannot build (unknown cards) — empty array when fine. */
  function unknownCards(cards) {
    const bad = [];
    for (const n of cards || []) {
      if (typeof n !== 'string') { bad.push(String(n)); continue; }
      try { OF.getDef(n); } catch (e) { if (bad.indexOf(n) < 0) bad.push(n); }
    }
    return bad;
  }

  function summarizeMatch(m) {
    return { winsA: m.winsA, winsB: m.winsB, draws: m.draws || 0, done: !!m.done, winner: m.winner, games: (m.games || []).map(g => ({ winner: g.winner, reason: g.reason, turns: g.turns })) };
  }

  MP.Proto = { VERSION, checksum, randomSeed, spreadSeats, cleanName, unknownCards, summarizeMatch, fnv };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
