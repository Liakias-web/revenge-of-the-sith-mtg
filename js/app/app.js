/* Revenge of the Sith application shell: main menu, Draft / Sealed events (3 Swiss rounds vs AI),
 * Theme Deck Duel, constructed Deck Editor, Card Gallery, Rules & Set Guide, Settings, Multiplayer.
 * Attaches OF.App and starts on DOMContentLoaded. */
(function (OF) {
  'use strict';
  if (typeof document === 'undefined') return;

  const EVENT_KEY = 'rots.event';
  const WIP_DECK_KEY = 'rots.editorDeck';
  const LAST_THEME_KEY = 'rots.lastTheme';
  const DECKS_KEY = 'rots.decks';
  const COLOR_NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

  let root = null;
  let current = null; // {destroy()} of the active screen

  const A = () => OF.AppUtil;

  function show(fn) {
    if (current && typeof current.destroy === 'function') { try { current.destroy(); } catch (e) { console.error(e); } }
    current = null;
    window.scrollTo(0, 0);
    A().clear(root);
    current = fn() || null;
  }

  function header(title, opts) {
    const { h } = A();
    opts = opts || {};
    return h('div', { class: 'screen-header' },
      h('button', { class: 'back-btn', onclick: opts.onBack || menu }, '◀ Menu'),
      h('span', { class: 'dv-title' }, title),
      opts.extra || null, h('span', { class: 'flex1' }), opts.right || null);
  }

  // ======================================================================= MENU
  function loadEvent() {
    const ev = A().storeGet(EVENT_KEY, null);
    return ev && ev.version === 1 && Array.isArray(ev.players) ? ev : null;
  }
  function saveEvent(ev) { A().storeSet(EVENT_KEY, ev); }

  function setCounts() {
    const r = { C: 0, U: 0, R: 0, M: 0 };
    for (const c of OF.CARD_DATA || []) if (r[c.rarity] !== undefined) r[c.rarity]++;
    const basics = (OF.BASIC_LAND_DATA || []).length;
    const dfc = (OF.CARD_DATA || []).filter(c => c.dfc).length;
    const paintings = (OF.BASIC_LAND_DATA || []).reduce((a, b) => a + ((b.variants && b.variants.length) || 1), 0);
    return { total: (OF.CARD_DATA || []).length + basics, nonbasic: (OF.CARD_DATA || []).length, basics, dfc, faces: (OF.CARD_DATA || []).length + basics + dfc,
      C: r.C, U: r.U, R: r.R, M: r.M, tokens: (OF.TOKEN_DATA || []).length, paintings, themes: (OF.THEME_DECKS || []).length };
  }
  const NUM_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  function menu() {
    show(() => {
      const { h } = A();
      const ev = loadEvent();
      const st = A().getSettings();
      const n = setCounts();
      const item = (id, title, sub, onclick, cls) => h('button', { class: 'menu-item ' + (cls || ''), 'data-menu': id, onclick }, h('span', { class: 'mi-title' }, title), h('span', { class: 'mi-sub' }, sub));
      const items = [];
      if (ev && ev.stage !== 'complete') {
        items.push(item('resume', 'Resume event', describeEvent(ev), () => resumeEvent(ev), 'resume'));
      }
      items.push(
        item('draft', 'Booster Draft', '8-player pod (you + 7 AI) · 3 Revenge of the Sith boosters · 3 Swiss rounds', () => confirmReplaceEvent(startDraft)),
        item('sealed', 'Sealed Deck', '6 Revenge of the Sith boosters · build 40 cards · 3 Swiss rounds', () => confirmReplaceEvent(startSealed)),
        item('theme', 'Theme Deck Duel', 'Pick one of the ' + (NUM_WORD[n.themes] || n.themes) + ' 60-card theme decks and face the AI', themeDuel),
        item('multiplayer', 'Multiplayer', 'Play friends on your LAN or online with invite codes: duels, draft, sealed', multiplayer, 'mp-entry'),
        item('editor', 'Deck Editor', 'Build and save constructed decks from the full set; play them against the AI', deckEditor),
        item('gallery', 'Card Gallery', 'Browse all ' + n.total + ' cards (' + n.faces + ' faces): both sides of the ' + n.dfc + ' double-faced cards, and the tokens', gallery),
        item('rules', 'Rules & Set Guide', 'Compromise, Force counters, Attunement, Afterimage, Turning to the Dark Side, coalitions, ten lanes, hotkeys', rules),
        item('settings', 'Settings', 'AI difficulty, match format, AI speed, auto-tap', settings),
      );
      const titleBlock = h('div', { class: 'menu-title' },
        h('img', { class: 'menu-emblem', src: 'assets/ui/emblem.png', alt: '' }),
        h('div', { class: 'menu-titletext' },
          h('div', { class: 'menu-pre' }, 'Revenge of'),
          h('div', { class: 'menu-set' }, 'THE SITH'),
          h('div', { class: 'menu-mosaic menu-orbit', 'aria-hidden': 'true' }),
          h('div', { class: 'menu-tag' }, 'The Republic fractures from within: Compromise, the Force, and the turn to the Dark Side'),
          h('div', { class: 'menu-sub' }, n.total + ' cards · Compromise · Force counters · Afterimage · cards that turn to the Dark Side')));
      const info = h('div', { class: 'menu-info panel' },
        h('div', { class: 'titlebar' }, 'Set information'),
        h('div', { class: 'mi-body' },
          h('p', {}, 'The final days of the Clone Wars: the Senate trades liberty for security, Jedi and clones cross the threshold into darkness, and the Separatist Armada presses from the Outer Rim.'),
          h('div', { class: 'mi-mech' }, h('b', {}, 'Compromise N'), ' — pay a bargain: give an opponent N Force counters, or lose N life.'),
          h('div', { class: 'mi-mech' }, h('b', {}, 'Force & Attunement'), ' — bank Force counters across turns; ', h('b', {}, 'Use the Force N'), ' spends them and turns on Attunement.'),
          h('div', { class: 'mi-mech' }, h('b', {}, 'Afterimage & Dark Side'), ' — recast spells from your graveyard, and transform five double-faced cards in place.'),
          h('div', { class: 'menu-coalitions' }, (OF.Ratings.COALITIONS || []).map(c => h('div', { class: 'mc', html: '<b>' + A().esc(c.name) + ' ' + A().manaHTML(c.colors.split('').map(x => '{' + x + '}').join('')) + '</b>' + A().esc(c.text) }))),
          h('div', { class: 'mi-stats dim' }, n.C + ' commons · ' + n.U + ' uncommons · ' + n.R + ' rares · ' + n.M + ' mythics · ' + n.basics + ' basic lands · ' + n.tokens + ' tokens · ' + (NUM_WORD[n.themes] || n.themes) + ' theme decks'),
          h('div', { class: 'mi-settings dim' }, 'AI: ' + st.aiLevel + ' · ' + (st.bestOf === 3 ? 'best of 3' : 'best of 1') + ' · auto-tap ' + (st.autoTap ? 'on' : 'off'))));
      const backs = h('div', { class: 'menu-cards' }, ['Anakin, Hero With No Fear', 'Darth Sidious, Sith Master', 'General Grievous, Blade Collector'].map((nm, i) =>
        A().cardData(nm) ? A().cardImg(nm, 'menu-fan f' + i) : null));
      const temple = OF.CARD_DATA.find(c => c.id === 'ROTS-120');
      const palaceName = temple && temple.back ? temple.back.name : 'Imperial Palace';
      const caption = h('div', { class: 'menu-caption' }, 'Background: ', h('i', {}, palaceName), temple ? ' (back face of ' + temple.name + ' · ROTS-120B)' : '');
      const el = h('div', { class: 'screen menu-screen' },
        h('div', { class: 'menu-left' }, titleBlock, h('div', { class: 'menu-list' }, items)),
        h('div', { class: 'menu-right' }, backs, info, caption),
        h('div', { class: 'menu-footer' }, 'Unofficial, noncommercial fan work. Magic: The Gathering and Star Wars are properties of their respective rights holders.'));
      root.appendChild(el);
      return null;
    });
  }

  // ======================================================================= MULTIPLAYER
  function multiplayer() {
    show(() => {
      const { h } = A();
      if (OF.MP && typeof OF.MP.open === 'function') {
        let c = null;
        try { c = OF.MP.open(root, { onExit: menu }); } catch (e) {
          console.error(e);
          A().clear(root);
          root.appendChild(h('div', { class: 'screen' }, header('Multiplayer'), h('div', { class: 'match-center' }, h('div', { class: 'panel match-between' }, h('div', { class: 'titlebar' }, 'Multiplayer could not start'), h('p', {}, String(e && e.message || e)), h('div', { class: 'mbx-buttons' }, h('button', { onclick: menu }, 'Back to menu'))))));
          return null;
        }
        return { destroy: () => { try { c.close(); } catch (e) { /* ignore */ } } };
      }
      root.appendChild(h('div', { class: 'screen' }, header('Multiplayer'), h('div', { class: 'match-center' }, h('div', { class: 'panel match-between', 'data-mp-missing': '1' }, h('div', { class: 'titlebar' }, 'Multiplayer not available'),
        h('p', {}, 'The multiplayer module is not included in this build.'),
        h('p', { class: 'dim' }, 'Everything else — drafts, sealed events, theme decks and the deck editor — works against the computer.'),
        h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', onclick: menu }, 'Back to menu'))))));
      return null;
    });
  }

  function describeEvent(ev) {
    const kind = ev.type === 'sealed' ? 'Sealed Deck' : 'Booster Draft';
    if (ev.stage === 'drafting' && ev.pod) return kind + ' — drafting: pack ' + (ev.pod.round + 1) + ', pick ' + (ev.pod.pick + 1);
    if (ev.stage === 'building') return kind + ' — deck building';
    const rd = ev.rounds.length;
    const me = OF.Events.standings(ev).find(r => r.isHuman);
    return kind + ' — round ' + Math.max(1, rd) + ' of ' + ev.totalRounds + (me ? ' · ' + me.mw + '–' + me.ml + (me.md ? '–' + me.md : '') : '');
  }

  function confirmReplaceEvent(start) {
    const ev = loadEvent();
    if (ev && ev.stage !== 'complete') {
      A().modal('Abandon current event?', A().h('p', {}, 'You have an event in progress (' + describeEvent(ev) + '). Starting a new one will discard it.'), [
        { label: 'Start new event', primary: true, onClick: () => { A().storeDel(EVENT_KEY); start(); } }, { label: 'Cancel' }]);
    } else start();
  }

  // ======================================================================= EVENTS
  function startDraft() {
    const st = A().getSettings();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const pod = OF.Draft.createPod({ seed, humanSeat: 0, playerName: st.playerName || 'You' });
    const ev = OF.Events.createEvent({ type: 'draft', seed, bestOf: st.bestOf, aiLevel: st.aiLevel, stage: 'drafting', pod,
      players: pod.players.map(p => ({ name: p.name, isHuman: p.isHuman, pool: [], deck: [] })) });
    saveEvent(ev);
    draftScreen(ev);
  }

  function startSealed() {
    const st = A().getSettings();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const rng = OF.util.makeRng(seed);
    const names = rng.shuffle(OF.Draft.AI_NAMES.slice()).slice(0, 7);
    const players = [{ name: st.playerName || 'You', isHuman: true }].concat(names.map(n => ({ name: n, isHuman: false })));
    players.forEach((p, i) => { p.pool = OF.Draft.sealedPool(A().hashSeed(seed, 'seat', i), 6); p.deck = []; });
    const ev = OF.Events.createEvent({ type: 'sealed', seed, bestOf: st.bestOf, aiLevel: st.aiLevel, stage: 'building', players });
    buildAIDecks(ev);
    saveEvent(ev);
    deckBuildScreen(ev);
    openingPools(ev);
  }

  function openingPools(ev) {
    // short "you opened" summary for sealed, then deck building
    const { h } = A();
    const rares = ev.players[0].pool.filter(n => /^[RM]$/.test((A().cardData(n) || {}).rarity || ''));
    const myth = rares.filter(n => (A().cardData(n) || {}).rarity === 'M').length;
    A().modal('Sealed pool opened', h('div', {}, h('p', {}, 'You opened six Revenge of the Sith boosters (90 cards). Rares' + (myth ? ' and mythics (' + myth + ' mythic)' : '') + ': '), h('div', { class: 'rare-row' }, rares.map(n => A().cardImg(n, 'card-img small'))), h('p', { class: 'dim' }, 'Build a deck of at least 40 cards. Auto-build gives a good starting point.')), [{ label: 'Build deck', primary: true }]);
  }

  function buildAIDecks(ev) {
    ev.players.forEach((p, i) => {
      if (i === ev.humanIndex) return;
      const res = OF.DeckTools.autoBuild(p.pool);
      p.deck = res.main;
      p.colors = res.colors;
    });
  }

  function draftScreen(ev) {
    show(() => {
      const st = A().getSettings();
      const view = OF.Draft.mountDraftView(root, {
        pod: ev.pod, title: 'Booster Draft — Revenge of the Sith × 3', pickTimer: st.pickTimer,
        onPick: () => saveEvent(ev),
        onComplete: (pod) => {
          ev.players.forEach((p, i) => { p.pool = pod.picks[i].slice(); });
          ev.stage = 'building';
          buildAIDecks(ev);
          ev.pod = { done: true, seed: pod.seed, players: pod.players.map(p => ({ name: p.name })) };
          saveEvent(ev);
          A().toast('Draft complete — 45 picks. Build your deck!', 3000);
          deckBuildScreen(ev);
        },
        onExit: () => { saveEvent(ev); menu(); },
      });
      return view;
    });
  }

  function deckBuildScreen(ev, opts) {
    opts = opts || {};
    show(() => {
      const me = ev.players[ev.humanIndex];
      const firstTime = ev.stage === 'building';
      const b = OF.DeckBuilder.mount(root, {
        mode: 'limited', pool: me.pool, deck: { main: me.deck || [] },
        title: (ev.type === 'sealed' ? 'Sealed Deck' : 'Booster Draft') + ' — Deck Builder',
        doneLabel: opts.doneLabel || (firstTime ? 'Start event ▶' : 'Save deck'),
        backLabel: firstTime ? 'Menu (save)' : 'Back',
        onChange: (deck) => { me.deck = deck.main; saveEvent(ev); },
        onBack: (deck) => { me.deck = deck.main; saveEvent(ev); if (opts.onReturn) opts.onReturn(null); else if (firstTime) menu(); else eventHub(ev); },
        onDone: (deck) => {
          me.deck = deck.main;
          if (firstTime) { ev.stage = 'playing'; OF.Events.pairNextRound(ev); }
          saveEvent(ev);
          if (opts.onReturn) opts.onReturn(deck.main); else eventHub(ev);
        },
      });
      if (firstTime && !(me.deck && me.deck.length)) { /* start empty; the player can press Auto-build */ }
      return b;
    });
  }

  function resumeEvent(ev) {
    if (ev.stage === 'drafting' && ev.pod && !ev.pod.done) draftScreen(ev);
    else if (ev.stage === 'building') deckBuildScreen(ev);
    else eventHub(ev);
  }

  function eventHub(ev) {
    show(() => {
      const { h } = A();
      const rd = OF.Events.currentRound(ev);
      const hm = OF.Events.humanMatch(ev);
      const roundDone = rd && rd.matches.every(m => m.done || m.b === null);
      const isLast = ev.rounds.length >= ev.totalRounds;
      const finished = ev.stage === 'complete' || (roundDone && isLast);
      const content = h('div', { class: 'hub-body' });
      const left = h('div', { class: 'hub-left' });
      const right = h('div', { class: 'hub-right' });
      content.append(left, right);
      const kind = ev.type === 'sealed' ? 'Sealed Deck' : 'Booster Draft';
      const el = h('div', { class: 'screen hub-screen' }, header(kind + ' — Swiss event', { right: h('button', { onclick: () => abandon(ev) }, 'Abandon event') }), content);
      root.appendChild(el);

      if (finished) {
        ev.stage = 'complete'; saveEvent(ev);
        left.appendChild(finalPanel(ev));
      } else if (hm) {
        const opp = ev.players[hm.b];
        const box = h('div', { class: 'panel hub-match' }, h('div', { class: 'titlebar' }, 'Round ' + rd.number + ' of ' + ev.totalRounds),
          h('div', { class: 'hub-vs' }, h('span', { class: 'hub-you' }, ev.players[hm.a].name), h('span', { class: 'hub-score' }, hm.winsA + ' – ' + hm.winsB), h('span', { class: 'hub-opp' }, opp.name)),
          h('div', { class: 'dim hub-oppinfo' }, opp.name + ' is playing ' + colorsText(opp.colors || deckColors(opp.deck)) + '.'),
          h('div', { class: 'hub-status' }, hm.done ? (hm.winner === 0 ? 'You won this match.' : hm.winner === 1 ? 'You lost this match.' : 'Match drawn.') : (hm.games.length ? 'Match in progress (' + hm.games.length + ' game' + (hm.games.length > 1 ? 's' : '') + ' played).' : 'Ready to play.')),
          h('div', { class: 'hub-buttons' },
            !hm.done ? h('button', { class: 'primary', 'data-act': 'play', onclick: () => playEventMatch(ev) }, hm.games.length ? 'Continue match' : 'Play match') : h('button', { class: 'primary', 'data-act': 'finish', onclick: () => finishRound(ev) }, isLast ? 'Finish event' : 'Finish round ' + rd.number),
            h('button', { 'data-act': 'deck', onclick: () => deckBuildScreen(ev) }, 'Edit deck / sideboard')));
        left.appendChild(box);
        left.appendChild(pairingsPanel(ev, rd));
      }
      right.appendChild(standingsPanel(ev, 'Standings'));
      right.appendChild(deckSummaryPanel(ev.players[ev.humanIndex].deck));
      return null;
    });
  }

  function colorsText(cols) { return (cols && cols.length) ? cols.map(c => COLOR_NAME[c]).join('/') : 'colorless'; }
  function deckColors(deck) {
    const cnt = {};
    for (const n of deck || []) for (const c of OF.Ratings.colorsOf(n)) cnt[c] = (cnt[c] || 0) + 1;
    return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 2);
  }

  function pairingsPanel(ev, rd) {
    const { h } = A();
    const rows = rd.matches.map(m => {
      const a = ev.players[m.a], b = m.b === null ? null : ev.players[m.b];
      const res = m.done ? (m.winsA + '–' + m.winsB + (m.draws ? '–' + m.draws : '')) : '—';
      return h('tr', { class: (a.isHuman || (b && b.isHuman)) ? 'me' : '' }, h('td', {}, a.name), h('td', { class: 'c' }, res), h('td', {}, b ? b.name : 'BYE'));
    });
    return h('div', { class: 'panel hub-pairings' }, h('div', { class: 'titlebar' }, 'Round ' + rd.number + ' pairings'), h('table', { class: 'grid' }, h('tbody', {}, rows)));
  }

  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function standingsPanel(ev, title) {
    const { h } = A();
    const st = OF.Events.standings(ev);
    return h('div', { class: 'panel hub-standings' }, h('div', { class: 'titlebar' }, title + ' (after ' + ev.rounds.filter(r => r.matches.every(m => m.done)).length + ' round' + (ev.rounds.length === 1 ? '' : 's') + ')'),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', {}, 'Points'), h('th', {}, 'Record'), h('th', {}, 'OMW%'), h('th', {}, 'GW%'))),
        h('tbody', {}, st.map(r => h('tr', { class: r.isHuman ? 'me' : '' }, h('td', {}, String(r.rank)), h('td', {}, r.name + (r.isHuman ? '' : ' (AI)')), h('td', { class: 'c' }, String(r.mp)), h('td', { class: 'c' }, r.mw + '–' + r.ml + (r.md ? '–' + r.md : '')), h('td', { class: 'c' }, r.omw ? pct(r.omw) : '—'), h('td', { class: 'c' }, r.gp ? pct(r.gwp) : '—'))))));
  }

  function deckSummaryPanel(deck) {
    const { h } = A();
    const s = OF.DeckTools.deckStats(deck || []);
    const counts = A().countBy(deck || []);
    const names = A().sortCards(Object.keys(counts), 'mv');
    return h('div', { class: 'panel hub-deck' }, h('div', { class: 'titlebar' }, 'Your deck — ' + s.total + ' cards (' + s.lands + ' lands)'),
      h('div', { class: 'hub-decklist' }, names.map(n => h('div', { class: 'hub-dl' }, h('span', { class: 'hub-dlc' }, counts[n] + '×'), ' ', n))));
  }

  function finalPanel(ev) {
    const { h } = A();
    const st = OF.Events.standings(ev);
    const me = st.find(r => r.isHuman);
    const place = me.rank;
    const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][place - 1] || place + 'th';
    const msg = place === 1 ? 'Champion of the pod!' : me.mw >= 2 ? 'A strong finish.' : 'The roads stay open — try again.';
    return h('div', { class: 'panel hub-final' }, h('div', { class: 'titlebar' }, 'Event complete'),
      h('div', { class: 'final-place' }, ord), h('div', { class: 'final-msg' }, msg),
      h('div', { class: 'final-rec' }, 'Record ' + me.mw + '–' + me.ml + (me.md ? '–' + me.md : '') + ' · ' + me.mp + ' match points'),
      h('div', { class: 'hub-buttons' }, h('button', { class: 'primary', onclick: () => { A().storeDel(EVENT_KEY); menu(); } }, 'Return to menu'),
        h('button', { onclick: () => { A().storeDel(EVENT_KEY); confirmReplaceEvent(ev.type === 'sealed' ? startSealed : startDraft); } }, 'New ' + (ev.type === 'sealed' ? 'sealed event' : 'draft'))));
  }

  function abandon(ev) {
    A().modal('Abandon event?', A().h('p', {}, 'Your pool, deck and results for this event will be discarded.'), [
      { label: 'Abandon', primary: true, onClick: () => { A().storeDel(EVENT_KEY); menu(); } }, { label: 'Cancel' }]);
    void ev;
  }

  function playEventMatch(ev) {
    const hm = OF.Events.humanMatch(ev);
    const rd = OF.Events.currentRound(ev);
    const me = ev.players[hm.a], opp = ev.players[hm.b];
    const st = A().getSettings();
    show(() => OF.Events.runMatch(root, {
      title: (ev.type === 'sealed' ? 'Sealed' : 'Draft') + ' — Round ' + rd.number,
      you: { name: me.name, deck: me.deck.slice() }, opp: { name: opp.name, deck: opp.deck.slice() },
      oppInfo: opp.name + ' is playing ' + colorsText(opp.colors || deckColors(opp.deck)) + '.',
      match: hm, bestOf: ev.bestOf, aiLevel: ev.aiLevel, aiDelayMs: st.aiDelayMs, seedBase: ev.seed + ':' + rd.number,
      onUpdate: () => saveEvent(ev),
      onComplete: () => { saveEvent(ev); eventHub(ev); },
      onQuit: () => { saveEvent(ev); eventHub(ev); },
      onSideboard: () => deckBuildScreen(ev, { doneLabel: 'Return to match ▶', onReturn: (deck) => { if (deck) me.deck = deck; saveEvent(ev); playEventMatch(ev); } }),
    }));
  }

  function finishRound(ev) {
    show(() => {
      const { h } = A();
      const txt = h('div', { class: 'sim-text' }, 'Waiting for the other tables…');
      const bar = h('div', { class: 'sim-fill' });
      root.appendChild(h('div', { class: 'screen sim-screen' }, header('Swiss event'), h('div', { class: 'match-center' }, h('div', { class: 'panel sim-box' }, h('div', { class: 'titlebar' }, 'Round ' + ev.rounds.length + ' — other tables'), txt, h('div', { class: 'sim-bar' }, bar), h('div', { class: 'dim small' }, OF.AI ? 'AI-vs-AI games are played out by the engine (turn cap 40).' : 'Results estimated from deck strength.')))));
      let cancelled = false;
      ev.simBudgetMs = 2500;
      OF.Events.simulateRoundAsync(ev, (t, f) => { txt.textContent = t; bar.style.width = Math.round(f * 100) + '%'; }).then(() => {
        if (cancelled) return;
        bar.style.width = '100%';
        if (ev.rounds.length < ev.totalRounds) OF.Events.pairNextRound(ev);
        else ev.stage = 'complete';
        saveEvent(ev);
        eventHub(ev);
      });
      return { destroy() { cancelled = true; } };
    });
  }

  // ======================================================================= THEME DUEL
  function themeArt(t) {
    // most expensive rare in the deck gives the box art
    let best = null;
    for (const c of t.cards) { const d = A().cardData(c.name); if (d && /^[RM]$/.test(d.rarity) && !c.land && (!best || d.mana_value > best.mana_value)) best = d; }
    return best ? best.art : 'assets/ui/menu-bg.jpg';
  }

  function themeDuel() {
    show(() => {
      const { h } = A();
      const themes = OF.THEME_DECKS || [];
      let mine = A().storeGet(LAST_THEME_KEY, 0);
      if (!(mine >= 0 && mine < themes.length)) mine = 0;
      let opp = -1; // random
      const grid = h('div', { class: 'theme-grid' });
      const oppSel = h('select', { onchange: (e) => { opp = Number(e.target.value); } }, h('option', { value: '-1' }, 'Random theme deck'), themes.map((t, i) => h('option', { value: String(i) }, t.name + ' (' + t.colours + ')')));
      const listEl = h('div', { class: 'theme-list' });
      const preview = A().createPreview({ compact: true });
      function renderList() {
        A().clear(listEl);
        const t = themes[mine];
        listEl.appendChild(h('div', { class: 'titlebar' }, t.name + ' — decklist'));
        const body = h('div', { class: 'theme-dl' });
        for (const c of t.cards) body.appendChild(h('div', { class: 'hub-dl', onmouseenter: () => preview.show(c.name) }, h('span', { class: 'hub-dlc' }, c.count + '×'), ' ', h('span', { class: 'rar-' + (c.rarity || 'C') }, c.name)));
        listEl.appendChild(body);
      }
      function renderGrid() {
        A().clear(grid);
        themes.forEach((t, i) => {
          grid.appendChild(h('div', { class: 'theme-box' + (i === mine ? ' selected' : ''), 'data-theme': String(i), onclick: () => { mine = i; renderGrid(); renderList(); } },
            h('div', { class: 'tb-art', style: { backgroundImage: 'url("' + themeArt(t) + '")' } }),
            h('div', { class: 'tb-name' }, t.name), h('div', { class: 'tb-col dim' }, t.colours), h('div', { class: 'tb-strat' }, t.strategy)));
        });
      }
      renderGrid(); renderList();
      const start = () => {
        A().storeSet(LAST_THEME_KEY, mine);
        let o = opp;
        if (o < 0) { const others = themes.map((_, i) => i).filter(i => i !== mine); o = others[Math.floor(Math.random() * others.length)]; }
        const st = A().getSettings();
        playCasual({ title: 'Theme Deck Duel', you: { name: st.playerName || 'You', deck: OF.DeckTools.themeDeckList(themes[mine]) }, opp: { name: themes[o].name, deck: OF.DeckTools.themeDeckList(themes[o]) }, oppInfo: 'Opponent: ' + themes[o].name + ' (' + themes[o].colours + ')', back: themeDuel });
      };
      root.appendChild(h('div', { class: 'screen theme-screen' }, header('Theme Deck Duel', { right: h('span', { class: 'flexrow gap' }, h('span', { class: 'dim' }, 'Opponent:'), oppSel, h('button', { class: 'primary', 'data-act': 'start-duel', onclick: start }, 'Start duel ▶')) }),
        h('div', { class: 'theme-body' }, h('div', { class: 'theme-main' }, h('div', { class: 'dim theme-help' }, 'Choose your theme deck. Each is a 60-card preconstructed list from Revenge of the Sith (iconic rares and mythics, 23–24 lands). Fall of the Republic (WB) and Separatist Armada (GUR) showcase the set’s two flagship factions.'), grid), h('div', { class: 'theme-side panel' }, listEl), h('div', { class: 'theme-pv' }, preview.el))));
      return null;
    });
  }

  function playCasual(cfg) {
    const st = A().getSettings();
    const match = OF.Events.newMatch(0, 1);
    show(() => OF.Events.runMatch(root, {
      title: cfg.title, you: cfg.you, opp: cfg.opp, oppInfo: cfg.oppInfo, match, bestOf: st.bestOf, aiLevel: st.aiLevel, aiDelayMs: st.aiDelayMs, seedBase: 'casual',
      onComplete: () => casualDone(cfg, match), onQuit: () => cfg.back(),
    }));
  }
  function casualDone(cfg, match) {
    const { h } = A();
    show(() => {
      const won = match.winner === 0;
      root.appendChild(h('div', { class: 'screen' }, header(cfg.title), h('div', { class: 'match-center' }, h('div', { class: 'panel match-between' }, h('div', { class: 'titlebar' }, 'Match over'),
        h('div', { class: 'final-place ' + (won ? 'win' : 'loss') }, won ? 'Victory' : match.winner === 1 ? 'Defeat' : 'Draw'),
        h('div', { class: 'mbx-info' }, cfg.you.name + ' ' + match.winsA + '–' + match.winsB + ' ' + cfg.opp.name),
        h('div', { class: 'mbx-buttons' }, h('button', { class: 'primary', onclick: () => playCasual(cfg) }, 'Rematch'), h('button', { onclick: cfg.back }, 'Back'), h('button', { onclick: menu }, 'Main menu'))))));
      return null;
    });
  }

  // ======================================================================= DECK EDITOR
  function deckEditor() {
    show(() => {
      const wip = A().storeGet(WIP_DECK_KEY, null);
      return OF.DeckBuilder.mount(root, {
        mode: 'constructed', deck: wip && Array.isArray(wip.main) ? wip : { main: [], name: '' }, title: 'Deck Editor',
        doneLabel: 'Play vs AI ▶', backLabel: '◀ Menu',
        onChange: (deck) => A().storeSet(WIP_DECK_KEY, deck),
        onBack: (deck) => { A().storeSet(WIP_DECK_KEY, deck); menu(); },
        onDone: (deck) => { A().storeSet(WIP_DECK_KEY, deck); chooseOpponent(deck); },
      });
    });
  }

  function chooseOpponent(deck) {
    const { h } = A();
    const saved = A().storeGet(DECKS_KEY, {}) || {};
    const opts = (OF.THEME_DECKS || []).map((t, i) => ({ id: 't' + i, label: 'Theme: ' + t.name + ' (' + t.colours + ')', deck: OF.DeckTools.themeDeckList(t), name: t.name }));
    for (const k of Object.keys(saved).sort()) if (saved[k] && Array.isArray(saved[k].main) && saved[k].main.length >= 40) opts.push({ id: 's' + k, label: 'Saved: ' + k, deck: saved[k].main, name: k });
    const sel = h('select', { class: 'wide' }, h('option', { value: 'random' }, 'Random theme deck'), opts.map(o => h('option', { value: o.id }, o.label)));
    A().modal('Play vs AI', h('div', {}, h('p', {}, 'Choose the AI opponent’s deck:'), sel), [{
      label: 'Start', primary: true, onClick: () => {
        let o = opts.find(x => x.id === sel.value);
        if (!o) o = opts[Math.floor(Math.random() * Math.min((OF.THEME_DECKS || []).length || 1, opts.length))];
        const st = A().getSettings();
        playCasual({ title: 'Deck test — ' + (deck.name || 'Untitled deck'), you: { name: st.playerName || 'You', deck: deck.main.slice() }, opp: { name: o.name, deck: o.deck.slice() }, oppInfo: 'Opponent deck: ' + o.name, back: deckEditor });
      },
    }, { label: 'Cancel' }]);
  }

  // ======================================================================= GALLERY
  function gallery() {
    show(() => {
      const { h, clear, manaHTML, esc } = A();
      const R = OF.Ratings;
      const f = { text: '', colors: new Set(), rarity: '', type: '', extras: false, backs: false, sort: 'number' };
      const preview = A().createPreview();
      const grid = h('div', { class: 'gal-grid' });
      const count = h('span', { class: 'dim' });
      const search = h('input', { type: 'search', placeholder: 'Search name, rules, type, flavor (both faces)…', oninput: (e) => { f.text = e.target.value.toLowerCase(); render(); } });
      const colorBtns = ['W', 'U', 'B', 'R', 'G', 'M', 'D', 'C', 'L'].map(c => {
        const lbl = { M: 'Multi', D: '☀/☾ DFC', C: 'Artifact', L: 'Land' }[c];
        const ttl = { M: 'Multicolour', D: 'Double-faced cards (Light / Dark Side)', C: 'Colourless artifacts', L: 'Lands' }[c];
        const b = h('button', { class: 'tog', 'data-color': c, html: lbl || '<span class="ms ms-' + c + '">' + c + '</span>', title: ttl || COLOR_NAME[c], onclick: () => { f.colors.has(c) ? f.colors.delete(c) : f.colors.add(c); b.classList.toggle('on'); render(); } });
        return b;
      });
      const rar = h('select', { onchange: (e) => { f.rarity = e.target.value; render(); } }, [['', 'All rarities'], ['C', 'Common'], ['U', 'Uncommon'], ['R', 'Rare'], ['M', 'Mythic rare'], ['L', 'Basic land']].map(([v, l]) => h('option', { value: v }, l)));
      const typ = h('select', { onchange: (e) => { f.type = e.target.value; render(); } }, ['', 'Creature', 'Instant', 'Sorcery', 'Enchantment', 'Aura', 'Artifact', 'Equipment', 'Land', 'Legendary', 'Jedi', 'Sith', 'Clone', 'Droid', 'Starship', 'Advisor', 'Wookiee'].map(t => h('option', { value: t }, t || 'All types')));
      const sort = h('select', { onchange: (e) => { f.sort = e.target.value; render(); } }, [['number', 'Sort: Collector #'], ['name', 'Sort: Name'], ['mv', 'Sort: Mana value'], ['rating', 'Sort: Limited rating']].map(([v, l]) => h('option', { value: v }, l)));
      const extras = h('label', { class: 'chk' }, h('input', { type: 'checkbox', 'data-f': 'extras', onchange: (e) => { f.extras = e.target.checked; render(); } }), ' Tokens');
      const backs = h('label', { class: 'chk', title: 'Also list each back face as its own cell' }, h('input', { type: 'checkbox', 'data-f': 'backs', onchange: (e) => { f.backs = e.target.checked; render(); } }), ' Back faces');
      const facesOf = (c) => c.dfc && c.back ? A().faces(c.name) : [c];
      function matches(c) {
        const fs = c.isBack ? [c] : facesOf(c);
        if (f.text) {
          const t = fs.map(x => x.name + ' ' + (x.printed_rules || '') + ' ' + (x.rules || '') + ' ' + (x.printed_type || x.type || '') + ' ' + (x.flavor || '')).join(' ').toLowerCase();
          if (t.indexOf(f.text) < 0) return false;
        }
        if (f.rarity && c.rarity !== f.rarity) return false;
        if (f.type && !fs.some(x => (x.type || '').indexOf(f.type) >= 0)) return false;
        if (f.colors.size) {
          let cols = c.isBack ? (c.colorIndicator || []) : R.colorsOf(c.name);
          if (c.rarity === 'T') cols = c.tokenColors || [];
          const land = /Land/.test(c.type || '');
          let ok = false;
          for (const x of f.colors) {
            if (x === 'M' ? cols.length > 1 : x === 'D' ? !!(c.dfc || c.isBack) : x === 'C' ? (!cols.length && !land && c.rarity !== 'T') : x === 'L' ? land : cols.indexOf(x) >= 0) ok = true;
          }
          if (!ok) return false;
        }
        return true;
      }
      function faceText(x) {
        return h('div', { class: 'zoom-face-text' },
          h('div', { class: 'pv-name', html: (x.side ? (OF.UI && OF.UI.sideBadgeHTML ? OF.UI.sideBadgeHTML(x) + ' ' : '') : '') + esc(x.name) + (x.cost ? ' <span class="pv-cost">' + manaHTML(x.cost) + '</span>' : '') }),
          h('div', { class: 'pv-type dim', html: (x.isBack && OF.UI && OF.UI.colorIndicatorHTML ? OF.UI.colorIndicatorHTML(x) : '') + esc((x.printed_type || x.type || '') + (x.pt ? ' — ' + x.pt : '')) }),
          h('div', { class: 'pv-rules', html: manaHTML(x.printed_rules || x.rules || '') }), x.flavor ? h('div', { class: 'pv-flavor' }, x.flavor) : null);
      }
      /** "Balance change" note: what was changed from the printed card (cards-data balance_note / printed_original). */
      function balanceNote(c) {
        if (!c || !c.balance_note) return null;
        const o = c.printed_original || {};
        const parts = [];
        if (o.cost !== undefined) parts.push('cost ' + manaHTML(o.cost) + ' → ' + manaHTML(c.cost));
        if (o.pt !== undefined) parts.push(esc(o.pt) + ' → ' + esc(c.pt));
        if (o.rules !== undefined) parts.push('printed text: “' + manaHTML(o.rules) + '”');
        return h('div', { class: 'zoom-balance', 'data-balance': '1', html: '<b>Balance change</b> (this client): ' + parts.join('; ') + '<div class="dim small">' + esc(c.balance_note) + '</div>' });
      }
      function zoom(c) {
        const front = c.isBack ? A().cardData(c.frontName) : c;
        const fs = facesOf(front);
        const rarity = A().RARITY_NAME[front.rarity] || '';
        const body = h('div', { class: 'zoom-body' + (fs.length > 1 ? ' dfc' : '') },
          h('div', { class: 'zoom-faces' }, fs.map(x => A().recordImg(x, 'zoom-img'))),
          h('div', { class: 'zoom-text' }, fs.map(faceText),
            fs.length > 1 ? h('div', { class: 'dim small' }, 'Double-faced card: it enters front face up and turns to its other side in place (counters, attachments and tapped status stay). Its mana value comes from the front face.') : null,
            /Afterimage/.test(front.rules || '') ? h('div', { class: 'dim small' }, 'Afterimage: cast it from your graveyard for its Afterimage cost; it is exiled when it leaves the stack.') : null,
            balanceNote(front),
            h('div', { class: 'dim small' }, h('span', { class: 'rar-' + front.rarity }, rarity), front.number ? ' · #' + front.number + ' / ' + A().setSize() : ''),
            front.id && /^[CURM]$/.test(front.rarity) && R.TABLE[R.norm(front.name)] !== undefined ? h('div', { class: 'dim small' }, 'Limited pick rating: ' + R.rating(front.name).toFixed(1) + ' / 5') : null));
        A().modal(fs.map(x => x.name).join(' / '), body, [{ label: 'Close' }]);
      }
      function render() {
        clear(grid);
        let list = OF.CARD_DATA.concat(OF.BASIC_LAND_DATA || []);
        if (f.backs) for (const c of OF.CARD_DATA) if (c.dfc) list.push(A().backData(c));
        if (f.extras) list = list.concat(OF.TOKEN_DATA || []);
        list = list.filter(matches);
        const num = (c) => (c.number || 999) + (c.isBack ? 0.5 : 0);
        if (f.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
        else if (f.sort === 'mv') list.sort((a, b) => (a.mana_value || 0) - (b.mana_value || 0) || a.name.localeCompare(b.name));
        else if (f.sort === 'rating') list.sort((a, b) => R.rating(b.isBack ? b.frontName : b.name) - R.rating(a.isBack ? a.frontName : a.name) || a.name.localeCompare(b.name));
        else list.sort((a, b) => (a.rarity === 'T') - (b.rarity === 'T') || num(a) - num(b));
        count.textContent = list.length + ' card' + (list.length === 1 ? '' : 's');
        for (const c of list) {
          const im = A().recordImg(c, 'card-img');
          const cell = h('div', { class: 'gal-card' + (c.dfc || c.isBack ? ' dfc' : ''), title: (c.display_name || c.name) + (c.dfc && c.back ? ' (double-faced: ' + c.back.name + ')' : c.isBack ? ' (back face of ' + c.frontName + ')' : ''), 'data-name': c.name, 'data-id': (c.isBack ? c.face_id : c.id) || '' }, im);
          if (c.dfc || c.isBack) cell.appendChild(h('div', { class: 'dfc-badge', html: OF.UI && OF.UI.sideBadgeHTML ? OF.UI.sideBadgeHTML(c) : '' }));
          if (/^[CURM]$/.test(c.rarity)) cell.appendChild(h('span', { class: 'rar-gem rar-' + c.rarity, title: A().RARITY_NAME[c.rarity] }));
          if (c.balance_note) cell.appendChild(h('span', { class: 'bal-mark', title: 'Balance change: ' + c.balance_note }, '⚖'));
          cell.addEventListener('mouseenter', () => { if (c.rarity === 'T') preview.show(c.name, c); else preview.show(c.isBack ? c.frontName : c.name); });
          cell.addEventListener('click', () => zoom(c));
          grid.appendChild(cell);
        }
        if (!list.length) grid.appendChild(h('div', { class: 'dim stack-empty' }, 'No cards match these filters.'));
      }
      render();
      const bar = h('div', { class: 'gal-filters' }, search, colorBtns, rar, typ, sort, extras, backs, count);
      root.appendChild(h('div', { class: 'screen gallery-screen' }, header('Card Gallery'), bar, h('div', { class: 'gal-body' }, grid, h('div', { class: 'gal-side' }, preview.el))));
      if (OF.CARD_DATA[0]) preview.show(OF.CARD_DATA[0].name);
      return null;
    });
  }

  // ======================================================================= RULES
  function rules() {
    show(() => {
      const { h, manaHTML } = A();
      const n = setCounts();
      const sec = (id, title, ...body) => h('section', { id: 'r-' + id, class: 'rules-sec' }, h('h2', {}, title), body);
      const p = (html) => h('p', { html });
      const ex = (html) => h('div', { class: 'rules-ex', html });
      const li = (html) => h('li', { html });
      const table = (rows, head) => h('table', { class: 'grid' }, head ? h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))) : null,
        h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { html: i === 0 && !/</.test(c) ? '<b>' + c + '</b>' : c }))))));
      const M = (s) => manaHTML(s);
      const dfcs = (OF.CARD_DATA || []).filter(c => c.dfc);
      const toc = [['world', 'Revenge of the Sith'], ['coalitions', 'Coalitions & themes'], ['compromise', 'Compromise N'], ['force', 'Force counters & Use the Force'],
        ['attunement', 'Attunement'], ['afterimage', 'Afterimage'], ['sides', 'Turning to the Dark Side'], ['mana', 'Mana symbols & tokens'],
        ['keywords', 'Menace, Indestructible & keywords'], ['controls', 'Controls & hotkeys'], ['limited', 'Limited formats'],
        ['boosters', 'Boosters & fixing'], ['archetypes', 'Ten draft lanes'], ['themes', 'Eight theme decks'], ['constructed', 'Constructed']];
      const content = h('div', { class: 'rules-content' },
        sec('world', 'Revenge of the Sith',
          p('<b>Revenge of the Sith</b> (<i>Porcelain &amp; Gilt 1.0</i>) is an unofficial small expansion set (' + n.total + ' cards, ' + n.faces + ' faces) designed in the spirit of 2006–09 Magic and set at the fall of the Galactic Republic. Anakin’s turn to Darth Vader, Order 66, the Separatist Armada, and the compromises made in the Coruscant Senate anchor the set’s mechanics.'),
          p(n.C + ' commons, ' + n.U + ' uncommons, ' + n.R + ' rares, ' + n.M + ' mythic rares, ' + n.basics + ' basic lands and ' + n.dfc + ' double-faced cards. Jedi, Sith, Clone, Droid, Starship, Pilot and Wookiee are creature types; Holocron is an artifact type.')),
        sec('coalitions', 'Two flagship themes',
          table((OF.Ratings.COALITIONS || []).map(c => [M(c.colors.split('').map(x => '{' + x + '}').join('')) + ' <b>' + c.name + '</b>', c.text])),
          p('<b>The Compromise (' + M('{W}{B}') + '):</b> White and Black intertwine across the Senate and the 501st. Cards like Padmé Amidala, Mace Windu, Senate Blackmailer and Underworld Peacekeeper carry off-colour activations, while Compromise spells ask you to pay in life or hand Force to your opponent.'),
          p('<b>Separatist / Outer Rim Coalition (' + M('{G}{U}{R}') + '):</b> Green, Blue and Red share three uncommon dual lands (Geonosis, Kashyyyk, Naboo) and three common fixing lands to cast three-colour payoffs like Geonosian Signal Thief, Chart the Outer Rim, The Invisible Hand and General Grievous.')),
        sec('compromise', 'Compromise N',
          p('<b>Compromise N</b> is a signature keyword action of Revenge of the Sith. To compromise N, <b>you may give an opponent N Force counters. If you don’t, you lose N life.</b>'),
          p('Some cards require you to compromise as part of their effect (<i>Separatist Demolition Droid</i>, <i>Silence a Delegate</i>, <i>Fragments of a Sith Testament</i>, <i>Polis Massa Midwives</i>, <i>For The Better, Right?</i>). Others make it optional — <i>Senate Observer</i> lets you choose whether to compromise 1 in order to tap an opponent’s creature.'),
          ex('Tip: Paying life with Compromise can turn on <b>Asajj Ventress, Lost Padawan</b> (lose 4+ life in a turn to transform), while handing Force counters to an opponent can trigger <b>Sacred Place Guardian</b> (grows to 5/5 reach if an opponent has 4+ Force)!')),
        sec('force', 'Force counters & Use the Force N',
          p('Each player starts the game with <b>zero Force</b>. “You get N Force counters” adds them to <b>your Force pool</b>. Force belongs to the player and persists across steps, phases and turns — Force generated by one card can fuel any other card you control.'),
          p('<span class="ms-force">Use the Force <b>N</b></span> in a cost means: <b>remove N of your Force counters</b> along with any other listed costs ({T}, mana, sacrifice). If a spell offers an optional payment as it resolves (“you may pay 2 Force counters”), a prompt lets you pay or decline.'),
          ex('On the game table the <b class="rules-force">&#x25C8; Force</b> box beside each life total tracks that player’s pool, flashing cyan on gain and violet on spend.')),
        sec('attunement', 'Attunement',
          p('<b>Attunement</b> is an ability word for bonuses that check whether <b>you spent a Force counter this turn</b> (e.g. <i>Abandon the Witness</i> giving −4/−4 instead of −3/−3, <i>Jedi Battalion-General</i> pumping attacking tokens, <i>Meditation in Formation</i> looting at end step, <i>Ryloth Fireteam</i> pinging on attack).'),
          ex('Your player box lights up <span class="rules-tag attune">ATTUNED · n</span> as soon as you spend Force this turn.')),
        sec('afterimage', 'Afterimage',
          p('<b>Afterimage</b> lets you cast an instant or sorcery <b>from your graveyard</b> for its Afterimage cost, obeying its normal timing. A spell cast with Afterimage is <b>exiled</b> when it leaves the stack (whether it resolves or is countered). Look for Afterimage on <i>Clone Reinforcements</i>, <i>Evasive Translation</i>, <i>Kamino’s Sealed Orders</i>, <i>Dark-Side Intercession</i>, <i>Sandburn</i>, <i>Cut the Pod Cable</i>, <i>Battle Meditation, Canopy Chorus</i> and <i>Chart the Outer Rim</i>.'),
          ex('Your graveyard counter glows violet whenever a card in it can be cast with Afterimage right now. Click <b>Graveyard</b> and press <b>Cast (Afterimage)</b>.')),
        sec('sides', 'Turning to the Dark Side (5 Double-Faced Cards)',
          p('Five double-faced cards begin on their Light Side face and <b>turn to the Dark Side</b> in place when their condition is met (or when <i>Execute Order 66!</i> flips non-Jedi transforming permanents). Counters, attachments and tapped state remain, it does not re-enter the battlefield, and its <b>mana value always comes from its front face</b>.'),
          p('Back faces have no mana cost; their colour comes from their <b>colour indicator</b> dots before the type line. The legend rule checks the card’s current name.'),
          table(dfcs.map(c => ['#' + c.number, (c.side === 'dark' ? '&#x263E; ' : '&#x2600; ') + c.name, (c.back.side === 'dark' ? '&#x263E; ' : '&#x2600; ') + c.back.name]), ['No.', 'Light Side (Face A)', 'Dark Side (Face B)']),
          ex('On the table a &#x2600; / &#x263E; badge marks which face is up; hovering shows both faces side by side, and transforming plays a flip animation.')),
        sec('mana', 'Mana symbols, colourless mana & tokens',
          h('ul', {},
            li(M('{W} {U} {B} {R} {G}') + ' are the five colours, ' + M('{C}') + ' is <b>colourless</b> mana (<i>Astromech Scout</i>, <i>Frontier Supply Post</i>, <i>Envoy’s Landing</i>, <i>Trade Route Junction</i>, <i>Jedi Temple, Coruscant</i>), and ' + M('{T}') + ' is tap.'),
            li('<i>Wroshyr Seed Tender</i> adds ' + M('{G}') + ' that can only be spent to cast creature spells; auto-tap respects this restriction.'),
            li('Tokens created in Revenge of the Sith: <b>1/1 white Clone Soldier</b>, <b>1/1 white and black Clone Soldier</b> (from <i>Imperial Palace</i>), <b>1/1 black Human Rogue</b>, and <b>1/1 colorless Droid</b> artifact creature.'))),
        sec('keywords', 'Menace, Indestructible & keywords',
          table([
            ['Menace', 'Can’t be blocked except by <b>two or more creatures</b> (<i>Darth Sidious</i>, <i>Darth Vader</i>, <i>501st, Vader’s Fist</i>, <i>Asajj Ventress, Dooku’s Assassin</i>). On the game table, assigning only one blocker to a menace attacker shows a warning and disables Confirm Blockers until you add a second blocker or unassign it.'],
            ['Indestructible', 'Damage and effects that say “destroy” don’t destroy it (<i>Anakin</i>, <i>Darth Vader</i>, <i>Underworld Peacekeeper</i>). Still dies if its toughness reaches 0 or if sacrificed/exiled. Marked with a shield badge on the battlefield.'],
            ['Flying / Reach', 'Flying creatures can only be blocked by creatures with flying or reach.'],
            ['First strike / Double strike', 'Deals combat damage in the first-strike step / in both damage steps (<i>General Grievous</i> when equipped, <i>Maul’s Lightsaber</i>).'],
            ['Deathtouch', 'Any amount of damage it deals to a creature is lethal.'],
            ['Lifelink', 'Damage dealt by this creature also gains its controller that much life.'],
            ['Vigilance', 'Attacking doesn’t cause this creature to tap.'],
            ['Trample', 'Excess combat damage beyond lethal to blockers carries over to the defending player.'],
            ['Haste / Flash / Defender', 'Haste attacks and taps immediately; Flash casts at instant speed; Defender can’t attack.'],
            ['Regenerate', 'The next time it would be destroyed this turn, tap it, remove all damage, and remove it from combat instead (<i>Ahsoka Tano</i>).'],
            ['Scry N / Fight', 'Scry looks at top N cards and puts any number on the bottom; Fight has each creature deal damage equal to its power to the other.'],
            ['Equipment', 'Equip attaches to a creature you control, only as a sorcery (<i>Jedi Lightsaber</i>, <i>Maul’s Lightsaber</i>).']].map(([a, b]) => [a, M(b)])),
          p('Cards use modern wording: battlefield, dies, exile, mana value, “create a token”, “activate only as a sorcery”. Games use London mulligan, no mana burn, and the current legend rule.')),
        sec('controls', 'Controls & hotkeys (MTGO style)',
          table([['F2', 'OK / pass priority once (also confirms Attack / Block / Auto-pay)'], ['F4', 'Pass until something changes (next turn, opponent spell/attack, or decision)'], ['F6', 'Pass priority until end of turn'], ['Esc', 'Cancel / back out of current targeting or stop F4/F6'], ['Ctrl+click', 'Cast a spell and hold priority'], ['Shift+click', 'Cast a spell and tap mana manually'], ['Click', 'Play a land, cast a spell, choose targets, declare attackers/blockers'], ['Right-click', 'Open card menu with all legal actions and View Card'], ['Hover', 'Inspect card (both faces for double-faced cards)'], ['Graveyard / Exile', 'Click zone counts in player boxes; Afterimage casts appear in your Graveyard'], ['Double-click (draft)', 'Draft the clicked card'], ['Click (deck builder)', 'Move a card between main deck and sideboard']].map(([k, v]) => ['<kbd>' + k + '</kbd>', v])),
          p('Auto-tap pays mana costs automatically (toggle in Settings). Phase stops can be configured on the game table’s phase bar.')),
        sec('limited', 'Limited formats',
          h('ul', {}, li('<b>Booster Draft</b>: 8 players (you + 7 AI drafters: Cody, Rex, Bail, Aayla, Luminara, Ki-Adi, Tarkin, Mon, Gree), three 15-card packs, passing left, right, left; 45 picks.'), li('<b>Sealed Deck</b>: six boosters (90 cards).'),
            li('<b>Decks</b>: at least 40 cards. Start at 17 lands and ~14–17 creatures. Basic lands are free in the Deck Builder.'),
            li('Draft a <b>two-colour base</b> and leverage the guaranteed fixing slot for a third colour — especially when moving into the <b>GUR Separatist</b> coalition or activating off-colour <b>WB</b> abilities.'),
            li('Events: 3 Swiss rounds vs your pod; best-of-1 or best-of-3 (Settings). Game loser chooses play or draw.'),
            li('Multiplayer: host or join LAN / online duels, drafts and sealed events via Multiplayer on the main menu.'))),
        sec('boosters', 'Small-set color-balanced boosters & fixing',
          table([['Common', '9', 'Color-balanced nonland commons: at least 1 each of W, U, B, R, G plus 4 more distinct commons'], ['Fixing land', '1', 'Frontier Supply Post, Envoy’s Landing, or Trade Route Junction'], ['Uncommon', '3', 'Distinct uncommons (includes Geonosis, Kashyyyk and Naboo dual lands)'], ['Rare / Mythic', '1', 'A rare, replaced by a <span class="rar-M">mythic rare</span> at 7/47 (~14.9%)'], ['Basic land', '1', 'Plains, Island, Swamp, Mountain or Forest']], ['Slot', 'Count', 'Pool']),
          p('Every booster guarantees at least one mono-coloured common of each of the five colours so no table in this 120-card small set is ever colour-starved, plus one dedicated fixing land in every pack (24 common fixing lands across an 8-player draft pod).')),
        sec('archetypes', 'Ten draft lanes',
          table(OF.Ratings.ARCHETYPES.map(a => [M(a.colors.split('').map(c => '{' + c + '}').join('')), '<b>' + a.name + '</b>', a.text]))),
        sec('themes', 'The ' + (NUM_WORD[n.themes] || n.themes) + ' theme decks',
          p('Preconstructed 60-card decks in the style of 2006–09 theme decks: 23–24 lands, iconic rares and mythics, at most four copies of any nonbasic card.'),
          table((OF.THEME_DECKS || []).map(t => ['<b>' + t.name + '</b>', t.colours, t.strategy]))),
        sec('constructed', 'Constructed',
          p('Deck Editor: at least 60 cards, up to four copies of any card except basic lands. Try starting from a Theme Deck copy (Load… in the Deck Editor) and tuning it around <i>Fall of the Republic</i> (WB Compromise &amp; DFCs), <i>Separatist Armada</i> (GUR Droids &amp; Grievous), or <i>Rule of Two</i> (UB Dooku &amp; Sidious).')));
      const nav = h('div', { class: 'rules-nav panel' }, h('div', { class: 'titlebar' }, 'Contents'), toc.map(([id, t]) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); const s2 = document.getElementById('r-' + id); if (s2) s2.scrollIntoView({ behavior: 'smooth' }); } }, t)));
      root.appendChild(h('div', { class: 'screen rules-screen' }, header('Rules & Set Guide'), h('div', { class: 'rules-body' }, nav, content)));
      return null;
    });
  }

  // ======================================================================= SETTINGS
  function settings() {
    show(() => {
      const { h } = A();
      const s = A().getSettings();
      const row = (label, ctl, help) => h('div', { class: 'set-row' }, h('label', {}, label), h('div', { class: 'set-ctl' }, ctl, help ? h('div', { class: 'dim small' }, help) : null));
      const lvl = h('select', { name: 'aiLevel' }, ['easy', 'normal', 'hard'].map(v => h('option', { value: v, selected: v === s.aiLevel }, v[0].toUpperCase() + v.slice(1))));
      const bo = h('select', { name: 'bestOf' }, [[1, 'Best of 1'], [3, 'Best of 3']].map(([v, l]) => h('option', { value: String(v), selected: v === s.bestOf }, l)));
      const spdVal = h('span', { class: 'set-val' });
      const spd = h('input', { type: 'range', name: 'aiDelayMs', min: '0', max: '1500', step: '50', value: String(s.aiDelayMs), oninput: () => { spdVal.textContent = spd.value + ' ms'; } });
      spdVal.textContent = s.aiDelayMs + ' ms';
      const tap = h('input', { type: 'checkbox', name: 'autoTap', checked: s.autoTap });
      const timer = h('select', { name: 'pickTimer' }, [[0, 'Off'], [40, 'Relaxed (40 s first pick)'], [60, 'Standard (60 s first pick)'], [90, 'Slow (90 s first pick)']].map(([v, l]) => h('option', { value: String(v), selected: v === s.pickTimer }, l)));
      const name = h('input', { type: 'text', name: 'playerName', value: s.playerName || 'You', maxlength: '24' });
      const save = () => {
        A().saveSettings({ aiLevel: lvl.value, bestOf: Number(bo.value), aiDelayMs: Number(spd.value), autoTap: tap.checked, pickTimer: Number(timer.value), playerName: (name.value || 'You').trim() || 'You' });
        A().toast('Settings saved.');
      };
      const reset = () => A().modal('Reset all saved data?', h('p', {}, 'This deletes settings, saved decks and any event in progress.'), [{ label: 'Delete everything', primary: true, onClick: () => { for (const k of [A().SETTINGS_KEY, EVENT_KEY, WIP_DECK_KEY, DECKS_KEY, LAST_THEME_KEY, 'rots.gameTable.settings.v1']) A().storeDel(k); settings(); A().toast('All Revenge of the Sith data deleted.'); } }, { label: 'Cancel' }]);
      root.appendChild(h('div', { class: 'screen settings-screen' }, header('Settings'), h('div', { class: 'match-center' }, h('div', { class: 'panel set-box' }, h('div', { class: 'titlebar' }, 'Settings'),
        row('AI difficulty', lvl, 'Applies to new games. Easy makes simpler attacks and fewer tricks.'),
        row('Match format', bo, 'Event and duel matches. The loser of each game chooses play/draw.'),
        row('AI speed', h('span', { class: 'flexrow gap' }, spd, spdVal), 'Delay before each AI action on the game table (0 = instant).'),
        row('Auto-tap mana', tap, 'Pay costs automatically with the best lands.'),
        row('Draft pick timer', timer),
        row('Player name', name),
        h('div', { class: 'set-buttons' }, h('button', { class: 'primary', 'data-act': 'save-settings', onclick: save }, 'Save'), h('button', { onclick: menu }, 'Back'), h('span', { class: 'flex1' }), h('button', { onclick: reset }, 'Reset all data…'))))));
      return null;
    });
  }

  // ======================================================================= BOOT
  function boot() {
    root = document.getElementById('app');
    if (!root) { root = document.createElement('div'); root.id = 'app'; document.body.appendChild(root); }
    root.classList.add('of-app');
    const missing = [];
    if (!OF.CARD_DATA) missing.push('card data');
    if (!OF.Game) missing.push('engine');
    if (missing.length) { root.textContent = 'Revenge of the Sith failed to load: missing ' + missing.join(', ') + '.'; return; }
    menu();
  }

  OF.App = { menu, gallery, rules, settings, themeDuel, deckEditor, multiplayer, startDraft, startSealed, eventHub, resumeEvent, loadEvent, saveEvent, playCasual, EVENT_KEY };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
