/* Revenge of the Sith game table (MTGO c. 2012 style).
 *
 * Revenge of the Sith: each player box shows the Force pool (players[p].force) beside the life total
 * with a gain/spend animation, and an ATTUNED tag when that player has spent Force this turn.
 * Double-faced cards show their current face, a ☀ Light Side / ☾ Dark Side badge, a colour indicator
 * on back faces, a short flip animation when they transform, and both faces in the preview. The
 * graveyard viewer offers "Cast (Afterimage)" for cards with that action; the exile viewer lists
 * exiled cards. Menace attackers require 2+ blockers (with live validation hints), indestructible
 * permanents show a shield badge, and Compromise prompts display life & opponent Force clearly.
 *
 * Inherited from Mirrors of Mehrava: attack tax (declareAttackers.attackTax + optional payMana reason
 * 'attackTax'), creatures that must attack (declareAttackers.mustAttack: pre-selected, highlighted),
 * blockers that can block an additional creature (declareBlockers.extraBlockers), extra combat
 * phases, colour changes (cardView.colors vs printed colours), generic counters (cardView.counterMap
 * badges by kind), clones ("copying X"), loses flying, landwalk.
 *
 *   const h = OF.UI.GameTable.mount(containerEl, {
 *     game, humanIndex: 0, controllers: {1: ai}, aiDelayMs: 350,
 *     title: 'Round 1 – Game 2', matchInfo: {wins: [1, 0]}, onGameEnd: (result) => {} });
 *   h.destroy();
 *
 * The table drives the game: after every respond() it looks at game.decision; decisions of players
 * with a controller are answered by controller.decide(game, d) on a timer, all others are answered
 * through this UI. See ENGINE_API.md for the decision contract.
 */
(function (OF) {
  'use strict';
  const UI = OF.UI = OF.UI || {};
  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

  function esc(s) { return UI.escapeHTML ? UI.escapeHTML(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function mana(s) { return UI.manaText ? UI.manaText(s) : esc(s); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function linkify(text) {
    return mana(text).replace(/\[\[(.+?)\]\]/g, (m, n) => '<span class="gt-clink" data-card-name="' + n + '">' + n + '</span>');
  }

  // Steps shown in the phase bar (untap/cleanup have no priority).
  const STEP_BAR = [
    { key: 'upkeep', label: 'Upkeep', short: 'Upk' },
    { key: 'draw', label: 'Draw', short: 'Draw' },
    { key: 'main1', label: 'Main 1', short: 'M1' },
    { key: 'beginCombat', label: 'Beginning of Combat', short: 'BoC' },
    { key: 'declareAttackers', label: 'Declare Attackers', short: 'Atk' },
    { key: 'declareBlockers', label: 'Declare Blockers', short: 'Blk' },
    { key: 'combatDamage', label: 'Combat Damage', short: 'Dmg' },
    { key: 'endCombat', label: 'End of Combat', short: 'EoC' },
    { key: 'main2', label: 'Main 2', short: 'M2' },
    { key: 'end', label: 'End of Turn', short: 'End' },
  ];
  function stepKey(step) {
    if (step === 'firstStrikeDamage') return 'combatDamage';
    if (step === 'untap') return 'upkeep';
    if (step === 'cleanup') return 'end';
    return step;
  }

  const SETTINGS_KEY = 'rots.gameTable.settings.v1';
  const DEFAULT_SETTINGS = {
    autoTap: true,            // auto-pay costs of spells/abilities you just played
    autoPassNoPlays: true,    // skip stops when you have no legal play
    stops: {
      me: { upkeep: false, draw: false, main1: true, beginCombat: false, declareAttackers: false, declareBlockers: true, combatDamage: false, endCombat: false, main2: true, end: false },
      opp: { upkeep: false, draw: false, main1: false, beginCombat: false, declareAttackers: true, declareBlockers: true, combatDamage: false, endCombat: false, main2: false, end: true },
    },
  };
  function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  function loadSettings() {
    const s = cloneDefaults();
    try {
      const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (typeof o.autoTap === 'boolean') s.autoTap = o.autoTap;
        if (typeof o.autoPassNoPlays === 'boolean') s.autoPassNoPlays = o.autoPassNoPlays;
        for (const row of ['me', 'opp']) if (o.stops && o.stops[row]) for (const k in s.stops[row]) if (typeof o.stops[row][k] === 'boolean') s.stops[row][k] = o.stops[row][k];
      }
    } catch (e) { /* storage unavailable */ }
    return s;
  }
  function saveSettings(s) { try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

  /** Keyword labels for the preview panel (modern wording) and short chips on permanents. */
  const KW_NAMES = {
    flying: 'Flying', firstStrike: 'First strike', doubleStrike: 'Double strike', trample: 'Trample', haste: 'Haste',
    vigilance: 'Vigilance', reach: 'Reach', defender: 'Defender (can’t attack)', deathtouch: 'Deathtouch', lifelink: 'Lifelink',
    menace: 'Menace (can’t be blocked except by two or more creatures)',
    indestructible: 'Indestructible (damage and “destroy” effects don’t destroy it)',
    flash: 'Flash', flanking: 'Flanking', shroud: 'Shroud', maxOneBlocker: 'Can’t be blocked by more than one creature',
    fear: 'Fear (can be blocked only by artifact and/or black creatures)', cantBlock: 'Can’t block', cantAttack: 'Can’t attack',
    unblockable: 'Unblockable', noActivated: 'Its abilities can’t be played', doesntUntap: 'Doesn’t untap', untargetable: 'Can’t be the target of spells or abilities',
    hexproofOpp: 'Can’t be targeted by opponents', mustBeBlocked: 'Must be blocked if able',
    mustAttack: 'Attacks each turn if able', extraBlock: 'Can block an additional creature', noFlying: 'Loses flying and can’t have or gain flying',
    mountainwalk: 'Mountainwalk', islandwalk: 'Islandwalk', swampwalk: 'Swampwalk', forestwalk: 'Forestwalk', plainswalk: 'Plainswalk',
  };
  const KW_CHIPS = {
    flying: ['FLY', 'Flying'], firstStrike: ['1ST', 'First strike'], doubleStrike: ['2×', 'Double strike'], trample: ['TRM', 'Trample'],
    haste: ['HST', 'Haste'], vigilance: ['VIG', 'Vigilance'], reach: ['RCH', 'Reach'], deathtouch: ['DTH', 'Deathtouch'], lifelink: ['LIFE', 'Lifelink'],
    menace: ['MEN', 'Menace: can’t be blocked except by two or more creatures'],
    indestructible: ['&#x1F6E1; IND', 'Indestructible: damage and “destroy” effects don’t destroy it'],
    flanking: ['FLNK', 'Flanking'], shroud: ['SHRD', 'Shroud'], maxOneBlocker: ['1BLK', 'Can’t be blocked by more than one creature'],
    defender: ['DEF', 'Defender'], fear: ['FEAR', 'Fear: can be blocked only by artifact and/or black creatures'],
    hexproofOpp: ['HEX', 'Can’t be targeted by opponents'], mustBeBlocked: ['LURE', 'Must be blocked if able'],
    unblockable: ['UNB', 'Unblockable'], cantBlock: ['NOBLK', 'Can’t block'], cantAttack: ['NOATK', 'Can’t attack'],
    doesntUntap: ['NOUNT', 'Doesn’t untap'], untargetable: ['SHRD', 'Can’t be the target of spells or abilities'],
    mustAttack: ['MUST', 'Attacks each turn if able'], extraBlock: ['+BLK', 'Can block an additional creature'],
    noFlying: ['NOFLY', 'Loses flying and can’t have or gain flying'], mountainwalk: ['MWALK', 'Mountainwalk'],
    islandwalk: ['IWALK', 'Islandwalk'], swampwalk: ['SWALK', 'Swampwalk'], forestwalk: ['FWALK', 'Forestwalk'], plainswalk: ['PWALK', 'Plainswalk'],
  };
  /** Display names of generic counters (cardView.counterMap kinds other than +1/+1 and charge). */
  const COUNTER_NAMES = { influence: 'Influence', forge: 'Forge', survey: 'Survey', p1p1: '+1/+1', charge: 'Charge', m1m1: '−1/−1', age: 'Age' };
  /** Keywords always shown as chips (rarely obvious from the card picture at table size). */
  const KW_ALWAYS = ['menace', 'indestructible', 'doubleStrike', 'fear', 'deathtouch', 'lifelink', 'flanking', 'shroud', 'maxOneBlocker', 'defender', 'hexproofOpp', 'mustBeBlocked', 'unblockable', 'cantBlock', 'cantAttack', 'doesntUntap', 'untargetable', 'mustAttack', 'extraBlock', 'noFlying', 'mountainwalk'];

  const END_REASONS = {
    life: 'life total reached 0', decking: 'drew from an empty library', conceded: 'conceded',
    card: 'a card effect', 'turn limit': 'turn limit reached', error: 'engine error',
  };

  /** A safe answer for any decision (used when an AI throws or answers illegally). */
  function safeAnswer(d, attempt) {
    attempt = attempt || 0;
    switch (d.type) {
      case 'playFirst': return { first: true };
      case 'mulligan': return { keep: true };
      case 'priority': return { type: 'pass' };
      case 'payMana': return d.canAuto && attempt === 0 ? { type: 'auto' } : (d.cancellable ? { type: 'cancel' } : { type: 'auto' });
      case 'chooseTargets': {
        if (d.cancellable && attempt > 0) return { cancel: true };
        if (d.groupCheck) {
          for (let i = 0; i < 40; i++) {
            const pick = d.legal.slice().sort(() => Math.random() - 0.5).slice(0, d.min);
            if (!d.groupCheck(pick)) return { targets: pick };
          }
        }
        return d.cancellable ? (attempt === 0 ? { targets: d.legal.slice(0, d.min) } : { cancel: true }) : { targets: d.legal.slice(0, d.min) };
      }
      case 'chooseCards': {
        if (d.cancellable && attempt > 0) return { cancel: true };
        if (d.validate) {
          for (let n = d.min; n <= d.max; n++) {
            for (let i = 0; i < 30; i++) {
              const pick = d.cards.slice().sort(() => Math.random() - 0.5).slice(0, n);
              if (!d.validate(pick)) return { cards: pick };
            }
          }
        }
        return { cards: d.cards.slice(0, d.min) };
      }
      case 'yesNo': return { yes: false };
      case 'chooseColor': return { color: d.colors[0] };
      case 'chooseOption': return { choice: d.options[0].id };
      case 'orderCards': return { order: d.cards.slice() };
      case 'chooseNumber': return d.cancellable && attempt > 0 ? { cancel: true } : { number: d.min };
      case 'declareAttackers': return { attackers: d.attackTax > 0 ? [] : (d.mustAttack || []).slice() };   // "attacks each turn if able"
      case 'declareBlockers': {
        // "must be blocked if able": assign one able blocker to each such attacker
        const blocks = [], used = new Set();
        for (const at of d.mustBeBlocked || []) {
          const b = Object.keys(d.candidates || {}).find(bid => !used.has(bid) && d.candidates[bid].includes(at));
          if (b !== undefined) { used.add(b); blocks.push({ blocker: Number(b), attacker: at }); }
        }
        return { blocks };
      }
      default: return { type: 'pass' };
    }
  }

  // ===========================================================================
  class Table {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts;
      this.g = opts.game;
      if (!this.g) throw new Error('GameTable.mount: opts.game is required');
      this.human = opts.humanIndex || 0;
      this.opp = this.g.players.length > 1 ? 1 - this.human : this.human;
      this.controllers = opts.controllers || {};
      this.aiDelay = opts.aiDelayMs !== undefined ? opts.aiDelayMs : 350;
      this.quickDelay = Math.min(60, this.aiDelay);
      this.settings = loadSettings();
      this.timers = new Set();
      this.ui = this.freshInteraction(null);
      this.passMode = null; this.passTurn = 0;
      this.holdPriority = false; this.humanInitiated = false; this.manualPay = false;
      this.drivenDecision = null; this.autoPending = null;
      this.pendingConcede = false;
      this.logCount = 0; this.thumbs = new Map(); this.htmlCache = {};
      this.prevLife = {}; this.prevForce = {}; this.prevFace = {}; this.flipUntil = {};
      this.hoverSid = null;
      this.endShown = false; this.endReported = false;
      this.revealCount = this.g.reveals ? this.g.reveals.length : 0;
      this.build();
      this.bind();
      const self = this;
      this.g.onChange(function () { if (!self.destroyed) self.requestRender(); });
      try {
        if (!this.g.started && !this.g._gen && !this.g.decision && !this.g.over) this.g.start();
      } catch (e) { this.engineError(e); }
      this.resize();
      this.render();
      this.scheduleDrive(0);
    }

    freshInteraction(d) {
      // blocks: {blockerId: [attackerIds]} (a blocker with extraBlockers may block two attackers)
      return { d, targets: [], attackers: new Set(), blocks: {}, pendingBlocker: null, error: '', modalHidden: false };
    }

    // ----- timers -------------------------------------------------------------
    later(fn, ms) {
      const self = this;
      const t = setTimeout(function () { self.timers.delete(t); if (!self.destroyed) fn(); }, ms || 0);
      this.timers.add(t);
      return t;
    }

    // ----- DOM skeleton -------------------------------------------------------
    build() {
      const root = this.root = document.createElement('div');
      root.className = 'gt-root';
      root.tabIndex = -1;
      root.innerHTML =
        '<div class="gt-left">' +
          this.pboxHTML(this.opp, 'opp') +
          '<div class="gt-preview"><div class="gt-preview-host"></div></div>' +
          this.pboxHTML(this.human, 'me') +
        '</div>' +
        '<div class="gt-center">' +
          '<div class="gt-bf gt-bf-opp"><div class="gt-row gt-row-lands"></div><div class="gt-row gt-row-creatures"></div></div>' +
          '<div class="gt-midbar"><span class="gt-mid-turn"></span><span class="gt-mid-step"></span><span class="gt-mid-pass"></span></div>' +
          '<div class="gt-bf gt-bf-me"><div class="gt-row gt-row-creatures"></div><div class="gt-row gt-row-lands"></div></div>' +
          '<div class="gt-hand"></div>' +
          '<div class="gt-dmodal gt-modal hidden"></div>' +
          '<div class="gt-dmodal-bar hidden"><span></span><button data-act="showModal">Show choice</button></div>' +
          '<div class="gt-toasts"></div>' +
        '</div>' +
        '<div class="gt-right">' +
          '<div class="gt-header">' +
            '<div class="gt-title"></div>' +
            '<div class="gt-hbtns">' +
              '<button class="gt-hbtn" data-act="settings" title="Settings">Settings</button>' +
              '<button class="gt-hbtn" data-act="help" title="Hotkeys and help">?</button>' +
              '<button class="gt-hbtn gt-concede" data-act="concede" title="Concede this game">Concede</button>' +
            '</div>' +
          '</div>' +
          '<div class="gt-phases panel"></div>' +
          '<div class="gt-stack panel"><div class="titlebar">Stack <span class="gt-stack-count dim"></span></div><div class="gt-stack-list"></div></div>' +
          '<div class="gt-prompt panel"></div>' +
          '<div class="gt-log panel"><div class="titlebar">Game Log <span class="gt-log-turn dim"></span></div><div class="gt-log-list"></div></div>' +
        '</div>' +
        '<svg class="gt-arrows" xmlns="http://www.w3.org/2000/svg"><defs>' +
          '<marker id="gt-ah-block" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#58a8ff"/></marker>' +
          '<marker id="gt-ah-target" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f0d000"/></marker>' +
        '</defs><g class="gt-arrow-layer"></g></svg>' +
        '<div class="gt-menu hidden"></div>' +
        '<div class="gt-imodal gt-modal hidden"></div>' +
        '<div class="gt-end hidden"></div>';
      this.container.appendChild(root);
      // If the container has no height of its own, take over the viewport.
      if (this.container.clientHeight < 200) root.classList.add('gt-fixed');
      const q = (s) => root.querySelector(s);
      this.el = {
        left: q('.gt-left'), center: q('.gt-center'), right: q('.gt-right'),
        preview: q('.gt-preview'), previewHost: q('.gt-preview-host'),
        pbox: { [this.opp]: q('.gt-pbox-opp'), [this.human]: q('.gt-pbox-me') },
        oppLands: q('.gt-bf-opp .gt-row-lands'), oppCreatures: q('.gt-bf-opp .gt-row-creatures'),
        meLands: q('.gt-bf-me .gt-row-lands'), meCreatures: q('.gt-bf-me .gt-row-creatures'),
        midTurn: q('.gt-mid-turn'), midStep: q('.gt-mid-step'), midPass: q('.gt-mid-pass'),
        hand: q('.gt-hand'), dmodal: q('.gt-dmodal'), dmodalBar: q('.gt-dmodal-bar'), toasts: q('.gt-toasts'),
        title: q('.gt-title'), phases: q('.gt-phases'), stackList: q('.gt-stack-list'), stackCount: q('.gt-stack-count'),
        prompt: q('.gt-prompt'), logList: q('.gt-log-list'), logTurn: q('.gt-log-turn'),
        arrows: q('.gt-arrows'), arrowLayer: q('.gt-arrow-layer'), menu: q('.gt-menu'), imodal: q('.gt-imodal'), end: q('.gt-end'),
      };
      if (this.opp === this.human) this.el.pbox = { [this.human]: q('.gt-pbox-me') };
      UI.setPreviewHost(this.el.previewHost);
      this.buildPhases();
      this.renderTitle();
      this.el.previewHost.innerHTML = '<div class="gt-preview-empty">Hover over a card to see it here.</div>';
    }

    pboxHTML(p, side) {
      return '<div class="gt-pbox gt-pbox-' + side + '" data-player="' + p + '">' +
        '<div class="gt-pb-head"><span class="gt-pb-name"></span><span class="gt-pb-active">ACTIVE</span><span class="gt-pb-prio" title="Waiting for this player">&#x23F3;</span></div>' +
        '<div class="gt-pb-main">' +
          '<div class="gt-pb-life" title="Life total"></div>' +
          '<div class="gt-pb-force" title="Force counters"><span class="gt-pf-sym">&#x25C8;</span><b>0</b><span class="gt-pf-lbl">Force</span></div>' +
          '<div class="gt-pb-zones">' +
            '<div class="gt-pb-zone" data-zone="library" title="Library (click for count)"><span>Library</span><b></b></div>' +
            '<div class="gt-pb-zone" data-zone="hand" title="Cards in hand"><span>Hand</span><b></b></div>' +
            '<div class="gt-pb-zone gt-zlink" data-zone="graveyard" title="Click to view graveyard"><span>Graveyard</span><b></b></div>' +
            '<div class="gt-pb-zone gt-zlink" data-zone="exile" title="Click to view exiled cards"><span>Exile</span><b></b></div>' +
          '</div>' +
        '</div>' +
        '<div class="gt-pb-foot"><span class="gt-pb-pool-l dim">Mana:</span><span class="gt-pb-pool"></span>' +
          '<span class="gt-pb-attune" title="Attunement: no Force spent this turn">ATTUNEMENT</span></div>' +
      '</div>';
    }

    buildPhases() {
      let h = '<div class="gt-ph-head"><span class="gt-ph-turn"></span></div><div class="gt-ph-grid">';
      h += '<div class="gt-ph-rowlabel"></div>';
      for (const s of STEP_BAR) h += '<div class="gt-ph-step" data-step="' + s.key + '" title="' + s.label + '">' + s.short + '</div>';
      for (const row of ['me', 'opp']) {
        h += '<div class="gt-ph-rowlabel" title="Stops during ' + (row === 'me' ? 'your' : "your opponent's") + ' turn">' + (row === 'me' ? 'You' : 'Opp') + '</div>';
        for (const s of STEP_BAR) h += '<div class="gt-ph-stop" data-stop="' + row + ':' + s.key + '" title="Stop at ' + s.label + ' (' + (row === 'me' ? 'your turn' : "opponent's turn") + ')"></div>';
      }
      h += '</div>';
      this.el.phases.innerHTML = h;
      this.updateStops();
    }

    updateStops() {
      for (const el of this.el.phases.querySelectorAll('.gt-ph-stop')) {
        const [row, key] = el.dataset.stop.split(':');
        el.classList.toggle('on', !!this.settings.stops[row][key]);
      }
    }

    renderTitle() {
      const o = this.opts;
      let h = '<span class="gt-title-text">' + esc(o.title || 'Revenge of the Sith') + '</span>';
      if (o.matchInfo && o.matchInfo.wins) {
        const w = o.matchInfo.wins;
        h += '<span class="gt-score" title="Match score (you – opponent)">' + (w[this.human] || 0) + '–' + (w[this.opp] || 0) + '</span>';
      }
      this.el.title.innerHTML = h;
    }

    // ----- events -------------------------------------------------------------
    bind() {
      const root = this.root;
      this.h = {
        click: (e) => this.onClick(e),
        input: (e) => {
          if (!e.target.classList || !e.target.classList.contains('gt-num-input')) return;
          const d = this.humanDecision();
          if (!d || d.type !== 'chooseNumber' || e.target.value === '') return;
          const v = clamp(Math.round(Number(e.target.value) || 0), d.min, d.max);
          this.ui.number = v;
          const info = this.el.prompt.querySelector('.gt-num-info');
          if (info) info.innerHTML = this.numberInfo(d, v);
          for (const q of this.el.prompt.querySelectorAll('.gt-num-q')) q.classList.toggle('on', Number(q.textContent) === v);
        },
        context: (e) => this.onContext(e),
        over: (e) => this.onOver(e),
        key: (e) => this.onKey(e),
        keyup: (e) => { if (e.key === 'Control') this.ctrlDown = false; },
        resize: () => { this.resize(); this.requestRender(true); },
        down: (e) => { if (!this.el.menu.classList.contains('hidden') && !e.target.closest('.gt-menu')) this.closeMenu(); },
      };
      root.addEventListener('click', this.h.click);
      root.addEventListener('input', this.h.input);
      root.addEventListener('contextmenu', this.h.context);
      root.addEventListener('mouseover', this.h.over);
      root.addEventListener('mousedown', this.h.down, true);
      document.addEventListener('keydown', this.h.key, true);
      document.addEventListener('keyup', this.h.keyup, true);
      window.addEventListener('resize', this.h.resize);
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => { this.resize(); this.requestRender(true); });
        this.ro.observe(root);
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      const root = this.root;
      root.removeEventListener('click', this.h.click);
      root.removeEventListener('input', this.h.input);
      root.removeEventListener('contextmenu', this.h.context);
      root.removeEventListener('mouseover', this.h.over);
      root.removeEventListener('mousedown', this.h.down, true);
      document.removeEventListener('keydown', this.h.key, true);
      document.removeEventListener('keyup', this.h.keyup, true);
      window.removeEventListener('resize', this.h.resize);
      if (this.ro) this.ro.disconnect();
      if (UI.getPreviewHost && UI.getPreviewHost() === this.el.previewHost) UI.setPreviewHost(null);
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    resize() {
      if (this.destroyed) return;
      const c = this.el.center;
      const H = c.clientHeight || 700, W = c.clientWidth || 800;
      const hh = clamp(Math.round(H * 0.215), 118, 200);
      const hw = Math.round((hh - 14) / 1.4);
      const half = (H - hh - 22) / 2;
      let bfh = clamp(Math.floor((half - 22) / 2), 56, 154);
      let bfw = Math.round(bfh / 1.4);
      if (W < 600) { bfw = Math.min(bfw, Math.round(W / 8)); bfh = Math.round(bfw * 1.4); }
      const s = this.root.style;
      s.setProperty('--hh', hh + 'px'); s.setProperty('--hw', hw + 'px');
      s.setProperty('--bfw', bfw + 'px'); s.setProperty('--bfh', bfh + 'px');
      s.setProperty('--attoff', Math.round(bfw * 0.2) + 'px');
      s.setProperty('--stackoff', Math.max(7, Math.round(bfw * 0.13)) + 'px');
      // preview size
      const lw = this.el.left.clientWidth || 260;
      const boxes = Array.from(this.el.left.querySelectorAll('.gt-pbox')).reduce((a, b) => a + b.offsetHeight, 0);
      const avail = (this.el.left.clientHeight || 700) - boxes - 70;
      const pw = clamp(Math.min(lw - 16, Math.floor(avail / 1.4)), 120, 460);
      s.setProperty('--pw', pw + 'px');
    }

    // ----- rendering ----------------------------------------------------------
    requestRender(force) {
      if (this.destroyed) return;
      if (force) this.htmlCache = {};
      if (this.rafPending) return;
      this.rafPending = true;
      const self = this;
      const run = function () { if (!self.rafPending) return; self.rafPending = false; if (!self.destroyed) self.render(); };
      requestAnimationFrame(run);
      // rAF does not fire in background tabs; keep the board current anyway.
      this.later(run, 250);
    }

    /** Render immediately (used when a human decision arrives so highlights match the prompt). */
    renderNow() { this.rafPending = false; this.render(); }

    setHTML(key, el, html) {
      if (this.htmlCache[key] === html) return false;
      this.htmlCache[key] = html;
      el.innerHTML = html;
      for (const slot of el.querySelectorAll('[data-thumb]')) slot.appendChild(this.thumb(slot.getAttribute('data-thumb')));
      return true;
    }

    thumb(key) {
      const art = key[0] === 'a';
      const id = Number(art ? key.slice(1) : key);
      const c = this.g.card(id);
      // keyed by name too: a clone (Mirrorborn Scholar) shows the card it copies, and reverts when it leaves play
      const ck = key + '|' + (c ? c.name : '');
      let t = this.thumbs.get(ck);
      if (!t) {
        t = UI.renderCardThumb(c || '?', { preview: false, useArt: art });   // basic lands: painting by card id
        this.thumbs.set(ck, t);
      }
      return t;
    }

    render() {
      if (this.destroyed) return;
      try {
        this.renderPlayers();
        this.renderBattlefield();
        this.renderHand();
        this.renderPhaseBar();
        this.renderStack();
        this.renderPrompt();
        this.renderLog();
        this.checkReveals();
        this.checkEnd();
        if (this.previewId) this.preview(this.previewId);   // keep status lines current
        this.fitRows();
        this.drawArrows();
      } catch (e) {
        console.error('[GameTable] render error', e);
      }
    }

    /** Decision currently answered through the UI (null while waiting for AI / auto answers). */
    humanDecision() {
      const d = this.g.decision;
      if (!d || this.g.over || this.controllers[d.player] || this.autoPending === d || this.drivenDecision !== d) return null;
      return d;
    }

    renderPlayers() {
      const g = this.g, d = g.decision;
      const legalPlayers = this.legalTargetPlayers();
      for (const key in this.el.pbox) {
        const p = Number(key), P = g.players[p], box = this.el.pbox[key];
        if (!P) continue;
        box.querySelector('.gt-pb-name').textContent = P.name;
        const lifeEl = box.querySelector('.gt-pb-life');
        if (lifeEl.textContent !== String(P.life)) {
          const prev = this.prevLife[p];
          lifeEl.textContent = String(P.life);
          if (prev !== undefined && prev !== P.life) {
            const cls = P.life < prev ? 'flash-down' : 'flash-up';
            lifeEl.classList.remove('flash-down', 'flash-up');
            void lifeEl.offsetWidth;
            lifeEl.classList.add(cls);
            const delta = document.createElement('div');
            delta.className = 'gt-life-delta ' + cls;
            delta.textContent = (P.life > prev ? '+' : '') + (P.life - prev);
            box.appendChild(delta);
            this.later(() => delta.remove(), 1400);
          }
          this.prevLife[p] = P.life;
        }
        const zones = { library: P.library.length, hand: P.hand.length, graveyard: P.graveyard.length, exile: P.exile.length };
        for (const z in zones) box.querySelector('[data-zone="' + z + '"] b').textContent = zones[z];
        box.querySelector('.gt-pb-pool').innerHTML = UI.poolHTML ? UI.poolHTML(P.manaPool) || '<span class="dim">—</span>' : '';
        // Force pool (Kaladesh-energy-like) with gain / spend animation; Attunement = Force spent this turn.
        const force = P.force || 0;
        const fEl = box.querySelector('.gt-pb-force');
        const fNum = fEl.querySelector('b');
        if (this.prevForce[p] === undefined) this.prevForce[p] = force;
        if (fNum.textContent !== String(force) || this.prevForce[p] !== force) {
          const prev = this.prevForce[p];
          fNum.textContent = String(force);
          if (prev !== undefined && prev !== force) {
            const cls = force < prev ? 'spend' : 'gain';
            fEl.classList.remove('spend', 'gain');
            void fEl.offsetWidth;
            fEl.classList.add(cls);
            const delta = document.createElement('div');
            delta.className = 'gt-force-delta ' + cls;
            delta.textContent = (force > prev ? '+' : '−') + Math.abs(force - prev) + ' Force';
            box.appendChild(delta);
            this.later(() => delta.remove(), 1400);
          }
          this.prevForce[p] = force;
        }
        fEl.classList.toggle('empty', force === 0);
        fEl.title = 'Force counters: ' + force + (p === this.human ? ' — spend them on “Use the Force N” costs' : '');
        const spent = P.forceSpentThisTurn || 0;
        const at = box.querySelector('.gt-pb-attune');
        at.classList.toggle('on', spent > 0 && !g.over);
        at.textContent = spent > 0 ? 'ATTUNED · ' + spent : 'ATTUNEMENT';
        at.title = spent > 0 ? 'Attunement: ' + (p === this.human ? 'you have' : P.name + ' has') + ' spent ' + spent + ' Force this turn — Attunement abilities are ON' : 'Attunement: no Force spent this turn';
        // graveyard glows when it holds a card you can cast with Afterimage right now
        const gz = box.querySelector('[data-zone="graveyard"]');
        gz.classList.toggle('gt-zplay', p === this.human && this.afterimageActions().length > 0);
        box.classList.toggle('active', !g.over && g.activePlayer === p && g.turnNumber > 0);
        box.classList.toggle('priority', !!d && !g.over && d.player === p);
        box.classList.toggle('target', legalPlayers.has(p));
        box.classList.toggle('selected', this.ui.targets.some(r => r.kind === 'player' && r.idx === p));
        box.classList.toggle('lost', !!P.lost);
      }
    }

    // ----- state classes ----------------------------------------------------
    /** Per-card interaction flags for the current human decision. */
    cardFlags(id) {
      const d = this.humanDecision();
      const f = {};
      if (!d) return f;
      const g = this.g;
      switch (d.type) {
        case 'priority': {
          const acts = this.actionsFor(d, id);
          if (acts.some(a => a.type !== 'mana')) f.playable = true;
          break;
        }
        case 'payMana':
          if (this.manaActionsFor(d.player, id, d).length) f.canpay = true;
          break;
        case 'chooseTargets':
          if (this.ui.targets.some(r => r.kind === 'card' && r.id === id)) f.selected = true;
          else if (d.legal.some(r => r.kind === 'card' && r.id === id)) f.target = true;
          break;
        case 'declareAttackers':
          if (d.candidates.includes(id)) { f.cand = true; if (this.ui.attackers.has(id)) f.declaring = true; }
          if ((d.mustAttack || []).includes(id) && !(d.attackTax > 0)) f.mustAttack = true;
          break;
        case 'declareBlockers': {
          if (d.candidates[id]) {
            f.cand = true;
            if (this.ui.pendingBlocker === id) f.pending = true;
            if (this.blocksOf(id).length) f.declaringBlock = true;
            if (this.blockLimit(d, id) > 1) f.extraBlock = true;
          }
          const pb = this.ui.pendingBlocker;
          if (pb !== null && d.candidates[pb] && d.candidates[pb].includes(id) && !this.blocksOf(pb).includes(id)) f.target = true;
          if (d.attackers.includes(id)) {
            let assigned = 0;
            for (const b of Object.keys(this.ui.blocks)) if (this.ui.blocks[b].includes(id)) assigned++;
            if (assigned > 0) f.blockedBy = true;
            if (this.hasMenace(d, id)) { f.menace = true; if (assigned === 1) f.menaceShort = true; }
          }
          if ((d.mustBeBlocked || []).includes(id)) f.mustBlock = true;
          break;
        }
        default: break;
      }
      void g;
      return f;
    }

    actionsFor(d, id) { return (d && d.type === 'priority') ? d.actions.filter(a => a.cardId === id) : []; }

    /** Usable mana abilities of permanent `id` for player p (d: current payMana decision, honours d.exclude). */
    manaActionsFor(p, id, d) {
      const g = this.g, c = g.card(id);
      if (!c || c.zone !== 'battlefield' || g.controllerOf(c) !== p) return [];
      if (d && Array.isArray(d.exclude) && d.exclude.includes(id)) return [];
      const out = [];
      g.activatedAbilities(c).forEach((ab, i) => {
        if (!ab.mana) return;
        let ok = false;
        try { ok = g.canActivateMana ? g.canActivateMana(p, c, i) : (g._canActivateMana ? g._canActivateMana(p, c, i) : true); } catch (e) { ok = false; }
        if (ok) out.push({ type: 'mana', cardId: id, ability: i, label: ab.text || 'Add mana', any: ab.mana.produce === 'ANY' });
      });
      return out;
    }

    /** Colour letters among permanents player p controls (Concord). */
    colorsAmong(p) {
      const g = this.g, set = new Set();
      for (const id of g.battlefield) {
        const c = g.card(id);
        if (!c || g.controllerOf(c) !== p) continue;
        const cols = g.colorsOf ? g.colorsOf(c) : (c.def.colors || []);
        for (const k of cols) set.add(k);
      }
      return COLORS.filter(k => set.has(k));
    }

    legalTargetPlayers() {
      const d = this.humanDecision();
      const s = new Set();
      if (d && d.type === 'chooseTargets') for (const r of d.legal) if (r.kind === 'player' && !this.ui.targets.some(t => t.kind === 'player' && t.idx === r.idx)) s.add(r.idx);
      return s;
    }

    flagClasses(f) {
      let c = '';
      if (f.playable) c += ' playable';
      if (f.canpay) c += ' canpay';
      if (f.target) c += ' target';
      if (f.selected) c += ' selected';
      if (f.cand) c += ' cand';
      if (f.declaring) c += ' declaring';
      if (f.pending) c += ' pending';
      if (f.declaringBlock) c += ' declaring-block';
      if (f.blockedBy) c += ' blocked-by';
      if (f.mustBlock) c += ' must-block';
      if (f.mustAttack) c += ' must-attack';
      if (f.extraBlock) c += ' extra-block';
      if (f.menaceShort) c += ' menace-short';
      return c;
    }

    /** Attackers currently assigned to blocker `id` in the blocker declaration being built. */
    blocksOf(id) { return this.ui.blocks[id] || []; }
    /** How many attackers blocker `id` may block (2 for "can block an additional creature"). */
    blockLimit(d, id) { return (d && d.extraBlockers && d.extraBlockers[id]) || 1; }
    /** True if attacking permanent `id` has menace (via decision metadata or cardView keywords). */
    hasMenace(d, id) {
      if (d && Array.isArray(d.menace) && d.menace.includes(id)) return true;
      const c = this.g.card(id);
      if (!c) return false;
      try {
        if (typeof this.g.hasKeyword === 'function' && this.g.hasKeyword(c, 'menace')) return true;
        const v = this.g.cardView(id);
        return !!(v && Array.isArray(v.keywords) && v.keywords.includes('menace'));
      } catch (e) { return false; }
    }
    /** Menace check for the current declareBlockers UI assignments. */
    menaceCheck(d) {
      const attackers = [], invalid = [];
      if (!d || !Array.isArray(d.attackers)) return { attackers, invalid };
      const counts = {};
      for (const b of Object.keys(this.ui.blocks)) for (const at of this.ui.blocks[b]) counts[at] = (counts[at] || 0) + 1;
      for (const id of d.attackers) {
        if (!this.hasMenace(d, id)) continue;
        attackers.push(id);
        if (counts[id] === 1) invalid.push(id);
      }
      return { attackers, invalid };
    }

    // ----- battlefield --------------------------------------------------------
    renderBattlefield() {
      const g = this.g;
      for (const p of [this.opp, this.human]) {
        if (p === this.opp && this.opp === this.human) continue;
        const ids = g.battlefield.filter(id => g.controllerOf(g.card(id)) === p);
        const isAttached = (id) => {
          const c = g.card(id);
          if (!c.attachedTo) return false;
          const h = g.card(c.attachedTo);
          return !!h && h.zone === 'battlefield';
        };
        const free = ids.filter(id => !isAttached(id));
        const creatures = free.filter(id => g.isCreature(g.card(id)));
        const lands = free.filter(id => !g.isCreature(g.card(id)) && g.isLand(g.card(id)));
        const others = free.filter(id => !g.isCreature(g.card(id)) && !g.isLand(g.card(id)));
        let ch = '';
        for (const id of creatures) ch += this.permHTML(id);
        let lh = this.landGroupsHTML(lands);
        others.forEach((id, i) => { lh += this.permHTML(id, i === 0 ? ' gt-first-other' : ''); });
        const mine = p === this.human;
        this.setHTML('cr' + p, mine ? this.el.meCreatures : this.el.oppCreatures, ch);
        this.setHTML('ld' + p, mine ? this.el.meLands : this.el.oppLands, lh);
      }
    }

    permHTML(id, extraCls) {
      const g = this.g, v = g.cardView(id);
      const f = this.cardFlags(id);
      let cls = 'gt-perm' + (extraCls || '') + this.flagClasses(f);
      if (v.tapped) cls += ' tapped';
      if (v.sick) cls += ' sick';
      if (v.attacking) cls += ' attacking';
      if (v.blocking) cls += ' blocking';
      if (v.token) cls += ' token';
      if (v.keywords && v.keywords.includes('indestructible')) cls += ' indestructible';
      if (v.dfc) {
        cls += ' dfc side-' + (v.side || 'light');
        // transform animation: the face id changed since the last render
        const was = this.prevFace[id];
        if (was !== undefined && was !== v.faceId) { this.flipUntil[id] = Date.now() + 750; this.later(() => this.requestRender(true), 800); }
        this.prevFace[id] = v.faceId;
        if (this.flipUntil[id] && Date.now() < this.flipUntil[id]) cls += ' flipping';
      }
      if (this.hoverTargets && this.hoverTargets.cards.has(id)) cls += ' hl-target';
      const atts = v.attachments || [];
      let h = '<div class="' + cls + '" data-card-id="' + id + '" style="--natt:' + atts.length + '">';
      atts.forEach((aid, i) => {
        const af = this.cardFlags(aid);
        const hl = this.hoverTargets && this.hoverTargets.cards.has(aid) ? ' hl-target' : '';
        h += '<div class="gt-att' + this.flagClasses(af) + hl + '" data-card-id="' + aid + '" style="--i:' + i + '"><div class="gt-slot" data-thumb="' + aid + '"></div></div>';
      });
      h += '<div class="gt-pcard"><div class="gt-slot" data-thumb="' + id + '"></div></div>';
      h += '<div class="gt-ov">';
      if (v.dfc) {
        const other = v.otherFace ? v.otherFace.name : '';
        h += '<div class="gt-flip ' + (v.side === 'dark' ? 'dark' : 'light') + '" title="' + (v.side === 'dark' ? 'Dark Side' : 'Light Side') + ' face' + (v.transformed ? ' (transformed)' : '') + (other ? ' — other face: ' + esc(other) : '') + '">' + (v.side === 'dark' ? '&#x263E;' : '&#x2600;') + '</div>';
        if (v.transformed && v.colorIndicator && v.colorIndicator.length) h += '<div class="gt-cind" title="Colour indicator: ' + v.colorIndicator.map(k => (COLOR_NAMES[k] || k).toLowerCase()).join(' and ') + '">' + v.colorIndicator.map(k => '<i class="gt-cc-dot gt-cc-' + k + '"></i>').join('') + '</div>';
      }
      if (v.chosenType) h += '<div class="gt-tag" title="Chosen creature type">' + esc(v.chosenType) + '</div>';
      if (v.cloneOf) h += '<div class="gt-tag gt-clone" title="' + esc((v.printedName || 'This card') + ' is copying ' + v.cloneOf) + '">copying ' + esc(v.cloneOf) + '</div>';
      const recol = this.colorChange(id, v);
      if (recol) h += '<div class="gt-recolor" title="' + esc(recol.title) + '">' + recol.html + '</div>';
      if (v.sick) h += '<div class="gt-sick" title="Summoning sick">zZ</div>';
      if (v.counters) h += '<div class="gt-counters" title="+1/+1 counters">+' + v.counters + '</div>';
      if (v.charge) h += '<div class="gt-charge" title="Charge counters: ' + v.charge + '">&#x25C6;' + v.charge + '</div>';
      const ctrs = this.otherCounters(v);
      if (ctrs.length) h += '<div class="gt-ctrs">' + ctrs.map(x => '<span class="gt-ctr gt-ctr-' + esc(x.kind) + '" title="' + esc(x.n + ' ' + x.label.toLowerCase() + ' counter' + (x.n > 1 ? 's' : '')) + '">' + esc(x.label) + ' ' + x.n + '</span>').join('') + '</div>';
      if (v.protection && v.protection.length) h += '<div class="gt-prot" title="Protection from ' + v.protection.map(k => COLOR_NAMES[k] ? COLOR_NAMES[k].toLowerCase() : k).join(' and ') + '">Pro ' + v.protection.map(k => mana('{' + k + '}')).join('') + '</div>';
      const chips = this.kwChips(id, v);
      if (chips) h += '<div class="gt-kws">' + chips + '</div>';
      if (f.mustBlock && !v.blocking) h += '<div class="gt-cbadge must">MUST BE BLOCKED</div>';
      if (f.menaceShort) h += '<div class="gt-cbadge menace">MENACE: 1/2</div>';
      if (f.mustAttack && !f.declaring) h += '<div class="gt-cbadge must">MUST ATTACK</div>';
      if (v.attacking) h += '<div class="gt-cbadge atk">ATTACKING</div>';
      else if (v.blocking) h += '<div class="gt-cbadge blk">BLOCKING</div>';
      else if (f.declaring) h += '<div class="gt-cbadge atk">ATTACK</div>';
      else if (f.declaringBlock) h += '<div class="gt-cbadge blk">BLOCK' + (this.blocksOf(id).length > 1 ? ' ×' + this.blocksOf(id).length : '') + '</div>';
      else if (f.extraBlock && f.cand) h += '<div class="gt-cbadge xblk" title="Can block an additional creature">BLOCKS 2</div>';
      if (v.power !== undefined && v.power !== null) {
        const pc = v.power > v.basePower ? 'up' : v.power < v.basePower ? 'down' : '';
        const tc = (v.damage > 0 || v.toughness < v.baseToughness) ? 'down' : v.toughness > v.baseToughness ? 'up' : '';
        h += '<div class="gt-pt" title="Power/toughness' + (v.damage ? ' (' + v.damage + ' damage marked)' : '') + '"><span class="' + pc + '">' + v.power + '</span>/<span class="' + tc + '">' + v.toughness + '</span></div>';
        if (v.damage > 0) h += '<div class="gt-dmg" title="Damage marked">' + v.damage + '</div>';
      }
      h += '</div></div>';
      return h;
    }

    /** Short keyword chips: granted keywords (e.g. by Concord) plus ones that are easy to miss. */
    kwChips(id, v) {
      const kws = v.keywords || [];
      if (!kws.length) return '';
      const c = this.g.card(id);
      const printed = (c && c.def && c.def.keywords) || [];
      let h = '', n = 0;
      for (const k of kws) {
        const chip = KW_CHIPS[k];
        if (!chip) continue;
        if (printed.includes(k) && !KW_ALWAYS.includes(k)) continue;
        if (n++ >= 4) break;
        h += '<span class="gt-kw gt-kw-' + k + ' kw-' + k + (printed.includes(k) ? '' : ' granted') + '" title="' + esc(chip[1]) + (printed.includes(k) ? '' : ' (granted)') + '">' + chip[0] + '</span>';
      }
      return h;
    }

    /** Generic counters other than +1/+1 and charge: [{kind, label, n}]. */
    otherCounters(v) {
      const m = v.counterMap || {};
      const out = [];
      for (const k of Object.keys(m).sort()) {
        if (k === 'p1p1' || k === 'charge' || !(m[k] > 0)) continue;
        out.push({ kind: k, label: COUNTER_NAMES[k] || (k.charAt(0).toUpperCase() + k.slice(1)), n: m[k] });
      }
      return out;
    }

    /** Colour-changing effects: {html, title} when the permanent's colours differ from its printed colours. */
    colorChange(id, v) {
      const c = this.g.card(id);
      if (!c || !Array.isArray(v.colors)) return null;
      const printed = (c.def && c.def.colors) || [];
      if (v.dfc) return null;   // a turned DFC shows its colour indicator instead
      const now = COLORS.filter(k => v.colors.includes(k));
      const was = COLORS.filter(k => printed.includes(k));
      if (now.join('') === was.join('')) return null;
      const name = (ks) => ks.length ? ks.map(k => COLOR_NAMES[k].toLowerCase()).join(' and ') : 'colorless';
      return { html: now.length ? now.map(k => '<i class="gt-cc-dot gt-cc-' + k + '"></i>').join('') : '<i class="gt-cc-dot gt-cc-none"></i>', title: 'Now ' + name(now) + ' (printed: ' + name(was) + ')' };
    }

    landGroupsHTML(lands) {
      const g = this.g;
      const groups = [];
      const byKey = {};
      for (const id of lands) {
        const c = g.card(id);
        const f = this.cardFlags(id);
        const v = g.cardView(id);
        const stackable = g.isBasicLand(c) && !(v.attachments && v.attachments.length) && !f.selected && !(this.hoverTargets && this.hoverTargets.cards.has(id));
        const key = stackable ? c.name + '|' + (c.tapped ? 1 : 0) + '|' + this.flagClasses(f) : 'u' + id;
        if (!byKey[key]) { byKey[key] = { ids: [], flags: f, tapped: c.tapped }; groups.push(byKey[key]); }
        byKey[key].ids.push(id);
      }
      let h = '';
      for (const gr of groups) {
        if (gr.ids.length === 1) { h += this.permHTML(gr.ids[0]); continue; }
        const n = gr.ids.length;
        h += '<div class="gt-perm gt-landstack' + (gr.tapped ? ' tapped' : '') + this.flagClasses(gr.flags) + '" data-card-id="' + gr.ids[0] + '" data-card-ids="' + gr.ids.join(' ') + '" style="--n:' + n + '">';
        gr.ids.forEach((id, k) => { h += '<div class="gt-pcard" style="--k:' + k + '"><div class="gt-slot" data-thumb="' + id + '"></div></div>'; });
        h += '<div class="gt-ov"><div class="gt-count">' + n + '</div></div></div>';
      }
      return h;
    }

    renderHand() {
      const g = this.g, P = g.players[this.human];
      let h = '';
      for (const id of P.hand) {
        const f = this.cardFlags(id);
        h += '<div class="gt-hcard' + this.flagClasses(f) + '" data-card-id="' + id + '"><div class="gt-slot" data-thumb="' + id + '"></div></div>';
      }
      if (!P.hand.length) h = '<div class="gt-hand-empty dim">Your hand is empty.</div>';
      this.setHTML('hand', this.el.hand, h);
    }

    fitRows() {
      const rows = [this.el.oppLands, this.el.oppCreatures, this.el.meCreatures, this.el.meLands, this.el.hand];
      for (const row of rows) {
        const kids = Array.from(row.children).filter(k => !k.classList.contains('gt-hand-empty'));
        const gap = row === this.el.hand ? 6 : 6;
        kids.forEach((k, i) => { k.style.marginLeft = i === 0 ? '' : gap + 'px'; });
        if (kids.length < 2) continue;
        const avail = row.clientWidth - 12;
        let total = 0;
        for (const k of kids) total += k.offsetWidth;
        total += gap * (kids.length - 1);
        const firstOther = kids.find(k => k.classList.contains('gt-first-other'));
        if (total > avail) {
          const m = gap - (total - avail) / (kids.length - 1);
          kids.forEach((k, i) => { if (i > 0) k.style.marginLeft = m + 'px'; });
        } else if (firstOther && firstOther !== kids[0]) {
          firstOther.style.marginLeft = 'auto';
        }
      }
    }

    /** Number of additional combat phases begun this turn (from the engine's log; 0 in the first combat). */
    extraCombatNo() {
      const g = this.g;
      if (!g.logs || !g.turnNumber) return 0;
      if (this._xcSeen === g.logs.length && this._xcTurn === g.turnNumber) return this._xcN;
      let n = 0;
      for (let i = g.logs.length - 1; i >= 0; i--) {
        const l = g.logs[i];
        if (l.turn !== undefined && l.turn !== g.turnNumber) break;
        if (/^Additional combat phase/.test(String(l.text))) n++;
      }
      this._xcSeen = g.logs.length; this._xcTurn = g.turnNumber; this._xcN = n;
      return n;
    }

    renderPhaseBar() {
      const g = this.g;
      const cur = g.over ? null : stepKey(g.step);
      const mine = g.activePlayer === this.human;
      for (const el of this.el.phases.querySelectorAll('.gt-ph-step')) {
        el.classList.toggle('current', el.dataset.step === cur);
        el.classList.toggle('mine', mine);
        el.classList.toggle('theirs', !mine);
      }
      const P = g.players[g.activePlayer];
      const turnTxt = g.turnNumber > 0 ? 'Turn ' + g.turnNumber + ' · ' + (mine ? 'Your turn' : esc(P.name) + "'s turn") : 'Game setup';
      const ph = this.el.phases.querySelector('.gt-ph-turn');
      ph.innerHTML = turnTxt;
      ph.className = 'gt-ph-turn ' + (mine ? 'mine' : 'theirs');
      this.el.midTurn.textContent = g.over ? 'Game over' : (g.turnNumber > 0 ? (mine ? 'Your turn' : P.name + "'s turn") : 'Pregame');
      this.el.midTurn.className = 'gt-mid-turn ' + (mine ? 'mine' : 'theirs');
      const xc = this.extraCombatNo();
      const inCombat = ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'].includes(g.step);
      this.el.midStep.textContent = g.step && !g.over ? (OF.STEP_NAMES ? OF.STEP_NAMES[g.step] : g.step) + (xc && (inCombat || g.step === 'main2') ? ' (additional ' + (inCombat ? 'combat' : 'main phase') + (xc > 1 ? ' ' + xc : '') + ')' : '') : '';
      let pass = '';
      if (this.passMode === 'F4') pass = 'Passing until something happens (F4) — Esc to stop';
      else if (this.passMode === 'F6') pass = 'Passing until end of turn (F6) — Esc to stop';
      else if (this.pendingConcede) pass = 'Conceding…';
      this.el.midPass.textContent = pass;
      this.el.logTurn.textContent = g.turnNumber > 0 ? 'Turn ' + g.turnNumber : '';
    }

    renderStack() {
      const g = this.g;
      const items = g.stackView ? g.stackView() : [];
      this.el.stackCount.textContent = items.length ? '(' + items.length + ')' : '';
      const d = this.humanDecision();
      const legalSids = new Set();
      const selSids = new Set();
      if (d && d.type === 'chooseTargets') {
        for (const r of d.legal) if (r.kind === 'stack') legalSids.add(r.sid);
        for (const r of this.ui.targets) if (r.kind === 'stack') selSids.add(r.sid);
      }
      let h = '';
      for (let i = items.length - 1; i >= 0; i--) {
        const s = items[i];
        const c = g.card(s.cardId);
        const data = c ? c.def.data : null;
        const mine = s.controller === this.human;
        let txt = s.text || '';
        if (!txt && data) txt = data.printed_rules || '';
        if (txt.length > 160) txt = txt.slice(0, 157) + '…';
        const tg = (s.targets || []).map(t => {
          if (t.player !== undefined) return esc(g.players[t.player].name);
          if (t.sid !== undefined) { const it = items.find(x => x.sid === t.sid); return it ? esc(it.name) + ' (stack)' : 'a spell'; }
          const tc = g.card(t.cardId); return tc ? '<span class="gt-clink" data-card-name="' + esc(tc.name) + '">' + esc(tc.name) + '</span>' : '?';
        }).join(', ');
        const raw = g.stack.find(x => x.sid === s.sid);
        const isCopy = !!(raw && raw.isCopy);
        const kind = s.kind === 'spell' ? (isCopy ? 'Spell copy (not played)' : 'Spell') : s.kind === 'trigger' ? 'Triggered ability' : 'Activated ability';
        const sname = isCopy && !/\(copy\)/.test(s.name) ? s.name + ' (copy)' : s.name;
        const xv = raw && raw.kind === 'spell' && raw.card && raw.card.def && raw.card.def.cost && raw.card.def.cost.X ? ' <span class="gt-sx">X=' + (raw.x || 0) + '</span>' : '';
        let cls = 'gt-sitem ' + (mine ? 'mine' : 'theirs') + (i === items.length - 1 ? ' top' : '') + (isCopy ? ' copy' : '');
        if (legalSids.has(s.sid)) cls += ' target';
        if (selSids.has(s.sid)) cls += ' selected';
        h += '<div class="' + cls + '" data-sid="' + s.sid + '" data-stack-card="' + s.cardId + '">' +
          '<div class="gt-sart gt-slot" data-thumb="a' + s.cardId + '"></div>' +
          '<div class="gt-sbody"><div class="gt-sname">' + esc(sname) + xv + '</div>' +
          '<div class="gt-skind">' + kind + ' · ' + esc(g.players[s.controller].name) + '</div>' +
          (txt ? '<div class="gt-stext">' + mana(txt) + '</div>' : '') +
          (tg ? '<div class="gt-stgt">&#x2192; ' + tg + '</div>' : '') + '</div></div>';
      }
      if (!items.length) h = '<div class="gt-stack-empty dim">The stack is empty.</div>';
      this.setHTML('stack', this.el.stackList, h);
    }

    renderLog() {
      const g = this.g, list = this.el.logList;
      if (this.logCount === g.logs.length) return;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
      const frag = document.createDocumentFragment();
      for (let i = this.logCount; i < g.logs.length; i++) {
        const l = g.logs[i];
        const div = document.createElement('div');
        const txt = String(l.text);
        div.className = 'gt-log-line' + (/^— Turn/.test(txt) ? ' gt-log-turnline' : '') +
          (/Force counter|uses the Force|Use the Force/.test(txt) ? ' gt-log-force' : '') +
          (/compromise/i.test(txt) ? ' gt-log-compromise' : '') +
          (/turns to the (Dark|Light) Side/.test(txt) ? ' gt-log-turn' + (/Dark Side/.test(txt) ? ' dark' : ' light') : '') +
          (/\(Afterimage\)/.test(txt) ? ' gt-log-afterimage' : '');
        div.innerHTML = linkify(txt);
        frag.appendChild(div);
      }
      this.logCount = g.logs.length;
      list.appendChild(frag);
      while (list.children.length > 800) list.removeChild(list.firstChild);
      if (atBottom || true) list.scrollTop = list.scrollHeight;
    }

    // ----- prompt -------------------------------------------------------------
    renderPrompt() {
      const g = this.g;
      const d = g.decision;
      let title = '', text = '', btns = [];
      const B = (act, label, o) => Object.assign({ act, label }, o || {});
      if (g.over) {
        title = 'Game over';
        text = this.resultText();
      } else if (!d) {
        title = 'Please wait';
      } else if (this.controllers[d.player] || this.autoPending === d || this.drivenDecision !== d) {
        title = 'Waiting';
        const nm = esc(g.players[d.player].name);
        const what = {
          priority: '', declareAttackers: ' is declaring attackers', declareBlockers: ' is declaring blockers',
          mulligan: ' is deciding on a mulligan', playFirst: ' is choosing who plays first', payMana: ' is paying mana',
          chooseTargets: ' is choosing targets', chooseCards: ' is choosing cards', chooseNumber: ' is choosing a number',
        }[d.type];
        text = this.controllers[d.player] ? 'Waiting for ' + nm + (what || '') + (this.controllers[d.player].remote ? ' <span class="dim">(network)</span>' : '') + '…' : 'Passing…';
        if (this.passMode) btns.push(B('cancelPass', 'Stop passing (Esc)'));
      } else {
        const m = this.promptFor(d);
        title = m.title; text = m.text; btns = m.buttons;
        if (d.type === 'priority' && this.passMode) btns.push(B('cancelPass', 'Stop passing (Esc)'));
      }
      let h = '<div class="titlebar gt-prompt-title">' + title + '</div><div class="gt-prompt-body"><div class="gt-prompt-text">' + text + '</div>';
      if (this.ui.error && d && this.ui.d === d) h += '<div class="gt-prompt-error">' + esc(this.ui.error) + '</div>';
      h += '<div class="gt-prompt-btns">';
      for (const b of btns) {
        h += '<button class="' + (b.primary ? 'primary ' : '') + (b.cls || '') + '" data-act="' + esc(b.act) + '"' +
          (b.primary ? ' data-primary="1"' : '') + (b.cancel ? ' data-cancel="1"' : '') + (b.disabled ? ' disabled' : '') +
          (b.title ? ' title="' + esc(b.title) + '"' : '') + '>' + b.label + '</button>';
      }
      h += '</div></div>';
      const ae = document.activeElement;
      const hadFocus = !!(ae && ae.classList && ae.classList.contains('gt-num-input') && this.el.prompt.contains(ae));
      if (this.setHTML('prompt', this.el.prompt, h) && hadFocus) {
        const inp = this.el.prompt.querySelector('.gt-num-input');
        if (inp) { try { inp.focus(); inp.select(); } catch (e) { /* ignore */ } }
      }
      this.el.prompt.classList.toggle('yours', !!this.humanDecision());
      const hd = this.humanDecision();
      this.el.prompt.classList.toggle('compromise', !!(hd && (hd.reason === 'compromise' || /compromise/i.test(hd.prompt || ''))));
    }

    sourceName(d) {
      if (!d.sourceId) return '';
      const c = this.g.card(d.sourceId);
      return c ? '<span class="gt-clink" data-card-name="' + esc(c.name) + '">' + esc(c.name) + '</span>' : '';
    }

    promptFor(d) {
      const g = this.g;
      const B = (act, label, o) => Object.assign({ act, label }, o || {});
      const src = this.sourceName(d);
      const srcLine = src ? '<div class="gt-prompt-src">Source: ' + src + '</div>' : '';
      switch (d.type) {
        case 'priority': {
          const mine = g.activePlayer === this.human;
          const top = g.stack[g.stack.length - 1];
          let text;
          if (top) {
            const who = top.controller === this.human ? 'Your' : esc(g.players[top.controller].name) + '’s';
            text = who + ' <span class="gt-clink" data-card-name="' + esc(top.name) + '">' + esc(top.name) + '</span> is on the stack. Respond with an instant or ability, or press OK to let it resolve.';
          } else if (mine && (g.step === 'main1' || g.step === 'main2')) {
            const land = d.actions.some(a => a.type === 'playLand');
            text = (land ? 'Play a land, cast' : 'Cast') + ' spells or activate abilities. Press OK to ' + (g.step === 'main1' ? 'go to combat' : 'end your turn') + '.';
          } else if (!mine && g.step === 'declareAttackers' && g.combat && g.combat.attackers.length) {
            text = esc(g.players[g.activePlayer].name) + ' attacks with ' + g.combat.attackers.length + ' creature' + (g.combat.attackers.length > 1 ? 's' : '') + '. You may cast instants or activate abilities before blocks. OK to continue.';
          } else {
            text = (OF.STEP_NAMES ? OF.STEP_NAMES[g.step] : g.step) + ' — ' + (mine ? 'your turn' : esc(g.players[g.activePlayer].name) + '’s turn') + '. You have priority. OK to continue.';
          }
          const pool = g.players[this.human].manaPool;
          if (UI.poolHTML && UI.poolHTML(pool)) text += '<div class="gt-prompt-pool">Mana pool: ' + UI.poolHTML(pool) + ' <span class="dim">(empties at end of step)</span></div>';
          return {
            title: (OF.STEP_NAMES ? OF.STEP_NAMES[g.step] : g.step) + ' — your priority',
            text,
            buttons: [B('pass', 'OK', { primary: true, title: 'Pass priority (F2)' }), B('f6', 'End turn', { title: 'Pass until end of turn (F6)' }), B('f4', 'F4', { title: 'Pass until something happens (F4)' })],
          };
        }
        case 'payMana': {
          const can = d.canAuto;
          if (d.optional && d.reason === 'attackTax') {
            return {
              title: 'Attack tax',
              text: '<div class="gt-prompt-cost">Pay ' + mana(d.costString) + ' to attack</div>' +
                '<div>' + esc(d.prompt).replace(/\{[^}]+\}/g, m => mana(m)) + '</div>' +
                '<div class="dim gt-small">An opponent’s card makes creatures pay to attack (e.g. Law of Shared Shelter). Decline and no creatures attack this combat.</div>',
              buttons: [B('autopay', 'Pay and attack', { primary: true, disabled: !can, title: can ? 'Tap mana automatically (F2)' : 'Not enough mana available' }), B('paycancel', 'Don’t attack', { cancel: true })],
            };
          }
          if (d.optional) {
            return {
              title: 'Optional payment',
              text: esc(d.prompt).replace(/\{[^}]+\}/g, m => mana(m)) + srcLine + '<div class="gt-prompt-cost">Remaining: ' + mana(d.costString) + '</div><div class="dim gt-small">Click mana sources to pay manually, or Pay to tap automatically.</div>',
              buttons: [B('autopay', 'Pay', { primary: true, disabled: !can }), B('paycancel', 'Decline', { cancel: true })],
            };
          }
          let div = '';
          if (d.diverse) {
            const sp = this.g.lastSpent || {};
            const done = COLORS.filter(k => sp[k] > 0);
            div = '<div class="gt-prompt-diverse">&#x2726; This spell rewards spending <b>different colours</b> of mana (Confluence / Sunburst). ' +
              'Auto-pay spends as many colours as it can; tap sources yourself to choose them.' +
              (done.length ? '<div>Colours spent so far: ' + done.map(k => mana('{' + k + '}')).join('') + ' <b>(' + done.length + ')</b></div>' : '') + '</div>';
          }
          return {
            title: 'Pay mana',
            text: '<div class="gt-prompt-cost">Pay ' + mana(d.costString) + '</div>' + srcLine + div + '<div class="dim gt-small">Click your lands / mana sources to pay, or press Auto-pay.</div>',
            buttons: [B('autopay', 'Auto-pay', { primary: true, disabled: !can, title: can ? 'Tap mana automatically (F2)' : 'Not enough mana available' }), d.cancellable ? B('paycancel', 'Cancel', { cancel: true, title: 'Cancel (Esc)' }) : null].filter(Boolean),
          };
        }
        case 'chooseTargets': {
          const n = this.ui.targets.length;
          const range = d.min === d.max ? String(d.max) : d.min + '–' + d.max;
          const sel = this.ui.targets.map(r => this.refName(r)).join(', ');
          const hasPicker = d.legal.some(r => r.kind === 'card' && this.g.card(r.id) && this.g.card(r.id).zone !== 'battlefield');
          const stackT = d.legal.some(r => r.kind === 'stack');
          let hint = 'Click a highlighted ' + (stackT ? 'item on the stack' : hasPicker ? 'card in the selection window' : 'card or player') + '.';
          const buttons = [];
          const ready = n >= d.min && n <= d.max;
          if (d.max > 1 || d.min < d.max || d.min === 0) buttons.push(B('targetsDone', n === 0 && d.min === 0 ? 'No target' : 'Done', { primary: true, disabled: !ready }));
          if (hasPicker) buttons.push(B('targetsPicker', 'Show cards'));
          if (d.cancellable) buttons.push(B('targetsCancel', 'Cancel', { cancel: true }));
          return {
            title: 'Choose target' + (d.max > 1 ? 's' : '') + (d.max > 1 || d.min !== 1 ? ' (' + range + ')' : ''),
            text: esc(d.prompt) + srcLine + '<div class="dim gt-small">' + hint + '</div>' + (sel ? '<div class="gt-prompt-sel">Selected: ' + sel + '</div>' : ''),
            buttons,
          };
        }
        case 'declareAttackers': {
          const n = this.ui.attackers.size;
          const tax = d.attackTax > 0 ? d.attackTax : 0;
          const must = tax ? [] : (d.mustAttack || []).filter(id => this.g.card(id));
          const link = (id) => '<span class="gt-clink" data-card-name="' + esc(this.g.card(id).name) + '">' + esc(this.g.card(id).name) + '</span>';
          let extra = '';
          if (must.length) extra += '<div class="gt-prompt-must">&#x26A0; ' + must.map(link).join(', ') + ' must attack this turn if able (highlighted).</div>';
          if (tax) extra += '<div class="gt-prompt-tax">&#x26A0; Attacking costs ' + mana('{' + tax + '}') + ' per creature' + (n ? ': <b>' + mana('{' + tax * n + '}') + '</b> for ' + n : '') + '. You pay after declaring; creatures that “attack each turn if able” need not attack.</div>';
          if (this.extraCombatNo()) extra += '<div class="gt-prompt-xcombat">Additional combat phase' + (this.extraCombatNo() > 1 ? ' (' + this.extraCombatNo() + ')' : '') + '.</div>';
          return {
            title: 'Declare attackers',
            text: 'Click creatures to toggle them as attackers. ' + (n ? '<b>' + n + '</b> attacking.' : 'No attackers selected.') + extra + '<div class="dim gt-small">OK with no attackers skips combat.</div>',
            buttons: [B('atkOK', n ? 'Attack (' + n + ')' : 'No attack', { primary: true }), B('atkAll', 'Attack with all', { disabled: n === d.candidates.length }), B('atkClear', 'Clear', { disabled: n === must.length })],
          };
        }
        case 'declareBlockers': {
          const pairs = [];
          for (const b of Object.keys(this.ui.blocks)) for (const at of this.ui.blocks[b]) pairs.push(esc(this.g.card(Number(b)).name) + ' &#x2192; ' + esc(this.g.card(at).name));
          const pb = this.ui.pendingBlocker;
          const pbHas = pb !== null ? this.blocksOf(pb).length : 0;
          let text = pb !== null
            ? (pbHas ? '<b>' + esc(this.g.card(pb).name) + '</b> can block an additional creature: click a second attacker for it (or click it again to remove its blocks).'
              : 'Now click the attacking creature that <b>' + esc(this.g.card(pb).name) + '</b> should block.')
            : 'Click one of your untapped creatures, then the attacker it should block. Click a blocker again to remove it.';
          const xb = Object.keys(d.extraBlockers || {}).filter(b => this.blockLimit(d, Number(b)) > 1 && this.g.card(Number(b)));
          if (xb.length) text += '<div class="dim gt-small">' + xb.map(b => esc(this.g.card(Number(b)).name)).join(', ') + (xb.length > 1 ? ' can' : ' can') + ' block an additional creature (click it, then two attackers).</div>';
          const must = (d.mustBeBlocked || []).filter(id => this.g.card(id));
          const mustTxt = must.length ? '<div class="gt-prompt-must">&#x26A0; ' + must.map(id => '<span class="gt-clink" data-card-name="' + esc(this.g.card(id).name) + '">' + esc(this.g.card(id).name) + '</span>').join(', ') +
            ' must be blocked if able (highlighted in red).</div>' : '';
          const mc = this.menaceCheck(d);
          const linkC = (id) => '<span class="gt-clink" data-card-name="' + esc(this.g.card(id).name) + '">' + esc(this.g.card(id).name) + '</span>';
          const menaceHint = mc.attackers.length ? '<div class="gt-prompt-menace"><b>Menace</b> — must be blocked by 2+ creatures (' + mc.attackers.filter(id => this.g.card(id)).map(linkC).join(', ') + ').</div>' : '';
          const menaceWarn = mc.invalid.length ? '<div class="gt-prompt-must">&#x26A0; ' + mc.invalid.filter(id => this.g.card(id)).map(linkC).join(', ') + ' has menace — assign a second blocker or remove its blocker.</div>' : '';
          return {
            title: 'Declare blockers',
            text: text + menaceHint + menaceWarn + mustTxt + (pairs.length ? '<div class="gt-prompt-sel">' + pairs.join('<br>') + '</div>' : '<div class="dim gt-small">No blocks assigned.</div>'),
            buttons: [B('blkOK', pairs.length ? 'Confirm Blockers' : 'No blocks', { primary: true, disabled: mc.invalid.length > 0, title: mc.invalid.length > 0 ? 'Menace attackers must be blocked by 0 or 2+ creatures' : 'Confirm blockers (F2)' }), B('blkClear', 'Clear', { disabled: !pairs.length && pb === null })],
          };
        }
        case 'chooseNumber': return this.numberPrompt(d, srcLine);
        case 'yesNo': {
          if (d.reason === 'payForce') {
            const have = g.players[d.player].force || 0;
            return { title: 'Use the Force?', text: esc(d.prompt) + '<div class="gt-prompt-pool">Your Force pool: <b class="gt-force-inline">&#x25C8; ' + have + '</b></div>' + srcLine,
              buttons: [B('yes', 'Pay ' + (d.amount || '') + ' Force', { primary: true, disabled: have < (d.amount || 0) }), B('no', 'Don’t pay', { cancel: true })] };
          }
          if (d.reason === 'compromise' || /compromise/i.test(d.prompt || '')) {
            const meP = g.players[d.player], oppP = g.players[1 - d.player];
            const info = '<div class="gt-prompt-pool">Your life: <b>' + meP.life + '</b>' + (oppP ? ' · ' + esc(oppP.name) + '’s Force: <b class="gt-force-inline">&#x25C8; ' + (oppP.force || 0) + '</b>' : '') + '</div>';
            return { title: d.amount ? 'Compromise ' + d.amount : 'Compromise', text: mana(d.prompt) + info + srcLine,
              buttons: [B('yes', esc(d.yesLabel || 'Yes'), { primary: true, cls: 'gt-compromise-btn' }), B('no', esc(d.noLabel || 'No'), { cancel: true, cls: 'gt-compromise-btn' })] };
          }
          return { title: 'Choose', text: mana(d.prompt) + srcLine, buttons: [B('yes', esc(d.yesLabel || 'Yes'), { primary: true }), B('no', esc(d.noLabel || 'No'), { cancel: true })] };
        }
        case 'chooseColor':
          return {
            title: 'Choose a color', text: esc(d.prompt) + srcLine,
            buttons: d.colors.map(c => B('color:' + c, mana('{' + c + '}') + ' ' + COLOR_NAMES[c], { cls: 'gt-colorbtn' })),
          };
        case 'chooseOption': {
          const isComp = d.reason === 'compromise' || /compromise/i.test(d.prompt || '');
          if (d.options.length <= 6 && d.reason !== 'creatureType') {
            const meP = g.players[d.player], oppP = g.players[1 - d.player];
            const compInfo = isComp ? '<div class="gt-prompt-pool">Your life: <b>' + meP.life + '</b>' + (oppP ? ' · ' + esc(oppP.name) + '’s Force: <b class="gt-force-inline">&#x25C8; ' + (oppP.force || 0) + '</b>' : '') + '</div>' : '';
            return { title: isComp ? (d.amount ? 'Compromise ' + d.amount : 'Compromise') : 'Choose one', text: mana(d.prompt) + compInfo + srcLine,
              buttons: d.options.map((o, i) => B('opt:' + i, mana(o.label), { primary: isComp && i === 0, cls: isComp ? 'gt-compromise-btn' : '' })) };
          }
          return { title: 'Choose one', text: esc(d.prompt) + srcLine + '<div class="dim gt-small">Make your choice in the selection window.</div>', buttons: [B('showModal', 'Show list')] };
        }
        case 'chooseCards':
          return { title: 'Choose cards', text: esc(d.prompt) + srcLine + '<div class="dim gt-small">Make your choice in the selection window.</div>', buttons: [B('showModal', 'Show cards')] };
        case 'orderCards':
          return { title: 'Order cards', text: esc(d.prompt) + '<div class="dim gt-small">Arrange the cards in the window.</div>', buttons: [B('showModal', 'Show cards')] };
        case 'mulligan':
          return {
            title: 'Mulligan', text: esc(d.prompt) + (d.mulligans ? '<div class="dim gt-small">Mulligans so far: ' + d.mulligans + '</div>' : ''),
            buttons: [B('keep', 'Keep', { primary: true }), B('mull', 'Mulligan', { disabled: d.hand.length === 0 })],
          };
        case 'playFirst':
          return { title: 'Play or draw?', text: 'You choose who plays first.', buttons: [B('playFirst', 'Play first', { primary: true }), B('drawFirst', 'Draw first')] };
        default:
          return { title: d.type, text: esc(d.prompt || ''), buttons: [] };
      }
    }

    /** Default / current value of the number picker for a chooseNumber decision. */
    numberValue(d) {
      if (this.ui.number === undefined || this.ui.number === null) {
        this.ui.number = d.reason === 'x' ? d.max : d.reason === 'divide' ? Math.ceil((d.min + d.max) / 2) : d.min;
      }
      this.ui.number = clamp(Math.round(Number(this.ui.number) || 0), d.min, d.max);
      return this.ui.number;
    }

    /** Explanation line under the number picker (X cost or damage division). */
    numberInfo(d, n) {
      const g = this.g;
      if (d.reason === 'divide' && Array.isArray(d.targets) && d.targets.length >= 2) {
        const a = g.card(d.targets[0]), b = g.card(d.targets[1]);
        const total = d.max + 1;
        return (a ? '<b>' + n + '</b> to ' + esc(a.name) : n) + ', <b>' + (total - n) + '</b> to ' + (b ? esc(b.name) : 'the other target');
      }
      if (d.reason === 'x' && d.sourceId) {
        const c = g.card(d.sourceId);
        if (c && c.def && c.def.cost && OF.util && OF.util.costToString) {
          const cost = OF.util.cloneCost ? OF.util.cloneCost(c.def.cost) : JSON.parse(JSON.stringify(c.def.cost));
          cost.generic += n * (cost.X || 1); cost.X = 0;
          return 'X = <b>' + n + '</b> &#x2192; total cost ' + mana(OF.util.costToString(cost));
        }
        return 'X = <b>' + n + '</b>';
      }
      return 'Chosen: <b>' + n + '</b>';
    }

    numberPrompt(d, srcLine) {
      const B = (act, label, o) => Object.assign({ act, label }, o || {});
      const n = this.numberValue(d);
      const quick = [];
      const span = d.max - d.min;
      const push = (v) => { if (v >= d.min && v <= d.max && !quick.includes(v)) quick.push(v); };
      if (span <= 6) for (let v = d.min; v <= d.max; v++) push(v);
      else { push(d.min); push(d.min + 1); push(Math.round((d.min + d.max) / 2)); push(d.max - 1); push(d.max); }
      quick.sort((a, b) => a - b);
      const title = d.reason === 'x' ? 'Choose X' : d.reason === 'divide' ? 'Divide damage' : 'Choose a number';
      const picker = '<div class="gt-numpick">' +
        '<button class="gt-num-btn" data-act="num-" title="Decrease"' + (n <= d.min ? ' disabled' : '') + '>&#x2212;</button>' +
        '<input class="gt-num-input" type="number" min="' + d.min + '" max="' + d.max + '" value="' + n + '" aria-label="Number">' +
        '<button class="gt-num-btn" data-act="num+" title="Increase"' + (n >= d.max ? ' disabled' : '') + '>+</button>' +
        '<span class="gt-num-range dim">' + d.min + '–' + d.max + '</span></div>' +
        '<div class="gt-numquick">' + quick.map(v => '<button class="gt-num-q' + (v === n ? ' on' : '') + '" data-act="numset:' + v + '">' + v + '</button>').join('') + '</div>' +
        '<div class="gt-num-info">' + this.numberInfo(d, n) + '</div>';
      const buttons = [B('numOK', 'OK', { primary: true, title: 'Confirm (F2 / Enter)' })];
      if (d.cancellable) buttons.push(B('numCancel', 'Cancel', { cancel: true, title: 'Cancel (Esc)' }));
      return { title, text: esc(d.prompt) + srcLine + picker, buttons };
    }

    setNumber(v) {
      const d = this.humanDecision();
      if (!d || d.type !== 'chooseNumber') return;
      this.ui.number = clamp(Math.round(Number(v) || 0), d.min, d.max);
      this.ui.error = '';
      this.renderPrompt();
    }

    refName(r) {
      if (r.kind === 'player') return esc(this.g.players[r.idx].name);
      if (r.kind === 'stack') { const s = this.g.stack.find(x => x.sid === r.sid); return s ? esc(s.name) + ' (stack)' : 'stack item'; }
      const c = this.g.card(r.id);
      return c ? esc(c.name) : '?';
    }

    resultText() {
      const g = this.g;
      if (g.winner === -1 || g.winner === null || g.winner === undefined) return 'The game is a draw.';
      return (g.winner === this.human ? 'You win' : esc(g.players[g.winner].name) + ' wins') + ' (' + esc(END_REASONS[g.endReason] || g.endReason) + ').';
    }

    // ----- driving the game ---------------------------------------------------
    scheduleDrive(ms) {
      if (this.driveTimer) return;
      const self = this;
      this.driveTimer = this.later(function () { self.driveTimer = null; self.drive(); }, ms || 0);
    }

    drive() {
      if (this.destroyed) return;
      const g = this.g;
      if (g.crash) { this.engineError(g.crash); return; }
      if (g.over) { this.closeDecisionModal(); this.requestRender(); return; }
      const d = g.decision;
      if (!d) return;
      if (this.pendingConcede && !this.controllers[d.player]) {
        this.pendingConcede = false;
        this.respondSafe({ type: 'concede' });
        this.scheduleDrive(0);
        return;
      }
      if (d === this.drivenDecision) return;
      this.drivenDecision = d;
      const ctrl = this.controllers[d.player];
      if (ctrl && ctrl.remote) {
        // Network opponent (lockstep multiplayer): wait for their answer.
        this.closeDecisionModal();
        this.ui = this.freshInteraction(null);
        this.waitingRemote = d;
        const self = this;
        ctrl.wait(this.g, d, function (ans) {
          if (self.destroyed || self.g.decision !== d) return;
          self.waitingRemote = null;
          const r = self.respondSafe(ans);
          if (!r.ok && !r.crashed && typeof self.opts.onDesync === 'function') self.opts.onDesync(r.error, d, ans);
          self.scheduleDrive(0);
        });
        this.requestRender();
        return;
      }
      if (ctrl) {
        this.closeDecisionModal();
        this.ui = this.freshInteraction(null);
        this.runAI(d, ctrl);
        this.requestRender();
        return;
      }
      this.onHumanDecision(d);
    }

    respondSafe(ans) {
      try {
        const d = this.g.decision;
        const r = this.g.respond(ans);
        // Report accepted answers of the local human (used by multiplayer lockstep sync).
        if (r.ok && d && !this.controllers[d.player] && typeof this.opts.onLocalAnswer === 'function') {
          try { this.opts.onLocalAnswer(d, ans); } catch (err) { console.error('[GameTable] onLocalAnswer threw', err); }
        }
        return r;
      } catch (e) {
        this.engineError(e);
        return { ok: false, error: String(e && e.message || e), crashed: true };
      }
    }

    runAI(d, ctrl) {
      let ans;
      try { ans = ctrl.decide(this.g, d); } catch (e) { console.error('[GameTable] AI decide threw', e); ans = null; }
      if (!ans || typeof ans !== 'object') ans = safeAnswer(d);
      const quick = (d.type === 'priority' && (ans.type === 'pass' || ans.type === 'mana')) || d.type === 'payMana';
      const delay = this.pendingConcede ? 0 : quick ? this.quickDelay : this.aiDelay;
      const self = this;
      this.later(function () {
        if (self.g.decision !== d || self.g.over) { self.scheduleDrive(0); return; }
        let r = self.respondSafe(ans);
        if (r.crashed) return;
        let attempt = 0;
        while (!r.ok && self.g.decision === d && attempt < 3) {
          console.warn('[GameTable] AI answer rejected (' + r.error + ') for ' + d.type + '; using fallback.', ans);
          r = self.respondSafe(safeAnswer(d, attempt++));
          if (r.crashed) return;
        }
        if (!r.ok && self.g.decision === d) {
          console.error('[GameTable] AI stuck on decision; conceding for it.', d);
          self.respondSafe({ type: 'concede' });
        }
        self.scheduleDrive(0);
      }, delay);
    }

    onHumanDecision(d) {
      this.ui = this.freshInteraction(d);
      if (d.type !== 'priority' && this.passMode === 'F4') this.passMode = null;
      const auto = this.autoAnswer(d);
      if (auto) {
        this.autoPending = d;
        this.closeDecisionModal();
        const self = this;
        this.later(function () {
          self.autoPending = null;
          if (self.g.decision !== d) { self.scheduleDrive(0); return; }
          const r = self.respondSafe(auto);
          if (!r.ok && !r.crashed) {
            // Auto answer was rejected: let the player answer manually.
            self.drivenDecision = null;
            self.passMode = null;
          }
          self.scheduleDrive(0);
        }, 0);
        this.requestRender();
        return;
      }
      if (d.type === 'priority') { this.humanInitiated = false; this.manualPay = false; }
      // creatures that attack each turn if able start selected (unless attacking costs mana: then it's optional)
      if (d.type === 'declareAttackers' && !(d.attackTax > 0)) for (const id of d.mustAttack || []) if (d.candidates.includes(id)) this.ui.attackers.add(id);
      this.openDecisionModal(d);
      this.renderNow();
      if (d.type === 'chooseNumber') {
        const inp = this.el.prompt.querySelector('.gt-num-input');
        if (inp) this.later(() => { try { inp.focus(); inp.select(); } catch (e) { /* ignore */ } }, 0);
      }
    }

    /** Returns an automatic answer for a human decision, or null to ask the player. */
    autoAnswer(d) {
      const g = this.g;
      if (d.type === 'payMana') {
        if (this.settings.autoTap && this.humanInitiated && !this.manualPay && d.canAuto && !d.optional) return { type: 'auto' };
        return null;
      }
      if (d.type !== 'priority') return null;
      const P = g.players[d.player];
      const poolTotal = P.manaPool ? Object.values(P.manaPool).reduce((a, b) => a + b, 0) : 0;
      if (this.holdPriority) { this.holdPriority = false; this.passMode = null; return null; }
      if (poolTotal > 0) return null;           // player floated mana: they are mid-interaction
      const top = g.stack[g.stack.length - 1];
      const nonMana = d.actions.filter(a => a.type !== 'mana');
      if (this.passMode === 'F6') {
        if (g.turnNumber === this.passTurn) return { type: 'pass' };
        this.passMode = null;
      }
      if (this.passMode === 'F4') {
        const oppObj = top && top.controller !== d.player;
        const oppAttack = g.activePlayer !== d.player && g.step === 'declareAttackers' && g.combat && g.combat.attackers.length > 0;
        const myTurn = g.activePlayer === d.player && g.turnNumber !== this.passTurn;
        if (oppObj || oppAttack || myTurn) this.passMode = null;
        else return { type: 'pass' };
      }
      if (top) {
        if (top.controller === d.player) return { type: 'pass' };   // MTGO: casting passes priority (hold Ctrl to keep it)
        if (!nonMana.length && this.settings.autoPassNoPlays) return { type: 'pass' };
        return null;
      }
      const row = g.activePlayer === this.human ? 'me' : 'opp';
      const key = stepKey(g.step);
      if (this.settings.stops[row][key]) {
        if (this.settings.autoPassNoPlays && !nonMana.length) return { type: 'pass' };
        return null;
      }
      return { type: 'pass' };
    }

    /** Human answer through the UI. */
    act(ans) {
      const d = this.humanDecision();
      if (!d) return false;
      if (d.type === 'priority' && (ans.type === 'cast' || ans.type === 'activate')) this.humanInitiated = true;
      const r = this.respondSafe(ans);
      if (r.crashed) return false;
      if (!r.ok) {
        this.ui.error = r.error || 'That is not allowed.';
        this.htmlCache.prompt = null;
        this.renderPrompt();
        return false;
      }
      this.closeMenu();
      this.drive();
      return true;
    }

    passUntil(mode) {
      if (this.g.over) return;
      this.passMode = mode;
      this.passTurn = this.g.turnNumber;
      const d = this.humanDecision();
      if (d && d.type === 'priority') this.act({ type: 'pass' });
      else this.requestRender();
    }

    engineError(e) {
      console.error('[GameTable] engine error', e);
      if (this.crashShown) return;
      this.crashShown = true;
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.showEnd({ winner: -1, endReason: 'error', turns: this.g.turnNumber, error: String(e && e.message || e) },
        'Game error', 'The rules engine hit an error and the game cannot continue.<div class="gt-small dim">' + esc(String(e && e.message || e)) + '</div>');
    }

    // ----- click handling -------------------------------------------------------
    onClick(e) {
      if (this.destroyed) return;
      const t = e.target;
      const btn = t.closest('button[data-act]');
      if (btn && !btn.closest('.gt-modal')) { if (!btn.disabled) this.onButton(btn.dataset.act, btn, e); return; }
      if (t.closest('.gt-modal') || t.closest('.gt-end')) return;
      if (t.closest('.gt-menu')) return;
      this.closeMenu();
      const stop = t.closest('[data-stop]');
      if (stop) {
        const [row, key] = stop.dataset.stop.split(':');
        this.settings.stops[row][key] = !this.settings.stops[row][key];
        saveSettings(this.settings);
        this.updateStops();
        return;
      }
      const sitem = t.closest('[data-sid]');
      if (sitem) { this.onStackClick(Number(sitem.dataset.sid), e); return; }
      const zone = t.closest('[data-zone]');
      const pbox = t.closest('[data-player]');
      if (pbox) {
        const p = Number(pbox.dataset.player);
        const d = this.humanDecision();
        if (d && d.type === 'chooseTargets' && d.legal.some(r => r.kind === 'player' && r.idx === p)) { this.targetClick({ kind: 'player', idx: p }); return; }
        if (zone) { this.showZone(p, zone.dataset.zone); return; }
        if (d && d.type === 'chooseTargets') this.flashError('That player is not a legal target.');
        return;
      }
      const cardEl = t.closest('[data-card-id]');
      if (cardEl && (cardEl.closest('.gt-bf') || cardEl.closest('.gt-hand'))) { this.onCardClick(cardEl, e); return; }
    }

    resolveGroup(el, pred) {
      const ids = el.dataset.cardIds ? el.dataset.cardIds.split(' ').map(Number) : [Number(el.dataset.cardId)];
      for (const id of ids) if (pred(id)) return id;
      return null;
    }

    onCardClick(el, e) {
      const d = this.humanDecision();
      if (!d) return;
      const g = this.g;
      switch (d.type) {
        case 'priority': {
          const id = this.resolveGroup(el, (x) => this.actionsFor(d, x).length > 0);
          if (id === null) {
            const c = g.card(Number(el.dataset.cardId));
            if (c && c.zone === 'hand') this.flashError(g.isLand(c) ? 'You can’t play a land now.' : 'You can’t play ' + c.name + ' now.');
            return;
          }
          const acts = this.actionsFor(d, id);
          if (acts.length === 1 && !(acts[0].type === 'mana' && this.isAnyMana(acts[0]))) { this.doAction(acts[0], e); return; }
          this.showActionMenu(acts, e, id);
          return;
        }
        case 'payMana': {
          const id = this.resolveGroup(el, (x) => this.manaActionsFor(d.player, x, d).length > 0);
          if (id === null) { this.flashError('That can’t produce mana now.'); return; }
          const acts = this.manaActionsFor(d.player, id, d);
          if (acts.length === 1) { this.payWith(acts[0], d, e); return; }
          this.showMenu(e, acts.map(a => ({ html: mana(a.label), fn: () => this.payWith(a, d, e) })));
          return;
        }
        case 'chooseTargets': {
          const id = this.resolveGroup(el, (x) => d.legal.some(r => r.kind === 'card' && r.id === x) || this.ui.targets.some(r => r.kind === 'card' && r.id === x));
          if (id === null) { this.flashError('That is not a legal target.'); return; }
          this.targetClick({ kind: 'card', id });
          return;
        }
        case 'declareAttackers': {
          const id = Number(el.dataset.cardId);
          if (!d.candidates.includes(id)) { if (g.card(id) && g.controllerOf(g.card(id)) === d.player && g.isCreature(g.card(id))) this.flashError(g.card(id).name + ' can’t attack.'); return; }
          if (this.ui.attackers.has(id)) this.ui.attackers.delete(id); else this.ui.attackers.add(id);
          this.ui.error = (!this.ui.attackers.has(id) && (d.mustAttack || []).includes(id) && !(d.attackTax > 0)) ? g.card(id).name + ' attacks each turn if able.' : '';
          this.requestRender();
          return;
        }
        case 'declareBlockers': {
          const id = Number(el.dataset.cardId);
          this.blockerClick(id, d);
          return;
        }
        default: return;
      }
    }

    blockerClick(id, d) {
      const ui = this.ui;
      ui.error = '';
      const lim = (b) => this.blockLimit(d, b);
      const add = (b, at) => { (ui.blocks[b] = ui.blocks[b] || []).push(at); };
      const freeFor = (b, at) => this.blocksOf(b).length < lim(b) && !this.blocksOf(b).includes(at);
      if (d.candidates[id]) {
        const has = this.blocksOf(id).length;
        if (has && (lim(id) <= 1 || ui.pendingBlocker === id || has >= lim(id) || !d.candidates[id].some(at => !this.blocksOf(id).includes(at)))) {
          delete ui.blocks[id]; ui.pendingBlocker = null;                 // second click removes its blocks
        } else if (has) ui.pendingBlocker = id;                             // extra blocker: choose another attacker
        else if (ui.pendingBlocker === id) ui.pendingBlocker = null;
        else {
          const opts = d.candidates[id];
          if (opts.length === 1 && d.attackers.length === 1) { add(id, opts[0]); ui.pendingBlocker = null; }
          else ui.pendingBlocker = id;
        }
      } else if (d.attackers.includes(id)) {
        const pb = ui.pendingBlocker;
        if (pb === null) {
          const able = Object.keys(d.candidates).filter(b => d.candidates[b].includes(id) && !this.blocksOf(b).length);
          if (able.length === 1) add(able[0], id);
          else ui.error = able.length ? 'First click the creature you want to block with.' : 'None of your creatures can block that attacker.';
        } else if (this.blocksOf(pb).includes(id)) {
          ui.blocks[pb] = this.blocksOf(pb).filter(x => x !== id);           // click an assigned attacker again: unassign
          if (!ui.blocks[pb].length) delete ui.blocks[pb];
        } else if (d.candidates[pb].includes(id) && freeFor(pb, id)) {
          add(pb, id);
          // a blocker that can block an additional creature stays selected while another attacker is possible
          const more = this.blocksOf(pb).length < lim(pb) && d.candidates[pb].some(at => !this.blocksOf(pb).includes(at));
          if (!more) ui.pendingBlocker = null;
        } else ui.error = this.g.card(pb).name + ' can’t block ' + this.g.card(id).name + '.';
      } else {
        const c = this.g.card(id);
        if (c && this.g.controllerOf(c) === d.player && this.g.isCreature(c)) ui.error = c.name + ' can’t block.';
      }
      this.requestRender();
    }

    isAnyMana(a) {
      if (a.type !== 'mana') return false;
      const c = this.g.card(a.cardId);
      const ab = c && this.g.activatedAbilities(c)[a.ability];
      return !!(ab && ab.mana && ab.mana.produce === 'ANY');
    }

    actionLabel(a) {
      const c = this.g.card(a.cardId);
      if (a.type === 'playLand') return 'Play ' + esc(c.name);
      if (a.type === 'cast' && a.alt === 'afterimage') return 'Cast ' + esc(c.name) + ' <span class="gt-ai-tag">Afterimage</span> ' + mana(c.def.afterimage || '');
      if (a.type === 'cast') return 'Cast ' + esc(c.name) + (c.def.costString ? ' ' + mana(c.def.costString) : '');
      return mana(a.label || 'Activate');
    }

    showActionMenu(acts, e, id) {
      const items = [];
      for (const a of acts) {
        if (a.type === 'mana' && this.isAnyMana(a)) {
          for (const col of COLORS) items.push({ html: mana(a.label.replace(/one mana of any color/, '{' + col + '}')), fn: () => this.act({ type: 'mana', cardId: a.cardId, ability: a.ability, color: col }) });
        } else {
          items.push({ html: this.actionLabel(a), fn: () => this.doAction(a, e) });
        }
      }
      items.push({ sep: true });
      items.push({ html: 'View card', fn: () => this.showCardModal(id) });
      this.showMenu(e, items);
    }

    doAction(a, e) {
      if (a.type === 'mana') { this.act({ type: 'mana', cardId: a.cardId, ability: a.ability }); return; }
      this.holdPriority = !!(e && (e.ctrlKey || e.metaKey)) || !!this.ctrlDown;
      this.manualPay = !!(e && e.shiftKey);
      const ans = { type: a.type, cardId: a.cardId };
      if (a.ability !== undefined) ans.ability = a.ability;
      if (a.alt !== undefined) ans.alt = a.alt;
      if (!this.act(ans)) { this.holdPriority = false; this.manualPay = false; }
    }

    payWith(a, d, e) {
      if (!a.any) { this.act({ type: 'mana', cardId: a.cardId, ability: a.ability }); return; }
      const hyb = (d.cost.hybrid || []).flat();
      const need = COLORS.filter(c => d.cost[c] > 0 || hyb.includes(c));
      if (need.length === 1 && !d.diverse) { this.act({ type: 'mana', cardId: a.cardId, ability: a.ability, color: need[0] }); return; }
      let cols = need.length ? need : COLORS;
      if (d.diverse) {
        // Confluence / Sunburst: offer every colour, the ones not spent yet first.
        const sp = this.g.lastSpent || {};
        cols = COLORS.filter(c => !(sp[c] > 0)).concat(COLORS.filter(c => sp[c] > 0));
      }
      this.showMenu(e, cols.map(col => ({ html: 'Add ' + mana('{' + col + '}'), fn: () => this.act({ type: 'mana', cardId: a.cardId, ability: a.ability, color: col }) })));
    }

    targetClick(ref) {
      const d = this.humanDecision();
      if (!d || d.type !== 'chooseTargets') return;
      const key = OF.refKey ? null : null; void key;
      const same = (r) => r.kind === ref.kind && (r.kind === 'player' ? r.idx === ref.idx : r.kind === 'stack' ? r.sid === ref.sid : r.id === ref.id);
      const i = this.ui.targets.findIndex(same);
      this.ui.error = '';
      if (i >= 0) { this.ui.targets.splice(i, 1); this.requestRender(); return; }
      const legal = d.legal.find(same);
      if (!legal) { this.flashError('That is not a legal target.'); return; }
      if (d.max === 1) {
        if (d.min <= 1) { this.submitTargets([legal]); return; }
      }
      this.ui.targets.push(legal);
      if (this.ui.targets.length >= d.max) { this.submitTargets(this.ui.targets.slice()); return; }
      this.requestRender();
    }

    submitTargets(list) {
      const d = this.humanDecision();
      if (!d) return;
      if (list.length < d.min || list.length > d.max) { this.flashError('Choose ' + (d.min === d.max ? d.min : d.min + '–' + d.max) + ' target(s).'); return; }
      if (d.groupCheck) {
        let err = null;
        try { err = d.groupCheck(list); } catch (e) { err = null; }
        if (err) { this.ui.targets = list.slice(0, -1); this.flashError(err); this.requestRender(); return; }
      }
      this.act({ targets: list });
    }

    onStackClick(sid, e) {
      const d = this.humanDecision();
      if (d && d.type === 'chooseTargets') {
        if (d.legal.some(r => r.kind === 'stack' && r.sid === sid) || this.ui.targets.some(r => r.kind === 'stack' && r.sid === sid)) { this.targetClick({ kind: 'stack', sid }); return; }
        this.flashError('That is not a legal target.');
      }
      void e;
    }

    onButton(act, btn, e) {
      const d = this.humanDecision();
      const g = this.g;
      if (act === 'settings') return this.showSettings();
      if (act === 'help') return this.showHelp();
      if (act === 'concede') return this.confirmConcede();
      if (act === 'cancelPass') { this.passMode = null; this.requestRender(); if (this.g.decision && this.autoPending !== this.g.decision) { this.drivenDecision = null; this.scheduleDrive(0); } return; }
      if (act === 'showModal') { this.ui.modalHidden = false; this.syncModalVisibility(); return; }
      if (!d) return;
      switch (act) {
        case 'pass': return this.act({ type: 'pass' });
        case 'f4': return this.passUntil('F4');
        case 'f6': return this.passUntil('F6');
        case 'autopay': return this.act({ type: 'auto' });
        case 'paycancel': return this.act({ type: 'cancel' });
        case 'targetsDone': return this.submitTargets(this.ui.targets.slice());
        case 'targetsCancel': return this.act({ cancel: true });
        case 'targetsPicker': this.openDecisionModal(d); return;
        case 'atkOK': return this.act({ attackers: Array.from(this.ui.attackers) });
        case 'atkAll': d.candidates.forEach(id => this.ui.attackers.add(id)); this.requestRender(); return;
        case 'atkClear': this.ui.attackers.clear(); if (!(d.attackTax > 0)) for (const id of d.mustAttack || []) this.ui.attackers.add(id); this.requestRender(); return;
        case 'blkOK': {
          const mc = this.menaceCheck(d);
          if (mc.invalid.length) {
            const nm = mc.invalid.map(id => this.g.card(id) ? this.g.card(id).name : 'Attacker').join(', ');
            this.flashError(nm + ' has menace — it must be blocked by 2 or more creatures.');
            return;
          }
          const blocks = [];
          for (const b of Object.keys(this.ui.blocks)) for (const at of this.ui.blocks[b]) blocks.push({ blocker: Number(b), attacker: at });
          return this.act({ blocks });
        }
        case 'blkClear': this.ui.blocks = {}; this.ui.pendingBlocker = null; this.requestRender(); return;
        case 'num-': return this.setNumber(this.numberValue(d) - 1);
        case 'num+': return this.setNumber(this.numberValue(d) + 1);
        case 'numOK': {
          const inp = this.el.prompt.querySelector('.gt-num-input');
          if (inp && inp.value !== '') this.ui.number = Number(inp.value);
          const v = Number(this.ui.number);
          if (!Number.isInteger(v) || v < d.min || v > d.max) { this.flashError('Choose a whole number from ' + d.min + ' to ' + d.max + '.'); return; }
          return this.act({ number: v });
        }
        case 'numCancel': return this.act({ cancel: true });
        case 'yes': return this.act({ yes: true });
        case 'no': return this.act({ yes: false });
        case 'keep': return this.act({ keep: true });
        case 'mull': return this.act({ keep: false });
        case 'playFirst': return this.act({ first: true });
        case 'drawFirst': return this.act({ first: false });
        default:
          if (act.startsWith('color:')) return this.act({ color: act.slice(6) });
          if (act.startsWith('opt:')) { const o = d.options[Number(act.slice(4))]; if (o) this.act({ choice: o.id }); return; }
          if (act.startsWith('numset:')) return this.setNumber(Number(act.slice(7)));
      }
      void g; void btn; void e;
    }

    flashError(msg) {
      this.ui.error = msg;
      this.htmlCache.prompt = null;
      this.renderPrompt();
      const el = this.el.prompt.querySelector('.gt-prompt-error');
      if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }

    // ----- context menu --------------------------------------------------------
    onContext(e) {
      const t = e.target;
      if (t.closest('input, textarea')) return;
      e.preventDefault();
      if (t.closest('.gt-modal')) {
        const pick = t.closest('[data-card-id]');
        if (pick) this.showMenu(e, [{ html: 'View card', fn: () => this.showCardModal(Number(pick.dataset.cardId)) }]);
        return;
      }
      const sitem = t.closest('[data-sid]');
      if (sitem) { this.showMenu(e, [{ html: 'View card', fn: () => this.showCardModal(Number(sitem.dataset.stackCard)) }]); return; }
      const el = t.closest('[data-card-id]');
      if (!el) { this.closeMenu(); return; }
      const id = Number(el.dataset.cardId);
      const d = this.humanDecision();
      const items = [];
      if (d && d.type === 'priority') {
        const ids = el.dataset.cardIds ? el.dataset.cardIds.split(' ').map(Number) : [id];
        const gid = ids.find(x => this.actionsFor(d, x).length) || id;
        for (const a of this.actionsFor(d, gid)) {
          if (a.type === 'mana' && this.isAnyMana(a)) {
            for (const col of COLORS) items.push({ html: 'Add ' + mana('{' + col + '}'), fn: () => this.act({ type: 'mana', cardId: a.cardId, ability: a.ability, color: col }) });
          } else items.push({ html: this.actionLabel(a), fn: () => this.doAction(a, e) });
        }
      } else if (d && d.type === 'payMana') {
        const gid = this.resolveGroup(el, (x) => this.manaActionsFor(d.player, x, d).length > 0);
        if (gid !== null) for (const a of this.manaActionsFor(d.player, gid, d)) items.push({ html: mana(a.label), fn: () => this.payWith(a, d, e) });
      } else if (d && d.type === 'chooseTargets') {
        const gid = this.resolveGroup(el, (x) => d.legal.some(r => r.kind === 'card' && r.id === x));
        if (gid !== null) items.push({ html: 'Target ' + esc(this.g.card(gid).name), fn: () => this.targetClick({ kind: 'card', id: gid }) });
      } else if (d && (d.type === 'declareAttackers' || d.type === 'declareBlockers')) {
        items.push({ html: d.type === 'declareAttackers' ? 'Toggle attack' : 'Select for blocking', fn: () => this.onCardClick(el, e) });
      }
      if (items.length) items.push({ sep: true });
      items.push({ html: 'View card', fn: () => this.showCardModal(id) });
      this.showMenu(e, items);
    }

    showMenu(e, items) {
      const m = this.el.menu;
      m.innerHTML = '';
      for (const it of items) {
        if (it.sep) { const s = document.createElement('div'); s.className = 'gt-menu-sep'; m.appendChild(s); continue; }
        const div = document.createElement('div');
        div.className = 'gt-menu-item';
        div.innerHTML = it.html;
        div.addEventListener('click', (ev) => { ev.stopPropagation(); this.closeMenu(); it.fn(ev); });
        m.appendChild(div);
      }
      m.classList.remove('hidden');
      const rr = this.root.getBoundingClientRect();
      const x = (e && e.clientX !== undefined ? e.clientX : rr.left + rr.width / 2) - rr.left;
      const y = (e && e.clientY !== undefined ? e.clientY : rr.top + rr.height / 2) - rr.top;
      const w = m.offsetWidth, h = m.offsetHeight;
      m.style.left = clamp(x + 2, 2, rr.width - w - 2) + 'px';
      m.style.top = clamp(y + 2, 2, rr.height - h - 2) + 'px';
    }

    closeMenu() { this.el.menu.classList.add('hidden'); }

    // ----- hover -----------------------------------------------------------------
    onOver(e) {
      const t = e.target;
      const sitem = t.closest('[data-sid]');
      const sid = sitem ? Number(sitem.dataset.sid) : null;
      if (sid !== this.hoverSid) this.setHoverSid(sid);
      if (sitem) { this.preview(Number(sitem.dataset.stackCard)); return; }
      const el = t.closest('[data-card-id]');
      if (el) { this.preview(Number(el.dataset.cardId)); return; }
      const nm = t.closest('[data-card-name]');
      if (nm) { this.previewId = null; UI.showCardPreview(nm.getAttribute('data-card-name')); }
    }

    setHoverSid(sid) {
      this.hoverSid = sid;
      const g = this.g;
      let ht = null;
      if (sid !== null) {
        const s = g.stack.find(x => x.sid === sid);
        if (s) {
          ht = { cards: new Set(), players: new Set(), sids: new Set() };
          for (const r of (s.targets || []).flat()) {
            if (r.kind === 'player') ht.players.add(r.idx);
            else if (r.kind === 'stack') ht.sids.add(r.sid);
            else ht.cards.add(r.id);
          }
        }
      }
      this.hoverTargets = ht;
      for (const key in this.el.pbox) this.el.pbox[key].classList.toggle('hl-target', !!(ht && ht.players.has(Number(key))));
      for (const el of this.el.stackList.querySelectorAll('[data-sid]')) el.classList.toggle('hl-target', !!(ht && ht.sids.has(Number(el.dataset.sid))));
      this.htmlCache.cr0 = this.htmlCache.cr1 = this.htmlCache.ld0 = this.htmlCache.ld1 = null;
      this.renderBattlefield();
      this.fitRows();
      this.drawArrows();
    }

    preview(id) {
      const g = this.g, c = g.card(id);
      if (!c) return;
      this.previewId = id;
      // Never preview hidden cards (opponent's hand / libraries).
      if ((c.zone === 'hand' && c.owner !== this.human) || c.zone === 'library') {
        const dm = this.el.dmodal;
        if (!(dm && !dm.classList.contains('hidden') && dm.querySelector('[data-card-id="' + id + '"]'))) return;
      }
      let extra = '';
      if (c.zone === 'battlefield') {
        const v = g.cardView(id);
        const bits = [];
        bits.push('<b>' + esc(g.players[v.controller].name) + '</b>' + (v.controller !== v.owner ? ' (owner: ' + esc(g.players[v.owner].name) + ')' : '') + (v.token ? ' · Token' : ''));
        if (v.power !== undefined && v.power !== null) bits.push('Power/Toughness: <b>' + v.power + '/' + v.toughness + '</b>' + ((v.power !== v.basePower || v.toughness !== v.baseToughness) ? ' (printed ' + v.basePower + '/' + v.baseToughness + ')' : ''));
        if (v.damage) bits.push('<span class="gt-red">Damage marked: ' + v.damage + '</span>');
        if (v.cloneOf) bits.push('<span class="gt-clone-txt">' + esc(v.printedName || 'This card') + ', copying ' + esc(v.cloneOf) + '</span>');
        if (v.counters) bits.push('+1/+1 counters: ' + v.counters);
        if (v.charge) bits.push('Charge counters: ' + v.charge);
        for (const x of this.otherCounters(v)) bits.push(x.label + ' counters: ' + x.n);
        const recol = this.colorChange(id, v);
        if (recol) bits.push('Colour changed: ' + esc(recol.title));
        if (v.protection && v.protection.length) bits.push('<span class="gt-prot-txt">Protection from ' + v.protection.map(k => (COLOR_NAMES[k] || k).toLowerCase()).join(' and ') + '</span>');
        if (v.multicolored) bits.push('Multicoloured (' + v.colors.map(k => mana('{' + k + '}')).join('') + ')');
        if (v.chosenType) bits.push('Chosen type: ' + esc(v.chosenType));
        if (v.keywords && v.keywords.length) bits.push(v.keywords.map(k => KW_NAMES[k] || k).join(', '));
        if (v.tapped) bits.push('Tapped');
        if (v.sick) bits.push('Summoning sick');
        if (v.attachedTo) { const h = g.card(v.attachedTo); if (h) bits.push((g.isEquipment && g.isEquipment(c) ? 'Equipping ' : 'Enchanting ') + esc(h.name)); }
        if (v.attachments && v.attachments.length) {
          const eq = v.attachments.filter(a => g.isEquipment && g.isEquipment(g.card(a)));
          const en = v.attachments.filter(a => !eq.includes(a));
          if (en.length) bits.push('Enchanted by ' + en.map(a => esc(g.card(a).name)).join(', '));
          if (eq.length) bits.push('Equipped with ' + eq.map(a => esc(g.card(a).name)).join(', '));
        }
        extra = bits.join('<br>');
      }
      if (c.zone === 'graveyard' && c.owner === this.human) {
        const ai = this.afterimageActions().find(a => a.cardId === id);
        if (ai) extra = (extra ? extra + '<br>' : '') + '<span class="gt-ai-txt">Can be cast now with Afterimage ' + mana(c.def.afterimage || '') + ' (open your graveyard)</span>';
      }
      UI.showCardPreview(UI.cardData(c), { extraHTML: extra, inPlay: c.zone === 'battlefield' });
    }

    /** Afterimage cast actions in the current human priority decision. */
    afterimageActions() {
      const d = this.humanDecision();
      if (!d || d.type !== 'priority') return [];
      return d.actions.filter(a => a.type === 'cast' && a.alt === 'afterimage');
    }

    // ----- arrows ----------------------------------------------------------------
    cardEl(id) {
      return this.root.querySelector('.gt-bf [data-card-id="' + id + '"]') || this.root.querySelector('.gt-bf [data-card-ids~="' + id + '"]');
    }

    drawArrows() {
      const layer = this.el.arrowLayer;
      const rr = this.root.getBoundingClientRect();
      this.el.arrows.setAttribute('width', rr.width);
      this.el.arrows.setAttribute('height', rr.height);
      let h = '';
      const center = (el) => { const r = el.getBoundingClientRect(); return [r.left - rr.left + r.width / 2, r.top - rr.top + r.height / 2]; };
      const line = (a, b, kind, dashed) => {
        if (!a || !b) return;
        const [x1, y1] = center(a), [x2, y2] = center(b);
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const sh = Math.min(28, len / 4);
        const ex = x2 - dx / len * sh, ey = y2 - dy / len * sh;
        h += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + ex + '" y2="' + ey + '" class="gt-arrow ' + kind + (dashed ? ' dashed' : '') + '" marker-end="url(#gt-ah-' + kind + ')"/>';
      };
      const g = this.g;
      if (g.combat && g.combat.blockAssign) { for (const b in g.combat.blockAssign) for (const at of g.combat.blockAssign[b]) line(this.cardEl(b), this.cardEl(at), 'block'); }
      else if (g.combat && g.combat.blockers) for (const b in g.combat.blockers) line(this.cardEl(b), this.cardEl(g.combat.blockers[b]), 'block');
      const d = this.humanDecision();
      if (d && d.type === 'declareBlockers') for (const b in this.ui.blocks) for (const at of this.ui.blocks[b]) line(this.cardEl(b), this.cardEl(at), 'block', true);
      if (this.hoverSid !== null && this.hoverTargets) {
        const from = this.el.stackList.querySelector('[data-sid="' + this.hoverSid + '"]');
        for (const id of this.hoverTargets.cards) line(from, this.cardEl(id), 'target');
        for (const p of this.hoverTargets.players) line(from, this.el.pbox[p] && this.el.pbox[p].querySelector('.gt-pb-life'), 'target');
      }
      if (layer._last !== h) { layer.innerHTML = h; layer._last = h; }
    }

    // ----- decision modal ----------------------------------------------------------
    closeDecisionModal() {
      this.el.dmodal.classList.add('hidden');
      this.el.dmodal.innerHTML = '';
      this.el.dmodalBar.classList.add('hidden');
      this.dmodalFor = null;
    }

    syncModalVisibility() {
      const open = !!this.dmodalFor;
      this.el.dmodal.classList.toggle('hidden', !open || this.ui.modalHidden);
      this.el.dmodalBar.classList.toggle('hidden', !open || !this.ui.modalHidden);
      if (open) this.el.dmodalBar.querySelector('span').textContent = 'Selection window hidden — ';
    }

    openDecisionModal(d) {
      this.closeDecisionModal();
      switch (d.type) {
        case 'mulligan': return this.openMulligan(d);
        case 'playFirst': return this.openPlayFirst(d);
        case 'chooseCards': return this.openChooseCards(d);
        case 'orderCards': return this.openOrder(d);
        case 'chooseOption': if (d.options.length > 6 || d.reason === 'creatureType') return this.openOptionList(d); return;
        case 'chooseTargets': {
          const off = d.legal.filter(r => r.kind === 'card' && this.g.card(r.id) && this.g.card(r.id).zone !== 'battlefield');
          if (off.length) return this.openTargetPicker(d, off);
          return;
        }
        default: return;
      }
    }

    modalShell(d, title, sub) {
      const m = this.el.dmodal;
      this.dmodalFor = d;
      this.ui.modalHidden = false;
      m.innerHTML = '<div class="gt-mbox"><div class="titlebar gt-mtitle"><span>' + title + '</span><button class="gt-mhide" data-mact="hide" title="Hide this window to look at the battlefield">Hide</button></div>' +
        (sub ? '<div class="gt-msub">' + sub + '</div>' : '') + '<div class="gt-mcontent"></div><div class="gt-mfoot"><span class="gt-mstatus"></span><span class="gt-merr"></span><span class="gt-mbtns"></span></div></div>';
      m.querySelector('[data-mact="hide"]').addEventListener('click', () => { this.ui.modalHidden = true; this.syncModalVisibility(); });
      this.syncModalVisibility();
      return { content: m.querySelector('.gt-mcontent'), status: m.querySelector('.gt-mstatus'), err: m.querySelector('.gt-merr'), btns: m.querySelector('.gt-mbtns') };
    }

    modalButton(parts, label, fn, o) {
      o = o || {};
      const b = document.createElement('button');
      b.innerHTML = label;
      if (o.primary) { b.className = 'primary'; b.dataset.primary = '1'; }
      if (o.cancel) b.dataset.cancel = '1';
      b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.disabled) fn(); });
      parts.btns.appendChild(b);
      return b;
    }

    pickTile(id, label) {
      const c = this.g.card(id);
      const tile = document.createElement('div');
      tile.className = 'gt-pick';
      tile.dataset.cardId = id;
      tile.appendChild(UI.renderCardThumb(c || '?', { preview: false }));
      if (label) { const l = document.createElement('div'); l.className = 'gt-pick-label'; l.innerHTML = label; tile.appendChild(l); }
      return tile;
    }

    zoneLabel(id, p) {
      const c = this.g.card(id);
      if (!c) return '';
      const owner = c.owner === p ? '' : esc(this.g.players[c.owner].name) + '’s ';
      const z = { battlefield: 'battlefield', graveyard: 'graveyard', exile: 'exile', hand: 'hand', library: 'library', stack: 'stack' }[c.zone] || c.zone;
      return owner + z;
    }

    openMulligan(d) {
      const parts = this.modalShell(d, d.mulligans ? 'Mulligan (' + d.mulligans + ' taken)' : 'Opening hand', esc(d.prompt));
      const grid = document.createElement('div');
      grid.className = 'gt-pick-grid big';
      for (const id of d.hand) grid.appendChild(this.pickTile(id));
      parts.content.appendChild(grid);
      parts.status.textContent = d.hand.length + ' cards' + (this.g.players[d.player] && this.g.firstPlayer !== null ? ' · ' + (this.g.firstPlayer === d.player ? 'You play first' : 'You draw first') : '');
      this.modalButton(parts, 'Keep', () => this.act({ keep: true }), { primary: true });
      const mb = this.modalButton(parts, 'Mulligan', () => this.act({ keep: false }));
      if (!d.hand.length) mb.disabled = true;
    }

    openPlayFirst(d) {
      const parts = this.modalShell(d, 'Play or draw?', 'You get to choose who takes the first turn.');
      parts.content.innerHTML = '<div class="gt-mbig">Do you want to play first?</div>';
      this.modalButton(parts, 'Play first', () => this.act({ first: true }), { primary: true });
      this.modalButton(parts, 'Draw first', () => this.act({ first: false }));
    }

    /** Generic multi-select card picker. */
    picker(d, cfg) {
      const parts = this.modalShell(d, cfg.title, cfg.sub);
      const sel = [];
      const grid = document.createElement('div');
      grid.className = 'gt-pick-grid';
      const tiles = {};
      for (const id of cfg.cards) {
        const t = this.pickTile(id, cfg.label ? cfg.label(id) : '');
        t.classList.add('selectable');
        tiles[id] = t;
        grid.appendChild(t);
      }
      if (cfg.dim && cfg.dim.length) {
        const sep = document.createElement('div');
        sep.className = 'gt-pick-sep';
        sep.textContent = cfg.dimLabel || 'Other cards';
        grid.appendChild(sep);
        for (const id of cfg.dim) { const t = this.pickTile(id, ''); t.classList.add('dimmed'); grid.appendChild(t); }
      }
      parts.content.appendChild(grid);
      const min = cfg.min, max = cfg.max;
      let confirm;
      const update = () => {
        for (const id in tiles) tiles[id].classList.toggle('picked', sel.includes(Number(id)));
        const rng = min === max ? String(min) : (min + '–' + max);
        parts.status.textContent = 'Selected ' + sel.length + ' (choose ' + rng + ')';
        parts.err.textContent = '';
        if (confirm) confirm.disabled = sel.length < min || sel.length > max;
      };
      const doConfirm = () => {
        if (sel.length < min || sel.length > max) return;
        if (cfg.validate) { let err = null; try { err = cfg.validate(sel.slice()); } catch (e) { err = null; } if (err) { parts.err.textContent = err; return; } }
        cfg.onConfirm(sel.slice(), parts);
      };
      grid.addEventListener('click', (e) => {
        const t = e.target.closest('.gt-pick.selectable');
        if (!t) return;
        const id = Number(t.dataset.cardId);
        const i = sel.indexOf(id);
        if (i >= 0) sel.splice(i, 1);
        else if (max === 1) { sel.length = 0; sel.push(id); }
        else if (sel.length < max) sel.push(id);
        update();
      });
      grid.addEventListener('dblclick', (e) => {
        const t = e.target.closest('.gt-pick.selectable');
        if (!t || max !== 1) return;
        sel.length = 0; sel.push(Number(t.dataset.cardId)); update(); doConfirm();
      });
      confirm = this.modalButton(parts, cfg.confirmLabel || 'Confirm', doConfirm, { primary: true });
      if (cfg.onCancel) this.modalButton(parts, cfg.cancelLabel || 'Cancel', cfg.onCancel, { cancel: true });
      update();
      return parts;
    }

    openChooseCards(d) {
      const g = this.g;
      const titles = {
        mulliganBottom: 'Put cards on the bottom of your library', cleanupDiscard: 'Discard to hand size', discard: 'Discard',
        opponentDiscard: 'Choose a card for your opponent to discard', sacrifice: 'Sacrifice', sacrificeCost: 'Sacrifice (cost)',
        exileCost: 'Remove from the game (cost)', inherit: 'Inherit', legendRule: 'Legend rule — choose the one to keep',
        search: 'Search your library', toHand: 'Choose a card to put into your hand', toGraveyard: 'Choose a card to put into the graveyard',
        toBattlefield: 'Choose a card to put into play', exileFromGraveyard: 'Remove a card in your graveyard from the game',
        returnFromGraveyard: 'Return from graveyard', upkeepCost: 'Upkeep cost', misc: 'Choose cards',
        clone: 'Choose a creature to copy', modeTarget: 'Choose the object for this mode', returnOwnCreature: 'Return a creature you control',
        toBottom: 'Put on the bottom of the library', toBottomOwn: 'Put on the bottom of your library', optionalSacrifice: 'You may sacrifice',
        loot: 'Discard', tapOrUntap: 'Tap or untap'
      };
      let dim = [], dimLabel = 'Rest of your library (not selectable)';
      if (d.library) dim = d.library.filter(id => !d.cards.includes(id)).sort((a, b) => g.card(a).name.localeCompare(g.card(b).name));
      else if (Array.isArray(d.revealed)) { dim = d.revealed.filter(id => !d.cards.includes(id)); dimLabel = 'Other revealed cards (not selectable)'; }
      const cards = d.reason === 'search' ? d.cards.slice().sort((a, b) => g.card(a).name.localeCompare(g.card(b).name)) : d.cards.slice();
      this.picker(d, {
        title: titles[d.reason] || 'Choose cards',
        sub: esc(d.prompt) + (d.sourceId ? ' <span class="dim">(' + this.sourceName(d) + ')</span>' : ''),
        cards, dim, dimLabel,
        min: d.min, max: d.max,
        label: (id) => this.zoneLabel(id, d.player) === 'hand' ? '' : this.zoneLabel(id, d.player),
        validate: d.validate ? (ids) => d.validate(ids) : null,
        confirmLabel: d.min === 0 && d.max >= 1 ? 'Done' : 'Confirm',
        onConfirm: (ids) => this.act({ cards: ids }),
        onCancel: d.cancellable ? () => this.act({ cancel: true }) : null,
      });
    }

    openTargetPicker(d, refs) {
      const ids = refs.map(r => r.id);
      const onBoard = d.legal.length > refs.length;
      this.picker(d, {
        title: 'Choose target' + (d.max > 1 ? 's' : ''),
        sub: esc(d.prompt) + (onBoard ? ' <span class="dim">(players / permanents can also be clicked on the table)</span>' : ''),
        cards: ids, min: onBoard ? 0 : d.min, max: d.max,
        label: (id) => this.zoneLabel(id, d.player),
        confirmLabel: d.min === 0 ? 'Done' : 'Confirm',
        onConfirm: (picked) => {
          const chosen = this.ui.targets.filter(r => !(r.kind === 'card' && ids.includes(r.id)));
          for (const id of picked) chosen.push(refs.find(r => r.id === id));
          if (chosen.length >= d.min && chosen.length <= d.max) this.submitTargets(chosen);
          else { this.ui.targets = chosen; this.ui.modalHidden = true; this.syncModalVisibility(); this.requestRender(); }
        },
        onCancel: d.cancellable ? () => this.act({ cancel: true }) : null,
      });
    }

    openOrder(d) {
      const parts = this.modalShell(d, 'Order cards', esc(d.prompt) + ' <span class="dim">The first card will be on top.</span>');
      const order = d.cards.slice();
      const list = document.createElement('div');
      list.className = 'gt-order-list';
      parts.content.appendChild(list);
      const draw = () => {
        list.innerHTML = '';
        order.forEach((id, i) => {
          const row = document.createElement('div');
          row.className = 'gt-order-item';
          const t = this.pickTile(id, (i === 0 ? '<b>Top</b>' : '#' + (i + 1)) + (i === order.length - 1 && i > 0 ? ' (deepest)' : ''));
          row.appendChild(t);
          const ctl = document.createElement('div');
          ctl.className = 'gt-order-ctl';
          const up = document.createElement('button'); up.textContent = '◀'; up.title = 'Move toward the top'; up.disabled = i === 0;
          const dn = document.createElement('button'); dn.textContent = '▶'; dn.title = 'Move deeper'; dn.disabled = i === order.length - 1;
          up.addEventListener('click', (e) => { e.stopPropagation(); [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); });
          dn.addEventListener('click', (e) => { e.stopPropagation(); [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); });
          ctl.appendChild(up); ctl.appendChild(dn);
          row.appendChild(ctl);
          list.appendChild(row);
        });
      };
      draw();
      parts.status.textContent = 'Use the arrows to reorder.';
      this.modalButton(parts, 'Reverse', () => { order.reverse(); draw(); });
      this.modalButton(parts, 'Confirm', () => this.act({ order: order.slice() }), { primary: true });
    }

    openOptionList(d) {
      const parts = this.modalShell(d, d.reason === 'creatureType' ? 'Choose a creature type' : 'Choose one', esc(d.prompt));
      const g = this.g;
      let suggested = [];
      if (d.reason === 'creatureType') {
        const counts = {};
        const mineIds = g.battlefield.filter(id => g.controllerOf(g.card(id)) === d.player).concat(g.players[d.player].hand, g.players[d.player].graveyard);
        for (const id of mineIds) { const c = g.card(id); if (c && g.isCreature(c)) for (const t of c.def.subtypes) counts[t] = (counts[t] || 0) + 1; }
        suggested = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).filter(t => d.options.some(o => o.id === t)).slice(0, 8);
      }
      let chosen = null;
      const wrap = document.createElement('div');
      wrap.className = 'gt-opt-wrap';
      wrap.innerHTML = (suggested.length ? '<div class="gt-opt-sug"><span class="dim">Suggested:</span> ' + suggested.map(s => '<button class="gt-opt" data-opt="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>' : '') +
        '<input class="gt-opt-search" type="text" placeholder="Search…" autocomplete="off"><div class="gt-opt-list"></div>';
      parts.content.appendChild(wrap);
      const list = wrap.querySelector('.gt-opt-list');
      const input = wrap.querySelector('.gt-opt-search');
      let confirm;
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        list.innerHTML = d.options.filter(o => !q || String(o.label).toLowerCase().includes(q))
          .map(o => '<button class="gt-opt' + (chosen === o.id ? ' picked' : '') + '" data-opt="' + esc(o.id) + '">' + esc(o.label) + '</button>').join('');
        for (const b of wrap.querySelectorAll('.gt-opt')) b.classList.toggle('picked', String(chosen) === b.dataset.opt);
        parts.status.textContent = chosen !== null ? 'Selected: ' + chosen : 'Nothing selected';
        if (confirm) confirm.disabled = chosen === null;
      };
      const findOpt = (key) => d.options.find(o => String(o.id) === key);
      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('.gt-opt');
        if (!b) return;
        e.stopPropagation();
        const o = findOpt(b.dataset.opt);
        if (o) { chosen = o.id; draw(); }
      });
      wrap.addEventListener('dblclick', (e) => {
        const b = e.target.closest('.gt-opt');
        if (!b) return;
        const o = findOpt(b.dataset.opt);
        if (o) this.act({ choice: o.id });
      });
      input.addEventListener('input', draw);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const first = list.querySelector('.gt-opt');
          if (chosen === null && first) { const o = findOpt(first.dataset.opt); if (o) chosen = o.id; }
          if (chosen !== null) this.act({ choice: chosen });
        }
      });
      confirm = this.modalButton(parts, 'Confirm', () => { if (chosen !== null) this.act({ choice: chosen }); }, { primary: true });
      draw();
      this.later(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 30);
    }

    // ----- info modals -------------------------------------------------------------
    showInfo(title, contentEl, opts) {
      opts = opts || {};
      const m = this.el.imodal;
      m.innerHTML = '<div class="gt-mbox' + (opts.wide ? ' wide' : '') + '"><div class="titlebar gt-mtitle"><span>' + title + '</span><button class="gt-mhide" data-close="1">Close</button></div><div class="gt-mcontent"></div><div class="gt-mfoot"><span class="gt-mstatus"></span><span class="gt-mbtns"></span></div></div>';
      m.querySelector('.gt-mcontent').appendChild(contentEl);
      m.classList.remove('hidden');
      const close = () => { m.classList.add('hidden'); m.innerHTML = ''; };
      m.querySelector('[data-close]').addEventListener('click', close);
      m.onclick = (e) => { if (e.target === m) close(); };
      const btns = m.querySelector('.gt-mbtns');
      for (const b of opts.buttons || []) {
        const el = document.createElement('button');
        el.innerHTML = b.label;
        if (b.primary) el.className = 'primary';
        el.addEventListener('click', () => { close(); if (b.fn) b.fn(); });
        btns.appendChild(el);
      }
      if (opts.status) m.querySelector('.gt-mstatus').innerHTML = opts.status;
      return close;
    }

    closeInfo() { if (!this.el.imodal.classList.contains('hidden')) { this.el.imodal.classList.add('hidden'); this.el.imodal.innerHTML = ''; return true; } return false; }

    showZone(p, zone) {
      const g = this.g, P = g.players[p];
      const who = p === this.human ? 'Your' : esc(P.name) + '’s';
      if (zone === 'library' || zone === 'hand') {
        const n = zone === 'library' ? P.library.length : P.hand.length;
        if (zone === 'hand' && p === this.human) return;
        const div = document.createElement('div');
        div.className = 'gt-mbig';
        div.textContent = (zone === 'library' ? 'Library' : 'Hand') + ': ' + n + ' card' + (n === 1 ? '' : 's') + '. The contents are hidden.';
        this.showInfo(who + ' ' + zone, div);
        return;
      }
      const ids = (zone === 'graveyard' ? P.graveyard : P.exile).slice().reverse();
      const grid = document.createElement('div');
      grid.className = 'gt-pick-grid gt-zone-' + zone;
      const ai = zone === 'graveyard' && p === this.human ? this.afterimageActions() : [];
      let close = null;
      for (const id of ids) {
        const c = g.card(id);
        const a = ai.find(x => x.cardId === id);
        const label = zone === 'graveyard' && c && c.def && c.def.afterimage ? (a ? '' : '<span class="dim">Afterimage ' + mana(c.def.afterimage) + '</span>') : '';
        const tile = this.pickTile(id, label);
        if (a) {
          tile.classList.add('gt-afterimage');
          const b = document.createElement('button');
          b.className = 'primary gt-ai-btn';
          b.dataset.afterimage = String(id);
          b.innerHTML = 'Cast (Afterimage) ' + mana(c.def.afterimage || '');
          b.title = 'Cast from your graveyard for its Afterimage cost; it is exiled when it leaves the stack';
          b.addEventListener('click', (ev) => { ev.stopPropagation(); if (close) close(); this.doAction(a, ev); });
          tile.appendChild(b);
        }
        grid.appendChild(tile);
      }
      if (!ids.length) grid.innerHTML = '<div class="gt-mbig dim">No cards.</div>';
      const label = zone === 'graveyard' ? 'graveyard' : 'exile';
      const status = ids.length ? 'Most recent first.' + (ai.length ? ' ' + ai.length + ' card' + (ai.length > 1 ? 's' : '') + ' can be cast with Afterimage now.' : '') + (zone === 'exile' ? ' Cards cast with Afterimage are exiled when they leave the stack.' : '') : '';
      close = this.showInfo(who + ' ' + label + ' (' + ids.length + ')', grid, { wide: true, status });
    }

    showCardModal(id) {
      const g = this.g, c = g.card(id);
      if (!c) return;
      if ((c.zone === 'hand' && c.owner !== this.human) || c.zone === 'library') return;
      const d = UI.cardData(c);
      const other = UI.otherFace ? UI.otherFace(d) : null;
      const wrap = document.createElement('div');
      wrap.className = 'gt-cardview' + (other ? ' dfc' : '');
      const faceInfo = (f) => '<div class="gt-cv-name">' + (UI.sideBadgeHTML ? UI.sideBadgeHTML(f) + ' ' : '') + esc(f.name) + ' <span>' + mana(f.cost || '') + '</span></div>' +
        '<div class="gt-cv-type">' + (f.isBack && UI.colorIndicatorHTML ? UI.colorIndicatorHTML(f) : '') + esc(f.printed_type || f.type) + '</div>' +
        '<div class="gt-cv-rules">' + mana(f.printed_rules || f.rules || '') + '</div>' +
        (f.flavor ? '<div class="gt-cv-flavor">' + esc(f.flavor) + '</div>' : '') +
        (f.pt ? '<div class="gt-cv-pt">' + esc(f.pt) + '</div>' : '');
      for (const f of other ? [d, other] : [d]) {
        const col = document.createElement('div');
        col.className = 'gt-cardview-face' + (f === d ? ' current' : '');
        col.appendChild(UI.renderCardThumb(f, { preview: false, className: 'gt-cardview-img' }));
        const info = document.createElement('div');
        info.className = 'gt-cardview-info';
        info.innerHTML = (other ? '<div class="gt-cv-face dim">' + (f === d ? (c.zone === 'battlefield' ? 'Face up now' : 'This face') : 'Other face') + '</div>' : '') + faceInfo(f);
        col.appendChild(info);
        wrap.appendChild(col);
      }
      if (c.def && c.def.afterimage) { const n = document.createElement('div'); n.className = 'gt-cv-note dim'; n.innerHTML = 'Afterimage ' + mana(c.def.afterimage) + ': cast it from your graveyard for this cost; then it is exiled.'; wrap.appendChild(n); }
      this.showInfo(esc(d.name) + (other ? ' / ' + esc(other.name) : ''), wrap, { wide: true });
    }

    showHelp() {
      const div = document.createElement('div');
      div.className = 'gt-help';
      div.innerHTML =
        '<table>' +
        '<tr><td><kbd>F2</kbd></td><td>OK / pass priority once (also confirms Done / Attack / Block / Auto-pay)</td></tr>' +
        '<tr><td><kbd>F4</kbd></td><td>Pass until something happens: until your next turn, an opponent spell or ability, attackers, or a decision</td></tr>' +
        '<tr><td><kbd>F6</kbd></td><td>Pass until end of turn (you still make required choices such as blocks)</td></tr>' +
        '<tr><td><kbd>Esc</kbd></td><td>Cancel the current spell/targeting, close windows, stop F4/F6 passing</td></tr>' +
        '<tr><td><kbd>Ctrl</kbd>+click</td><td>Cast while holding priority (you are not auto-passed afterwards)</td></tr>' +
        '<tr><td><kbd>Shift</kbd>+click</td><td>Cast and pay mana manually (ignores auto-tap once)</td></tr>' +
        '<tr><td>Click</td><td>Hand card: play/cast it. Land / mana source: tap for mana. Permanent: activate its ability</td></tr>' +
        '<tr><td>Right-click</td><td>All legal actions for a card, plus View card</td></tr>' +
        '<tr><td>Stops</td><td>The small lights under the phase bar: green = stop there (top row your turn, bottom row opponent’s turn)</td></tr>' +
        '<tr><td>Combat</td><td>Attack: click creatures, then OK. Block: click your creature, then the attacker</td></tr>' +
        '<tr><td>Zones</td><td>Click Graveyard / Exile counts in the player boxes to view them</td></tr>' +
        '<tr><td>Numbers</td><td>Choosing X or dividing damage: use &minus; / + or the quick buttons, or type the number and press Enter</td></tr>' +
        '<tr><td>Force</td><td>&#x25C8; beside the life total is the player’s Force pool (Force counters). “Use the Force N” costs remove N of them; the number flashes on gain and spend</td></tr>' +
        '<tr><td>Compromise</td><td>Compromise N lets you give an opponent N Force counters; if you don’t, you lose N life</td></tr>' +
        '<tr><td>Attunement</td><td>The ATTUNED tag lights up once a player has spent Force this turn — Attunement abilities are on</td></tr>' +
        '<tr><td>Light / Dark</td><td>&#x2600; / &#x263E; on a double-faced card shows which face is up; hover shows both faces. Back faces show their colour indicator dots</td></tr>' +
        '<tr><td>Afterimage</td><td>Your graveyard glows when a card in it can be cast with Afterimage: click Graveyard, then “Cast (Afterimage)”</td></tr>' +
        '<tr><td>Menace / Indestructible</td><td>Menace (MEN) attackers must be blocked by 2+ creatures; Indestructible (&#x1F6E1; IND) permanents can’t be destroyed by damage or “destroy” effects</td></tr>' +
        '<tr><td>Badges</td><td>+N = +1/+1 counters, &#x25C6; = charge, named counters (influence, forge…), colour dots when a card’s colour was changed</td></tr>' +
        '</table>';
      this.showInfo('Help — hotkeys', div);
    }

    showSettings() {
      const s = this.settings;
      const div = document.createElement('div');
      div.className = 'gt-settings';
      div.innerHTML =
        '<label><input type="checkbox" data-set="autoTap"' + (s.autoTap ? ' checked' : '') + '> Auto-tap mana when casting (optional payments always ask)</label>' +
        '<label><input type="checkbox" data-set="autoPassNoPlays"' + (s.autoPassNoPlays ? ' checked' : '') + '> Auto-pass priority when I have no legal plays</label>' +
        '<div class="dim gt-small">Stops: click the lights under the phase bar. Top row = your turn, bottom row = opponent’s turn.</div>' +
        '<button data-reset="1">Reset stops to defaults</button>';
      div.addEventListener('change', (e) => {
        const k = e.target.dataset.set;
        if (k) { s[k] = !!e.target.checked; saveSettings(s); }
      });
      div.querySelector('[data-reset]').addEventListener('click', () => {
        this.settings.stops = cloneDefaults().stops;
        saveSettings(this.settings);
        this.updateStops();
      });
      this.showInfo('Settings', div);
    }

    confirmConcede() {
      if (this.g.over) return;
      const div = document.createElement('div');
      div.className = 'gt-mbig';
      div.textContent = 'Concede this game?';
      this.showInfo('Concede', div, {
        buttons: [{ label: 'Concede', primary: true, fn: () => { if (typeof this.opts.onConcede === 'function') { try { this.opts.onConcede(this.human); } catch (err) { console.error(err); } } if (this.g.concede) { this.g.concede(this.human); this.closeDecisionModal(); this.requestRender(); this.scheduleDrive(0); return; } this.pendingConcede = true; this.passMode = null; this.requestRender(); this.drivenDecision = this.controllers[this.g.decision && this.g.decision.player] ? this.drivenDecision : null; this.scheduleDrive(0); } }, { label: 'Keep playing' }],
      });
    }

    // ----- reveals / toasts ------------------------------------------------------------
    checkReveals() {
      const g = this.g;
      if (!g.reveals) return;
      while (this.revealCount < g.reveals.length) {
        const r = g.reveals[this.revealCount++];
        this.toastReveal(r);
      }
    }

    toastReveal(r) {
      const g = this.g;
      const t = document.createElement('div');
      t.className = 'gt-toast';
      const who = r.player === this.human ? 'You reveal' : esc(g.players[r.player].name) + ' reveals';
      t.innerHTML = '<div class="gt-toast-title">' + who + (r.cards.length ? '' : ' no cards') + (r.text ? ' <span class="dim">— ' + linkify(r.text) + '</span>' : '') + '</div><div class="gt-toast-cards"></div>';
      const cards = t.querySelector('.gt-toast-cards');
      for (const id of r.cards.slice(0, 10)) {
        const c = g.card(id);
        if (!c) continue;
        const th = UI.renderCardThumb(c, { preview: false });
        th.setAttribute('data-card-name', c.name);
        cards.appendChild(th);
      }
      t.addEventListener('click', () => t.remove());
      this.el.toasts.appendChild(t);
      while (this.el.toasts.children.length > 3) this.el.toasts.removeChild(this.el.toasts.firstChild);
      this.later(() => { t.classList.add('fade'); this.later(() => t.remove(), 600); }, 5500);
    }

    // ----- end of game -------------------------------------------------------------------
    checkEnd() {
      const g = this.g;
      if (!g.over || this.endShown) return;
      const res = { winner: g.winner, endReason: g.endReason, turns: g.turnNumber };
      const title = g.winner === this.human ? 'You win!' : (g.winner === -1 || g.winner === null) ? 'Draw' : 'You lose';
      this.passMode = null;
      this.closeDecisionModal();
      this.showEnd(res, title, this.resultText() + '<div class="gt-small dim">Turns played: ' + g.turnNumber + '</div>');
    }

    showEnd(res, title, html) {
      this.endShown = true;
      const e = this.el.end;
      const cls = res.winner === this.human ? 'win' : (res.winner === -1 || res.winner === null) ? 'draw' : 'lose';
      e.innerHTML = '<div class="gt-endbox ' + cls + '"><div class="gt-endtitle">' + esc(title) + '</div><div class="gt-endtext">' + html + '</div>' +
        '<div class="gt-endbtns"><button class="primary" data-end="continue">Continue</button><button data-end="look">View board</button></div></div>';
      e.classList.remove('hidden');
      e.querySelector('[data-end="continue"]').addEventListener('click', () => {
        if (this.endReported) return;
        this.endReported = true;
        e.classList.add('hidden');
        if (typeof this.opts.onGameEnd === 'function') {
          try { this.opts.onGameEnd(res); } catch (err) { console.error('[GameTable] onGameEnd threw', err); }
        }
      });
      e.querySelector('[data-end="look"]').addEventListener('click', () => {
        e.classList.add('peek');
        const back = document.createElement('button');
        back.className = 'primary gt-end-back';
        back.textContent = 'Back to results';
        back.addEventListener('click', () => { e.classList.remove('peek'); back.remove(); });
        this.root.appendChild(back);
      });
    }

    // ----- keyboard ----------------------------------------------------------------------
    onKey(e) {
      if (this.destroyed || !this.root.isConnected) return;
      if (e.key === 'Control') { this.ctrlDown = true; return; }
      const typing = !!e.target && (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && /^(text|search|number|)$/i.test(e.target.type || '')));
      if (e.key === 'F2' || e.key === 'F4' || e.key === 'F6') {
        e.preventDefault();
        if (this.g.over) return;
        if (e.key === 'F2') this.pressPrimary();
        else this.passUntil(e.key);
        return;
      }
      if (e.key === 'Escape') {
        if (typing && e.target.value && !e.target.classList.contains('gt-num-input')) { e.target.value = ''; e.target.dispatchEvent(new Event('input')); return; }
        e.preventDefault();
        this.pressCancel();
        return;
      }
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('gt-num-input')) {
        e.preventDefault();
        const b = this.el.prompt.querySelector('button[data-act="numOK"]');
        if (b && !b.disabled) b.click();
        return;
      }
      if (e.key === 'Enter' && !typing && e.target === document.body && !this.el.imodal.classList.contains('hidden')) return;
    }

    pressPrimary() {
      if (!this.el.imodal.classList.contains('hidden')) return;
      const dm = this.el.dmodal;
      if (this.dmodalFor && !dm.classList.contains('hidden')) {
        const b = dm.querySelector('button[data-primary]');
        if (b && !b.disabled) b.click();
        return;
      }
      const b = this.el.prompt.querySelector('button[data-primary]');
      if (b && !b.disabled) b.click();
    }

    pressCancel() {
      if (!this.el.menu.classList.contains('hidden')) { this.closeMenu(); return; }
      if (this.closeInfo()) return;
      if (this.passMode) { this.passMode = null; this.requestRender(); return; }
      const dm = this.el.dmodal;
      if (this.dmodalFor && !dm.classList.contains('hidden')) {
        const b = dm.querySelector('button[data-cancel]');
        if (b && !b.disabled) { b.click(); return; }
      }
      const d = this.humanDecision();
      if (d && d.type === 'declareBlockers' && this.ui.pendingBlocker !== null) { this.ui.pendingBlocker = null; this.requestRender(); return; }
      const b = this.el.prompt.querySelector('button[data-cancel]');
      if (b && !b.disabled && d && d.type !== 'yesNo') b.click();
    }
  }

  function mount(container, opts) {
    const t = new Table(container, opts || {});
    return { destroy: () => t.destroy(), table: t };
  }

  UI.GameTable = { mount, STEP_BAR, DEFAULT_SETTINGS, safeAnswer, _Table: Table };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
