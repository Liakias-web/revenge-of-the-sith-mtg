/* Oathfall engine utilities: RNG, mana costs, constants. */
(function (OF) {
  'use strict';

  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };
  const BASIC_FOR_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
  const COLOR_FOR_BASIC = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

  // Deterministic PRNG (mulberry32).
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    const rng = function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = (n) => Math.floor(rng() * n);
    rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
    rng.shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    };
    rng.getState = () => s;
    return rng;
  }

  // Mana cost object: {generic, W, U, B, R, G, C, X, hybrid: [['W','B'], ...]}
  function emptyCost() { return { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, X: 0, hybrid: [] }; }

  function parseCost(str) {
    const c = emptyCost();
    if (!str) return c;
    const re = /\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(str))) {
      const sym = m[1].toUpperCase();
      if (/^\d+$/.test(sym)) c.generic += parseInt(sym, 10);
      else if (sym === 'X') c.X += 1;
      else if (sym.indexOf('/') > 0) c.hybrid.push(sym.split('/'));
      else if (c[sym] !== undefined) c[sym] += 1;
      else throw new Error('Unknown mana symbol ' + sym);
    }
    return c;
  }

  function cloneCost(c) {
    const r = Object.assign(emptyCost(), c || {});
    r.hybrid = ((c && c.hybrid) || []).map(h => h.slice());
    return r;
  }

  function costToString(c) {
    if (!c) return '';
    let s = '';
    for (let i = 0; i < (c.X || 0); i++) s += '{X}';
    if (c.generic) s += '{' + c.generic + '}';
    for (const h of c.hybrid || []) s += '{' + h.join('/') + '}';
    for (const k of ['C', 'W', 'U', 'B', 'R', 'G']) for (let i = 0; i < (c[k] || 0); i++) s += '{' + k + '}';
    return s || '{0}';
  }

  /** Total mana to pay (X excluded; it is added to generic when chosen). */
  function costTotal(c) {
    return c.generic + c.W + c.U + c.B + c.R + c.G + c.C + ((c.hybrid && c.hybrid.length) || 0);
  }

  function addCosts(a, b) {
    const r = emptyCost();
    for (const k in r) if (k !== 'hybrid') r[k] = (a[k] || 0) + (b[k] || 0);
    r.hybrid = (a.hybrid || []).concat(b.hybrid || []);
    return r;
  }

  function colorsOfCost(c) {
    const out = COLORS.filter(k => c[k] > 0);
    for (const h of c.hybrid || []) for (const k of h) if (COLORS.includes(k) && !out.includes(k)) out.push(k);
    return COLORS.filter(k => out.includes(k));
  }

  function emptyPool() { return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; }
  function poolTotal(p) { return p.W + p.U + p.B + p.R + p.G + p.C; }

  OF.util = {
    COLORS, COLOR_NAMES, BASIC_FOR_COLOR, COLOR_FOR_BASIC,
    makeRng, emptyCost, parseCost, cloneCost, costToString, costTotal, addCosts, colorsOfCost,
    emptyPool, poolTotal,
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
