/* Old Republic multiplayer Booster Draft / Sealed events (host-authoritative).
 *
 *   OF.MP.EventHost    host logic (Node-safe): seats (humans + AI fill), seeded boosters
 *                      (OF.Draft), multi-human pick rounds with AI drafters and a pick timer,
 *                      deck submission, Swiss rounds (OF.Events pairing/standings),
 *                      human-vs-human matches via OF.MP.MatchHost (lockstep), human-vs-AI
 *                      matches played on that human's client, AI-vs-AI matches simulated by
 *                      the host (asynchronously, in small time slices).
 *   OF.MP.EventClient  client screens (DOM): draft picks, deck builder, event hub, AI match.
 *   OF.MP.simulateGameAsync(deckA, deckB, opts) -> Promise<{winner, turns, reason}>
 */
(function (OF) {
  'use strict';
  const MP = OF.MP = OF.MP || {};
  const P = () => MP.Proto;
  const A = () => OF.AppUtil;

  // ====================================================================== AI-vs-AI simulation
  /** Play an AI-vs-AI game in time slices so the host's UI (and its own live game) stays responsive. */
  function simulateGameAsync(deckA, deckB, opts) {
    opts = opts || {};
    const seed = (opts.seed >>> 0) || 1;
    return new Promise((resolve) => {
      const fallback = (reason) => {
        const rng = OF.util.makeRng(seed ^ 0x5bd1e995);
        const w = OF.Events && OF.Events.strengthResult ? OF.Events.strengthResult(deckA, deckB, rng) : (rng() < 0.5 ? 0 : 1);
        resolve({ winner: w, turns: 0, reason: reason || 'estimated', simulated: false });
      };
      if (!OF.Game || !OF.AI || typeof OF.AI.createController !== 'function') { fallback('estimated'); return; }
      let g, ctrls;
      try {
        g = new OF.Game({ seed, maxTurns: opts.maxTurns || 40, chooser: opts.chooser, players: [{ name: 'A', deck: deckA, ai: true }, { name: 'B', deck: deckB, ai: true }] });
        ctrls = [OF.AI.createController({ level: opts.aiLevel || 'normal', seed: seed + 1 }), OF.AI.createController({ level: opts.aiLevel || 'normal', seed: seed + 2 })];
        g.start();
      } catch (e) { fallback('error'); return; }
      const t0 = Date.now();
      const budget = opts.budgetMs || 30000, slice = opts.sliceMs || 12;
      let guard = 0;
      const score = (p) => {
        let s = g.players[p].life + g.players[p].hand.length * 0.8;
        for (const id of g.battlefield) { const c = g.card(id); if (g.controllerOf(c) === p && g.isCreature(c)) s += g.power(c) * 0.8 + g.toughness(c) * 0.3; }
        return s;
      };
      const adjudicate = (reason) => {
        const a = score(0), b = score(1);
        if (Math.abs(a - b) < 0.5) { fallback(reason); return; }
        resolve({ winner: a > b ? 0 : 1, turns: g.turnNumber, reason, simulated: true, adjudicated: true });
      };
      const step = () => {
        const end = Date.now() + slice;
        try {
          while (!g.over && g.decision && Date.now() < end) {
            if (++guard > 60000) { adjudicate('time'); return; }
            const d = g.decision;
            let ans = null;
            try { ans = ctrls[d.player].decide(g, d); } catch (e) { ans = null; }
            let r = ans ? g.respond(ans) : { ok: false };
            if (!r.ok && g.decision === d) {
              r = g.respond(OF.Events && OF.Events.fallbackDecide ? OF.Events.fallbackDecide(g, d) : { type: 'pass' });
              if (!r.ok && g.decision === d) g.respond({ type: 'concede' });
            }
          }
        } catch (e) { fallback('error'); return; }
        if (g.over || !g.decision) {
          if (g.winner === 0 || g.winner === 1) resolve({ winner: g.winner, turns: g.turnNumber, reason: g.endReason, simulated: true });
          else adjudicate(g.endReason || 'turn limit');
          return;
        }
        if (Date.now() - t0 > budget) { adjudicate('time'); return; }
        setTimeout(step, opts.gapMs !== undefined ? opts.gapMs : 4);
      };
      step();
    });
  }

  // ====================================================================== host logic
  /**
   * opts: {type:'draft'|'sealed', humans:[{peer, name, cid}], aiCount (sealed AI opponents),
   *        bestOf, aiLevel, pickTimer (seconds per full pack, 0 = off), seed,
   *        send(peer, msg), onChange(view), onComplete(ev), simOpts}
   */
  class EventHost {
    constructor(opts) {
      this.opts = opts;
      this.type = opts.type === 'sealed' ? 'sealed' : 'draft';
      this.seed = (opts.seed >>> 0) || P().randomSeed();
      this.bestOf = opts.bestOf === 3 ? 3 : 1;
      this.aiLevel = opts.aiLevel || 'normal';
      this.pickTimer = Math.max(0, Number(opts.pickTimer) || 0);
      const humans = opts.humans.slice(0, 8);
      let n;
      if (this.type === 'draft') n = OF.Draft.SEATS || 8;
      else {
        n = humans.length + Math.max(0, Math.min(8 - humans.length, Number(opts.aiCount) || 0));
        if (n % 2) n++;
        n = Math.max(2, Math.min(8, n));
      }
      this.n = n;
      this.totalRounds = this.type === 'draft' ? 3 : Math.min(3, Math.max(1, n - 1));
      const humanSeats = P().spreadSeats(humans.length, n);
      this.humanSeats = humanSeats;
      const nameRng = OF.util.makeRng(A().hashSeed('mp-names', this.seed));
      const aiNames = nameRng.shuffle((OF.Draft.AI_NAMES || ['Edrin', 'Vessa', 'Thalen', 'Caldren', 'Mareth', 'Orla', 'Brannoc', 'Sefa', 'Imric']).slice());
      const taken = new Set(humans.map(h => h.name));
      this.players = [];
      for (let s = 0; s < n; s++) {
        const hi = humanSeats.indexOf(s);
        if (hi >= 0) {
          const hu = humans[hi];
          this.players.push({ seat: s, name: hu.name, isHuman: true, peer: hu.peer, cid: hu.cid || '', connected: true, pool: [], deck: [], deckSubmitted: false });
        } else {
          let nm = aiNames.pop() || ('AI ' + s);
          while (taken.has(nm) && aiNames.length) nm = aiNames.pop();
          taken.add(nm);
          this.players.push({ seat: s, name: nm + ' (AI)', isHuman: false, peer: null, connected: false, pool: [], deck: [], deckSubmitted: true });
        }
      }
      this.ev = OF.Events.createEvent({ id: 'mp' + this.seed.toString(36), type: this.type, seed: this.seed, bestOf: this.bestOf, aiLevel: this.aiLevel, totalRounds: this.totalRounds, stage: this.type === 'draft' ? 'drafting' : 'building', humanIndex: -1, players: this.players.map(p => ({ name: p.name, isHuman: p.isHuman, pool: [], deck: [] })) });
      this.ev.humanIndex = -1;
      this.stage = this.ev.stage;
      this.matchHosts = new Map(); // mid -> MatchHost
      this.aiMatches = new Map();  // mid -> {seat, m}
      this.draft = null;
      this.destroyed = false;
      this.log = [];
    }

    // ---------------------------------------------------------------- helpers
    seatOfPeer(peer) { const p = this.players.find(x => x.isHuman && x.peer === peer); return p ? p.seat : -1; }
    _send(seat, msg) { const p = this.players[seat]; if (p && p.isHuman && p.connected && p.peer) this.opts.send(p.peer, msg); }
    _changed() { if (!this.destroyed && this.opts.onChange) this.opts.onChange(this.view()); }
    isLive(seat) { const p = this.players[seat]; return !!(p && p.isHuman && p.connected); }

    view() {
      const ev = this.ev;
      let standings = [];
      try { standings = OF.Events.standings(ev).map(r => ({ rank: r.rank, index: r.index, name: r.name, isHuman: this.players[r.index].isHuman, mp: r.mp, mw: r.mw, ml: r.ml, md: r.md, omw: r.omw, gwp: r.gwp })); } catch (e) { standings = []; }
      const rd = OF.Events.currentRound(ev);
      return {
        type: this.type, stage: this.stage, totalRounds: this.totalRounds, bestOf: this.bestOf, aiLevel: this.aiLevel, n: this.n,
        seats: this.players.map(p => ({ seat: p.seat, name: p.name, isHuman: p.isHuman, connected: p.connected, peer: p.peer, submitted: !!p.deckSubmitted, colors: p.colors || null })),
        draft: this.draft && this.stage === 'drafting' ? { round: this.draft.round, pick: this.draft.pick, waiting: this.waitingPickers().map(s => this.players[s].name), deadline: this.draft.deadlineAt ? Math.max(0, this.draft.deadlineAt - Date.now()) : 0 } : null,
        rounds: ev.rounds.map(r => ({ number: r.number, matches: r.matches.map((m, mi) => ({ mid: this.mid(r.number, mi), a: m.a, b: m.b, winsA: m.winsA, winsB: m.winsB, draws: m.draws || 0, done: !!m.done, winner: m.winner, kind: m.kind || '', status: m.status || '' })) })),
        roundDone: !!(rd && rd.matches.every(m => m.done)),
        standings,
      };
    }
    mid(round, mi) { return 'e' + this.seed.toString(36) + 'r' + round + 'm' + mi; }

    // ---------------------------------------------------------------- start
    start() {
      if (this.type === 'draft') this.startDraft();
      else {
        this.players.forEach((p, s) => { p.pool = OF.Draft.sealedPool(A().hashSeed(this.seed, 'seat', s), 6); });
        this.startBuilding();
      }
      return this;
    }

    // ---------------------------------------------------------------- draft
    startDraft() {
      const pod = OF.Draft.createPod({ seed: this.seed, humanSeat: null });
      this.draft = {
        round: 0, pick: 0, packs: pod.packs.map(p => p.slice()), picks: this.players.map(() => []),
        pers: pod.players.map(p => p.personality || OF.Draft.makePersonality(OF.util.makeRng(A().hashSeed('pers', this.seed, p.seat)))),
        choices: {}, timer: null, deadlineAt: 0,
      };
      this.stage = 'drafting';
      this.sendPacks();
    }
    packSize() { return OF.Draft.PACK_SIZE || 15; }
    waitingPickers() {
      const d = this.draft;
      if (!d) return [];
      return this.players.filter(p => this.isLive(p.seat) && d.choices[p.seat] === undefined).map(p => p.seat);
    }
    sendPacks() {
      const d = this.draft;
      clearTimeout(d.timer);
      d.choices = {};
      d.deadlineAt = 0;
      if (this.pickTimer) {
        const secs = Math.max(5, Math.round(this.pickTimer * (this.packSize() - d.pick) / this.packSize()));
        d.deadlineAt = Date.now() + secs * 1000;
        d.timer = setTimeout(() => this.pickTimeout(), secs * 1000 + 1500);
      }
      for (const p of this.players) if (this.isLive(p.seat)) this.sendPack(p.seat);
      this._changed();
      if (!this.waitingPickers().length) this.advancePick(); // nobody live (all humans gone)
    }
    sendPack(seat) {
      const d = this.draft;
      this._send(seat, { t: 'dpack', round: d.round, pick: d.pick, rounds: OF.Draft.ROUNDS || 3, packSize: this.packSize(), pack: d.packs[seat].slice(), picks: d.picks[seat].slice(), dir: OF.Draft.direction(d.round), deadline: d.deadlineAt ? Math.max(0, d.deadlineAt - Date.now()) : 0, picked: d.choices[seat] !== undefined ? d.choices[seat] : null });
    }
    pickTimeout() {
      const d = this.draft;
      if (!d || this.stage !== 'drafting') return;
      for (const s of this.waitingPickers()) {
        d.choices[s] = OF.Draft.suggestPick(d.packs[s], d.picks[s]);
        this._send(s, { t: 'dauto', round: d.round, pick: d.pick, card: d.choices[s] });
      }
      this.advancePick();
    }
    onPick(seat, msg) {
      const d = this.draft;
      if (!d || this.stage !== 'drafting') return;
      if (msg.round !== d.round || msg.pick !== d.pick) return; // stale
      if (d.choices[seat] !== undefined) return;
      const pack = d.packs[seat];
      d.choices[seat] = pack.indexOf(msg.card) >= 0 ? msg.card : OF.Draft.suggestPick(pack, d.picks[seat]);
      if (this.waitingPickers().length) { this._changed(); return; }
      this.advancePick();
    }
    advancePick() {
      const d = this.draft;
      clearTimeout(d.timer);
      const n = this.n;
      const chosen = [];
      for (let s = 0; s < n; s++) {
        const pack = d.packs[s];
        let card;
        if (d.choices[s] !== undefined) card = d.choices[s];
        else if (this.players[s].isHuman) card = OF.Draft.suggestPick(pack, d.picks[s]); // disconnected human
        else card = OF.Draft.aiChoose(pack, d.picks[s], d.pers[s], OF.util.makeRng(OF.Draft.seedFor('pick', this.seed, d.round, d.pick, s)));
        chosen.push(card);
      }
      for (let s = 0; s < n; s++) {
        const pack = d.packs[s];
        const i = pack.indexOf(chosen[s]);
        if (i >= 0) pack.splice(i, 1);
        d.picks[s].push(chosen[s]);
      }
      const dir = OF.Draft.direction(d.round);
      const next = new Array(n);
      for (let s = 0; s < n; s++) next[(s + dir + n) % n] = d.packs[s];
      d.packs = next;
      d.pick++;
      if (d.pick >= this.packSize()) {
        d.round++;
        d.pick = 0;
        if (d.round >= (OF.Draft.ROUNDS || 3)) {
          this.players.forEach((p, s) => { p.pool = d.picks[s].slice(); });
          this.draft = null;
          this.startBuilding();
          return;
        }
        d.packs = [];
        for (let s = 0; s < n; s++) d.packs.push(OF.Draft.makeBooster(OF.util.makeRng(OF.Draft.seedFor('pack', this.seed, d.round, s))));
      }
      this.sendPacks();
    }

    // ---------------------------------------------------------------- deck building
    startBuilding() {
      this.stage = 'building';
      this.ev.stage = 'building';
      this.players.forEach((p, s) => {
        this.ev.players[s].pool = p.pool.slice();
        if (!p.isHuman || !p.connected) this.autoDeck(s);
      });
      for (const p of this.players) if (this.isLive(p.seat)) this._send(p.seat, { t: 'ebuild', pool: p.pool.slice(), deck: p.deck.slice(), type: this.type });
      this._changed();
      this.maybeStartPlay();
    }
    autoDeck(seat) {
      const p = this.players[seat];
      try {
        const res = OF.DeckTools.autoBuild(p.pool);
        p.deck = res.main; p.colors = res.colors;
      } catch (e) { p.deck = p.pool.slice(0, 40); }
      p.deckSubmitted = true;
      this.ev.players[seat].deck = p.deck.slice();
    }
    onSubmit(seat, msg) {
      const p = this.players[seat];
      const deck = Array.isArray(msg.deck) ? msg.deck.filter(x => typeof x === 'string') : [];
      const errs = OF.DeckTools.validate(deck, 'limited', p.pool);
      if (errs.length) { this._send(seat, { t: 'dsubmit-err', errors: errs }); return; }
      p.deck = deck.slice();
      p.deckSubmitted = true;
      try { p.colors = OF.util.COLORS.filter(c => deck.some(n => (OF.Ratings ? OF.Ratings.colorsOf(n) : []).indexOf(c) >= 0)); } catch (e) { p.colors = null; }
      this.ev.players[seat].deck = p.deck.slice();
      this._send(seat, { t: 'dsubmit-ok' });
      this._changed();
      this.maybeStartPlay();
    }
    maybeStartPlay() {
      if (this.stage !== 'building') return;
      if (this.players.some(p => p.isHuman && p.connected && !p.deckSubmitted)) return;
      this.stage = 'playing';
      this.ev.stage = 'playing';
      this.startRound();
    }

    // ---------------------------------------------------------------- rounds
    startRound() {
      const rd = OF.Events.pairNextRound(this.ev);
      rd.matches.forEach((m, mi) => this.startMatch(rd, m, mi));
      this._changed();
      this.checkRoundDone();
    }
    startMatch(rd, m, mi) {
      const mid = this.mid(rd.number, mi);
      if (m.b === null || m.b === undefined) { m.done = true; m.kind = 'bye'; return; }
      const la = this.isLive(m.a), lb = this.isLive(m.b);
      const pa = this.players[m.a], pb = this.players[m.b];
      if (la && lb) {
        m.kind = 'live'; m.status = 'playing';
        const mh = new MP.MatchHost({
          mid, peers: [pa.peer, pb.peer], players: [{ name: pa.name, deck: pa.deck }, { name: pb.name, deck: pb.deck }], bestOf: this.bestOf, match: m,
          title: (this.type === 'sealed' ? 'Sealed' : 'Draft') + ' — Round ' + rd.number,
          send: (peer, msg) => this.opts.send(peer, msg),
          onUpdate: () => this._changed(),
          onDone: () => { m.status = 'done'; this.matchHosts.delete(mid); this._changed(); this.checkRoundDone(); },
        });
        this.matchHosts.set(mid, mh);
        mh.start();
      } else if (la || lb) {
        const hs = la ? m.a : m.b, as = la ? m.b : m.a;
        m.kind = 'ai'; m.status = 'playing';
        this.aiMatches.set(mid, { seat: hs, ai: as, m, rd: rd.number });
        this.sendAiMatch(mid);
      } else {
        m.kind = 'sim'; m.status = 'simulating';
        this.simulateMatch(rd, m, mi);
      }
    }
    sendAiMatch(mid) {
      const x = this.aiMatches.get(mid);
      if (!x) return;
      const ph = this.players[x.seat], pa = this.players[x.ai];
      const humanIsA = x.m.a === x.seat;
      this._send(x.seat, { t: 'aimatch', mid, title: (this.type === 'sealed' ? 'Sealed' : 'Draft') + ' — Round ' + x.rd, bestOf: this.bestOf, aiLevel: this.aiLevel,
        you: { name: ph.name, deck: ph.deck.slice() }, opp: { name: pa.name, deck: pa.deck.slice(), colors: pa.colors || null },
        progress: { winsA: humanIsA ? x.m.winsA : x.m.winsB, winsB: humanIsA ? x.m.winsB : x.m.winsA, games: x.m.games.length } });
    }
    async simulateMatch(rd, m, mi) {
      let k = 0;
      while (!m.done && k++ < 6 && !this.destroyed) {
        const chooser = OF.Events.nextChooser(m);
        const res = await simulateGameAsync(this.players[m.a].deck, this.players[m.b].deck, Object.assign({ seed: A().hashSeed('mpsim', this.seed, rd.number, mi, m.games.length), aiLevel: this.aiLevel, chooser }, this.opts.simOpts || {}));
        if (this.destroyed) return;
        OF.Events.recordGame(m, res.winner, { turns: res.turns, reason: res.reason, sim: true }, this.bestOf);
        this._changed();
      }
      m.status = 'done';
      this._changed();
      this.checkRoundDone();
    }
    onAiResult(seat, msg, final) {
      const x = this.aiMatches.get(msg.mid);
      if (!x || x.seat !== seat || x.m.done) return;
      const humanIsA = x.m.a === seat;
      const wh = Math.max(0, msg.winsA | 0), wa = Math.max(0, msg.winsB | 0);
      if (!final) {
        x.m.winsA = humanIsA ? wh : wa; x.m.winsB = humanIsA ? wa : wh;
        this._changed();
        return;
      }
      // Rebuild the match from the reported games (from the human's perspective: 0 = human).
      const m = x.m;
      m.games = []; m.winsA = 0; m.winsB = 0; m.draws = 0; m.done = false; m.winner = null;
      const games = Array.isArray(msg.games) ? msg.games.slice(0, 5) : [];
      for (const g of games) {
        const w = g.winner === 0 ? (humanIsA ? 0 : 1) : g.winner === 1 ? (humanIsA ? 1 : 0) : -1;
        OF.Events.recordGame(m, w, { reason: g.reason || '', turns: g.turns || 0 }, this.bestOf);
      }
      let guard = 0;
      while (!m.done && guard++ < 6) OF.Events.recordGame(m, humanIsA ? 1 : 0, { reason: 'unfinished' }, this.bestOf); // left early = loss
      m.status = 'done';
      this.aiMatches.delete(msg.mid);
      this._changed();
      this.checkRoundDone();
    }
    checkRoundDone() {
      const rd = OF.Events.currentRound(this.ev);
      if (!rd || !rd.matches.every(m => m.done)) return;
      if (rd.number >= this.totalRounds) {
        if (this.stage !== 'complete') {
          this.stage = 'complete';
          this.ev.stage = 'complete';
          this._changed();
          if (this.opts.onComplete) this.opts.onComplete(this.ev);
        }
      } else this._changed();
    }
    /** Host pressed "Start next round". */
    nextRound() {
      if (this.stage !== 'playing') return false;
      const rd = OF.Events.currentRound(this.ev);
      if (!rd || !rd.matches.every(m => m.done) || rd.number >= this.totalRounds) return false;
      this.startRound();
      return true;
    }

    // ---------------------------------------------------------------- messages & presence
    handle(from, msg) {
      if (this.destroyed || !msg) return false;
      for (const mh of this.matchHosts.values()) if (mh.handle(from, msg)) return true;
      const seat = this.seatOfPeer(from);
      switch (msg.t) {
        case 'dpick': if (seat >= 0) this.onPick(seat, msg); return true;
        case 'dsubmit': if (seat >= 0) this.onSubmit(seat, msg); return true;
        case 'mprog': if (seat >= 0) this.onAiResult(seat, msg, false); return true;
        case 'mresult': if (seat >= 0) this.onAiResult(seat, msg, true); return true;
        case 'esync': if (seat >= 0) this.resync(seat); return true;
      }
      return false;
    }
    /** A human left: their seat continues as an AI player. */
    peerLeft(peer) {
      const seat = this.seatOfPeer(peer);
      if (seat < 0) return;
      const p = this.players[seat];
      p.connected = false;
      for (const mh of Array.from(this.matchHosts.values())) mh.peerLeft(peer);
      if (this.stage === 'building' && !p.deckSubmitted) this.autoDeck(seat);
      else if (!p.deck.length && p.pool.length) this.autoDeck(seat);
      // pending human-vs-AI match of that seat: simulate it
      for (const [mid, x] of Array.from(this.aiMatches.entries())) {
        if (x.seat !== seat || x.m.done) continue;
        this.aiMatches.delete(mid);
        x.m.kind = 'sim'; x.m.status = 'simulating';
        const rd = OF.Events.currentRound(this.ev);
        this.simulateMatch(rd, x.m, rd.matches.indexOf(x.m));
      }
      this._changed();
      if (this.stage === 'drafting' && this.draft && !this.waitingPickers().length) this.advancePick();
      if (this.stage === 'building') this.maybeStartPlay();
    }
    /** A known player (same client id) came back with a new peer id. */
    rejoin(cid, peer) {
      if (!cid) return false;
      const p = this.players.find(x => x.isHuman && x.cid === cid);
      if (!p || (p.connected && p.peer === peer)) return false;
      p.peer = peer; p.connected = true;
      this.resync(p.seat);
      this._changed();
      return true;
    }
    resync(seat) {
      const p = this.players[seat];
      if (this.stage === 'drafting' && this.draft) this.sendPack(seat);
      else if (this.stage === 'building' || this.stage === 'playing' || this.stage === 'complete') this._send(seat, { t: 'ebuild', pool: p.pool.slice(), deck: p.deck.slice(), type: this.type, submitted: !!p.deckSubmitted, quiet: this.stage !== 'building' });
      for (const [mid, x] of this.aiMatches) if (x.seat === seat && !x.m.done) this.sendAiMatch(mid);
      this._changed();
    }
    destroy() {
      this.destroyed = true;
      if (this.draft) clearTimeout(this.draft.timer);
    }
  }

  // ====================================================================== client screens
  const COLOR_NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

  /**
   * Client side of an event. `app` (from lobby.js): {show(builder), sendHost(msg), myId,
   * isHost, view (latest estate), hostNextRound(), leaveToLobby(), status(text)}.
   */
  class EventClient {
    constructor(app) {
      this.app = app;
      this.view = null;
      this.pool = []; this.deck = []; this.submitted = false;
      this.pack = null;      // current dpack message
      this.myPick = null;
      this.aiMatch = null;   // pending aimatch message {.., match}
      this.screen = 'wait';  // wait | draft | build | hub | aimatch | live
      this.timerId = null;
      this.buildErrors = [];
    }
    mySeat() { const v = this.view; if (!v) return -1; const s = v.seats.find(x => x.peer === this.app.myId); return s ? s.seat : -1; }

    handle(from, msg) {
      switch (msg.t) {
        case 'estate': this.view = msg.view; this.onView(); return true;
        case 'dpack': this.pack = msg; this.myPick = msg.picked; this.showDraft(); return true;
        case 'dauto': if (this.pack && this.pack.round === msg.round && this.pack.pick === msg.pick) { this.myPick = msg.card; this.app.toast('Time is up: ' + msg.card + ' was picked for you.'); this.renderDraftStatus(); } return true;
        case 'ebuild':
          this.pool = msg.pool || []; this.deck = (msg.deck && msg.deck.length) ? msg.deck : this.deck; this.submitted = !!msg.submitted;
          if (!msg.quiet) this.showBuild(); else if (this.screen === 'wait' || this.screen === 'draft') this.showHub();
          return true;
        case 'dsubmit-ok': this.submitted = true; this.buildErrors = []; if (this.screen === 'build' || this.screen === 'buildwait') this.showBuildWait(); else this.app.toast('Deck saved for your next match.'); return true;
        case 'dsubmit-err': this.buildErrors = msg.errors || []; OF.AppUtil.modal('Deck not accepted', OF.AppUtil.h('div', {}, this.buildErrors.map(e => OF.AppUtil.h('div', {}, e))), [{ label: 'OK' }]); return true;
        case 'aimatch': this.aiMatch = Object.assign({}, msg, { match: this.aiMatch && this.aiMatch.mid === msg.mid ? this.aiMatch.match : null }); if (this.screen !== 'aimatch' && this.screen !== 'live') this.showHub(); return true;
      }
      return false;
    }

    onView() {
      const v = this.view;
      if (this.screen === 'draft') this.renderDraftStatus();
      else if (this.screen === 'buildwait') this.showBuildWait();
      else if (this.screen === 'hub') this.renderHub();
      else if (this.screen === 'wait' && v.stage !== 'drafting' && v.stage !== 'building') this.showHub();
    }

    stopTimer() { if (this.timerId) { clearInterval(this.timerId); this.timerId = null; } }

    // ------------------------------------------------------------- draft
    showDraft() {
      const { h, clear, createPreview, cardImg } = OF.AppUtil;
      const pk = this.pack;
      this.screen = 'draft';
      this.app.show((root) => {
        const preview = createPreview();
        let selected = null;
        const self = this;
        const timerEl = h('span', { class: 'mp-timer' });
        const statusEl = h('div', { class: 'mp-draft-status dim' });
        const draftBtn = h('button', { class: 'primary', 'data-mp': 'draft-pick', disabled: true, onclick: () => commit(selected) }, 'Draft');
        const autoBtn = h('button', { 'data-mp': 'draft-auto', title: 'Let the computer choose this pick', onclick: () => commit(OF.Draft.suggestPick(pk.pack, pk.picks)) }, 'Auto-pick');
        const header = h('div', { class: 'screen-header mp-header' },
          h('span', { class: 'dv-title' }, 'Booster Draft (online)'),
          h('span', { class: 'mp-pickno', 'data-mp': 'pickno' }, 'Pack ' + (pk.round + 1) + ', Pick ' + (pk.pick + 1)),
          h('span', { class: 'dim' }, pk.dir > 0 ? 'Passing left ←' : 'Passing right →'),
          h('span', { class: 'flex1' }), timerEl, autoBtn, draftBtn);
        const grid = h('div', { class: 'mp-pack' });
        const commit = (name) => {
          if (!name || this.myPick || this.pack !== pk) return;
          this.myPick = name;
          this.app.sendHost({ t: 'dpick', round: pk.round, pick: pk.pick, card: name });
          renderPack();
          this.renderDraftStatus();
        };
        const renderPack = () => {
          clear(grid);
          for (const name of pk.pack) {
            const cell = h('div', { class: 'mp-pcard' + (name === (this.myPick || selected) ? ' selected' : '') + (this.myPick && name !== this.myPick ? ' faded' : ''), 'data-card': name }, cardImg(name, 'card-img'));
            cell.addEventListener('mouseenter', () => preview.show(name));
            cell.addEventListener('click', () => { if (this.myPick) return; selected = name; draftBtn.disabled = false; for (const c of grid.children) c.classList.toggle('selected', c === cell); preview.show(name); });
            cell.addEventListener('dblclick', () => commit(name));
            grid.appendChild(cell);
          }
          draftBtn.disabled = !selected || !!this.myPick;
          autoBtn.disabled = !!this.myPick;
          if (pk.pack[0]) preview.show(pk.pack[0]);
        };
        const picksCols = h('div', { class: 'stack-columns mp-picks-cols' });
        const picksTitle = h('div', { class: 'titlebar' }, 'Your picks (' + pk.picks.length + ')');
        renderPack();
        root.appendChild(h('div', { class: 'screen mp-draft' }, header,
          h('div', { class: 'mp-draft-body' },
            h('div', { class: 'mp-draft-main' },
              h('div', { class: 'panel mp-packwrap' }, h('div', { class: 'titlebar' }, 'Booster — double-click a card to draft it'), grid, statusEl),
              h('div', { class: 'panel mp-pickswrap' }, picksTitle, picksCols)),
            h('div', { class: 'mp-draft-side' }, preview.el))));
        try { OF.Draft.renderStackColumns(picksCols, pk.picks, { mode: 'mv', onHover: (n) => preview.show(n) }); } catch (e) { picksCols.textContent = pk.picks.join(', '); }
        self.draftEls = { timerEl, statusEl, deadlineAt: pk.deadline ? Date.now() + pk.deadline : 0 };
        self.stopTimer();
        if (pk.deadline) {
          const tick = () => {
            const left = Math.max(0, Math.round((self.draftEls.deadlineAt - Date.now()) / 1000));
            timerEl.textContent = '⏱ ' + left + 's';
            timerEl.classList.toggle('urgent', left <= 5);
          };
          tick();
          self.timerId = setInterval(tick, 500);
        }
        const onKey = (e) => { if (e.key === 'Enter' && selected) commit(selected); };
        window.addEventListener('keydown', onKey);
        this.renderDraftStatus();
        return { destroy: () => { self.stopTimer(); window.removeEventListener('keydown', onKey); } };
      });
    }
    renderDraftStatus() {
      const els = this.draftEls;
      if (!els || this.screen !== 'draft') return;
      const v = this.view;
      let txt = '';
      if (this.myPick) {
        const waiting = v && v.draft ? v.draft.waiting : [];
        txt = 'You picked ' + this.myPick + '. ' + (waiting.length ? 'Waiting for: ' + waiting.join(', ') : 'Passing packs…');
      } else txt = 'Choose a card.' + (v && v.draft && v.draft.waiting.length > 1 ? ' Still picking: ' + v.draft.waiting.join(', ') : '');
      els.statusEl.textContent = txt;
    }

    // ------------------------------------------------------------- deck building
    showBuild() {
      this.screen = 'build';
      this.stopTimer();
      const self = this;
      this.app.show((root) => {
        const isSealed = this.view ? this.view.type === 'sealed' : false;
        const b = OF.DeckBuilder.mount(root, {
          mode: 'limited', pool: this.pool, deck: { main: this.deck || [] },
          title: (isSealed ? 'Sealed' : 'Booster Draft') + ' (online) — build 40+ cards',
          doneLabel: this.submitted ? 'Save deck ▶' : 'Submit deck ▶',
          onChange: (deck) => { self.deck = deck.main; },
          onBack: this.submitted ? (deck) => { self.deck = deck.main; self.showHub(); } : null,
          backLabel: 'Back to event',
          onDone: (deck) => { self.deck = deck.main; self.app.sendHost({ t: 'dsubmit', deck: deck.main }); },
        });
        return b;
      });
      if (!this.submitted && this.pool.length && this.view && this.view.type === 'sealed' && !this.shownPoolIntro) {
        this.shownPoolIntro = true;
        this.app.toast('You opened six boosters. Build a deck of at least 40 cards (Auto-build helps).', 4000);
      }
    }
    showBuildWait() {
      const { h } = OF.AppUtil;
      const v = this.view;
      if (v && v.stage !== 'building') { this.showHub(); return; }
      this.screen = 'buildwait';
      const waiting = v ? v.seats.filter(s => s.isHuman && s.connected && !s.submitted).map(s => s.name) : [];
      this.app.show((root) => {
        root.appendChild(h('div', { class: 'screen mp-screen' }, this.app.header('Deck submitted'),
          h('div', { class: 'match-center' }, h('div', { class: 'panel mp-box', 'data-mp': 'build-wait' }, h('div', { class: 'titlebar' }, 'Waiting for the other players'),
            h('p', {}, 'Your ' + this.deck.length + '-card deck was accepted.'),
            h('p', { class: 'dim' }, waiting.length ? 'Still building: ' + waiting.join(', ') : 'Everyone is ready — pairing round 1…'),
            h('div', { class: 'mbx-buttons' }, h('button', { onclick: () => this.showBuild() }, 'Edit deck'))))));
        return null;
      });
    }

    // ------------------------------------------------------------- hub
    showHub() {
      this.screen = 'hub';
      this.stopTimer();
      this.app.show((root) => {
        const { h } = OF.AppUtil;
        this.hubEl = h('div', { class: 'mp-hub-body' });
        root.appendChild(h('div', { class: 'screen mp-screen mp-hub' }, this.app.header((this.view && this.view.type === 'sealed' ? 'Sealed' : 'Booster Draft') + ' event (online)'), this.hubEl));
        this.renderHub();
        return null;
      });
    }
    renderHub() {
      const { h, clear } = OF.AppUtil;
      const v = this.view, el = this.hubEl;
      if (!el || !v) return;
      clear(el);
      const me = this.mySeat();
      const rd = v.rounds[v.rounds.length - 1];
      const name = (i) => (v.seats[i] ? v.seats[i].name : '?');
      // --- my status / actions
      const act = h('div', { class: 'panel mp-hub-me' }, h('div', { class: 'titlebar' }, v.stage === 'complete' ? 'Event complete' : rd ? 'Round ' + rd.number + ' of ' + v.totalRounds : 'Event'));
      const body = h('div', { class: 'mp-hub-mebody' });
      act.appendChild(body);
      if (v.stage === 'drafting') body.appendChild(h('p', {}, 'Drafting…'));
      else if (v.stage === 'building') {
        body.appendChild(h('p', {}, this.submitted ? 'Deck submitted. Waiting for the others.' : 'Build your deck.'));
        body.appendChild(h('button', { class: 'primary', onclick: () => this.showBuild() }, this.submitted ? 'Edit deck' : 'Build deck ▶'));
      } else if (v.stage === 'complete') {
        const row = v.standings.find(r => r.index === me);
        body.appendChild(h('div', { class: 'final-place ' + (row && row.rank === 1 ? 'win' : '') , 'data-mp': 'final-place' }, row ? 'You finished #' + row.rank + ' of ' + v.n : 'Final standings'));
        body.appendChild(h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', 'data-mp': 'event-lobby', onclick: () => this.app.leaveToLobby() }, 'Back to lobby')));
      } else if (rd) {
        const mm = rd.matches.find(m => m.a === me || m.b === me);
        if (mm) {
          const opp = mm.a === me ? mm.b : mm.a;
          const myW = mm.a === me ? mm.winsA : mm.winsB, opW = mm.a === me ? mm.winsB : mm.winsA;
          body.appendChild(h('div', { class: 'mp-hub-pair', 'data-mp': 'my-pairing' }, 'You vs ' + (opp === null || opp === undefined ? 'BYE' : name(opp)) + ' — ' + myW + '–' + opW + (mm.done ? ' (finished)' : '')));
          if (!mm.done && mm.kind === 'ai' && this.aiMatch && this.aiMatch.mid === mm.mid) {
            body.appendChild(h('button', { class: 'primary', 'data-mp': 'play-ai', onclick: () => this.playAiMatch() }, (this.aiMatch.match && this.aiMatch.match.games.length ? 'Resume' : 'Play') + ' match vs ' + this.aiMatch.opp.name + ' ▶'));
          } else if (!mm.done && mm.kind === 'live') body.appendChild(h('p', { class: 'dim' }, 'Live match in progress.'));
          else if (mm.done) body.appendChild(h('p', { class: 'dim' }, 'Waiting for the other tables…'));
        }
        if (v.roundDone && rd.number < v.totalRounds) {
          if (this.app.isHost) body.appendChild(h('button', { class: 'primary', 'data-mp': 'next-round', onclick: () => this.app.hostNextRound() }, 'Start round ' + (rd.number + 1) + ' ▶'));
          else body.appendChild(h('p', { class: 'dim' }, 'Round finished. The host starts the next round.'));
        }
        if (!(mm && !mm.done && (mm.kind === 'live'))) body.appendChild(h('button', { onclick: () => this.showBuild() }, 'Edit deck (sideboard)'));
      }
      // --- pairings
      const pair = h('div', { class: 'panel mp-hub-pairings' }, h('div', { class: 'titlebar' }, rd ? 'Round ' + rd.number + ' pairings' : 'Pairings'));
      if (rd) {
        const t = h('table', { class: 'mp-table' });
        for (const m of rd.matches) {
          const st = m.done ? (m.winner === 0 ? name(m.a) + ' wins' : m.winner === 1 ? name(m.b) + ' wins' : 'draw') : m.kind === 'live' ? 'playing (live)' : m.kind === 'ai' ? 'playing vs AI' : m.kind === 'sim' ? 'simulating…' : '…';
          t.appendChild(h('tr', { class: (m.a === me || m.b === me) ? 'me' : '' }, h('td', {}, name(m.a)), h('td', { class: 'mp-score' }, m.winsA + '–' + m.winsB), h('td', {}, m.b === null || m.b === undefined ? 'BYE' : name(m.b)), h('td', { class: 'dim' }, st)));
        }
        pair.appendChild(t);
      } else pair.appendChild(h('p', { class: 'dim mp-pad' }, 'Pairings appear once every deck is submitted.'));
      // --- standings
      const stand = h('div', { class: 'panel mp-hub-standings' }, h('div', { class: 'titlebar' }, v.stage === 'complete' ? 'Final standings' : 'Standings'));
      const t2 = h('table', { class: 'mp-table', 'data-mp': 'standings' }, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', {}, 'Pts'), h('th', {}, 'W-L-D'), h('th', {}, 'OMW'), h('th', {}, 'GW')));
      for (const r of v.standings) t2.appendChild(h('tr', { class: r.index === me ? 'me' : '' }, h('td', {}, String(r.rank)), h('td', {}, r.name + (v.seats[r.index] && v.seats[r.index].isHuman && !v.seats[r.index].connected ? ' (left)' : '')), h('td', {}, String(r.mp)), h('td', {}, r.mw + '-' + r.ml + '-' + r.md), h('td', {}, (r.omw * 100).toFixed(0) + '%'), h('td', {}, (r.gwp * 100).toFixed(0) + '%')));
      stand.appendChild(t2);
      // --- seats
      const seats = h('div', { class: 'panel mp-hub-seats' }, h('div', { class: 'titlebar' }, 'Players'));
      for (const s of v.seats) seats.appendChild(h('div', { class: 'mp-seat' + (s.seat === me ? ' me' : '') }, h('span', { class: 'mp-dot ' + (s.isHuman ? (s.connected ? 'on' : 'off') : 'ai') }), s.name, s.colors && s.colors.length ? h('span', { class: 'dim' }, '  ' + s.colors.map(c => COLOR_NAME[c] || c).join('/')) : null));
      el.append(h('div', { class: 'mp-hub-col' }, act, pair), h('div', { class: 'mp-hub-col' }, stand, seats));
    }

    // ------------------------------------------------------------- human vs AI match
    playAiMatch() {
      const am = this.aiMatch;
      if (!am) return;
      this.screen = 'aimatch';
      const match = am.match || (am.match = OF.Events.newMatch(0, 1));
      const self = this;
      this.app.show((root) => OF.Events.runMatch(root, {
        title: am.title + ' — vs ' + am.opp.name, you: { name: am.you.name, deck: (this.submitted && this.deck.length ? this.deck : am.you.deck).slice() }, opp: { name: am.opp.name, deck: am.opp.deck.slice() },
        oppInfo: am.opp.colors && am.opp.colors.length ? 'Opponent colours: ' + am.opp.colors.map(c => COLOR_NAME[c] || c).join('/') : '',
        match, bestOf: am.bestOf, aiLevel: am.aiLevel, aiDelayMs: (OF.AppUtil.getSettings().aiDelayMs), seedBase: 'mp-' + am.mid,
        onUpdate: (m) => self.app.sendHost({ t: 'mprog', mid: am.mid, winsA: m.winsA, winsB: m.winsB }),
        onComplete: (m) => { self.app.sendHost({ t: 'mresult', mid: am.mid, winsA: m.winsA, winsB: m.winsB, winner: m.winner, games: m.games.map(g => ({ winner: g.winner, reason: g.reason, turns: g.turns })) }); self.aiMatch = null; self.showHub(); },
        onQuit: () => self.showHub(),
        onSideboard: (m, resume) => {
          self.app.show((r2) => OF.DeckBuilder.mount(r2, { mode: 'limited', pool: self.pool, deck: { main: self.deck }, title: 'Sideboarding', doneLabel: 'Return to match ▶',
            onChange: (deck) => { self.deck = deck.main; },
            onDone: (deck) => { self.deck = deck.main; self.app.sendHost({ t: 'dsubmit', deck: deck.main }); self.playAiMatch(); } }));
          void resume;
        },
      }));
    }
    destroy() { this.stopTimer(); }
  }

  MP.EventHost = EventHost;
  MP.EventClient = EventClient;
  MP.simulateGameAsync = simulateGameAsync;
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
