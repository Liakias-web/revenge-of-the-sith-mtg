/* Revenge of the Sith events: Swiss pairings and standings, match bookkeeping, headless AI-vs-AI
 * simulation, and the match runner that hosts games in OF.UI.GameTable.
 * Attaches OF.Events. Logic is Node-safe; runMatch needs the DOM. */
(function (OF) {
  'use strict';

  const U = () => OF.AppUtil;

  // ------------------------------------------------------------------ matches
  function newMatch(a, b) { return { a, b, games: [], winsA: 0, winsB: 0, draws: 0, done: false, winner: null }; }
  function needed(bestOf) { return bestOf === 3 ? 2 : 1; }

  /** Record a game result. winner: 0 = side a, 1 = side b, -1 = draw. */
  function recordGame(match, winner, info, bestOf) {
    if (match.done) return match;
    match.games.push(Object.assign({ winner }, info || {}));
    if (winner === 0) match.winsA++;
    else if (winner === 1) match.winsB++;
    else match.draws++;
    const need = needed(bestOf);
    if (match.winsA >= need) { match.done = true; match.winner = 0; }
    else if (match.winsB >= need) { match.done = true; match.winner = 1; }
    else if (match.games.length >= (bestOf === 3 ? 5 : 3)) {
      match.done = true;
      match.winner = match.winsA > match.winsB ? 0 : match.winsB > match.winsA ? 1 : -1;
    }
    return match;
  }
  /** Who chooses play/draw for the next game: loser of the previous game (in match sides). */
  function nextChooser(match) {
    const last = match.games[match.games.length - 1];
    if (!last || last.winner === -1 || last.winner === undefined) return undefined;
    return 1 - last.winner;
  }

  // ------------------------------------------------------------------ Swiss
  function createEvent(cfg) {
    return {
      version: 1,
      id: cfg.id || ('ev' + Date.now().toString(36)),
      type: cfg.type,                       // 'draft' | 'sealed'
      seed: cfg.seed >>> 0,
      bestOf: cfg.bestOf === 3 ? 3 : 1,
      aiLevel: cfg.aiLevel || 'normal',
      totalRounds: cfg.totalRounds || 3,
      stage: cfg.stage || 'building',       // drafting | building | playing | roundDone | complete
      players: cfg.players || [],           // [{name, isHuman, pool:[names], deck:[names]}]
      humanIndex: cfg.humanIndex || 0,
      rounds: [],
      pod: cfg.pod || null,
      created: Date.now(),
    };
  }

  function standings(ev) {
    const rows = ev.players.map((p, i) => ({ index: i, name: p.name, isHuman: !!p.isHuman, mp: 0, mw: 0, ml: 0, md: 0, gw: 0, gp: 0, opps: [] }));
    for (const rd of ev.rounds) {
      for (const m of rd.matches) {
        if (m.b === null || m.b === undefined) { // bye
          rows[m.a].mp += 3; rows[m.a].mw++; rows[m.a].gw += 2; rows[m.a].gp += 2; continue;
        }
        if (!m.done) continue;
        const A = rows[m.a], B = rows[m.b];
        A.opps.push(m.b); B.opps.push(m.a);
        A.gw += m.winsA; B.gw += m.winsB;
        A.gp += m.games.length; B.gp += m.games.length;
        if (m.winner === 0) { A.mp += 3; A.mw++; B.ml++; }
        else if (m.winner === 1) { B.mp += 3; B.mw++; A.ml++; }
        else { A.mp++; B.mp++; A.md++; B.md++; }
      }
    }
    for (const r of rows) {
      const played = r.mw + r.ml + r.md;
      r.mwp = played ? Math.max(1 / 3, r.mp / (3 * played)) : 0;
      r.gwp = r.gp ? Math.max(1 / 3, r.gw / r.gp) : 0;
    }
    for (const r of rows) r.omw = r.opps.length ? r.opps.reduce((a, o) => a + rows[o].mwp, 0) / r.opps.length : 0;
    const sorted = rows.slice().sort((x, y) => y.mp - x.mp || y.omw - x.omw || y.gwp - x.gwp || x.index - y.index);
    sorted.forEach((r, i) => { r.rank = i + 1; });
    return sorted;
  }

  /** Create pairings for the next round and push it onto ev.rounds. */
  function pairNextRound(ev) {
    const n = ev.players.length;
    const r = ev.rounds.length;
    const matches = [];
    if (r === 0) {
      const half = n / 2;
      for (let i = 0; i < half; i++) matches.push(newMatch(i, i + half));
    } else {
      const st = standings(ev);
      const rng = OF.util.makeRng(U() ? U().hashSeed('swiss', ev.seed, r) : ev.seed + r);
      // shuffle within equal match points for variety
      const order = st.map(x => ({ i: x.index, mp: x.mp, k: rng() })).sort((a, b) => b.mp - a.mp || a.k - b.k).map(x => x.i);
      const played = new Set();
      for (const rd of ev.rounds) for (const m of rd.matches) if (m.b !== null) { played.add(m.a + '-' + m.b); played.add(m.b + '-' + m.a); }
      const res = pairBacktrack(order, played);
      for (const [a, b] of (res || greedy(order))) matches.push(newMatch(a, b));
    }
    // human always listed first in their match, as side a
    for (const m of matches) if (m.b === ev.humanIndex) { const t = m.a; m.a = m.b; m.b = t; }
    ev.rounds.push({ number: r + 1, matches });
    return ev.rounds[ev.rounds.length - 1];
  }
  function pairBacktrack(order, played) {
    if (!order.length) return [];
    const [first, ...rest] = order;
    for (let j = 0; j < rest.length; j++) {
      if (played.has(first + '-' + rest[j])) continue;
      const remaining = rest.slice(0, j).concat(rest.slice(j + 1));
      const sub = pairBacktrack(remaining, played);
      if (sub) return [[first, rest[j]]].concat(sub);
    }
    return null;
  }
  function greedy(order) { const out = []; for (let i = 0; i + 1 < order.length; i += 2) out.push([order[i], order[i + 1]]); return out; }

  function currentRound(ev) { return ev.rounds[ev.rounds.length - 1] || null; }
  function humanMatch(ev) { const rd = currentRound(ev); return rd ? rd.matches.find(m => m.a === ev.humanIndex || m.b === ev.humanIndex) : null; }

  // ------------------------------------------------------------------ headless simulation
  function fallbackDecide(g, d) {
    switch (d.type) {
      case 'playFirst': return { first: true };
      case 'mulligan': return { keep: true };
      case 'priority': {
        const land = d.actions.find(a => a.type === 'playLand');
        if (land) return { type: 'playLand', cardId: land.cardId };
        return { type: 'pass' };
      }
      case 'chooseTargets': {
        if (d.cancellable) return { cancel: true };
        const t = d.legal.slice(0, Math.max(d.min, 0));
        return { targets: t };
      }
      case 'chooseCards':
        if (d.cancellable && d.min === 0) return { cards: [] };
        return { cards: d.cards.slice(0, d.min) };
      case 'yesNo': return { yes: false };
      case 'chooseColor': return { color: d.colors[0] };
      case 'chooseOption': return { choice: d.options[0].id };
      case 'orderCards': return { order: d.cards.slice() };
      case 'payMana': return d.canAuto ? { type: 'auto' } : (d.cancellable ? { type: 'cancel' } : { type: 'auto' });
      case 'declareAttackers': return { attackers: d.attackTax > 0 ? [] : (d.mustAttack || []).slice() };   // "attacks each turn if able"
      case 'chooseNumber': return { number: d.min };
      case 'declareBlockers': {
        const blocks = [], used = new Set();
        for (const at of d.mustBeBlocked || []) {
          const b = Object.keys(d.candidates || {}).find(bid => !used.has(bid) && d.candidates[bid].includes(at));
          if (b !== undefined) { used.add(b); blocks.push({ blocker: Number(b), attacker: at }); }
        }
        return { blocks };
      }
    }
    return { type: 'pass' };
  }

  function strengthResult(deckA, deckB, rng) {
    const sA = OF.DeckTools.deckStrength(deckA), sB = OF.DeckTools.deckStrength(deckB);
    const pA = Math.max(0.15, Math.min(0.85, 0.5 + (sA - sB) * 0.35));
    return rng() < pA ? 0 : 1;
  }

  function adjudicate(g, deckA, deckB, rng) {
    const score = (p) => {
      let s = g.players[p].life;
      for (const id of g.battlefield) {
        const c = g.card(id);
        if (g.controllerOf(c) === p && g.isCreature(c)) s += g.power(c) * 0.8 + g.toughness(c) * 0.3;
      }
      s += g.players[p].hand.length * 0.8;
      return s;
    };
    const a = score(0), b = score(1);
    if (Math.abs(a - b) < 0.5) return strengthResult(deckA, deckB, rng);
    return a > b ? 0 : 1;
  }

  /**
   * Play one AI-vs-AI game headlessly. Returns {winner:0|1, turns, reason, simulated, adjudicated}.
   * Falls back to deck strength + randomness when OF.AI is missing or anything throws.
   */
  function simulateGame(deckA, deckB, opts) {
    opts = opts || {};
    const seed = (opts.seed >>> 0) || 1;
    const rng = OF.util.makeRng(seed ^ 0x5bd1e995);
    if (!OF.Game || !OF.AI || typeof OF.AI.createController !== 'function') {
      return { winner: strengthResult(deckA, deckB, rng), turns: 0, reason: 'estimated', simulated: false };
    }
    const budget = opts.timeBudgetMs || 2500;
    const t0 = Date.now();
    let g;
    try {
      g = new OF.Game({ seed, maxTurns: opts.maxTurns || 40, chooser: opts.chooser, players: [{ name: 'A', deck: deckA, ai: true }, { name: 'B', deck: deckB, ai: true }] });
      const ctrls = [OF.AI.createController({ level: opts.aiLevel || 'normal', seed: seed + 1 }), OF.AI.createController({ level: opts.aiLevel || 'normal', seed: seed + 2 })];
      g.start();
      let guard = 0;
      while (!g.over && g.decision) {
        if (++guard > 60000 || Date.now() - t0 > budget) {
          return { winner: adjudicate(g, deckA, deckB, rng), turns: g.turnNumber, reason: 'time', simulated: true, adjudicated: true };
        }
        const d = g.decision;
        let ans;
        try { ans = ctrls[d.player].decide(g, d); } catch (e) { ans = null; }
        let r = ans ? g.respond(ans) : { ok: false };
        if (!r.ok && g.decision === d) {
          r = g.respond(fallbackDecide(g, d));
          if (!r.ok && g.decision === d) r = g.respond({ type: 'concede' });
        }
      }
      if (g.winner === 0 || g.winner === 1) return { winner: g.winner, turns: g.turnNumber, reason: g.endReason, simulated: true };
      return { winner: adjudicate(g, deckA, deckB, rng), turns: g.turnNumber, reason: g.endReason || 'turn limit', simulated: true, adjudicated: true };
    } catch (e) {
      return { winner: strengthResult(deckA, deckB, rng), turns: g ? g.turnNumber : 0, reason: 'error', simulated: false, error: String(e && e.message || e) };
    }
  }

  /** Simulate the next game of an AI-vs-AI match (mutates match). */
  function simulateNextGame(ev, match, gameSeed) {
    const A = ev.players[match.a], B = ev.players[match.b];
    const chooser = nextChooser(match);
    const res = simulateGame(A.deck, B.deck, { seed: gameSeed, aiLevel: ev.aiLevel, chooser, timeBudgetMs: ev.simBudgetMs || 2500 });
    recordGame(match, res.winner, { turns: res.turns, reason: res.reason, sim: true }, ev.bestOf);
    return res;
  }

  /** Synchronously resolve every unfinished AI-vs-AI match of the current round. */
  function simulateRoundSync(ev) {
    const rd = currentRound(ev);
    rd.matches.forEach((m, mi) => {
      if (m.a === ev.humanIndex || m.b === ev.humanIndex) return;
      let k = 0;
      while (!m.done && k++ < 6) simulateNextGame(ev, m, U().hashSeed('sim', ev.seed, rd.number, mi, m.games.length));
    });
  }

  /** Asynchronously resolve AI-vs-AI matches (one game per tick). onProgress(text, fraction). */
  function simulateRoundAsync(ev, onProgress) {
    return new Promise((resolve) => {
      const rd = currentRound(ev);
      const todo = rd.matches.map((m, mi) => ({ m, mi })).filter(x => x.m.a !== ev.humanIndex && x.m.b !== ev.humanIndex);
      let idx = 0;
      const total = todo.length * ev.bestOf;
      let doneGames = 0;
      const step = () => {
        while (idx < todo.length && todo[idx].m.done) idx++;
        if (idx >= todo.length) { resolve(); return; }
        const { m, mi } = todo[idx];
        onProgress && onProgress(ev.players[m.a].name + ' vs ' + ev.players[m.b].name + ' — game ' + (m.games.length + 1), Math.min(1, doneGames / Math.max(1, total)));
        setTimeout(() => {
          simulateNextGame(ev, m, U().hashSeed('sim', ev.seed, rd.number, mi, m.games.length));
          doneGames++;
          step();
        }, 30);
      };
      step();
    });
  }

  // ------------------------------------------------------------------ match runner (DOM)
  /**
   * Host a match between the human (side a, player index 0 in each game) and an AI.
   * cfg: {title, you:{name, deck}, opp:{name, deck}, match, bestOf, aiLevel, aiDelayMs, seedBase,
   *       onUpdate(match), onComplete(match), onQuit(match), onSideboard(match, resume)}
   */
  function runMatch(container, cfg) {
    const { h, clear, modal } = U();
    const match = cfg.match || newMatch(0, 1);
    let table = null;
    let game = null;
    let recorded = false;
    let destroyed = false;
    const bar = h('div', { class: 'match-bar' });
    const host = h('div', { class: 'match-host' });
    const root = h('div', { class: 'screen match-screen' }, bar, host);
    clear(container).appendChild(root);

    const score = () => cfg.you.name + ' ' + match.winsA + '–' + match.winsB + ' ' + cfg.opp.name;

    function renderBar(inGame) {
      clear(bar);
      bar.append(h('span', { class: 'mb-title' }, cfg.title || 'Match'),
        h('span', { class: 'mb-score' }, 'Game ' + (match.games.length + (inGame ? 1 : 0) || 1) + ' · ' + score() + (cfg.bestOf === 3 ? ' (best of 3)' : '')),
        h('span', { class: 'flex1' }));
      if (inGame) {
        bar.append(h('button', { class: 'mini', onclick: () => confirmConcede(false) }, 'Concede game'));
        if (cfg.bestOf === 3) bar.append(h('button', { class: 'mini', onclick: () => confirmConcede(true) }, 'Concede match'));
      }
      bar.append(h('button', { class: 'mini', onclick: quit }, 'Leave (save)'));
    }

    function teardown() {
      if (table && typeof table.destroy === 'function') { try { table.destroy(); } catch (e) { /* ignore */ } }
      table = null;
      game = null;
      clear(host);
    }

    function quit() {
      const leave = () => { teardown(); destroyed = true; cfg.onQuit && cfg.onQuit(match); };
      if (game && !game.over && !recorded) {
        modal('Leave match?', h('p', {}, 'The game in progress will be lost, but the match score (' + score() + ') is saved. You can resume the event from the main menu and replay this game.'), [{ label: 'Leave', primary: true, onClick: leave }, { label: 'Stay' }]);
      } else leave();
    }

    function confirmConcede(wholeMatch) {
      modal(wholeMatch ? 'Concede match?' : 'Concede game?', h('p', {}, wholeMatch ? 'You will lose the match.' : 'You will lose this game.'), [{
        label: 'Concede', primary: true, onClick: () => {
          if (!game || recorded) return;
          const d = game.decision;
          if (!game.over) { try { if (game.concede) game.concede(0); else if (d && d.player === 0) game.respond({ type: 'concede' }); } catch (e) { /* ignore */ } }
          finishGame(1, 'conceded');
          if (wholeMatch) {
            while (!match.done) recordGame(match, 1, { reason: 'conceded' }, cfg.bestOf);
            cfg.onUpdate && cfg.onUpdate(match);
          }
        },
      }, { label: 'Cancel' }]);
    }

    function finishGame(winner, reason, viaTable) {
      if (recorded) return;
      recorded = true;
      recordGame(match, winner, { reason, turns: game ? game.turnNumber : 0 }, cfg.bestOf);
      cfg.onUpdate && cfg.onUpdate(match);
      if (table && viaTable && !match.done) { teardown(); showBetween(); return; }
      if (table) teardown();
      showResult(winner, reason);
    }

    function showResult(winner, reason) {
      renderBar(false);
      const msg = winner === 0 ? 'You won game ' + match.games.length + '.' : winner === 1 ? cfg.opp.name + ' won game ' + match.games.length + '.' : 'Game ' + match.games.length + ' was a draw.';
      const why = { life: 'life total reached 0', decking: 'drew from an empty library', conceded: 'concession', card: 'card effect', 'turn limit': 'turn limit' }[reason] || reason || '';
      const next = match.done ? (match.winner === 0 ? 'You won the match ' + match.winsA + '–' + match.winsB + '!' : match.winner === 1 ? 'You lost the match ' + match.winsA + '–' + match.winsB + '.' : 'The match is a draw.') : 'Match: ' + score() + '.';
      const btn = h('button', { class: 'primary', onclick: () => { teardown(); if (match.done) cfg.onComplete && cfg.onComplete(match); else showBetween(); } }, match.done ? 'Continue' : 'Next game');
      const overlay = h('div', { class: 'match-result ' + (winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw') }, h('div', { class: 'mr-head' }, msg), why ? h('div', { class: 'dim' }, '(' + why + ')') : null, h('div', { class: 'mr-next' }, next), btn);
      if (table) host.appendChild(overlay); else { clear(host); host.appendChild(h('div', { class: 'match-center' }, overlay)); }
      setTimeout(() => btn.focus(), 0);
    }

    function showBetween() {
      renderBar(false);
      clear(host);
      const chooser = nextChooser(match);
      const who = match.games.length === 0 ? 'A random player chooses whether to play or draw.' : chooser === 0 ? 'You lost the last game: you choose to play or draw.' : chooser === 1 ? cfg.opp.name + ' lost the last game and chooses to play or draw.' : 'A random player chooses whether to play or draw.';
      const box = h('div', { class: 'match-between panel' },
        h('div', { class: 'titlebar' }, cfg.title || 'Match'),
        h('div', { class: 'mbx-vs' }, h('div', { class: 'mbx-p' }, h('div', { class: 'mbx-name' }, cfg.you.name), h('div', { class: 'mbx-wins' }, String(match.winsA))), h('div', { class: 'mbx-sep' }, 'vs'), h('div', { class: 'mbx-p' }, h('div', { class: 'mbx-name' }, cfg.opp.name), h('div', { class: 'mbx-wins' }, String(match.winsB)))),
        h('div', { class: 'mbx-info' }, (cfg.bestOf === 3 ? 'Best of three' : 'Single game') + ' · Game ' + (match.games.length + 1) + ' · AI: ' + (cfg.aiLevel || 'normal')),
        lastGameLine() ? h('div', { class: 'mbx-info' }, lastGameLine()) : null,
        h('div', { class: 'mbx-info dim' }, who),
        cfg.oppInfo ? h('div', { class: 'mbx-info dim' }, cfg.oppInfo) : null,
        h('div', { class: 'mbx-buttons' },
          h('button', { class: 'primary', onclick: startGame }, match.games.length ? 'Start game ' + (match.games.length + 1) : 'Start match'),
          cfg.onSideboard ? h('button', { onclick: () => { teardown(); cfg.onSideboard(match, (deck) => { if (deck) cfg.you.deck = deck; if (!destroyed) runMatch(container, cfg); }); } }, match.games.length ? 'Sideboard' : 'Edit deck') : null,
          h('button', { onclick: quit }, 'Back to menu')));
      host.appendChild(h('div', { class: 'match-center' }, box));
    }

    function lastGameLine() {
      const last = match.games[match.games.length - 1];
      if (!last) return '';
      const who = last.winner === 0 ? cfg.you.name + ' won' : last.winner === 1 ? cfg.opp.name + ' won' : 'Draw in';
      return who + ' game ' + match.games.length + (last.reason ? ' (' + last.reason + (last.turns ? ', turn ' + last.turns : '') + ')' : '') + '.';
    }

    function startGame() {
      clear(host);
      recorded = false;
      const seed = U().hashSeed(cfg.seedBase || 'm', match.games.length, Date.now());
      const chooser = nextChooser(match);
      const opts = { seed, players: [{ name: cfg.you.name, deck: cfg.you.deck.slice() }, { name: cfg.opp.name, deck: cfg.opp.deck.slice(), ai: true }] };
      if (chooser !== undefined) opts.chooser = chooser;
      try { game = new OF.Game(opts); } catch (e) {
        host.appendChild(h('div', { class: 'match-center' }, h('div', { class: 'panel match-between' }, h('div', { class: 'titlebar' }, 'Could not start game'), h('p', {}, String(e && e.message || e)), h('button', { onclick: showBetween }, 'Back'))));
        return;
      }
      renderBar(true);
      const level = cfg.aiLevel || 'normal';
      let ai = null;
      if (OF.AI && typeof OF.AI.createController === 'function') { try { ai = OF.AI.createController({ level, seed: seed + 7 }); } catch (e) { ai = null; } }
      const g = game;
      OF.Events.activeGame = g; // debugging / test hook
      let tableEnded = false;
      const onEnd = () => {
        if (recorded || g !== game) return;
        const w = g.winner === 0 ? 0 : g.winner === 1 ? 1 : -1;
        finishGame(w, g.endReason, tableEnded);
      };
      if (OF.UI && OF.UI.GameTable && typeof OF.UI.GameTable.mount === 'function' && ai) {
        const tableHost = h('div', { class: 'match-table' });
        host.appendChild(tableHost);
        try {
          // The table drives the game (it calls game.start()) and shows its own end-of-game
          // box; its "Continue" button reports back through onGameEnd.
          table = OF.UI.GameTable.mount(tableHost, {
            game: g, humanIndex: 0, controllers: { 1: ai }, aiDelayMs: cfg.aiDelayMs, title: (cfg.title || 'Match') + ' — Game ' + (match.games.length + 1),
            matchInfo: { wins: [match.winsA, match.winsB], gameNumber: match.games.length + 1, bestOf: cfg.bestOf, score: score() },
            onGameEnd: () => setTimeout(() => { if (!g.over) return; tableEnded = true; onEnd(); }, 0),
          });
          OF.Events.activeTable = table; // test hook (table.table.act / humanDecision)
        } catch (e) {
          table = null;
          clear(host);
          host.appendChild(h('div', { class: 'match-center' }, h('div', { class: 'panel match-between' }, h('div', { class: 'titlebar' }, 'Game table error'), h('p', {}, String(e && e.message || e)), h('button', { onclick: () => finishGame(-1, 'error') }, 'Abandon game'))));
          return;
        }
      } else {
        // No game table (or no AI) available: offer an automatic simulation instead.
        const why = !(OF.UI && OF.UI.GameTable) ? 'The game table UI (js/ui/game-table.js) is not available in this build.' : 'The AI module (js/ai/ai.js) is not available in this build.';
        host.appendChild(h('div', { class: 'match-center' }, h('div', { class: 'panel match-between' }, h('div', { class: 'titlebar' }, 'Game table unavailable'), h('p', {}, why), h('p', { class: 'dim' }, 'You can let the computer play this game for you (both sides automated) to keep the event moving.'),
          h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', onclick: () => { const res = simulateGame(cfg.you.deck, cfg.opp.deck, { seed, aiLevel: level, chooser }); finishGame(res.winner, res.reason || 'simulated'); } }, 'Simulate game'), h('button', { onclick: showBetween }, 'Back')))));
      }
    }

    if (match.done) { renderBar(false); showResult(match.games.length ? match.games[match.games.length - 1].winner : -1, ''); }
    else showBetween();
    return { destroy() { destroyed = true; teardown(); }, match };
  }

  OF.Events = {
    newMatch, recordGame, nextChooser, createEvent, standings, pairNextRound, currentRound, humanMatch,
    simulateGame, simulateNextGame, simulateRoundSync, simulateRoundAsync, fallbackDecide, strengthResult, runMatch,
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
