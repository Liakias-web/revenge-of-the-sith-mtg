/* Revenge of the Sith card rendering helpers (shared by the game table, draft and deck builder).
 *
 *   Double-faced cards (data.dfc, data.back): UI.cardData(backName) returns a back-face record
 *   (isBack, side, colorIndicator, image/art of the B face); UI.otherFace(rec) gives the other face.
 *   Previews of a DFC show both faces side by side. {C} is the colourless symbol; "Use the Force N"
 *   costs render as a Force pill (.ms-force); "Compromise N" actions highlight with .ms-compromise.
 *
 *   Basic lands have four paintings each (OF.BASIC_LAND_DATA[i].variants): a game card shows
 *   painting (card id % 4), so a battlefield of Plains looks varied. UI.landVariant(data, id).
 *
 *   OF.UI.manaText(str)             -> HTML string; "{2}{W}" / "{T}" become styled .ms spans,
 *                                      hybrid "{W/B}" becomes a split circle (.ms-hy)
 *   OF.UI.cardData(x)               -> CARD_DATA-style record from a name, data, def, card or cardView
 *   OF.UI.renderCardThumb(x, opts)  -> HTMLElement (card image, text-frame fallback if the image fails)
 *   OF.UI.renderCardFrame(x, opts)  -> HTMLElement (text card frame, period wording)
 *   OF.UI.showCardPreview(x)        -> shows a large preview (in the registered host, or floating)
 *   OF.UI.hideCardPreview()
 *   OF.UI.setPreviewHost(el)        -> large previews render into `el` (game table left column)
 *   OF.UI.cardTooltipText(x)        -> plain-text summary (title attributes)
 */
(function (OF) {
  'use strict';
  const UI = OF.UI = OF.UI || {};

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ESC[c]); }
  UI.escapeHTML = esc;

  // ---------------------------------------------------------------------------
  // Mana symbols
  // ---------------------------------------------------------------------------
  function symbolHTML(sym) {
    const s = String(sym).toUpperCase();
    if (/^\d+$/.test(s) || s === 'X') return '<span class="ms ms-N" title="' + s + '">' + s + '</span>';
    if (s === 'T') return '<span class="ms ms-T" title="Tap">&#x21B7;</span>';
    if (s === 'Q') return '<span class="ms ms-T" title="Untap">&#x21B6;</span>';
    if (s === 'C') return '<span class="ms ms-C" title="Colorless mana">&#x25C7;</span>';
    if (/^[WUBRG]$/.test(s)) return '<span class="ms ms-' + s + '" title="' + s + '">' + s + '</span>';
    const hy = /^([WUBRG])\/([WUBRG])$/.exec(s);
    if (hy) {
      const n = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
      return '<span class="ms ms-hy ms-hy-' + hy[1] + hy[2] + '" style="--c1:var(--mana-' + hy[1] + ');--c2:var(--mana-' + hy[2] + ')" title="Hybrid: pay ' + n[hy[1]] + ' or ' + n[hy[2]] + '">' +
        '<span class="ms-h1">' + hy[1] + '</span><span class="ms-h2">' + hy[2] + '</span></span>';
    }
    return null;
  }
  UI.symbolHTML = symbolHTML;

  /** Escape text and convert {..} mana symbols, Force costs, Compromise keywords and newlines to HTML. */
  UI.manaText = function (str) {
    if (str === null || str === undefined) return '';
    return esc(str).replace(/\{([^}]{1,3})\}/g, (m, sym) => symbolHTML(sym) || m)
      .replace(/Use the Force (\d+)/g, (m, n) => forceHTML(n))
      .replace(/\b([Cc]ompromise) (\d+)\b/g, (m, word, n, offset, full) => {
        if (offset >= 3 && full.slice(offset - 3, offset) === 'To ') return m;
        return compromiseHTML(word, n);
      })
      .replace(/\n/g, '<br>');
  };
  /** "Use the Force N" cost pill (remove N of your Force counters). */
  function forceHTML(n) {
    return '<span class="ms-force" title="Use the Force ' + n + ': remove ' + n + ' of your Force counters">Use the Force <b>' + n + '</b></span>';
  }
  UI.forceHTML = forceHTML;
  /** "Compromise N" inline badge (give an opponent N Force counters, or lose N life). */
  function compromiseHTML(word, n) {
    const s = Number(n) === 1 ? '' : 's';
    return '<span class="ms-compromise" title="Compromise ' + n + ': give an opponent ' + n + ' Force counter' + s + ', or lose ' + n + ' life">' + word + ' <b>' + n + '</b></span>';
  }
  UI.compromiseHTML = compromiseHTML;

  /** Mana pool / cost object -> HTML ({W:2,U:0..} -> two W symbols) */
  UI.poolHTML = function (pool, opts) {
    opts = opts || {};
    let h = '';
    for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) {
      const n = pool && pool[k] ? pool[k] : 0;
      if (!n) continue;
      if (n > 3 || opts.compact) h += '<span class="of-pool-n">' + symbolHTML(k) + '<b>' + n + '</b></span>';
      else for (let i = 0; i < n; i++) h += symbolHTML(k);
    }
    return h;
  };

  // ---------------------------------------------------------------------------
  // Card data lookup
  // ---------------------------------------------------------------------------
  let index = null;
  function buildIndex() {
    index = {};
    for (const list of [OF.CARD_DATA, OF.TOKEN_DATA, OF.BASIC_LAND_DATA]) {
      if (!list) continue;
      for (const c of list) {
        if (!index[c.name]) index[c.name] = c;
        if (c.dfc && c.back && !index[c.back.name]) index[c.back.name] = backRecord(c);
      }
    }
  }
  /** Display record for the back face of a double-faced CARD_DATA entry. */
  const backCache = {};
  function backRecord(c) {
    if (!c || !c.back) return null;
    if (backCache[c.id]) return backCache[c.id];
    const b = c.back;
    const ind = (b.color_indicator || b.colorIndicator || []).slice();
    const r = {
      id: c.id, number: c.number, rarity: c.rarity, name: b.name, cost: '', mana_value: c.mana_value, type: b.type,
      printed_type: b.printed_type || b.type, pt: b.pt || null, rules: b.rules || '', printed_rules: b.printed_rules || b.rules || '',
      flavor: b.flavor || '', image: b.image, art: b.art, side: b.side, face_id: b.face_id, color: ind, colorIndicator: ind,
      isBack: true, frontName: c.name, dfc: true,
    };
    backCache[c.id] = r;
    return r;
  }
  UI.backRecord = backRecord;
  /** The other face of a DFC record (front <-> back), or null. Accepts engine back records too. */
  UI.otherFace = function (d) {
    if (!d) return null;
    if (d.isBack) { if (!index) buildIndex(); const f = index[d.frontName]; return f || null; }
    if (d.dfc && d.back) return backRecord(d);
    return null;
  };
  /** 'light' | 'dark' | null: the side of this face. */
  UI.sideOf = function (d) { return d && (d.side === 'light' || d.side === 'dark') ? d.side : null; };
  function lookup(name) {
    if (!index || !index[name]) buildIndex();
    if (index[name]) return index[name];
    try { if (OF.getDef) { const d = OF.getDef(name); if (d && d.data) return d.data; } } catch (e) { /* unknown */ }
    return { name: String(name), cost: '', type: '', printed_type: '', printed_rules: '', rules: '', pt: null, color: 'Colorless', image: '', art: '' };
  }

  /** Basic land: the record for painting (id % number of variants); other cards unchanged. */
  const variantCache = {};
  function landVariant(d, id) {
    if (!d || !d.variants || !d.variants.length || typeof id !== 'number' || !isFinite(id)) return d;
    const k = Math.abs(Math.floor(id)) % d.variants.length;
    const key = d.name + '#' + k;
    if (!variantCache[key]) {
      const v = d.variants[k];
      variantCache[key] = Object.assign({}, d, { image: v.image, art: v.art, number: v.number, variantId: v.id });
    }
    return variantCache[key];
  }
  UI.landVariant = landVariant;

  /** Accepts a name, CARD_DATA record, rules def, raw card object, or cardView. A raw card / cardView
   *  of a basic land resolves to its painting variant; a clone resolves to the card it copies. */
  UI.cardData = function (x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string') return lookup(x);
    if (x.def && x.def.data) return landVariant(x.def.data, x.id);    // raw engine card (c.def = copied def for clones)
    if (x.data && x.data.name && x.types) return x.data;              // rules definition
    if (typeof x.printed_rules === 'string' || (typeof x.type === 'string' && 'cost' in x)) return x; // data record
    if (x.name) return landVariant(lookup(x.name), x.id);             // cardView or similar
    return null;
  };

  const COLOR_KEY = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'A', Land: 'L' };
  function colorKey(data) {
    if (!data) return 'A';
    if (Array.isArray(data.color) || Array.isArray(data.colorIndicator)) {
      const cs = (data.isBack ? (data.colorIndicator || data.color) : data.color) || [];
      if (cs.length > 1) return 'M';
      if (cs.length === 1) return cs[0];
      return /Land/.test(data.type || '') ? 'L' : 'A';
    }
    const c = data.color || '';
    if (COLOR_KEY[c]) return COLOR_KEY[c];
    if (/^Multi/i.test(c)) return 'M';
    if (/Land/.test(data.type || '')) return 'L';
    return 'A';
  }
  UI.colorKey = colorKey;

  UI.cardTooltipText = function (x) {
    const d = UI.cardData(x);
    if (!d) return '';
    let s = d.name + (d.cost ? '  ' + d.cost : '') + '\n' + (d.printed_type || d.type || '');
    if (d.printed_rules) s += '\n' + d.printed_rules;
    if (d.pt) s += '\n' + d.pt;
    return s;
  };

  // Images that failed once are not requested again (avoids flicker on re-render).
  const badImages = new Set();
  UI._badImages = badImages;

  // ---------------------------------------------------------------------------
  // Text frame fallback
  // ---------------------------------------------------------------------------
  UI.renderCardFrame = function (x, opts) {
    opts = opts || {};
    const d = UI.cardData(x) || {};
    const el = document.createElement('div');
    const side = UI.sideOf(d);
    el.className = 'of-frame of-frame-' + colorKey(d) + (side ? ' of-side-' + side : '') + (opts.className ? ' ' + opts.className : '');
    const rules = d.printed_rules !== undefined && d.printed_rules !== null ? d.printed_rules : (d.rules || '');
    const art = d.art && !badImages.has(d.art) ? '<img class="of-frame-art-img" draggable="false" src="' + esc(d.art) + '" alt="">' : '';
    el.innerHTML =
      '<div class="of-frame-title"><span class="of-frame-name">' + esc(d.name || '') + '</span>' +
      '<span class="of-frame-cost">' + UI.manaText(d.cost || '') + '</span></div>' +
      '<div class="of-frame-art">' + art + '</div>' +
      '<div class="of-frame-type">' + (d.isBack ? UI.colorIndicatorHTML(d) : '') + esc(d.printed_type || d.type || '') + '</div>' +
      '<div class="of-frame-text">' + UI.manaText(rules) +
      (d.flavor && !opts.noFlavor ? '<div class="of-frame-flavor">' + esc(d.flavor) + '</div>' : '') + '</div>' +
      (d.pt ? '<div class="of-frame-pt">' + esc(d.pt) + '</div>' : '');
    const img = el.querySelector('.of-frame-art-img');
    if (img) img.onerror = function () { badImages.add(d.art); img.remove(); };
    return el;
  };

  /** Colour-indicator dots of a back face (e.g. Revan, Memory of the Mask: black). */
  const CNAME = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  UI.colorIndicatorHTML = function (d) {
    const ind = d && (d.colorIndicator || d.color_indicator);
    if (!ind || !ind.length) return '';
    return '<span class="of-cind" title="Colour indicator: ' + ind.map(k => CNAME[k] || k).join(' and ') + '">' +
      ind.map(k => '<i class="of-cind-dot of-cind-' + k + '"></i>').join('') + '</span>';
  };
  /** Small Light/Dark Side badge for a DFC face: ☀ Light Side, ☾ Dark Side. */
  UI.sideBadgeHTML = function (d, cls) {
    const side = UI.sideOf(d);
    if (!side) return '';
    const other = UI.otherFace(d);
    return '<span class="of-side-badge of-side-badge-' + side + (cls ? ' ' + cls : '') + '" title="' + (side === 'light' ? 'Light Side' : 'Dark Side') + ' face' +
      (other ? ' — other face: ' + esc(other.name) : '') + '">' + (side === 'light' ? '&#x2600;' : '&#x263E;') + '</span>';
  };

  // ---------------------------------------------------------------------------
  // Thumbnails
  // ---------------------------------------------------------------------------
  /**
   * opts: {width (px, optional — otherwise CSS sizes it), useArt (art crop instead of full face),
   *        preview (default true: hover shows the large preview), className, title (tooltip, default true)}
   */
  UI.renderCardThumb = function (x, opts) {
    opts = opts || {};
    const d = UI.cardData(x) || { name: '?' };
    const el = document.createElement('div');
    el.className = 'of-card' + (opts.useArt ? ' of-card-art' : '') + (opts.className ? ' ' + opts.className : '');
    el.setAttribute('data-card-name', d.name || '');
    if (opts.width) {
      el.style.width = opts.width + 'px';
      el.style.height = Math.round(opts.width * (opts.useArt ? 2 / 3 : 1.4)) + 'px';
    }
    if (opts.title) el.title = UI.cardTooltipText(d);
    const src = opts.useArt ? d.art : d.image;
    if (src && !badImages.has(src)) {
      const img = document.createElement('img');
      img.className = 'of-card-img';
      img.draggable = false;
      img.alt = d.name || '';
      img.onerror = function () {
        badImages.add(src);
        img.remove();
        el.appendChild(opts.useArt ? artFallback(d) : UI.renderCardFrame(d, { noFlavor: true }));
      };
      img.src = src;
      el.appendChild(img);
    } else {
      el.appendChild(opts.useArt ? artFallback(d) : UI.renderCardFrame(d, { noFlavor: true }));
    }
    if (opts.preview !== false) {
      el.addEventListener('mouseenter', () => UI.showCardPreview(d));
      el.addEventListener('mouseleave', () => UI.hideCardPreview(true));
    }
    return el;
  };

  function artFallback(d) {
    const f = document.createElement('div');
    f.className = 'of-art-fallback of-frame-' + colorKey(d);
    f.textContent = d.name || '';
    return f;
  }

  // ---------------------------------------------------------------------------
  // Large preview
  // ---------------------------------------------------------------------------
  let previewHost = null, floatEl = null, mouseX = 0, mouseY = 0, mouseTracked = false;
  UI.setPreviewHost = function (el) { previewHost = el || null; };
  UI.getPreviewHost = function () { return previewHost; };

  function trackMouse() {
    if (mouseTracked || typeof document === 'undefined') return;
    mouseTracked = true;
    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX; mouseY = e.clientY;
      if (floatEl && floatEl.style.display !== 'none') placeFloat();
    }, true);
  }
  function placeFloat() {
    const w = floatEl.offsetWidth || 260, h = floatEl.offsetHeight || 364;
    let x = mouseX + 18, y = mouseY - h / 2;
    if (x + w > window.innerWidth - 4) x = mouseX - w - 18;
    if (x < 4) x = 4;
    if (y + h > window.innerHeight - 4) y = window.innerHeight - h - 4;
    if (y < 4) y = 4;
    floatEl.style.left = x + 'px'; floatEl.style.top = y + 'px';
  }

  /** Large card picture (image or text frame) for preview panes. */
  UI.renderLargeCard = function (x) {
    const d = UI.cardData(x);
    if (!d) return document.createElement('div');
    return UI.renderCardThumb(d, { preview: false, className: 'of-card-large' });
  };

  /** Show a large preview. opts.extraHTML: status lines under the card (host mode only). */
  /** Large picture of a card; a double-faced card shows both faces side by side (current face first). */
  UI.renderFaces = function (x, opts) {
    opts = opts || {};
    const d = UI.cardData(x);
    const other = opts.single ? null : UI.otherFace(d);
    if (!other) return UI.renderLargeCard(d);
    const wrap = document.createElement('div');
    wrap.className = 'of-faces' + (opts.className ? ' ' + opts.className : '');
    for (const f of [d, other]) {
      const cell = document.createElement('div');
      cell.className = 'of-face' + (f === d ? ' current' : ' other') + (UI.sideOf(f) ? ' of-face-' + UI.sideOf(f) : '');
      cell.appendChild(UI.renderLargeCard(f));
      const cap = document.createElement('div');
      cap.className = 'of-face-cap';
      cap.innerHTML = UI.sideBadgeHTML(f) + ' ' + (UI.sideOf(f) === 'dark' ? 'Dark Side' : 'Light Side') + (f === d && opts.markCurrent ? ' · showing' : '');
      cell.appendChild(cap);
      wrap.appendChild(cell);
    }
    return wrap;
  };

  UI.showCardPreview = function (x, opts) {
    opts = opts || {};
    const d = UI.cardData(x);
    if (!d) return;
    if (previewHost && previewHost.isConnected) {
      if (previewHost._ofName === d.name && previewHost._ofExtra === (opts.extraHTML || '')) return;
      previewHost._ofName = d.name; previewHost._ofExtra = opts.extraHTML || '';
      previewHost.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'of-preview-card' + (UI.otherFace(d) ? ' dfc' : '');
      wrap.appendChild(UI.renderFaces(d, { markCurrent: !!opts.inPlay }));
      previewHost.appendChild(wrap);
      if (opts.extraHTML) {
        const info = document.createElement('div');
        info.className = 'of-preview-info';
        info.innerHTML = opts.extraHTML;
        previewHost.appendChild(info);
      }
      return;
    }
    trackMouse();
    if (!floatEl) {
      floatEl = document.createElement('div');
      floatEl.className = 'of-preview-float';
      document.body.appendChild(floatEl);
    }
    if (floatEl._ofName !== d.name) {
      floatEl._ofName = d.name;
      floatEl.innerHTML = '';
      floatEl.classList.toggle('dfc', !!UI.otherFace(d));
      floatEl.appendChild(UI.renderFaces(d));
    }
    floatEl.style.display = 'block';
    placeFloat();
  };

  /** Hides the floating preview (the docked host keeps showing the last card, like MTGO). */
  UI.hideCardPreview = function () {
    if (floatEl) floatEl.style.display = 'none';
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
