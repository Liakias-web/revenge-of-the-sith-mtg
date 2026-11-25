/* Revenge of the Sith booster generation, 8-seat booster draft with AI drafters, sealed pools and
 * the MTGO-style draft screen. Logic functions operate on plain JSON-able state so a
 * draft can be saved to localStorage and resumed. Attaches OF.Draft. */
(function (OF) {
  'use strict';

  const SEATS = 8;
  const ROUNDS = 3;
  const PACK_SIZE = 15;
  const AI_NAMES = ['Cody', 'Rex', 'Bail', 'Aayla', 'Luminara', 'Ki-Adi', 'Tarkin', 'Mon', 'Gree'];

  const U = () => OF.AppUtil;
  const Rt = () => OF.Ratings;

  const MYTHIC_RATE = 7 / 47; // 20 rares (2x) + 7 mythics (1x) = 7/47 (~14.9%)
  let byRarity = null;
  /** Rarity pools: C = nonland commons (with per-colour buckets for small-set balance),
   *  FIX = the three common fixing lands (Frontier Supply Post, Envoy’s Landing, Trade Route Junction),
   *  U, R, M, L = the five basic lands. DFCs sit in their front's rarity. */
  function rarityPools() {
    if (!byRarity) {
      byRarity = { C: [], CByColor: { W: [], U: [], B: [], R: [], G: [] }, FIX: [], U: [], R: [], M: [], L: [] };
      for (const c of OF.CARD_DATA) {
        if (c.rarity === 'C') {
          if (/\bLand\b/.test(c.type)) byRarity.FIX.push(c.name);
          else {
            byRarity.C.push(c.name);
            const cols = Array.isArray(c.color) ? c.color : [];
            if (cols.length === 1 && byRarity.CByColor[cols[0]]) byRarity.CByColor[cols[0]].push(c.name);
          }
        } else if (byRarity[c.rarity]) byRarity[c.rarity].push(c.name);
      }
      for (const b of OF.BASIC_LAND_DATA || []) byRarity.L.push(b.name);
    }
    return byRarity;
  }

  /** One 15-card Revenge of the Sith booster (color-balanced small-set collation):
   *  1 rare (replaced by a mythic at 7/47 ≈ 14.9%), 3 uncommons, 9 nonland commons (guaranteed at
   *  least 1 of each of W, U, B, R, G plus 4 more distinct nonland commons), 1 common fixing land
   *  (Frontier Supply Post, Envoy’s Landing, or Trade Route Junction) and 1 basic land; no duplicate
   *  names. Order: rare, uncommons, commons by rating, fixing land, basic. */
  function makeBooster(rng) {
    const p = rarityPools();
    const take = (arr, n) => rng.shuffle(arr.slice()).slice(0, n);
    const byRating = (a, b) => Rt().rating(b) - Rt().rating(a);
    const rare = (p.M.length && rng() < MYTHIC_RATE) ? take(p.M, 1) : take(p.R, 1);
    const uncommons = take(p.U, 3).sort(byRating);
    const used = new Set();
    const commons = [];
    for (const col of ['W', 'U', 'B', 'R', 'G']) {
      const bucket = (p.CByColor[col] || []).filter(n => !used.has(n));
      if (bucket.length) {
        const pick = take(bucket, 1)[0];
        used.add(pick);
        commons.push(pick);
      }
    }
    const rest = p.C.filter(n => !used.has(n));
    for (const pick of take(rest, Math.max(0, 9 - commons.length))) {
      used.add(pick);
      commons.push(pick);
    }
    commons.sort(byRating);
    return rare.concat(uncommons, commons, take(p.FIX, 1), take(p.L, 1));
  }

  function seedFor(...parts) { return U() ? U().hashSeed(...parts) : (parts.join('|').length * 2654435761) >>> 0; }

  function sealedPool(seed, packs) {
    const out = [];
    for (let i = 0; i < (packs || 6); i++) out.push(...makeBooster(OF.util.makeRng(seedFor('sealed', seed, i))));
    return out;
  }

  // ------------------------------------------------------------ AI drafters
  function makePersonality(rng) {
    return {
      rareBias: rng() * 0.6,                 // extra love for rares
      rareChance: 0.08 + rng() * 0.14,       // chance to slam any rare
      noise: 0.25 + rng() * 0.45,
      favorite: rng.pick(['W', 'U', 'B', 'R', 'G']),
      favoriteBonus: rng() * 0.35,
      commitAt: 4 + rng.int(4),              // pick number from which colours firm up
    };
  }

  /** Colour preference weights from the picks so far (hybrid / gold cards split their weight). */
  function colorWeights(picks) {
    const w = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const n of picks) {
      const cols = Rt().colorsOf(n);
      if (!cols.length) continue;
      const v = Math.max(0.2, Rt().rating(n) - 1.0) * (Rt().isHybrid(n) && !Rt().isGold(n) ? 0.7 : 1);
      for (const c of cols) w[c] += v / cols.length;
    }
    return w;
  }
  function topColors(picks, k) {
    const w = colorWeights(picks);
    return Object.keys(w).sort((a, b) => w[b] - w[a]).slice(0, k || 2).filter(c => w[c] > 0);
  }
  /** Fixing already drafted that covers colour c (Frontier Supply Post, Envoy's Landing, duals, Astromech Scout, land search). */
  function fixingFor(picks, c, forCard) {
    let n = 0;
    for (const p of picks) if (Rt().isFixer(p) && Rt().fixesFor(p, c, forCard)) n++;
    return n;
  }

  /** Score a card for a drafter with the given picks. */
  function pickScore(name, picks, pers, rng) {
    const r = Rt();
    let s = r.rating(name);
    const cols = r.colorsOf(name);
    const n = picks.length;
    const d = r.data(name);
    const commit = n >= pers.commitAt ? Math.min(1, (n - pers.commitAt + 1) / 6) : 0;
    if (r.isFixer(name)) {
      // Fixing: worth more once colours are known; duals should touch at least one main colour.
      const f = r.fixing(name);
      if (commit > 0) {
        const top = topColors(picks, 2);
        if (f.any) s += 0.25 * commit;
        else {
          const inTop = f.colors.filter(c => top.indexOf(c) >= 0).length;
          if (inTop === 2) s += 0.45 * commit;
          else if (inTop === 1) s += 0.1 * commit;
          else s -= 0.8 * commit;
        }
        // reward fixing that enables a splash of strong off-colour or GUR coalition picks
        const splashWant = [];
        for (const p of picks) {
          if (r.rating(p) < 2.9) continue;
          const off = r.offColor(p, top);
          if (off.pips >= 1 && off.pips <= 2 && off.colors.length === off.pips) splashWant.push(...off.colors.map(c => [c, p]));
        }
        if (splashWant.some(([c, p]) => r.fixesFor(name, c, p))) s += 0.35 * commit;
        // a coloured fixer (Wroshyr Trailfinder, Separatist Signal Array, Chart the Outer Rim) must still be castable
        if (cols.length) { const off = r.offColor(name, top); if (off.pips) s -= (off.pips > 1 ? 1.3 : 0.75) * commit; }
      }
    } else if (commit > 0 && cols.length) {
      const top = topColors(picks, 2);
      const off = r.offColor(name, top);
      if (off.pips === 0) s += 0.6 * commit;
      else if (off.pips === 1 && off.colors.length === 1) {
        // a light splash (including GUR coalition cards on a 2-colour base): acceptable with fixing
        const fx = fixingFor(picks, off.colors[0], name);
        s -= (fx >= 2 ? 0.3 : fx === 1 ? 0.55 : 0.9) * commit;
        if (r.rating(name) < 2.9) s -= 0.4 * commit;
      } else if (off.pips === 2 && off.colors.length === 2 && r.isGold(name) && r.rating(name) >= 3) {
        const fx = Math.min(fixingFor(picks, off.colors[0], name), fixingFor(picks, off.colors[1], name));
        s -= (fx >= 2 ? 0.55 : fx === 1 ? 0.95 : 1.4) * commit;
      } else if (cols.some(c => top.indexOf(c) >= 0)) s -= 1.1 * commit;
      else s -= 1.6 * commit;
    } else if (cols.length) {
      const w = colorWeights(picks);
      const tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
      s += 0.25 * cols.reduce((a, c) => a + w[c] / tot, 0) / cols.length;
      if (r.isGold(name)) s -= 0.3 + 0.15 * (cols.length - 2); // early, gold cards are a commitment
    }
    if (cols.indexOf(pers.favorite) >= 0) s += pers.favoriteBonus * (cols.length > 1 ? 0.6 : 1);
    if (d && (d.rarity === 'R' || d.rarity === 'M')) {
      s += pers.rareBias * 0.5;
      if (rng() < pers.rareChance) s += 1.2;
    }
    if (r.isLand(name) && !r.isBasic(name) && !r.isFixer(name)) s -= 0.2;
    s += (rng() - 0.5) * pers.noise;
    return s;
  }

  function aiChoose(pack, picks, pers, rng) {
    let best = pack[0], bestS = -Infinity;
    for (const n of pack) {
      const sc = pickScore(n, picks, pers, rng);
      if (sc > bestS) { bestS = sc; best = n; }
    }
    return best;
  }

  /** Best pick for a human given his picks (used by auto-pick / timer expiry). */
  function suggestPick(pack, picks) {
    const pers = { rareBias: 0, rareChance: 0, noise: 0, favorite: 'W', favoriteBonus: 0, commitAt: 5 };
    return aiChoose(pack, picks, pers, () => 0.5);
  }

  // ------------------------------------------------------------ pod state
  function createPod(opts) {
    opts = opts || {};
    const seed = (opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2 ** 31)) >>> 0;
    const nameRng = OF.util.makeRng(seedFor('names', seed));
    const ai = nameRng.shuffle(AI_NAMES.slice());
    const humanSeat = opts.humanSeat === null ? -1 : (opts.humanSeat || 0);
    const players = [];
    for (let i = 0; i < SEATS; i++) {
      const isHuman = i === humanSeat;
      players.push({
        seat: i, isHuman,
        name: isHuman ? (opts.playerName || 'You') : ai.pop(),
        personality: isHuman ? null : makePersonality(OF.util.makeRng(seedFor('pers', seed, i))),
      });
    }
    const pod = { version: 1, seed, humanSeat, players, round: 0, pick: 0, packs: [], picks: players.map(() => []), done: false, pickLog: [] };
    openRound(pod);
    return pod;
  }

  function openRound(pod) {
    pod.packs = [];
    for (let s = 0; s < SEATS; s++) pod.packs.push(makeBooster(OF.util.makeRng(seedFor('pack', pod.seed, pod.round, s))));
    pod.pick = 0;
  }

  /** Pass direction for a round: +1 = left, -1 = right. */
  function direction(round) { return round === 1 ? -1 : 1; }

  function currentPack(pod, seat) { return pod.packs[seat === undefined ? pod.humanSeat : seat] || []; }

  /** Make the pick for every AI seat whose pick is still pending, given human choice. */
  function doPick(pod, humanChoice) {
    if (pod.done) return pod;
    const chosen = [];
    for (let s = 0; s < SEATS; s++) {
      const pack = pod.packs[s];
      let card;
      if (s === pod.humanSeat) {
        card = humanChoice && pack.indexOf(humanChoice) >= 0 ? humanChoice : suggestPick(pack, pod.picks[s]);
      } else {
        const rng = OF.util.makeRng(seedFor('pick', pod.seed, pod.round, pod.pick, s));
        card = aiChoose(pack, pod.picks[s], pod.players[s].personality, rng);
      }
      chosen.push(card);
    }
    for (let s = 0; s < SEATS; s++) {
      const pack = pod.packs[s];
      const i = pack.indexOf(chosen[s]);
      pack.splice(i, 1);
      pod.picks[s].push(chosen[s]);
    }
    if (pod.humanSeat >= 0) pod.pickLog.push({ round: pod.round, pick: pod.pick, card: chosen[pod.humanSeat] });
    // pass
    const dir = direction(pod.round);
    const next = new Array(SEATS);
    for (let s = 0; s < SEATS; s++) next[(s + dir + SEATS) % SEATS] = pod.packs[s];
    pod.packs = next;
    pod.pick++;
    if (pod.pick >= PACK_SIZE) {
      pod.round++;
      if (pod.round >= ROUNDS) { pod.done = true; pod.packs = []; }
      else openRound(pod);
    }
    return pod;
  }

  function runAll(pod) { let guard = 0; while (!pod.done && guard++ < 100) doPick(pod, null); return pod; }

  // ------------------------------------------------------------ draft screen
  /**
   * Mount the draft screen.
   * opts: {pod, title, onPick(pod), onComplete(pod), onExit(pod), pickTimer(seconds base, 0 = off)}
   */
  function mountDraftView(container, opts) {
    const { h, clear, createPreview, cardImg, sortCards } = U();
    const pod = opts.pod;
    const preview = createPreview();
    let selected = null;
    let timerId = null;
    let timeLeft = 0;
    let destroyed = false;

    const titleEl = h('span', { class: 'dv-title' }, opts.title || 'Booster Draft');
    const pickEl = h('span', { class: 'dv-pick' });
    const dirEl = h('span', { class: 'dv-dir dim' });
    const timerEl = h('span', { class: 'dv-timer' });
    const draftBtn = h('button', { class: 'primary', onclick: () => commit(selected), disabled: true }, 'Draft');
    const autoBtn = h('button', { title: 'Let the computer make this pick', onclick: () => commit(suggestPick(currentPack(pod), pod.picks[pod.humanSeat])) }, 'Auto-pick');
    const exitBtn = h('button', { onclick: () => { stopTimer(); opts.onExit && opts.onExit(pod); } }, 'Save & exit');
    const header = h('div', { class: 'screen-header' }, titleEl, pickEl, dirEl, h('span', { class: 'flex1' }), timerEl, autoBtn, draftBtn, exitBtn);

    const packGrid = h('div', { class: 'dv-pack' });
    const packWrap = h('div', { class: 'dv-packwrap panel' }, h('div', { class: 'titlebar' }, 'Booster', h('span', { class: 'dim dv-hint' }, '  —  double-click a card to draft it (or select it and press Draft / Enter)')), packGrid);
    let sortMode = 'mv';
    const sortSel = h('select', { onchange: (e) => { sortMode = e.target.value; renderPicks(); } }, h('option', { value: 'mv' }, 'Sort: Mana value'), h('option', { value: 'color' }, 'Sort: Color'));
    const picksTitle = h('span', {});
    const picksCols = h('div', { class: 'stack-columns' });
    const picksWrap = h('div', { class: 'dv-picks panel' }, h('div', { class: 'titlebar flexrow' }, picksTitle, h('span', { class: 'flex1' }), sortSel), picksCols);
    const main = h('div', { class: 'dv-main' }, packWrap, picksWrap);
    const side = h('div', { class: 'dv-side' }, preview.el);
    const root = h('div', { class: 'screen draft-screen' }, header, h('div', { class: 'dv-body' }, main, side));
    clear(container).appendChild(root);

    function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } timerEl.textContent = ''; }
    function startTimer() {
      stopTimer();
      const base = Number(opts.pickTimer) || 0;
      if (!base) return;
      timeLeft = Math.max(5, Math.round(base * (PACK_SIZE - pod.pick) / PACK_SIZE));
      timerEl.textContent = '⏱ ' + timeLeft + 's';
      timerId = setInterval(() => {
        timeLeft--;
        timerEl.textContent = '⏱ ' + timeLeft + 's';
        timerEl.classList.toggle('urgent', timeLeft <= 5);
        if (timeLeft <= 0) { stopTimer(); commit(selected || suggestPick(currentPack(pod), pod.picks[pod.humanSeat])); }
      }, 1000);
    }

    function fitPack() {
      const n = Math.max(1, packGrid.children.length);
      const W = packGrid.clientWidth - 8, H = packGrid.clientHeight - 8;
      if (W <= 0 || H <= 0) return;
      let best = 60;
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const w = Math.min((W - (cols - 1) * 8) / cols, ((H - (rows - 1) * 8) / rows) * 5 / 7);
        if (w > best) best = w;
      }
      packGrid.style.setProperty('--cw', Math.floor(Math.min(best, 250)) + 'px');
    }

    function commit(name) {
      if (destroyed || pod.done || !name) return;
      stopTimer();
      doPick(pod, name);
      selected = null;
      opts.onPick && opts.onPick(pod);
      if (pod.done) { opts.onComplete && opts.onComplete(pod); return; }
      render();
    }

    function renderPack() {
      clear(packGrid);
      const pack = currentPack(pod);
      for (const name of pack) {
        const im = cardImg(name, 'card-img');
        const d = Rt().data(name) || {};
        const cell = h('div', { class: 'dv-card' + (name === selected ? ' selected' : '') + (d.dfc ? ' dfc' : ''), 'data-name': name }, im);
        if (d.dfc && OF.UI && OF.UI.sideBadgeHTML) cell.appendChild(h('div', { class: 'dfc-badge', title: 'Double-faced: ' + d.name + ' / ' + d.back.name, html: OF.UI.sideBadgeHTML(d) + OF.UI.sideBadgeHTML(OF.UI.otherFace(d)) }));
        if (/^[CURM]$/.test(d.rarity || '')) cell.appendChild(h('span', { class: 'rar-gem rar-' + d.rarity, title: (U().RARITY_NAME || {})[d.rarity] || '' }));
        cell.addEventListener('mouseenter', () => preview.show(name));
        cell.addEventListener('click', () => { selected = name; draftBtn.disabled = false; for (const c of packGrid.children) c.classList.toggle('selected', c === cell); preview.show(name); });
        cell.addEventListener('dblclick', () => commit(name));
        packGrid.appendChild(cell);
      }
      if (pack[0]) preview.show(pack[0]);
      draftBtn.disabled = !selected;
      requestAnimationFrame(fitPack);
    }

    function renderPicks() {
      const picks = pod.picks[pod.humanSeat] || [];
      const cnt = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      for (const n of picks) for (const c of Rt().colorsOf(n)) cnt[c]++; // hybrid counts toward both
      clear(picksTitle);
      picksTitle.appendChild(document.createTextNode('Picks (' + picks.length + ')  '));
      for (const c of ['W', 'U', 'B', 'R', 'G']) if (cnt[c]) picksTitle.insertAdjacentHTML('beforeend', ' <span class="ms ms-' + c + '">' + c + '</span>' + cnt[c]);
      renderStackColumns(picksCols, picks, { mode: sortMode, onHover: (n) => preview.show(n) });
    }

    function render() {
      pickEl.textContent = 'Pack ' + (pod.round + 1) + ', Pick ' + (pod.pick + 1);
      dirEl.textContent = direction(pod.round) > 0 ? 'Passing left ←' : 'Passing right →';
      renderPack();
      renderPicks();
      startTimer();
    }

    const onKey = (e) => { if (e.key === 'Enter' && selected) commit(selected); };
    const onResize = () => fitPack();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    render();
    void sortCards;
    return {
      destroy() { destroyed = true; stopTimer(); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); },
    };
  }

  /**
   * Render cards into stacked, overlapping mana-value (or colour) columns.
   * opts: {mode:'mv'|'color', onClick(name, idx), onHover(name), counts:boolean, cardWidth}
   */
  function renderStackColumns(container, names, opts) {
    const { h, clear, cardImg, colorGroup, GROUP_LABEL } = U();
    opts = opts || {};
    clear(container);
    const r = Rt();
    const groups = {};
    // lands: one column per basic land name (keeps 17-land stacks short), one for other lands
    const landKey = (n) => 100 + (r.isBasic(n) ? r.BASICS.indexOf(r.norm(n)) : 9);
    const keyOf = (n) => {
      if (opts.mode === 'color') return colorGroup(n);
      if (r.isLand(n)) return opts.splitLands ? landKey(n) : 99;
      return Math.min(7, r.manaValue(n));
    };
    for (const n of names) { const k = keyOf(n); (groups[k] = groups[k] || []).push(n); }
    let keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
    if (opts.allColumns && opts.mode !== 'color') {
      const set = new Set(keys); for (let i = 1; i <= 6; i++) set.add(i);
      keys = Array.from(set).sort((a, b) => a - b);
    }
    for (const k of keys) {
      const list = (groups[k] || []).slice().sort((a, b) => colorGroup(a) - colorGroup(b) || r.manaValue(a) - r.manaValue(b) || a.localeCompare(b));
      const label = opts.mode === 'color' ? GROUP_LABEL[k] : k === 99 ? 'Lands' : k >= 100 ? (k === 109 ? 'Other lands' : r.BASICS[k - 100]) : k === 7 ? '7+' : String(k);
      const stack = h('div', { class: 'stack' });
      list.forEach((n, i) => {
        // basic lands cycle through their four paintings down the column
        const card = h('div', { class: 'stack-card', style: { zIndex: i + 1 } }, cardImg(n, 'card-img', r.isBasic(n) ? i : undefined));
        card.addEventListener('mouseenter', () => opts.onHover && opts.onHover(n));
        if (opts.onClick) card.addEventListener('click', () => opts.onClick(n, i));
        if (opts.onDblClick) card.addEventListener('dblclick', () => opts.onDblClick(n, i));
        stack.appendChild(card);
      });
      container.appendChild(h('div', { class: 'stack-col' + (list.length ? '' : ' empty') }, h('div', { class: 'stack-head' }, label, h('span', { class: 'dim' }, ' (' + list.length + ')')), stack));
    }
    if (!names.length && opts.emptyText) container.appendChild(h('div', { class: 'stack-empty dim' }, opts.emptyText));
  }

  OF.Draft = {
    SEATS, ROUNDS, PACK_SIZE, AI_NAMES, MYTHIC_RATE, rarityPools,
    makeBooster, sealedPool, createPod, doPick, runAll, currentPack, direction, aiChoose, suggestPick, pickScore,
    topColors, colorWeights, fixingFor, makePersonality, seedFor, mountDraftView, renderStackColumns,
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
