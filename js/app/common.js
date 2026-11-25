/* Revenge of the Sith app shared helpers: persistence, settings, DOM builder, card display helpers
 * (double-faced cards show both faces in previews and zooms; mythic rarity).
 * Attaches OF.AppUtil. Safe to load in Node (DOM helpers are only used when called). */
(function (OF) {
  'use strict';

  const SETTINGS_KEY = 'rots.settings';  // all app storage keys start with 'rots.' (isolated from 'tor.')
  const DEFAULT_SETTINGS = { aiLevel: 'normal', bestOf: 1, aiDelayMs: 600, autoTap: true, pickTimer: 0, playerName: 'You' };

  // ---------------------------------------------------------------- storage
  const memStore = {};
  function storeGet(key, def) {
    let raw = null;
    try { raw = window.localStorage.getItem(key); } catch (e) { raw = Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null; }
    if (raw === null || raw === undefined) return def;
    try { return JSON.parse(raw); } catch (e) { return def; }
  }
  function storeSet(key, val) {
    const raw = JSON.stringify(val);
    try { window.localStorage.setItem(key, raw); return true; } catch (e) { memStore[key] = raw; return false; }
  }
  function storeDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    delete memStore[key];
  }

  function getSettings() {
    const s = storeGet(SETTINGS_KEY, null);
    const out = Object.assign({}, DEFAULT_SETTINGS, (s && typeof s === 'object') ? s : {});
    if (['easy', 'normal', 'hard'].indexOf(out.aiLevel) < 0) out.aiLevel = 'normal';
    out.bestOf = Number(out.bestOf) === 3 ? 3 : 1;
    out.aiDelayMs = Math.max(0, Math.min(3000, Number(out.aiDelayMs) || 0));
    out.autoTap = out.autoTap !== false;
    out.pickTimer = Math.max(0, Number(out.pickTimer) || 0);
    return out;
  }
  function saveSettings(s) { storeSet(SETTINGS_KEY, Object.assign(getSettings(), s)); }

  // ---------------------------------------------------------------- DOM
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    appendKids(el, children);
    return el;
  }
  function appendKids(el, kids) {
    for (const c of kids) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) appendKids(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------------------------------------------------------- cards
  const R = () => OF.Ratings;
  function cardData(name) { return R() ? R().data(name) : null; }
  function cardImage(name) { const d = cardData(name); return d ? d.image : 'assets/ui/card-back.jpg'; }
  const CARD_BACK = 'assets/ui/card-back.jpg';

  /** Mana/rules text to HTML using the shared .ms symbol style (or OF.UI.manaText if present). */
  function manaHTML(text) {
    if (!text) return '';
    if (OF.UI && typeof OF.UI.manaText === 'function') {
      try { const r = OF.UI.manaText(text); if (typeof r === 'string') return r; } catch (e) { /* fall back */ }
    }
    return esc(text).replace(/\{([^}]+)\}/g, (m, s) => {
      const k = s.toUpperCase();
      const cls = /^\d+$/.test(k) ? 'N' : k;
      const label = k === 'T' ? '↷' : k;
      return '<span class="ms ms-' + cls + '">' + label + '</span>';
    }).replace(/\n/g, '<br>');
  }

  // colour sort order: W U B R G, multicolour, colourless, land
  const COLOR_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };
  function colorGroup(name) {
    const r = R();
    if (r.isLand(name)) return 7;
    const cols = r.colorsOf(name);
    if (cols.length === 0) return 6;
    if (cols.length > 1) return 5;
    return COLOR_ORDER[cols[0]];
  }
  const GROUP_LABEL = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Land'];
  function sortCards(names, mode) {
    const r = R();
    return names.slice().sort((a, b) => {
      if (mode === 'rating') return r.rating(b) - r.rating(a) || a.localeCompare(b);
      if (mode === 'color') return colorGroup(a) - colorGroup(b) || r.manaValue(a) - r.manaValue(b) || a.localeCompare(b);
      return (r.isLand(a) - r.isLand(b)) || r.manaValue(a) - r.manaValue(b) || colorGroup(a) - colorGroup(b) || a.localeCompare(b);
    });
  }
  function countBy(names) { const m = {}; for (const n of names) m[n] = (m[n] || 0) + 1; return m; }

  const RARITY_NAME = { C: 'Common', U: 'Uncommon', R: 'Rare', M: 'Mythic rare', T: 'Token', L: 'Basic land' };

  /** Display record of a DFC's back face (from OF.UI when loaded, else built here). */
  function backData(d) {
    if (!d || !d.dfc || !d.back) return null;
    if (OF.UI && OF.UI.backRecord) return OF.UI.backRecord(d);
    const b = d.back;
    return Object.assign({}, d, { name: b.name, type: b.type, printed_type: b.printed_type || b.type, pt: b.pt, rules: b.rules, printed_rules: b.printed_rules || b.rules,
      flavor: b.flavor || '', image: b.image, art: b.art, side: b.side, cost: '', colorIndicator: b.color_indicator || [], isBack: true, frontName: d.name, back: undefined });
  }
  /** [front, back] records of a DFC (by front or back name), or [record]. */
  function faces(name) {
    const d = cardData(name);
    if (!d) return [];
    const b = backData(d);
    return b ? [d, b] : [d];
  }
  const sideBadge = (f) => f && (f.side === 'light' || f.side === 'dark') ? '<span class="of-side-badge of-side-badge-' + f.side + '" title="' + (f.side === 'light' ? 'Light Side' : 'Dark Side') + ' face">' + (f.side === 'light' ? '&#x2600;' : '&#x263E;') + '</span> ' : '';

  /** Large card preview panel: {el, show(name)}. A double-faced card shows both faces. */
  function createPreview(opts) {
    opts = opts || {};
    const img = h('img', { class: 'pv-img', alt: '', draggable: 'false' });
    const img2 = h('img', { class: 'pv-img pv-img2', alt: '', draggable: 'false' });
    const name = h('div', { class: 'pv-name' });
    const type = h('div', { class: 'pv-type dim' });
    const rules = h('div', { class: 'pv-rules' });
    const flavor = h('div', { class: 'pv-flavor' });
    const back = h('div', { class: 'pv-back' });
    const extra = h('div', { class: 'pv-extra dim' });
    const imgwrap = h('div', { class: 'pv-imgwrap' }, img, img2);
    const el = h('div', { class: 'preview-panel' + (opts.compact ? ' compact' : '') }, imgwrap, h('div', { class: 'pv-text' }, name, type, rules, flavor, back, extra));
    let current = null;
    let currentKey = null;
    /** show(name) or show(name, record) — record overrides the picture (basic-land painting, token). */
    function show(n, rec) {
      const key = rec ? n + '#' + (rec.variantId || rec.id || rec.number || '') : n;
      if (!n || key === currentKey) return;
      current = n; currentKey = key;
      const d = rec || cardData(n);
      const bk = rec ? null : backData(d);
      imgwrap.classList.toggle('dfc', !!bk);
      img.src = d ? d.image : CARD_BACK;
      img.alt = n;
      if (bk) { img2.style.display = ''; img2.src = bk.image; img2.alt = bk.name; } else { img2.style.display = 'none'; img2.removeAttribute('src'); }
      name.innerHTML = (bk ? sideBadge(d) : '') + esc(d ? d.name : n) + (d && d.cost ? ' <span class="pv-cost">' + manaHTML(d.cost) + '</span>' : '');
      type.textContent = d ? (d.printed_type || d.type) + (d.pt ? '  —  ' + d.pt : '') : '';
      rules.innerHTML = d ? manaHTML(d.printed_rules || d.rules || '') : '';
      flavor.textContent = d && d.flavor ? d.flavor : '';
      back.innerHTML = bk ? '<div class="pv-back-name">' + sideBadge(bk) + esc(bk.name) + ' <span class="dim">(other face)</span></div>' +
        '<div class="pv-type dim">' + (OF.UI && OF.UI.colorIndicatorHTML ? OF.UI.colorIndicatorHTML(bk) : '') + esc(bk.printed_type || bk.type) + (bk.pt ? '  —  ' + esc(bk.pt) : '') + '</div>' +
        '<div class="pv-rules">' + manaHTML(bk.printed_rules || bk.rules || '') + '</div>' : '';
      const rar = d ? (RARITY_NAME[d.rarity] || '') : '';
      const nums = d && d.variants && d.variants.length > 1 && !d.variantId ? d.variants.map(v => '#' + v.number).join(', ') : (d && d.number && d.rarity !== 'T' ? '#' + d.number : '');
      extra.innerHTML = d ? [rar ? '<span class="rar-' + d.rarity + '">' + rar + '</span>' : '', nums ? esc(nums) + ' / ' + setSize() : '', bk ? 'double-faced' : ''].filter(Boolean).join(' · ') : '';
      if (d && d.balance_note) {
        const o = d.printed_original || {};
        const was = [o.cost !== undefined ? 'printed cost ' + manaHTML(o.cost) : '', o.pt !== undefined ? 'printed ' + esc(o.pt) : '', o.rules !== undefined ? 'printed: “' + manaHTML(o.rules) + '”' : ''].filter(Boolean).join('; ');
        extra.insertAdjacentHTML('beforeend', '<div class="pv-balance"><b>Balance change</b> — ' + was + '</div>');
      }
      shown = d;
      if (!d || !d.image) failFace(img, d || n);
    }
    let shown = null;
    img.addEventListener('error', () => failFace(img, shown || current));
    img2.addEventListener('error', () => { const bk = shown ? backData(shown) : null; if (bk) failFace(img2, bk); });
    return { el, show, get current() { return current; } };
  }

  /** Highest collector number in the set (basic lands included), e.g. 125. */
  let SET_SIZE = 0;
  function setSize() {
    if (!SET_SIZE) {
      for (const c of OF.CARD_DATA || []) SET_SIZE = Math.max(SET_SIZE, c.number || 0);
      for (const b of OF.BASIC_LAND_DATA || []) for (const v of b.variants || []) SET_SIZE = Math.max(SET_SIZE, v.number || 0);
    }
    return SET_SIZE;
  }

  /** The record shown for basic-land painting `variant` (0-3), or the card itself. */
  function variantData(d, variant) {
    if (!d || !d.variants || !d.variants.length || variant === undefined || variant === null) return d;
    const v = d.variants[((variant % d.variants.length) + d.variants.length) % d.variants.length];
    return Object.assign({}, d, { image: v.image, art: v.art, number: v.number, variantId: v.id });
  }

  /**
   * A missing card face (images not rendered yet) degrades to the text frame of OF.UI.renderCardFrame
   * (name, cost, art crop, type line, rules) instead of a card back. Replaces `img` in place; the
   * replacement keeps the img's classes and data-name.
   */
  function failFace(img, x) {
    const d = typeof x === 'string' ? cardData(x) : x;
    if (!img || !d || !(OF.UI && OF.UI.renderCardFrame)) { if (img && img.src.indexOf(CARD_BACK) < 0) img.src = CARD_BACK; return; }
    if (img._ofFallback && img._ofFallback.parentNode) img._ofFallback.remove();
    const wrap = h('div', { class: (img.className || 'card-img') + ' card-fallback', title: img.title || '' });
    if (img.dataset && img.dataset.name) wrap.dataset.name = img.dataset.name;
    wrap.appendChild(OF.UI.renderCardFrame(d, { noFlavor: true }));
    img._ofFallback = wrap;
    if (img.parentNode) {
      img.style.display = 'none';
      img.parentNode.insertBefore(wrap, img.nextSibling);
      // the preview <img> is reused: show it again when the next card loads
      img.addEventListener('load', function again() { img.style.display = ''; if (wrap.parentNode) wrap.remove(); img.removeEventListener('load', again); });
    }
  }

  /** Card image element; a basic land may give `variant` (0-3) for one of its four paintings. */
  function cardImg(name, cls, variant) {
    const d = variantData(cardData(name), variant);
    const im = h('img', { class: cls || 'card-img', src: d ? d.image : CARD_BACK, alt: name, title: '', draggable: 'false', loading: 'lazy' });
    im.dataset.name = name;
    im.addEventListener('error', () => failFace(im, d || name), { once: true });
    return im;
  }
  /** Image for a data record (gallery: tokens, basic-land variants). */
  function recordImg(d, cls) {
    const im = h('img', { class: cls || 'card-img', src: d.image || CARD_BACK, alt: d.name, draggable: 'false', loading: 'lazy' });
    im.dataset.name = d.name;
    im.addEventListener('error', () => failFace(im, d), { once: true });
    return im;
  }

  // ---------------------------------------------------------------- modal / toast
  function modal(title, body, buttons) {
    const back = h('div', { class: 'app-modal-back' });
    const box = h('div', { class: 'app-modal panel' }, h('div', { class: 'titlebar' }, title), h('div', { class: 'app-modal-body' }, body));
    const bar = h('div', { class: 'app-modal-buttons' });
    const close = () => { if (back.parentNode) back.parentNode.removeChild(back); };
    for (const b of (buttons || [{ label: 'OK' }])) {
      bar.appendChild(h('button', { class: b.primary ? 'primary' : '', onclick: () => { const keep = b.onClick && b.onClick() === false; if (!keep) close(); } }, b.label));
    }
    box.appendChild(bar);
    back.appendChild(box);
    document.body.appendChild(back);
    const first = bar.querySelector('button.primary') || bar.querySelector('button');
    if (first) setTimeout(() => first.focus(), 0);
    return { close, el: back };
  }
  function toast(msg, ms) {
    const t = h('div', { class: 'app-toast' }, msg);
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms || 2200);
  }

  function hashSeed(...parts) {
    let x = 2166136261 >>> 0;
    for (const p of parts) {
      const s = String(p);
      for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
      x ^= 0x9e37; x = Math.imul(x, 2654435761) >>> 0;
    }
    return x >>> 0 || 1;
  }

  OF.AppUtil = {
    SETTINGS_KEY, DEFAULT_SETTINGS, storeGet, storeSet, storeDel, getSettings, saveSettings,
    h, clear, esc, cardData, cardImage, cardImg, recordImg, variantData, failFace, setSize, CARD_BACK, manaHTML, colorGroup, GROUP_LABEL, sortCards, countBy,
    createPreview, modal, toast, hashSeed, faces, backData, RARITY_NAME,
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
