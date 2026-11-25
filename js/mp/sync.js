/* Old Republic lockstep multiplayer games.
 *
 * Both players' clients build the same OF.Game (same seed from the host, same decks, same
 * player order) and only exchange answers to decisions. Each client answers its own
 * seat's decisions through OF.UI.GameTable; the opponent's seat is a `remote` controller
 * whose answers arrive over the network. Every relayed answer carries a checksum of the
 * state at which the decision was asked; a mismatch aborts the game as a draw.
 *
 *   OF.MP.Lockstep      core, Node-safe (tests drive two games through it)
 *   OF.MP.MatchHost     host-side match coordinator (Bo1/Bo3, seeds, results, forfeits)
 *   OF.MP.mountLiveMatch(container, cfg)   client-side match screen (DOM)
 */
(function (OF) {
  'use strict';
  const MP = OF.MP = OF.MP || {};
  const P = () => MP.Proto;

  // ======================================================================== Lockstep core
  /**
   * opts: {game, seat (local player index), gid, send(msg) -> to the opponent,
   *        onDesync(info), onGameOver(result), onRemoteConcede(seat)}
   * Call lock.localAnswer(d, ans) for every accepted local answer (GameTable onLocalAnswer),
   * lock.receive(msg) for every incoming ans/concede/desync message of this game, and give
   * lock.remoteController to the table as the opponent's controller.
   */
  class Lockstep {
    constructor(opts) {
      this.g = opts.game;
      this.seat = opts.seat;
      this.gid = opts.gid;
      this.sendFn = opts.send;
      this.opts = opts;
      this.defer = opts.defer || function (fn) { setTimeout(fn, 0); };
      this.pre = new Map();       // decision id -> checksum of the state when it was asked
      this.buffer = new Map();    // decision id -> early 'ans' message
      this.waiter = null;         // {d, cb}
      this.lastSeen = 0;
      this.failed = null;
      this.ended = false;
      this.disposed = false;
      this.sent = 0; this.applied = 0;
      this.log = [];              // [{did, seat, ans}] (debugging, rejoin)
      const self = this;
      this.g.onChange(function () { if (!self.disposed) self._observe(); });
      this._observe();
      this.remoteController = {
        remote: true,
        wait(game, d, cb) { self._wait(d, cb); },
      };
    }

    _observe() {
      const d = this.g.decision;
      if (d && d.id > this.lastSeen) {
        this.lastSeen = d.id;
        this.pre.set(d.id, P().checksum(this.g));
        if (this.pre.size > 400) { for (const k of this.pre.keys()) { if (k < d.id - 300) this.pre.delete(k); else break; } }
      }
      if (this.g.over && !this.ended) {
        this.ended = true;
        const res = { gid: this.gid, winner: this.g.winner === 0 || this.g.winner === 1 ? this.g.winner : -1, reason: this.g.endReason || '', turns: this.g.turnNumber, ck: P().checksum(this.g) };
        if (this.g.crash) res.reason = 'engine error';
        const cb = this.opts.onGameOver;
        if (cb) this.defer(() => { if (!this.disposed) cb(res); });
      }
    }

    /** Local human answered decision d (already applied to our game). */
    localAnswer(d, ans) {
      if (this.disposed || this.failed) return;
      if (d.player !== this.seat) return; // only our own seat's answers are relayed
      const ck = this.pre.has(d.id) ? this.pre.get(d.id) : '';
      const msg = { t: 'ans', gid: this.gid, did: d.id, dt: d.type, dp: d.player, ck, ans: stripAnswer(ans) };
      this.log.push({ did: d.id, seat: d.player, ans: msg.ans });
      this.sent++;
      this.sendFn(msg);
    }

    localConcede(seat) {
      if (this.disposed) return;
      this.sendFn({ t: 'concede', gid: this.gid, seat: typeof seat === 'number' ? seat : this.seat });
    }

    /** Feed a network message. Returns true when it belonged to this game. */
    receive(msg) {
      if (!msg || msg.gid !== this.gid || this.disposed) return false;
      if (msg.t === 'ans') {
        if (this.failed) return true;
        if (this.waiter && this.waiter.d.id === msg.did) { const w = this.waiter; this.waiter = null; this._apply(w.d, w.cb, msg); }
        else if (this.g.decision && msg.did < this.g.decision.id && !this.buffer.has(msg.did)) { /* duplicate of an applied answer */ }
        else this.buffer.set(msg.did, msg);
        return true;
      }
      if (msg.t === 'concede') {
        if (!this.g.over && typeof this.g.concede === 'function') {
          const seat = msg.seat === 0 || msg.seat === 1 ? msg.seat : 1 - this.seat;
          this.g.concede(seat);
          if (this.opts.onRemoteConcede) this.opts.onRemoteConcede(seat);
        }
        return true;
      }
      if (msg.t === 'desync') { this.fail('Your opponent\'s client reported that the game went out of sync (' + (msg.why || 'checksum mismatch') + ').', true); return true; }
      return false;
    }

    _wait(d, cb) {
      if (this.disposed || this.failed) return;
      const m = this.buffer.get(d.id);
      if (m) {
        this.buffer.delete(d.id);
        this.defer(() => this._apply(d, cb, m));
        return;
      }
      this.waiter = { d, cb };
    }

    _apply(d, cb, msg) {
      if (this.disposed || this.failed) return;
      if (this.g.decision !== d) return; // game moved on (concession / end)
      const mine = this.pre.get(d.id);
      if (msg.dt !== d.type || msg.dp !== d.player) {
        this.fail('decision mismatch at #' + d.id + ': expected ' + d.type + ' for player ' + (d.player + 1) + ', opponent answered ' + msg.dt + ' for player ' + (msg.dp + 1));
        return;
      }
      if (msg.ck && mine && msg.ck !== mine) {
        this.fail('state checksum mismatch at decision #' + d.id + ' (' + d.type + ')');
        return;
      }
      this.log.push({ did: d.id, seat: d.player, ans: msg.ans });
      this.applied++;
      cb(msg.ans);
    }

    /** Abort: the game is out of sync. */
    fail(why, fromRemote) {
      if (this.failed || this.disposed) return;
      this.failed = why;
      this.waiter = null;
      if (!fromRemote) this.sendFn({ t: 'desync', gid: this.gid, did: this.g.decision ? this.g.decision.id : 0, why });
      if (this.opts.onDesync) this.opts.onDesync({ gid: this.gid, why, fromRemote: !!fromRemote, ck: P().checksum(this.g) });
    }

    dispose() { this.disposed = true; this.waiter = null; this.buffer.clear(); }
  }

  /** JSON-safe copy of an answer (drops labels and anything non-serializable). */
  function stripAnswer(ans) {
    if (!ans || typeof ans !== 'object') return ans;
    const out = JSON.parse(JSON.stringify(ans));
    if (out && typeof out === 'object') delete out.label;
    return out;
  }

  // ======================================================================== host coordinator
  function newMatch() { return OF.Events && OF.Events.newMatch ? OF.Events.newMatch(0, 1) : { a: 0, b: 1, games: [], winsA: 0, winsB: 0, draws: 0, done: false, winner: null }; }
  function recordGame(m, winner, info, bestOf) {
    if (OF.Events && OF.Events.recordGame) return OF.Events.recordGame(m, winner, info, bestOf);
    if (m.done) return m;
    m.games.push(Object.assign({ winner }, info || {}));
    if (winner === 0) m.winsA++; else if (winner === 1) m.winsB++; else m.draws++;
    const need = bestOf === 3 ? 2 : 1;
    if (m.winsA >= need) { m.done = true; m.winner = 0; } else if (m.winsB >= need) { m.done = true; m.winner = 1; }
    else if (m.games.length >= (bestOf === 3 ? 5 : 3)) { m.done = true; m.winner = m.winsA > m.winsB ? 0 : m.winsB > m.winsA ? 1 : -1; }
    return m;
  }
  function nextChooser(m) {
    if (OF.Events && OF.Events.nextChooser) return OF.Events.nextChooser(m);
    const last = m.games[m.games.length - 1];
    if (!last || last.winner === -1 || last.winner === undefined) return undefined;
    return 1 - last.winner;
  }

  /**
   * Host side of one human-vs-human match.
   * opts: {mid, peers:[peerA, peerB], players:[{name, deck}, {name, deck}], bestOf, title,
   *        send(to, msg), onUpdate(match), onDone(match), resultTimeoutMs}
   */
  class MatchHost {
    constructor(opts) {
      this.opts = opts;
      this.mid = opts.mid;
      this.peers = opts.peers.slice();
      this.bestOf = opts.bestOf === 3 ? 3 : 1;
      this.match = opts.match || newMatch();
      this.ready = [false, false];
      this.game = null;    // {gno, gid, seed, chooser, results:[r0, r1]}
      this.finished = false;
    }
    _send(side, msg) { this.opts.send(this.peers[side], msg); }
    _both(msg) { this._send(0, msg); this._send(1, msg); }
    start() {
      for (const side of [0, 1]) this._send(side, this.startMsg(side));
    }
    startMsg(side) {
      return { t: 'mstart', mid: this.mid, side, bestOf: this.bestOf, title: this.opts.title || 'Match', oppPeer: this.peers[1 - side],
        players: this.opts.players.map(p => ({ name: p.name, deck: p.deck.slice() })), match: P().summarizeMatch(this.match) };
    }
    /** Re-send the current state to a reconnected player (new peer id). */
    rebind(side, peer) {
      this.peers[side] = peer;
      this._send(side, this.startMsg(side));
      this._send(1 - side, { t: 'mpeer', mid: this.mid, oppPeer: peer });
    }
    sideOf(peer) { return this.peers.indexOf(peer); }
    handle(from, msg) {
      if (!msg || msg.mid !== this.mid || this.finished) return false;
      const side = this.sideOf(from);
      if (side < 0) return true;
      if (msg.t === 'gready') {
        if (this.game) return true;
        this.ready[side] = true;
        this._both({ t: 'mstatus', mid: this.mid, ready: this.ready.slice() });
        if (this.ready[0] && this.ready[1]) this.startGame();
        return true;
      }
      if (msg.t === 'gresult') {
        const gm = this.game;
        if (!gm || msg.gid !== gm.gid) return true;
        gm.results[side] = { winner: msg.winner, reason: msg.reason || '', turns: msg.turns || 0, ck: msg.ck };
        if (msg.reason === 'desync' || (gm.results[0] && gm.results[1])) this.finishGame();
        else if (!gm.timer) gm.timer = setTimeout(() => { if (this.game === gm) this.finishGame(); }, this.opts.resultTimeoutMs || 20000);
        return true;
      }
      if (msg.t === 'mconcede') { this.forfeit(side, 'conceded the match'); return true; }
      return false;
    }
    startGame() {
      const gno = this.match.games.length + 1;
      const chooser = nextChooser(this.match);
      this.game = { gno, gid: this.mid + '.g' + gno + '.' + P().randomSeed().toString(36), seed: P().randomSeed(), chooser, results: [null, null], timer: null };
      this.ready = [false, false];
      this._both({ t: 'gstart', mid: this.mid, gno, gid: this.game.gid, seed: this.game.seed, chooser: chooser === undefined ? null : chooser });
    }
    finishGame() {
      const gm = this.game;
      if (!gm) return;
      clearTimeout(gm.timer);
      this.game = null;
      const [r0, r1] = gm.results;
      let winner, reason, note = '';
      const rs = [r0, r1].filter(Boolean);
      if (rs.some(r => r.reason === 'desync')) { winner = -1; reason = 'desync'; note = 'The game went out of sync and is recorded as a draw.'; }
      else if (r0 && r1 && r0.winner !== r1.winner) { winner = -1; reason = 'desync'; note = 'The two clients disagree about the result; recorded as a draw.'; }
      else { const r = r0 || r1; winner = r.winner; reason = r.reason; }
      const turns = Math.max(r0 ? r0.turns : 0, r1 ? r1.turns : 0);
      recordGame(this.match, winner, { reason, turns }, this.bestOf);
      this._update(note);
    }
    _update(note, extra) {
      const msg = Object.assign({ t: 'mupdate', mid: this.mid, match: P().summarizeMatch(this.match), done: !!this.match.done, note: note || '' }, extra || {});
      this._both(msg);
      if (this.opts.onUpdate) this.opts.onUpdate(this.match);
      if (this.match.done && !this.finished) { this.finished = true; if (this.opts.onDone) this.opts.onDone(this.match); }
    }
    /** side loses the rest of the match (disconnect / concession). */
    forfeit(side, why) {
      if (this.finished) return;
      if (this.game) { clearTimeout(this.game.timer); this.game = null; }
      let guard = 0;
      while (!this.match.done && guard++ < 6) recordGame(this.match, 1 - side, { reason: 'forfeit' }, this.bestOf);
      const name = this.opts.players[side].name;
      this._update(name + ' ' + (why || 'left the game') + '.', { abort: true, forfeitSide: side });
    }
    peerLeft(peer) { const side = this.sideOf(peer); if (side >= 0) this.forfeit(side, 'disconnected'); }
  }

  // ======================================================================== client match screen
  /**
   * cfg: {ctx: {myId, send(to,msg), sendHost(msg)}, start: mstart message, onDone(summary),
   *       chatSlot(el)?}  Returns {handle(from, msg) -> bool, destroy()}.
   */
  function mountLiveMatch(container, cfg) {
    const A = OF.AppUtil;
    const { h, clear } = A;
    const st = cfg.start;
    const side = st.side, opp = 1 - side;
    let oppPeer = st.oppPeer;
    const names = st.players.map(p => p.name);
    let match = st.match || { winsA: 0, winsB: 0, games: [], done: false, winner: null };
    let ready = [false, false];
    let cur = null;          // {gid, gno, game, lock, table, over, result, desync}
    let pendingUpdate = null;
    let destroyed = false;
    let finished = false;

    const bar = h('div', { class: 'match-bar mp-matchbar' });
    const host = h('div', { class: 'match-host' });
    const root = h('div', { class: 'screen match-screen mp-match' }, bar, host);
    clear(container).appendChild(root);

    const wins = () => [match.winsA, match.winsB];
    const score = () => names[side] + ' ' + wins()[side] + '–' + wins()[opp] + ' ' + names[opp];

    function renderBar(inGame) {
      clear(bar);
      bar.append(h('span', { class: 'mb-title' }, st.title || 'Match'),
        h('span', { class: 'mb-score' }, 'vs ' + names[opp] + ' · ' + score() + (st.bestOf === 3 ? ' (best of 3)' : '')),
        h('span', { class: 'flex1' }));
      if (st.bestOf === 3 && !match.done) bar.append(h('button', { class: 'mini', 'data-mp': 'concede-match', onclick: confirmConcedeMatch }, 'Concede match'));
      if (inGame) bar.append(h('span', { class: 'dim mp-small' }, 'Use the table\'s Concede button to concede this game.'));
    }

    function confirmConcedeMatch() {
      A.modal('Concede the match?', h('p', {}, 'You will lose the match against ' + names[opp] + '.'), [
        { label: 'Concede match', primary: true, onClick: () => {
          if (cur && cur.game && !cur.game.over) { try { cur.lock.localConcede(side); cur.game.concede(side); } catch (e) { /* ignore */ } }
          cfg.ctx.sendHost({ t: 'mconcede', mid: st.mid });
        } }, { label: 'Cancel' }]);
    }

    function teardownGame() {
      if (cur) {
        if (cur.lock) cur.lock.dispose();
        if (cur.table) { try { cur.table.destroy(); } catch (e) { /* ignore */ } }
      }
      cur = null;
      clear(host);
    }

    function lastLine() {
      const g = match.games[match.games.length - 1];
      if (!g) return '';
      const who = g.winner === side ? 'You won' : g.winner === opp ? names[opp] + ' won' : 'Draw in';
      return who + ' game ' + match.games.length + (g.reason ? ' (' + g.reason + (g.turns ? ', turn ' + g.turns : '') + ')' : '') + '.';
    }

    function showBetween(note) {
      if (destroyed) return;
      teardownGame();
      renderBar(false);
      const gno = match.games.length + 1;
      const chooser = nextChooser({ games: match.games });
      const who = match.games.length === 0 ? 'A random player chooses whether to play or draw.' : chooser === side ? 'You lost the last game: you choose to play or draw.' : chooser === opp ? names[opp] + ' lost the last game and chooses to play or draw.' : 'A random player chooses whether to play or draw.';
      const readyBtn = h('button', { class: 'primary', 'data-mp': 'ready', onclick: () => { readyBtn.disabled = true; readyBtn.textContent = 'Waiting for ' + names[opp] + '…'; cfg.ctx.sendHost({ t: 'gready', mid: st.mid, gno }); } }, match.games.length ? 'Ready for game ' + gno : 'Ready — start match');
      if (ready[side]) { readyBtn.disabled = true; readyBtn.textContent = 'Waiting for ' + names[opp] + '…'; }
      const oppState = h('div', { class: 'mbx-info dim mp-oppready' }, ready[opp] ? names[opp] + ' is ready.' : names[opp] + ' is not ready yet.');
      const box = h('div', { class: 'match-between panel mp-between' },
        h('div', { class: 'titlebar' }, (st.title || 'Match') + ' — online'),
        h('div', { class: 'mbx-vs' },
          h('div', { class: 'mbx-p' }, h('div', { class: 'mbx-name' }, names[side] + ' (you)'), h('div', { class: 'mbx-wins' }, String(wins()[side]))),
          h('div', { class: 'mbx-sep' }, 'vs'),
          h('div', { class: 'mbx-p' }, h('div', { class: 'mbx-name' }, names[opp]), h('div', { class: 'mbx-wins' }, String(wins()[opp])))),
        h('div', { class: 'mbx-info' }, (st.bestOf === 3 ? 'Best of three' : 'Single game') + ' · Game ' + gno),
        lastLine() ? h('div', { class: 'mbx-info' }, lastLine()) : null,
        note ? h('div', { class: 'mbx-info mp-note' }, note) : null,
        h('div', { class: 'mbx-info dim' }, who),
        oppState,
        h('div', { class: 'mbx-buttons' }, readyBtn));
      host.appendChild(h('div', { class: 'match-center' }, box));
    }

    function showDone(note) {
      if (destroyed) return;
      teardownGame();
      finished = true;
      renderBar(false);
      const won = match.winner === side, lost = match.winner === opp;
      const box = h('div', { class: 'match-between panel mp-between' },
        h('div', { class: 'titlebar' }, (st.title || 'Match') + ' — result'),
        h('div', { class: 'final-place ' + (won ? 'win' : lost ? 'loss' : 'draw') }, won ? 'Victory' : lost ? 'Defeat' : 'Draw'),
        h('div', { class: 'mbx-info mp-final-score' }, score()),
        note ? h('div', { class: 'mbx-info mp-note' }, note) : null,
        lastLine() ? h('div', { class: 'mbx-info dim' }, lastLine()) : null,
        h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', 'data-mp': 'match-continue', onclick: () => cfg.onDone && cfg.onDone(match) }, 'Continue')));
      host.appendChild(h('div', { class: 'match-center' }, box));
    }

    function overlay(title, text, btnLabel, fn) {
      const o = h('div', { class: 'mp-overlay' }, h('div', { class: 'panel mp-overlay-box' }, h('div', { class: 'titlebar' }, title), h('div', { class: 'mp-overlay-text' }, text),
        h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', 'data-mp': 'overlay-ok', onclick: () => { o.remove(); fn && fn(); } }, btnLabel || 'Continue'))));
      root.appendChild(o);
      return o;
    }

    function afterGame() {
      // The table's "Continue" (or a desync / abort) — move on once the host recorded the result.
      if (pendingUpdate) { const u = pendingUpdate; pendingUpdate = null; applyUpdate(u); return; }
      if (!cur) return; // already moved on (result arrived meanwhile)
      teardownGame();
      host.appendChild(h('div', { class: 'match-center' }, h('div', { class: 'panel match-between mp-between mp-waitresult' }, h('div', { class: 'titlebar' }, 'Game over'), h('div', { class: 'mbx-info' }, 'Waiting for the host to record the result…'))));
      waitingForUpdate = true;
    }
    let waitingForUpdate = false;

    function applyUpdate(u) {
      match = u.match;
      waitingForUpdate = false;
      if (u.done) showDone(u.note); else showBetween(u.note);
    }

    function startGame(m) {
      teardownGame();
      renderBar(true);
      const opts = { seed: m.seed, players: st.players.map(p => ({ name: p.name, deck: p.deck.slice() })) };
      if (m.chooser === 0 || m.chooser === 1) opts.chooser = m.chooser;
      let game;
      try { game = new OF.Game(opts); } catch (e) {
        cfg.ctx.sendHost({ t: 'gresult', mid: st.mid, gno: m.gno, gid: m.gid, winner: -1, reason: 'desync', turns: 0, ck: '' });
        overlay('Could not start the game', String(e && e.message || e), 'OK', () => {});
        return;
      }
      const c = cur = { gid: m.gid, gno: m.gno, game, lock: null, table: null, over: false };
      const sendOpp = (msg) => cfg.ctx.send(oppPeer, msg);
      c.lock = new Lockstep({
        game, seat: side, gid: m.gid, send: sendOpp,
        onGameOver: (res) => {
          if (cur !== c || c.desync) return;
          c.over = true;
          cfg.ctx.sendHost({ t: 'gresult', mid: st.mid, gno: m.gno, gid: m.gid, winner: res.winner, reason: res.reason, turns: res.turns, ck: res.ck });
        },
        onDesync: (info) => {
          if (cur !== c || c.desync) return;
          c.desync = info.why;
          cfg.ctx.sendHost({ t: 'gresult', mid: st.mid, gno: m.gno, gid: m.gid, winner: -1, reason: 'desync', turns: game.turnNumber, ck: info.ck });
          console.warn('[MP] desync', info);
          overlay('Game out of sync', 'The two clients no longer agree about the game state (' + info.why + '). This game is recorded as a draw.', 'Continue', afterGame);
        },
      });
      MP.activeGame = game; MP.activeLock = c.lock; // test / debugging hooks
      const tableHost = h('div', { class: 'match-table' });
      host.appendChild(tableHost);
      try {
        c.table = OF.UI.GameTable.mount(tableHost, {
          game, humanIndex: side, controllers: { [opp]: c.lock.remoteController }, aiDelayMs: 0,
          title: (st.title || 'Match') + ' — Game ' + m.gno + ' · vs ' + names[opp] + ' (online)',
          matchInfo: { wins: wins(), gameNumber: m.gno, bestOf: st.bestOf, score: score() },
          onLocalAnswer: (d, ans) => c.lock.localAnswer(d, ans),
          onConcede: (seat) => c.lock.localConcede(seat),
          onDesync: (err) => c.lock.fail('the opponent\'s answer was rejected by the rules engine: ' + err),
          onGameEnd: () => setTimeout(() => { if (cur === c) afterGame(); }, 0),
        });
        MP.activeTable = c.table;
      } catch (e) {
        console.error(e);
        c.lock.fail('game table error: ' + (e && e.message || e));
      }
    }

    showBetween();

    return {
      mid: st.mid,
      handle(from, msg) {
        if (destroyed || !msg) return false;
        if ((msg.t === 'ans' || msg.t === 'concede' || msg.t === 'desync') && cur && cur.lock && msg.gid === cur.gid) { cur.lock.receive(msg); return true; }
        if (msg.mid !== st.mid) return false;
        switch (msg.t) {
          case 'mstatus':
            ready = msg.ready || ready;
            if (!cur && !finished) { const el = host.querySelector('.mp-oppready'); if (el) el.textContent = ready[opp] ? names[opp] + ' is ready.' : names[opp] + ' is not ready yet.'; }
            return true;
          case 'mpeer': oppPeer = msg.oppPeer; return true;
          case 'gstart': ready = [false, false]; startGame(msg); return true;
          case 'mupdate': {
            if (msg.abort && cur && cur.game && !cur.over) {
              // Opponent left / conceded the match while a game was running.
              match = msg.match;
              const c = cur;
              if (c.lock) c.lock.dispose();
              overlay(msg.done ? 'Match over' : 'Game over', msg.note || 'The game was ended by the host.', 'Continue', () => { if (cur === c) applyUpdate(msg); });
              return true;
            }
            if (cur && cur.game && !waitingForUpdate && !cur.desync) { pendingUpdate = msg; match = msg.match; return true; } // table end screen still showing
            applyUpdate(msg);
            return true;
          }
        }
        return false;
      },
      destroy() { destroyed = true; teardownGame(); },
      get game() { return cur && cur.game; },
    };
  }

  MP.Lockstep = Lockstep;
  MP.MatchHost = MatchHost;
  MP.mountLiveMatch = mountLiveMatch;
  MP.stripAnswer = stripAnswer;
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
