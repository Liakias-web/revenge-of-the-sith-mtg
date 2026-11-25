/* Revenge of the Sith deck tools (auto-build, land suggestion, stats, validation) and the MTGO-style
 * deck builder screen used for Limited pools and the constructed Deck Editor.
 * Attaches OF.DeckTools (pure logic, Node-safe) and OF.DeckBuilder (DOM). */
(function (OF) {
  'use strict';

  const Rt = () => OF.Ratings;
  const U = () => OF.AppUtil;
  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const DECKS_KEY = 'rots.decks';
  const PAIRS = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) PAIRS.push([COLORS[i], COLORS[j]]);

  // ------------------------------------------------------------------ logic
  function isSpell(n) { return !Rt().isLand(n); }

  /** Rating used for deck construction (slight preference for creatures / sane curve). */
  function buildValue(n) {
    const r = Rt();
    let v = r.rating(n);
    if (r.isCreature(n)) v += 0.15;
    if (r.manaValue(n) >= 6) v -= 0.15;
    return v;
  }

  /** Pick `count` cards by value(n) with a creature floor and at most 4 cards of 6+ mana. */
  function chooseSpells(cands, count, value) {
    const r = Rt();
    value = value || buildValue;
    const sorted = cands.slice().sort((a, b) => value(b) - value(a) || a.localeCompare(b));
    const chosen = sorted.slice(0, count);
    const rest = sorted.slice(count);
    // ensure a reasonable creature count
    let creatures = chosen.filter(n => r.isCreature(n)).length;
    while (creatures < 13) {
      const add = rest.find(n => r.isCreature(n));
      if (!add) break;
      let worstIdx = -1;
      for (let i = chosen.length - 1; i >= 0; i--) if (!r.isCreature(chosen[i])) { worstIdx = i; break; }
      if (worstIdx < 0 || value(chosen[worstIdx]) - value(add) > 1.1) break;
      rest.push(chosen[worstIdx]);
      chosen.splice(worstIdx, 1, add);
      rest.splice(rest.indexOf(add), 1);
      creatures++;
    }
    // avoid a top-heavy curve: at most 4 cards of 6+ mana
    let heavy = chosen.filter(n => r.manaValue(n) >= 6);
    while (heavy.length > 4) {
      const worst = heavy.sort((a, b) => value(a) - value(b))[0];
      const add = rest.find(n => r.manaValue(n) < 6);
      if (!add) break;
      chosen.splice(chosen.indexOf(worst), 1, add);
      rest.splice(rest.indexOf(add), 1);
      rest.push(worst);
      heavy = chosen.filter(n => r.manaValue(n) >= 6);
    }
    return chosen;
  }

  /** Coloured-mana demand of a list of spells: mono pips count fully; a hybrid symbol goes to the
   *  half the deck already uses (or half to each when both / neither are used). Early pips weigh more. */
  function manaDemand(spells) {
    const r = Rt();
    const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const mono = new Set();
    for (const s of spells) { if (r.isLand(s)) continue; const p = r.pips(s); for (const c of COLORS) if (p[c]) mono.add(c); }
    for (const s of spells) {
      if (r.isLand(s)) continue;
      const p = r.pips(s);
      const early = r.manaValue(s) <= 2 ? 1.3 : 1;
      for (const c of COLORS) pips[c] += p[c] * early;
      for (const h of r.hybridPips(s)) {
        const a = mono.has(h[0]), b = mono.has(h[1]);
        if (a && !b) pips[h[0]] += early;
        else if (b && !a) pips[h[1]] += early;
        else { pips[h[0]] += early / 2; pips[h[1]] += early / 2; }
      }
    }
    return pips;
  }

  /** Coloured sources a list of cards already provides (non-basic lands and mana fixers). */
  function fixingSources(cards) {
    const r = Rt();
    const out = { W: 0, U: 0, B: 0, R: 0, G: 0, any: 0 };
    for (const n of cards) {
      if (r.isBasic(n) || !(r.isLand(n) || r.isFixer(n))) continue;
      const f = r.fixing(n);
      if (f.any) out.any++;
      for (const c of f.colors) out[c]++;
    }
    return out;
  }

  /**
   * Split `n` basic lands by the coloured mana symbols of the given spells. Returns {W,U,B,R,G}.
   * A hybrid {W/B} counts toward both colours. opts.sources: coloured sources already in the deck
   * (dual lands, Frontier Supply Post, Envoy's Landing, Astromech Scout...) so a splash colour still reaches ~3 sources.
   */
  function suggestLands(spells, n, opts) {
    opts = opts || {};
    const pips = manaDemand(spells);
    const have = opts.sources || fixingSources(spells);
    const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const total = COLORS.reduce((a, c) => a + pips[c], 0);
    if (n <= 0) return out;
    if (!total) { // colourless pile: split Plains/Swamp arbitrarily but deterministically
      out.W = Math.ceil(n / 2); out.B = n - out.W; return out;
    }
    const used = COLORS.filter(c => pips[c] > 0);
    let assigned = 0;
    const rema = [];
    for (const c of used) {
      const exact = pips[c] / total * n;
      out[c] = Math.floor(exact);
      assigned += out[c];
      rema.push([c, exact - out[c]]);
    }
    rema.sort((a, b) => b[1] - a[1]);
    for (let i = 0; assigned < n; i++, assigned++) out[rema[i % rema.length][0]]++;
    // every colour gets at least 3 sources in total (basics + fixing) when there is room
    const minFor = used.length > 1 ? Math.min(3, Math.floor(n / used.length)) : 0;
    for (const c of used) {
      const extra = (have[c] || 0) + Math.min(1, have.any || 0);
      while (out[c] + extra < minFor && out[c] < minFor) {
        const donor = used.filter(d => d !== c).sort((a, b) => out[b] - out[a])[0];
        if (!donor || out[donor] <= minFor) break;
        out[donor]--; out[c]++;
      }
    }
    return out;
  }

  function countIn(arr, n) { let k = 0; for (const x of arr) if (x === n) k++; return k; }

  function basicsList(counts) {
    const out = [];
    for (const c of COLORS) for (let i = 0; i < (counts[c] || 0); i++) out.push(Rt().COLOR_BASIC[c]);
    return out;
  }

  /**
   * Build the deck for a colour pair, optionally splashing colours `splash` (array of 0-2 letters).
   * A one-colour splash takes up to three strong cards one pip off the pair — including the
   * three-colour GUR Separatist payoffs (General Grievous, The Invisible Hand, Geonosian Signal
   * Thief, Chart the Outer Rim) on a UR/RG/GU base.
   * Returns {pair, splash:[...], chosen:[spells], lands:[nonbasic lands], score} or null.
   */
  function buildFor(spells, poolLands, pair, splash, spellsN, landsN) {
    const r = Rt();
    splash = splash || [];
    const cols = pair.concat(splash);
    const fixFor = (n, c, card) => r.isFixer(n) && r.fixesFor(n, c, card);
    // splash cards: castable with the splash colours, each off colour one pip, strong enough
    let splashCards = [];
    if (splash.length) {
      splashCards = spells.filter(n => {
        if (r.fits(n, pair) || !r.fits(n, cols)) return false;
        const off = r.offColor(n, pair);
        if (off.pips !== off.colors.length) return false;            // one pip per off colour
        if (splash.length === 2) return !r.isFixer(n) && off.colors.length === 2 && r.colorsOf(n).length >= 3 && r.rating(n) >= 3.0;
        const isThreeColor = r.colorsOf(n).length >= 3;
        if (r.isFixer(n) && !isThreeColor) return false;
        return off.pips === 1 && r.rating(n) >= (isThreeColor ? 2.8 : 3.2);
      }).sort((a, b) => r.rating(b) - r.rating(a) || a.localeCompare(b)).slice(0, 3);
      if (!splashCards.length) return null;
    }
    const base = spells.filter(n => r.fits(n, pair));
    // Only the best couple of non-land fixers per splash colour earn a bonus (no fixer piles).
    const bonusFixers = new Set();
    for (const X of splash) {
      const want0 = splashCards.find(n => r.offColor(n, pair).colors.indexOf(X) >= 0);
      const lands = poolLands.filter(n => fixFor(n, X, want0)).length;
      const fx = base.filter(n => fixFor(n, X, want0) && !bonusFixers.has(n)).sort((a, b) => {
        const q = (n) => (r.fixing(n).any ? 1 : 0) + (r.isCreature(n) ? 0.5 : 0) + r.rating(n) / 10;
        return q(b) - q(a) || a.localeCompare(b);
      });
      const want = Math.max(1, (splash.length === 2 ? 3 : 3) - Math.min(2, lands));
      for (let i = 0, k = 0; i < fx.length && k < want; i++, k++) bonusFixers.add(fx[i]);
    }
    const value = (n) => {
      let v = buildValue(n);
      if (r.isFixer(n)) {
        const f = r.fixing(n);
        if (bonusFixers.has(n)) v += 0.6;
        else if (f.any && r.isCreature(n)) v += 0.1;
        else if (f.colors.length && f.colors.every(c => pair.indexOf(c) >= 0)) v += 0.05; // acceleration only
        else v -= 0.7;                                                                 // fixes colours we don't need
      }
      if (splashCards.indexOf(n) >= 0) v -= 0.45 + (r.manaValue(n) <= 2 ? 0.3 : 0) + (r.offColor(n, pair).pips > 1 ? 0.25 : 0);
      return v;
    };
    const cands = base.concat(splashCards);
    const chosen = chooseSpells(cands, spellsN, value);
    // utility / fixing lands from the pool (they take land slots)
    const lands = [];
    const isSplash = (c) => splash.indexOf(c) >= 0;
    const fixers = poolLands.filter(n => r.isFixer(n)).sort((a, b) => {
      const sc = (x) => r.fixing(x).colors.filter(c => cols.indexOf(c) >= 0).length * 2 + (splash.some(c => r.fixesFor(x, c)) ? 1 : 0) + r.rating(x) / 10;
      return sc(b) - sc(a) || a.localeCompare(b);
    });
    const maxLands = splash.length === 2 ? 6 : 4;
    for (const l of fixers) {
      const f = r.fixing(l);
      const inPair = f.colors.filter(c => pair.indexOf(c) >= 0).length;
      const inCols = f.colors.filter(c => cols.indexOf(c) >= 0).length;
      // duals in the pair; duals touching a splash colour plus a main colour; any-colour lands when
      // splashing; the best any-colour land (one) in a straight two-colour deck
      const good = inPair === 2 || (splash.length && (f.any || (inCols === 2 && f.colors.some(isSplash)) || (inCols >= 1 && f.colors.some(isSplash) && inPair >= 1))) ||
        (!splash.length && f.any && r.rating(l) >= 1.6 && !lands.some(x => r.fixing(x).any));
      if (good && lands.length < maxLands) lands.push(l);
    }
    // a couple of strong utility lands of a main colour (Valley of the Dark Lords, Lehon...)
    for (const l of poolLands) {
      if (lands.length >= maxLands || lands.indexOf(l) >= 0 || r.isFixer(l)) continue;
      const f = r.fixing(l);
      if (r.rating(l) >= 1.6 && f.colors.length === 1 && pair.indexOf(f.colors[0]) >= 0 && lands.filter(x => !r.isFixer(x)).length < 1) lands.push(l);
    }
    let score = chosen.reduce((a, n) => a + value(n), 0);
    score -= Math.max(0, spellsN - chosen.length) * 2;
    const creatures = chosen.filter(n => r.isCreature(n)).length;
    score -= Math.max(0, 12 - creatures) * 0.6;
    let splashUsed = [];
    if (splash.length) {
      splashUsed = chosen.filter(n => splashCards.indexOf(n) >= 0);
      if (!splashUsed.length) return null;
      for (const X of splash) {
        const card = splashUsed.find(n => r.offColor(n, pair).colors.indexOf(X) >= 0);
        if (!card) return null;
        const fx = chosen.concat(lands).filter(n => fixFor(n, X, card)).length;
        const need = splash.length === 2 ? 2 : 1;
        if (fx < need) return null;               // never splash without real fixing
        score -= 0.9 + (fx < need + 1 ? 1.0 : 0); // every extra colour costs consistency
      }
    }
    return { pair, splash: splash.length && splashUsed.length ? splash.slice() : null, chosen, lands, score, landsN };
  }

  /**
   * Best deck from a pool by ratings: 23 spells + 17 lands (40 cards). Prefers two colours;
   * splashes a third colour for up to three strong cards (including GUR Separatist payoffs) when
   * the pool has fixing for it (uncommon duals, Frontier Supply Post, Envoy's Landing, Trade Route
   * Junction, Jedi Temple, Astromech Scout, Wroshyr Trailfinder).
   * Returns {main:[names], side:[names], colors:[...], pair:[c1,c2], splash:[...]|null, score}.
   */
  function autoBuild(pool, opts) {
    opts = opts || {};
    const r = Rt();
    const spellsN = opts.spells || 23;
    const landsN = opts.lands || 17;
    const nonbasic = pool.filter(n => !r.isBasic(n));
    const spells = nonbasic.filter(isSpell);
    const poolLands = nonbasic.filter(n => r.isLand(n));
    let best = null;
    for (const pair of PAIRS) {
      const b2 = buildFor(spells, poolLands, pair, [], spellsN, landsN);
      if (b2 && (!best || b2.score > best.score)) best = b2;
      if (opts.noSplash || !b2) continue;
      const others = COLORS.filter(c => pair.indexOf(c) < 0);
      for (const X of others) {
        const b3 = buildFor(spells, poolLands, pair, [X], spellsN, landsN);
        if (b3 && b3.score > b2.score + 0.9 && (!best || b3.score > best.score)) best = b3;
      }
      for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
        const b4 = buildFor(spells, poolLands, pair, [others[i], others[j]], spellsN, landsN);
        if (b4 && b4.score > b2.score + 1.8 && (!best || b4.score > best.score)) best = b4;
      }
    }
    let chosen = best.chosen.slice();
    const cols = best.splash ? best.pair.concat(best.splash) : best.pair;
    // fill with the most castable leftovers if the pair is too shallow
    if (chosen.length < spellsN) {
      const left = spells.slice();
      for (const n of chosen) left.splice(left.indexOf(n), 1);
      left.sort((a, b) => (r.offColor(a, cols).pips - r.offColor(b, cols).pips) || buildValue(b) - buildValue(a) || a.localeCompare(b));
      while (chosen.length < spellsN && left.length) chosen.push(left.shift());
    }
    const lands = best.lands.slice();
    const sources = fixingSources(chosen.concat(lands));
    const basics = basicsList(suggestLands(chosen, landsN - lands.length, { sources }));
    const main = chosen.concat(lands, basics);
    const side = nonbasic.slice();
    for (const n of chosen.concat(lands)) { const i = side.indexOf(n); if (i >= 0) side.splice(i, 1); }
    const used = COLORS.filter(c => chosen.some(n => r.colorsOf(n).indexOf(c) >= 0 && cols.indexOf(c) >= 0));
    return { main, side, colors: used.length ? used : best.pair.slice(), pair: best.pair, splash: best.splash, score: best.score };
  }

  function deckStats(main) {
    const r = Rt();
    const st = { total: main.length, lands: 0, creatures: 0, other: 0, curve: [0, 0, 0, 0, 0, 0, 0, 0], pips: { W: 0, U: 0, B: 0, R: 0, G: 0 }, sources: { W: 0, U: 0, B: 0, R: 0, G: 0 }, fixers: 0, anySources: 0, hybrid: 0 };
    for (const n of main) {
      if (r.isLand(n)) {
        st.lands++;
        const f = r.fixing(n);
        for (const c of f.colors) st.sources[c]++;
        if (f.any) st.anySources++;
        continue;
      }
      if (r.isCreature(n)) st.creatures++; else st.other++;
      st.curve[Math.min(7, r.manaValue(n))]++;
      const p = r.symbolCounts(n);              // a hybrid {W/B} counts toward both W and B
      for (const c of COLORS) st.pips[c] += p[c];
      if (r.isHybrid(n)) st.hybrid++;
      if (r.isFixer(n)) { st.fixers++; const f = r.fixing(n); if (f.any) st.anySources++; }
    }
    return st;
  }

  /** Returns an array of error strings (empty when legal). format: 'limited' | 'constructed'. */
  function validate(main, format, pool) {
    const r = Rt();
    const errs = [];
    const min = format === 'constructed' ? 60 : 40;
    if (main.length < min) errs.push('Deck has ' + main.length + ' cards; minimum is ' + min + '.');
    const counts = U() ? U().countBy(main) : main.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
    for (const n in counts) {
      if (!r.data(n)) errs.push('Unknown card: ' + n);
      if (r.isBasic(n)) continue;
      if (format === 'constructed' && counts[n] > 4) errs.push('More than 4 copies of ' + n + '.');
      if (format !== 'constructed' && pool) {
        const have = pool.filter(x => x === n).length;
        if (counts[n] > have) errs.push(n + ' is not in your pool (' + counts[n] + '/' + have + ').');
      }
    }
    return errs;
  }

  /** Average rating of the non-land cards (deck strength used for fallback results). */
  function deckStrength(main) {
    const r = Rt();
    const sp = main.filter(n => !r.isLand(n));
    if (!sp.length) return 0;
    return sp.reduce((a, n) => a + r.rating(n), 0) / sp.length;
  }

  function themeDeckList(theme) {
    const out = [];
    for (const c of theme.cards) for (let i = 0; i < c.count; i++) out.push(c.name);
    return out;
  }

  OF.DeckTools = { autoBuild, suggestLands, basicsList, deckStats, validate, deckStrength, themeDeckList, buildValue, manaDemand, fixingSources, PAIRS, COLORS, DECKS_KEY };

  // ------------------------------------------------------------------ screen
  /**
   * opts: {mode:'limited'|'constructed', pool, deck:{main, side, name}, title, doneLabel,
   *        onDone(deck), onBack(deck), onChange(deck), backLabel, extraHeader(el)}
   */
  function mount(container, opts) {
    const { h, clear, createPreview, cardImg, countBy, toast, modal, storeGet, storeSet } = U();
    const r = Rt();
    const constructed = opts.mode === 'constructed';
    const pool = (opts.pool || []).filter(n => !r.isBasic(n));
    let main = (opts.deck && opts.deck.main ? opts.deck.main.slice() : []);
    let side;
    if (constructed) side = [];
    else {
      side = pool.slice();
      for (const n of main) { if (r.isBasic(n)) continue; const i = side.indexOf(n); if (i >= 0) side.splice(i, 1); else main = main.filter((x, k) => !(x === n && k === main.indexOf(n))); }
    }
    let deckName = (opts.deck && opts.deck.name) || '';
    const preview = createPreview();
    let poolSort = 'mv';
    const filter = { text: '', colors: new Set(), type: '', rarity: '' };

    const statsEl = h('span', { class: 'db-headstats' });
    const nameInput = constructed ? h('input', { type: 'text', class: 'db-name', placeholder: 'Deck name', value: deckName, oninput: (e) => { deckName = e.target.value; changed(); } }) : null;
    const buttons = [];
    if (!constructed) buttons.push(h('button', { title: 'Build the best 40-card deck from your pool (two colours, a light splash only with fixing)', onclick: doAutoBuild }, 'Auto-build'));
    buttons.push(h('button', { title: 'Replace basic lands with a suggested split (17 for 40 cards, 24 for 60)', onclick: doSuggestLands }, 'Auto-suggest lands'));
    buttons.push(h('button', { onclick: doClear }, constructed ? 'Clear deck' : 'Move all to sideboard'));
    if (constructed) {
      buttons.push(h('button', { onclick: doSave }, 'Save'));
      buttons.push(h('button', { onclick: doLoad }, 'Load…'));
    }
    const backBtn = opts.onBack ? h('button', { class: 'back-btn', onclick: () => opts.onBack(getDeck()) }, opts.backLabel || 'Back') : null;
    const doneBtn = opts.onDone ? h('button', { class: 'primary', onclick: tryDone }, opts.doneLabel || 'Done') : null;
    const header = h('div', { class: 'screen-header' }, h('span', { class: 'dv-title' }, opts.title || (constructed ? 'Deck Editor' : 'Deck Builder')), nameInput, statsEl, h('span', { class: 'flex1' }), buttons, backBtn, doneBtn);

    const deckCols = h('div', { class: 'stack-columns deck-cols' });
    const deckTitle = h('span', {}, 'Main deck');
    const deckArea = h('div', { class: 'db-deck panel' }, h('div', { class: 'titlebar flexrow' }, deckTitle, h('span', { class: 'flex1' }), h('span', { class: 'dim small' }, constructed ? 'click a card to remove one copy' : 'click a card to move it to the sideboard')), deckCols);

    const poolCols = h('div', { class: constructed ? 'db-browser' : 'stack-columns pool-cols' });
    const poolTitle = h('span', {});
    const poolTools = h('span', { class: 'db-pooltools' });
    const poolArea = h('div', { class: 'db-pool panel' }, h('div', { class: 'titlebar flexrow' }, poolTitle, h('span', { class: 'flex1' }), poolTools), poolCols);

    // side panel: preview, basics, stats, validation
    const basicsEl = h('div', { class: 'db-basics' });
    const curveEl = h('div', { class: 'db-curve' });
    const colorEl = h('div', { class: 'db-colors' });
    const validEl = h('div', { class: 'db-valid' });
    const side_ = h('div', { class: 'db-side' }, preview.el,
      h('div', { class: 'panel db-statpanel' }, h('div', { class: 'titlebar' }, 'Basic lands'), basicsEl,
        h('div', { class: 'titlebar' }, 'Mana curve'), curveEl, h('div', { class: 'titlebar' }, 'Colors'), colorEl, validEl));
    const root = h('div', { class: 'screen deck-screen' + (constructed ? ' constructed' : '') }, header, h('div', { class: 'db-body' }, h('div', { class: 'db-main' }, deckArea, poolArea), side_));
    clear(container).appendChild(root);

    // pool tools
    if (constructed) {
      const search = h('input', { type: 'search', placeholder: 'Search name / text / type', oninput: (e) => { filter.text = e.target.value.toLowerCase(); renderPool(); } });
      const colorBtns = COLORS.concat(['M', 'D', 'C', 'L']).map(c => {
        const lbl = { M: 'Multi', D: '☀/☾ DFC', C: 'Artifact', L: 'Land' }[c];
        const b = h('button', { class: 'tog', title: lbl || c, html: lbl ? lbl : '<span class="ms ms-' + c + '">' + c + '</span>', onclick: () => { if (filter.colors.has(c)) filter.colors.delete(c); else filter.colors.add(c); b.classList.toggle('on'); renderPool(); } });
        return b;
      });
      const typeSel = h('select', { onchange: (e) => { filter.type = e.target.value; renderPool(); } }, ['', 'Creature', 'Instant', 'Sorcery', 'Enchantment', 'Aura', 'Artifact', 'Equipment', 'Land', 'Legendary', 'Jedi', 'Sith', 'Clone', 'Droid', 'Starship', 'Advisor', 'Wookiee'].map(t => h('option', { value: t }, t || 'All types')));
      const rarSel = h('select', { onchange: (e) => { filter.rarity = e.target.value; renderPool(); } }, [['', 'All rarities'], ['C', 'Common'], ['U', 'Uncommon'], ['R', 'Rare'], ['M', 'Mythic rare']].map(([v, l]) => h('option', { value: v }, l)));
      poolTools.append(search, ...colorBtns, typeSel, rarSel);
    } else {
      const sortSel = h('select', { onchange: (e) => { poolSort = e.target.value; renderPool(); } }, h('option', { value: 'mv' }, 'Sort: Mana value'), h('option', { value: 'color' }, 'Sort: Color'));
      poolTools.append(sortSel);
    }

    function getDeck() { return { main: main.slice(), side: side.slice(), name: deckName }; }
    function changed() { renderStats(); opts.onChange && opts.onChange(getDeck()); }

    function moveToDeck(n) {
      if (constructed) {
        if (!r.isBasic(n) && countIn(main, n) >= 4) { toast('Maximum 4 copies of ' + n + '.'); return; }
        main.push(n);
      } else {
        const i = side.indexOf(n); if (i < 0) return; side.splice(i, 1); main.push(n);
      }
      renderAll();
    }
    function moveToSide(n) {
      const i = main.indexOf(n); if (i < 0) return;
      main.splice(i, 1);
      if (!constructed && !r.isBasic(n)) side.push(n);
      renderAll();
    }

    function renderDeck() {
      OF.Draft.renderStackColumns(deckCols, main, { mode: 'mv', allColumns: true, splitLands: true, onHover: (n) => preview.show(n), onClick: moveToSide, emptyText: constructed ? 'Click cards below to add them to your deck.' : '' });
      const st = OF.DeckTools.deckStats(main);
      deckTitle.textContent = 'Main deck — ' + st.total + ' cards (' + st.lands + ' lands, ' + st.creatures + ' creatures, ' + st.other + ' other)';
    }
    function passesFilter(c) {
      if (filter.text) {
        const t = (c.name + ' ' + (c.printed_rules || '') + ' ' + (c.rules || '') + ' ' + (c.printed_type || c.type) + (c.back ? ' ' + c.back.name + ' ' + (c.back.rules || '') + ' ' + c.back.type : '')).toLowerCase();
        if (t.indexOf(filter.text) < 0) return false;
      }
      if (filter.type && c.type.indexOf(filter.type) < 0) return false;
      if (filter.rarity && c.rarity !== filter.rarity) return false;
      if (filter.colors.size) {
        const cols = r.colorsOf(c.name);
        const isLand = r.isLand(c.name);
        let ok = false;
        for (const f of filter.colors) {
          if (f === 'M' && cols.length > 1) ok = true;
          else if (f === 'D' && c.dfc) ok = true;
          else if (f === 'C' && !cols.length && !isLand) ok = true;
          else if (f === 'L' && isLand) ok = true;
          else if (cols.indexOf(f) >= 0) ok = true;
        }
        if (!ok) return false;
      }
      return true;
    }
    function renderPool() {
      if (constructed) {
        clear(poolCols);
        const counts = countBy(main);
        const list = OF.CARD_DATA.concat(OF.BASIC_LAND_DATA || []).filter(passesFilter);
        poolTitle.textContent = 'Card pool — ' + list.length + ' cards (click to add, right-click to remove)';
        for (const c of list) {
          const badge = counts[c.name] ? h('span', { class: 'db-badge' }, '×' + counts[c.name]) : null;
          const cell = h('div', { class: 'db-bcard' + (counts[c.name] ? ' indeck' : '') }, cardImg(c.name, 'card-img'), badge);
          cell.addEventListener('mouseenter', () => preview.show(c.name));
          cell.addEventListener('click', () => moveToDeck(c.name));
          cell.addEventListener('contextmenu', (e) => { e.preventDefault(); moveToSide(c.name); });
          poolCols.appendChild(cell);
        }
      } else {
        OF.Draft.renderStackColumns(poolCols, side, { mode: poolSort, onHover: (n) => preview.show(n), onClick: moveToDeck, emptyText: 'Sideboard is empty.' });
        poolTitle.textContent = 'Sideboard / pool — ' + side.length + ' cards (click a card to add it to the deck)';
      }
    }
    function renderBasics() {
      clear(basicsEl);
      for (const c of COLORS) {
        const name = r.COLOR_BASIC[c];
        const n = countIn(main, name);
        basicsEl.appendChild(h('div', { class: 'db-basicrow' },
          h('span', { class: 'ms ms-' + c }, c), h('span', { class: 'db-bname', onmouseenter: () => preview.show(name) }, name),
          h('button', { class: 'mini', title: 'Remove ' + name, onclick: () => { moveToSide(name); } }, '−'),
          h('span', { class: 'db-bcount' }, String(n)),
          h('button', { class: 'mini', title: 'Add ' + name, onclick: () => { main.push(name); renderAll(); } }, '+')));
      }
    }
    function renderStats() {
      const st = OF.DeckTools.deckStats(main);
      statsEl.textContent = st.total + ' cards · ' + st.lands + ' lands · ' + st.creatures + ' creatures';
      clear(curveEl);
      const max = Math.max(1, ...st.curve);
      st.curve.forEach((v, i) => {
        curveEl.appendChild(h('div', { class: 'db-bar' }, h('div', { class: 'db-barval' }, v ? String(v) : ''), h('div', { class: 'db-barfill', style: { height: Math.round(v / max * 60) + 'px' } }), h('div', { class: 'db-barlbl' }, i === 7 ? '7+' : String(i))));
      });
      clear(colorEl);
      for (const c of COLORS) {
        if (!st.pips[c] && !st.sources[c]) continue;
        colorEl.appendChild(h('div', { class: 'db-colorrow' }, h('span', { class: 'ms ms-' + c }, c), h('span', {}, st.pips[c] + ' symbols'), h('span', { class: 'dim' }, ' · ' + st.sources[c] + ' land sources')));
      }
      if (!colorEl.firstChild) colorEl.appendChild(h('div', { class: 'dim' }, 'No coloured cards yet.'));
      else if (st.hybrid || st.fixers || st.anySources) colorEl.appendChild(h('div', { class: 'dim small' }, [st.hybrid ? st.hybrid + ' hybrid card' + (st.hybrid > 1 ? 's' : '') + ' (counted for both colours)' : '', st.fixers ? st.fixers + ' fixer' + (st.fixers > 1 ? 's' : '') + ' (duals, Frontier Supply Post, Envoy’s Landing, Astromech Scout, land search…)' : ''].filter(Boolean).join(' · ')));
      const errs = OF.DeckTools.validate(main, constructed ? 'constructed' : 'limited', constructed ? null : pool);
      clear(validEl);
      if (errs.length) validEl.appendChild(h('div', { class: 'db-err' }, errs.slice(0, 3).join(' ')));
      else validEl.appendChild(h('div', { class: 'db-ok' }, '✔ Deck is legal (' + (constructed ? 'constructed, 60+' : 'limited, 40+') + ').'));
      if (doneBtn) doneBtn.disabled = false;
    }
    function renderAll() { renderDeck(); renderPool(); renderBasics(); changed(); }

    function doAutoBuild() {
      const res = OF.DeckTools.autoBuild(pool);
      main = res.main; side = res.side;
      renderAll();
      const CN = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
      toast('Auto-built ' + res.pair.map(c => CN[c]).join('/') + (res.splash ? ' splashing ' + res.splash.map(c => CN[c]).join(' and ') : '') + ' — 23 spells, 17 lands.');
    }
    function doSuggestLands() {
      const nonBasicMain = main.filter(n => !r.isBasic(n));
      const spells = nonBasicMain.filter(n => !r.isLand(n));
      const otherLands = nonBasicMain.filter(n => r.isLand(n)).length;
      const target = constructed ? Math.max(40, Math.min(60, Math.round(nonBasicMain.length / 0.6))) : 40;
      const landsN = Math.max(0, (constructed ? Math.max(24, target - nonBasicMain.length) : Math.max(17, target - nonBasicMain.length)) - otherLands);
      const counts = OF.DeckTools.suggestLands(spells, landsN, { sources: OF.DeckTools.fixingSources(nonBasicMain) });
      main = nonBasicMain.concat(OF.DeckTools.basicsList(counts));
      renderAll();
    }
    function doClear() {
      if (constructed) main = [];
      else { side = side.concat(main.filter(n => !r.isBasic(n))); main = []; }
      renderAll();
    }
    function tryDone() {
      const errs = OF.DeckTools.validate(main, constructed ? 'constructed' : 'limited', constructed ? null : pool);
      if (errs.length) { modal('Deck not legal', h('div', {}, errs.map(e => h('p', {}, e))), [{ label: 'OK', primary: true }]); return; }
      opts.onDone(getDeck());
    }
    // constructed save/load
    function savedDecks() { const d = storeGet(DECKS_KEY, {}); return d && typeof d === 'object' ? d : {}; }
    function doSave() {
      const nm = (deckName || '').trim();
      if (!nm) { toast('Give the deck a name first.'); nameInput.focus(); return; }
      const all = savedDecks();
      all[nm] = { name: nm, main: main.slice(), saved: Date.now() };
      storeSet(DECKS_KEY, all);
      toast('Saved "' + nm + '" (' + main.length + ' cards).');
    }
    function doLoad() {
      const all = savedDecks();
      const names = Object.keys(all).sort();
      const list = h('div', { class: 'db-loadlist' });
      if (!names.length) list.appendChild(h('p', { class: 'dim' }, 'No saved decks yet.'));
      let m;
      for (const nm of names) {
        list.appendChild(h('div', { class: 'db-loadrow' }, h('span', { class: 'flex1' }, nm + ' (' + all[nm].main.length + ')'),
          h('button', { onclick: () => { main = all[nm].main.slice(); deckName = nm; nameInput.value = nm; renderAll(); m.close(); } }, 'Load'),
          h('button', { onclick: () => { delete all[nm]; storeSet(DECKS_KEY, all); m.close(); doLoad(); } }, 'Delete')));
      }
      const themes = h('div', { class: 'db-loadlist' }, h('div', { class: 'dim' }, 'Start from a theme deck:'));
      for (const t of (OF.THEME_DECKS || [])) themes.appendChild(h('div', { class: 'db-loadrow' }, h('span', { class: 'flex1' }, t.name + ' (' + t.colours + ')'), h('button', { onclick: () => { main = OF.DeckTools.themeDeckList(t); deckName = t.name + ' (copy)'; nameInput.value = deckName; renderAll(); m.close(); } }, 'Copy')));
      m = modal('Load deck', h('div', {}, list, themes), [{ label: 'Close' }]);
    }

    renderAll();
    return { getDeck, destroy() { /* nothing global */ } };
  }

  OF.DeckBuilder = { mount };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
