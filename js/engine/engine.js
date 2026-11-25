/* Rules engine (Oathfall lineage; The Old Republic edition: Force, double-faced cards, Afterimage).
 *
 * The whole game runs as one generator coroutine. Whenever a player must decide
 * something, the engine yields a decision object (see ENGINE_API.md) and waits
 * until a controller (UI or AI) calls game.respond(answer).
 */
(function (OF) {
  'use strict';
  const U = OF.util;
  const { parseCost, costToString, costTotal, emptyCost, emptyPool, COLORS } = U;

  class GameOver extends Error { constructor() { super('game over'); this.isGameOver = true; } }

  const STEPS = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers',
    'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];
  const STEP_NAMES = {
    untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1', beginCombat: 'Beginning of Combat',
    declareAttackers: 'Declare Attackers', declareBlockers: 'Declare Blockers', firstStrikeDamage: 'First-Strike Damage',
    combatDamage: 'Combat Damage', endCombat: 'End of Combat', main2: 'Main 2', end: 'End of Turn', cleanup: 'Cleanup',
  };

  // ---------------------------------------------------------------------------
  // Card definitions
  // ---------------------------------------------------------------------------
  OF.CardScripts = OF.CardScripts || {};
  const defCache = {};

  function parseTypeLine(line) {
    const [left, right] = line.split(/\s+[—-]\s+/);
    const words = left.trim().split(/\s+/);
    const supertypes = [], types = [];
    let token = false;
    for (const w of words) {
      if (w === 'Legendary' || w === 'Basic') supertypes.push(w);
      else if (w === 'Token') token = true;
      else types.push(w);
    }
    const subtypes = right ? right.trim().split(/\s+/).filter(s => s && s !== 'Legend') : [];
    return { supertypes, types, subtypes, token };
  }

  // Derive simple keywords from rules text so scripts only need non-trivial abilities.
  const KW = { 'flying': 'flying', 'first strike': 'firstStrike', 'double strike': 'doubleStrike', 'trample': 'trample', 'haste': 'haste',
    'vigilance': 'vigilance', 'defender': 'defender', 'fear': 'fear', 'deathtouch': 'deathtouch', 'lifelink': 'lifelink',
    'reach': 'reach', 'shroud': 'shroud', 'flash': 'flash', 'flanking': 'flanking', 'hexproof': 'hexproofOpp',
    'menace': 'menace', 'indestructible': 'indestructible' };
  function deriveKeywords(data) {
    const kws = [];
    let inherit = 0, cycling = null, sunburst = false, equip = null, afterimage = null;
    const lines = (data.rules || '').split('\n').map(s => s.replace(/\s*\([^)]*\)\s*$/, '').trim());
    for (const ln of lines) {
      const parts = ln.split(/,\s*/);
      if (/^(Plains|Island|Swamp|Mountain|Forest)walk$/.test(ln)) { kws.push(ln.toLowerCase()); continue; }
      if (ln === data.name + ' can\'t be the target of spells or abilities.') { kws.push('untargetable'); continue; }
      if (ln === data.name + ' attacks each turn if able.' || ln === data.name + ' attacks each combat if able.') { kws.push('mustAttack'); continue; }
      if (ln === data.name + ' can\'t be blocked by more than one creature.') { kws.push('maxOneBlocker'); continue; }
      if (/can block only creatures with flying\.$/.test(ln) && (ln.startsWith(data.name) || /^This (?:creature|permanent) /i.test(ln) || /^can block only/i.test(ln))) { kws.push('canBlockOnlyFlying'); continue; }
      if (/^Afterimage (\{.+\})$/.test(ln)) { afterimage = /^Afterimage (\{.+\})$/.exec(ln)[1]; continue; }
      if (parts.every(p => KW[p.toLowerCase()])) { for (const p of parts) kws.push(KW[p.toLowerCase()]); continue; }
      let m;
      if ((m = /^Inherit (\d+)$/.exec(ln))) { inherit = parseInt(m[1], 10); continue; }
      if ((m = /^Cycling (\{.+\})$/.exec(ln))) { cycling = m[1]; continue; }
      if ((m = /^Equip (\{[^}]+\})/.exec(ln))) { equip = m[1]; continue; }
      if (/^Sunburst/.test(ln)) { sunburst = true; continue; }
      if (/^Attacking doesn[’']t cause .+ to tap\.$/.test(ln)) { kws.push('vigilance'); continue; }
      if (/^[^.]+ can[’']t block\.$/.test(ln) && ln.startsWith(data.name)) { kws.push('cantBlock'); continue; }
      if (/^[^.]+ (can[’']t be blocked|is unblockable)\.$/.test(ln) && ln.startsWith(data.name)) { kws.push('unblockable'); continue; }
      if (/can block (creatures with flying )?as though it had flying\.$/.test(ln) && ln.startsWith(data.name)) { kws.push('reach'); continue; }
    }
    return { kws, inherit, cycling, sunburst, equip, afterimage };
  }

  /** Data record for a card name; back faces of double-faced cards get a synthesized record. */
  function findData(name) {
    for (const c of OF.CARD_DATA || []) {
      if (c.back && c.back.name === name) {
        const b = c.back;
        return { id: c.id, number: c.number, name: b.name, cost: '', rarity: c.rarity, type: b.type, printed_type: b.printed_type || b.type,
          pt: b.pt, rules: b.rules, printed_rules: b.printed_rules || b.rules, flavor: b.flavor, image: b.image, art: b.art,
          side: b.side, face_id: b.face_id, colorIndicator: b.color_indicator || [], isBack: true, frontName: c.name, frontManaValue: c.mana_value };
      }
    }
    return null;
  }

  function buildDef(name) {
    let data = (OF.CARD_DATA || []).find(c => c.name === name) || findData(name)
      || (OF.TOKEN_DATA || []).find(c => c.name === name)
      || (OF.BASIC_LAND_DATA || []).find(c => c.name === name);
    const script = OF.CardScripts[name] || {};
    if (!data && script.data) data = script.data;
    if (!data) throw new Error('Unknown card: ' + name);
    const tl = parseTypeLine(data.type);
    const cost = parseCost(data.cost);
    let power = null, toughness = null;
    if (data.pt) { const [p, t] = data.pt.split('/'); power = parseInt(p, 10); toughness = parseInt(t, 10); }
    const dk = deriveKeywords(data);
    let colors = data.tokenColors ? data.tokenColors.slice() : data.isBack ? data.colorIndicator.slice() : U.colorsOfCost(cost);
    const def = {
      name: data.name, data, id: data.id,
      cost, costString: data.cost || '', manaValue: data.isBack ? data.frontManaValue : costTotal(cost),
      backName: data.back ? data.back.name : null, frontName: data.isBack ? data.frontName : null, side: data.side || null,
      isBack: !!data.isBack, afterimage: script.afterimage !== undefined ? script.afterimage : dk.afterimage,
      supertypes: tl.supertypes, types: tl.types, subtypes: tl.subtypes,
      isToken: tl.token || data.rarity === 'T',
      colors, power, toughness,
      keywords: (script.keywords || dk.kws).slice(),
      inherit: script.inherit !== undefined ? script.inherit : dk.inherit,
      cycling: script.cycling !== undefined ? script.cycling : dk.cycling,
      spell: script.spell || null,
      activated: (script.activated || []).slice(),
      triggers: (script.triggers || []).slice(),
      statics: (script.statics || []).slice(),
      onEnter: script.onEnter || null,
      enterUnderOpponent: !!script.enterUnderOpponent,
      attackRestriction: script.attackRestriction || null,
      entersTapped: !!script.entersTapped
        || new RegExp('^' + data.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (enters the battlefield|comes into play|enters) tapped\\.$', 'm').test(data.rules || '')
        || /^This (?:land|permanent|artifact|creature|enchantment) (?:enters the battlefield |enters )tapped\.$/m.test(data.rules || ''),
      sunburst: dk.sunburst ? (tl.types.includes('Creature') ? 'p1p1' : 'charge') : null,
      wantsColors: /Confluence|Sunburst/.test(data.rules || ''),
      blockRestriction: script.blockRestriction || null,
      enchant: script.enchant || null,
      ai: script.ai || {},
      implemented: !!OF.CardScripts[name] || isVanillaish(data, dk),
    };
    // Simple mana abilities parsed from the rules text: "[cost, ]{T}: Add ... to your mana pool."
    if (!script.noAutoMana) {
      for (const ln of (data.rules || '').split('\n').map(x => x.trim())) {
        const m = /^((?:\{\d+\}, )?)\{T\}: Add (.+?)(?: to your mana pool)?\.$/.exec(ln);
        if (!m || tl.supertypes.includes('Basic')) continue;
        const extra = m[1] ? m[1].replace(/, $/, '') : null;
        const what = m[2];
        const mk = (produce, amount, label) => ({ mana: { produce, amount: amount || 1 }, cost: Object.assign({ tap: true }, extra ? { mana: extra } : {}), text: label || ln, auto: true });
        const mkChoice = (sym) => { const s = sym === '1' ? 'C' : sym; return mk(s, 1, (extra ? extra + ', ' : '') + '{T}: Add {' + s + '}.'); };
        let mm;
        if (what === 'one mana of any color') def.activated.push(mk('ANY'));
        else if (what === 'two mana in any combination of colors') def.activated.push(mk('ANY', 2));
        else if ((mm = /^\{([WUBRGC1])\}, \{([WUBRGC1])\}(?:,)? or \{([WUBRGC1])\}$/.exec(what))) {
          def.activated.push(mkChoice(mm[1])); def.activated.push(mkChoice(mm[2])); def.activated.push(mkChoice(mm[3]));
        }
        else if ((mm = /^\{([WUBRGC1])\} or \{([WUBRGC1])\}$/.exec(what))) { def.activated.push(mkChoice(mm[1])); def.activated.push(mkChoice(mm[2])); }
        else if ((mm = /^((?:\{[WUBRGC1]\})+)$/.exec(what))) {
          const syms = mm[1].match(/[WUBRGC1]/g).map(x => x === '1' ? 'C' : x);
          def.activated.push(mk(syms.join('')));
        }
      }
    }
    // Basic land mana ability.
    if (tl.supertypes.includes('Basic') && tl.types.includes('Land')) {
      const col = U.COLOR_FOR_BASIC[tl.subtypes[0]];
      def.activated.unshift({ mana: { produce: col }, cost: { tap: true }, text: '{T}: Add {' + col + '}.' });
    }
    // Cycling as a hand ability.
    if (def.cycling) {
      def.activated.push({
        zone: 'hand', isCycling: true, cost: { mana: def.cycling, discardSelf: true },
        text: 'Cycling ' + def.cycling,
        resolve: function* (g, ctx) { g.draw(ctx.controller, 1); },
      });
    }
    // Inherit as an enters-the-battlefield trigger.
    if (def.inherit) {
      const n = def.inherit;
      def.triggers.unshift({
        event: 'etb', isInherit: true, text: 'Inherit ' + n,
        match: (g, src, evt) => evt.card === src,
        resolve: function* (g, ctx) {
          const me = ctx.source;
          if (!g.isOnBattlefield(me, ctx.sourceZcc)) return;
          const p = ctx.controller;
          const fuel = g.players[p].graveyard.map(id => g.card(id))
            .filter(c => g.isCreatureCard(c) && g.sharesCreatureType(c, me));
          if (!fuel.length) return;
          const pick = yield* g.chooseCards(p, fuel, 0, 1, 'Inherit ' + n + ': remove a creature card sharing a type with ' + me.name + ' from the game?', { sourceId: me.id, reason: 'inherit' });
          if (!pick.length) return;
          g.exile(pick[0]);
          g.addCounters(me, n);
          g.log(`[[${me.name}]] inherits from [[${pick[0].name}]] (+${n}/+${n}).`);
        },
      });
    }
    // Equip {N}: attach to target creature you control, sorcery speed.
    if (dk.equip) {
      def.activated.push({
        cost: { mana: dk.equip }, sorcery: true, isEquip: true, text: 'Equip ' + dk.equip,
        targets: [{ type: 'creature', yours: true, prompt: 'Choose a creature you control to equip.', filter: (g, c, p, it) => !it || c.id !== (it.source && it.source.attachedTo) }],
        ai: { kind: 'equip', target: 'ownCreature', when: 'main' },
        resolve: function* (g, ctx) { const c = ctx.t(0); if (c && g.isOnBattlefield(ctx.source)) g.attach(ctx.source, c); },
      });
    }
    def.colors = colors;
    def.multicolored = colors.length >= 2;
    return def;
  }

  function isVanillaish(data, dk) {
    // Cards whose whole text is handled by derived keywords / parsed lines.
    const lines = (data.rules || '').split('\n').map(s => s.replace(/\s*\([^)]*\)\s*$/, '').trim()).filter(Boolean);
    return lines.length === 0 || lines.every(ln => ln.split(/,\s*/).every(p => KW[p.toLowerCase()]) || /^Inherit \d+$|^Cycling \{.+\}$|^Equip \{\d+\}$|^Attacking doesn[’']t cause|can[’']t block\.$|can block only creatures with flying\.$|can[’']t be blocked\.$|is unblockable\.$|as though it had flying\.$|^\(\{T\}: Add|attacks each (turn|combat) if able\.$|can't be blocked by more than one creature\.$|(enters the battlefield|comes into play|enters) tapped\.$|^(\{\d+\}, )?\{T\}: Add (\{[WUBRGC1]\}(, \{[WUBRGC1]\},? or \{[WUBRGC1]\}| or \{[WUBRGC1]\})?|one mana of any color|two mana in any combination of colors)\.$|^(Plains|Island|Swamp|Mountain|Forest)walk$/.test(ln));
  }

  OF.getDef = function (name) {
    if (!defCache[name]) defCache[name] = buildDef(name);
    return defCache[name];
  };
  OF.clearDefCache = function () { for (const k in defCache) delete defCache[k]; };

  // ---------------------------------------------------------------------------
  // Game
  // ---------------------------------------------------------------------------
  class Game {
    constructor(opts) {
      this.opts = Object.assign({ startingLife: 20, handSize: 7, maxTurns: 0 }, opts || {});
      this.seed = this.opts.seed !== undefined ? this.opts.seed : Math.floor(Math.random() * 2 ** 31);
      this.rng = U.makeRng(this.seed);
      this.cards = {};           // id -> card object
      this.nextId = 1;
      this.nextSid = 1;
      this.timestamp = 0;
      this.players = this.opts.players.map((pd, i) => ({
        index: i, isPlayer: true, name: pd.name || ('Player ' + (i + 1)),
        life: this.opts.startingLife, library: [], hand: [], graveyard: [], exile: [],
        manaPool: emptyPool(), landsPlayed: 0, lost: false, drewFromEmpty: false,
        mulligans: 0, lastTurnStarted: 0, ai: !!pd.ai, shields: [], spellsCastThisTurn: 0,
        force: 0, forceSpentThisTurn: 0, lifeGainedThisTurn: 0, creaturesDiedThisTurn: 0, discardedThisTurn: 0,
      }));
      this.battlefield = [];
      this.stack = [];
      this.turnNumber = 0;
      this.activePlayer = 0;
      this.step = null;
      this.priorityPlayer = null;
      this.combat = null;
      this.pendingTriggers = [];
      this.delayedTriggers = [];
      this.extraTurns = [];
      this.logs = [];
      this.decision = null;
      this.over = false;
      this.winner = null;     // player index, or -1 for draw
      this.endReason = '';
      this.preventAllCombatDamage = false;
      this.firstPlayer = null;
      this.reveals = [];       // [{player, cards:[ids], text, seq}]
      this.seq = 0;            // bumps on every change, for UI refresh
      this._decisionSeq = 0;
      this._lookback = null;
      this.listeners = [];
      this._resetTurnStats();
      for (let i = 0; i < this.players.length; i++) {
        for (const name of this.opts.players[i].deck) this._makeCard(name, i, 'library');
      }
    }

    _resetTurnStats() {
      const n = this.players.length;
      this.turnStats = {
        anyCreatureDied: false,
        nontokenDied: Array(n).fill(0),
        jediDied: Array(n).fill(0),
        lifeLost: Array(n).fill(0),
        attackedIds: Array.from({ length: n }, () => []),
        diedCardIds: Array.from({ length: n }, () => []),
      };
    }

    anyCreatureDiedThisTurn() { return !!(this.turnStats && this.turnStats.anyCreatureDied); }
    nontokenDiedThisTurn(p, excludeId) {
      if (!this.turnStats) return 0;
      if (excludeId === undefined || excludeId === null) return this.turnStats.nontokenDied[p] || 0;
      const ids = this.turnStats.diedCardIds[p] || [];
      return ids.filter(id => id !== excludeId).length;
    }
    jediDiedThisTurn(p) { return (this.turnStats && this.turnStats.jediDied[p]) || 0; }
    lifeLostThisTurn(p) { return (this.turnStats && this.turnStats.lifeLost[p]) || 0; }
    attackedThisTurn(p) { return (this.turnStats && this.turnStats.attackedIds[p]) ? this.turnStats.attackedIds[p].slice() : []; }

    // ----- infrastructure -----------------------------------------------------
    _makeCard(name, owner, zone) {
      const def = OF.getDef(name);
      const card = {
        id: this.nextId++, name: def.name, def, owner, controller: owner, zone: null, zcc: 0,
        tapped: false, damage: 0, counters: { p1p1: 0 }, attachedTo: null, token: false,
        controlTs: 0, ts: 0, eot: null, perm: { kw: [] }, shields: [], regen: 0,
        chosenType: null, skipNextUntap: false, abilityUses: {}, _abUsedTurn: {}, _trUsedTurn: {}, eotController: null, baseDef: def,
        frontDef: def, backDef: def.backName ? OF.getDef(def.backName) : null, transformed: false,
      };
      this.cards[card.id] = card;
      this._placeInZone(card, zone, owner, 'top');
      return card;
    }

    card(id) { return typeof id === 'object' ? id : this.cards[id]; }
    opponent(p) { return 1 - p; }
    log(text) { this.logs.push({ turn: this.turnNumber, text }); this._changed(); }
    _changed() { this.seq++; for (const l of this.listeners) { try { l(this); } catch (e) { /* ignore */ } } }
    onChange(fn) { this.listeners.push(fn); }

    start() {
      this.started = true;
      this._gen = this._main();
      this._advance(undefined);
      return this;
    }

    _advance(input) {
      const r = this._gen.next(input);
      if (r.done) this.decision = null; else this.decision = r.value;
      this._changed();
    }

    /** Submit an answer to the current decision. Returns {ok, error}. */
    respond(answer) {
      const d = this.decision;
      if (!d) return { ok: false, error: 'No decision pending' };
      this._lastError = null;
      this._advance(answer);
      if (this.decision === d && this._lastError) return { ok: false, error: this._lastError };
      return { ok: true };
    }

    /** Concede on behalf of player p at any time (not only on their own decision). */
    concede(p) {
      if (this.over) return { ok: false, error: 'Game is over' };
      this.log(`${this.players[p].name} concedes.`);
      this._lose(p, 'conceded');
      this.over = true; this.step = null; this.decision = null;
      try { if (this._gen) this._gen.return(); } catch (e) { /* ignore */ }
      this._changed();
      return { ok: true };
    }

    canActivateMana(p, c, idx) { return this._canActivateMana(p, c, idx); }

    *ask(player, d) {
      d.player = player;
      d.id = ++this._decisionSeq;
      for (;;) {
        const ans = yield d;
        if (ans && ans.type === 'concede') {
          const who = typeof ans.player === 'number' ? ans.player : player;
          this.log(`${this.players[who].name} concedes.`);
          this._lose(who, 'conceded');
          throw new GameOver();
        }
        const err = this._validate(d, ans);
        if (!err) return ans;
        this._lastError = err;
      }
    }

    _validate(d, a) {
      if (!a || typeof a !== 'object') return 'Answer must be an object';
      switch (d.type) {
        case 'chooseCards': {
          if (a.cancel) return d.cancellable ? null : 'Cannot cancel';
          if (!Array.isArray(a.cards)) return 'cards array required';
          if (a.cards.length < d.min || a.cards.length > d.max) return `Choose between ${d.min} and ${d.max} cards`;
          if (new Set(a.cards).size !== a.cards.length) return 'Duplicate cards';
          if (!a.cards.every(id => d.cards.includes(id))) return 'Illegal card choice';
          if (d.validate) return d.validate(a.cards) || null;
          return null;
        }
        case 'chooseTargets': {
          if (a.cancel) return d.cancellable ? null : 'Cannot cancel';
          if (!Array.isArray(a.targets)) return 'targets array required';
          if (a.targets.length < d.min || a.targets.length > d.max) return `Choose between ${d.min} and ${d.max} targets`;
          const keys = a.targets.map(refKey);
          if (new Set(keys).size !== keys.length) return 'Duplicate targets';
          const legalKeys = d.legal.map(refKey);
          if (!keys.every(k => legalKeys.includes(k))) return 'Illegal target';
          if (d.groupCheck) { const e = d.groupCheck(a.targets); if (e) return e; }
          return null;
        }
        case 'yesNo': return typeof a.yes === 'boolean' ? null : 'yes must be boolean';
        case 'chooseNumber': {
          if (a.cancel) return d.cancellable ? null : 'Cannot cancel';
          return (Number.isInteger(a.number) && a.number >= d.min && a.number <= d.max) ? null : `Choose a number from ${d.min} to ${d.max}`;
        }
        case 'chooseColor': return d.colors.includes(a.color) ? null : 'Illegal color';
        case 'chooseOption': if (a.cancel) return d.cancellable ? null : 'Cannot cancel'; return d.options.some(o => o.id === a.choice) ? null : 'Illegal option';
        case 'mulligan': return typeof a.keep === 'boolean' ? null : 'keep must be boolean';
        case 'playFirst': return typeof a.first === 'boolean' ? null : 'first must be boolean';
        case 'orderCards': {
          if (!Array.isArray(a.order) || a.order.length !== d.cards.length) return 'order must list all cards';
          if (!d.cards.every(id => a.order.includes(id))) return 'order must list all cards';
          return null;
        }
        case 'declareAttackers': {
          if (!Array.isArray(a.attackers)) return 'attackers array required';
          if (!a.attackers.every(id => d.candidates.includes(id))) return 'Illegal attacker';
          for (const id of d.mustAttack || []) if (!a.attackers.includes(id) && !(d.attackTax > 0)) return `${this.card(id).name} attacks each turn if able.`;
          if (new Set(a.attackers).size !== a.attackers.length) return 'Duplicate attacker';
          return null;
        }
        case 'declareBlockers': {
          if (!Array.isArray(a.blocks)) return 'blocks array required';
          const seen = {};
          for (const b of a.blocks) {
            const lim = (d.extraBlockers && d.extraBlockers[b.blocker]) || 1;
            seen[b.blocker] = seen[b.blocker] || [];
            if (seen[b.blocker].includes(b.attacker)) return 'Duplicate block';
            seen[b.blocker].push(b.attacker);
            if (seen[b.blocker].length > lim) return lim > 1 ? 'That creature can block at most ' + lim + ' attackers' : 'A creature can block only one attacker';
            if (!d.candidates[b.blocker] || !d.candidates[b.blocker].includes(b.attacker)) return 'Illegal block';
          }
          for (const at of d.maxOneBlocker || []) if (a.blocks.filter(b => b.attacker === at).length > 1) return `${this.card(at).name} can't be blocked by more than one creature.`;
          for (const at of d.menace || []) if (a.blocks.filter(b => b.attacker === at).length === 1) return `${this.card(at).name} has menace (must be blocked by two or more creatures).`;
          const must = d.mustBeBlocked || [];
          if (must.length) {
            // The declaration must satisfy as many "must be blocked" requirements as possible (max matching).
            const covered = new Set(a.blocks.filter(b => must.includes(b.attacker)).map(b => b.attacker));
            const match = {};
            const tryAssign = (at, seen) => {
              for (const bid of Object.keys(d.candidates)) {
                if (!d.candidates[bid].includes(at) || seen.has(bid)) continue;
                seen.add(bid);
                if (match[bid] === undefined || tryAssign(match[bid], seen)) { match[bid] = at; return true; }
              }
              return false;
            };
            let best = 0;
            for (const at of must) if (tryAssign(at, new Set())) best++;
            if (covered.size < best) {
              const missing = must.find(at => !covered.has(at));
              return `${this.card(missing).name} must be blocked if able.`;
            }
          }
          return null;
        }
        case 'priority': {
          if (a.type === 'pass') return null;
          if (a.type === 'mana') return this._canActivateMana(d.player, this.card(a.cardId), a.ability) ? null : 'Cannot activate that mana ability';
          const match = (list) => list.some(x => x.type === a.type && x.cardId === a.cardId && (a.type !== 'activate' || x.ability === a.ability) && (a.type !== 'cast' || (x.alt || null) === (a.alt || null)));
          return (match(d.actions) || match(this.legalActions(d.player))) ? null : 'Illegal action';
        }
        case 'payMana': {
          if (a.type === 'cancel') return d.cancellable ? null : 'Cannot cancel';
          if (a.type === 'auto') return d.canAuto ? null : 'Cannot pay automatically';
          if (a.type === 'mana') {
            if (d.exclude && d.exclude.includes(a.cardId)) return 'That permanent is being tapped to pay this cost';
            return this._canActivateMana(d.player, this.card(a.cardId), a.ability) ? null : 'Cannot activate that mana ability';
          }
          return 'Unknown payment action';
        }
        default: return null;
      }
    }

    // ----- main loop ------------------------------------------------------------
    *_main() {
      try {
        yield* this._setup();
        for (;;) {
          yield* this._turn();
          if (this.opts.maxTurns && this.turnNumber >= this.opts.maxTurns) {
            this.winner = -1; this.endReason = 'turn limit'; this.log('Game drawn: turn limit reached.');
            throw new GameOver();
          }
        }
      } catch (e) {
        if (!e || !e.isGameOver) {
          this.crash = e;
          if (typeof console !== 'undefined') console.error('Oathfall engine error:', e);
          this.winner = -1;
          this.endReason = 'engine error: ' + (e && e.message);
          this.log('The game was stopped by an internal rules error (' + (e && e.message) + '). It is recorded as a draw.');
          if (this.opts.throwOnError) throw e;
        }
      }
      this.over = true;
      this.step = null;
      this._changed();
    }

    *_setup() {
      for (const p of this.players) this.shuffle(p.index);
      let first = this.opts.firstPlayer;
      if (first === undefined || first === null) {
        const chooser = this.opts.chooser !== undefined ? this.opts.chooser : this.rng.int(this.players.length);
        this.log(`${this.players[chooser].name} chooses who plays first.`);
        const a = yield* this.ask(chooser, { type: 'playFirst', prompt: 'Do you want to play first?' });
        first = a.first ? chooser : this.opponent(chooser);
      }
      this.firstPlayer = first;
      this.activePlayer = first;
      this.log(`${this.players[first].name} plays first.`);
      for (const p of this.players) this.draw(p.index, this.opts.handSize, true);
      // London mulligan, in turn order.
      for (const pi of [first, this.opponent(first)]) {
        const p = this.players[pi];
        if (this.opts.noMulligans) break;
        for (;;) {
          if (p.mulligans >= this.opts.handSize) break;
          const a = yield* this.ask(pi, { type: 'mulligan', hand: p.hand.slice(), mulligans: p.mulligans, prompt: p.mulligans ? `Keep this hand? (you will put ${p.mulligans} card(s) on the bottom)` : 'Keep this opening hand?' });
          if (a.keep) break;
          p.mulligans++;
          this.log(`${p.name} mulligans.`);
          while (p.hand.length) this._placeInZone(this.card(p.hand[0]), 'library', pi, 'top');
          this.shuffle(pi);
          this.draw(pi, this.opts.handSize, true);
        }
        if (p.mulligans > 0) {
          const n = Math.min(p.mulligans, p.hand.length);
          const cards = yield* this.chooseCards(pi, p.hand.map(id => this.card(id)), n, n, `Choose ${n} card(s) to put on the bottom of your library.`, { reason: 'mulliganBottom' });
          for (const c of cards) this._placeInZone(c, 'library', pi, 'bottom');
          this.log(`${p.name} keeps ${p.hand.length} cards.`);
        }
      }
    }

    *_turn() {
      const ap = this.extraTurns.length ? this.extraTurns.shift() : (this.turnNumber === 0 ? this.firstPlayer : this.opponent(this.activePlayer));
      this.turnNumber++;
      this.activePlayer = ap;
      const P = this.players[ap];
      P.lastTurnStarted = this.turnNumber;
      P.landsPlayed = 0;
      for (const p of this.players) { p.spellsCastThisTurn = 0; p.forceSpentThisTurn = 0; p.lifeGainedThisTurn = 0; p.creaturesDiedThisTurn = 0; p.discardedThisTurn = 0; p.artifactSpellsThisTurn = 0; }
      this._resetTurnStats();
      this.onceTriggers = {};
      for (const id of this.battlefield) { const bc = this.card(id); bc.abilityUses = {}; bc._abUsedTurn = {}; bc._trUsedTurn = {}; }
      this.log(`— Turn ${this.turnNumber}: ${P.name} —`);

      // Untap step
      this._setStep('untap');
      for (const id of this.battlefield.slice()) {
        const c = this.card(id);
        if (this.controllerOf(c) !== ap) continue;
        if (c.skipNextUntap) { c.skipNextUntap = false; continue; }
        if (this.has(c, 'doesntUntap')) continue;
        c.tapped = false;
      }
      // Upkeep
      this._setStep('upkeep');
      this.emit({ type: 'upkeep', player: ap });
      yield* this._priorityRound();
      // Draw
      this._setStep('draw');
      if (!(this.turnNumber === 1)) this.draw(ap, 1);
      yield* this._priorityRound();
      // Main 1
      this._setStep('main1');
      this.extraCombats = 0; this.combatNumber = 0;
      yield* this._priorityRound();
      yield* this._extraCombats();
      // Combat
      yield* this._combatPhase();
      // Main 2
      this._setStep('main2');
      yield* this._priorityRound();
      yield* this._extraCombats();
      // End step
      this._setStep('end');
      this.emit({ type: 'endStep', player: ap });
      yield* this._priorityRound();
      // Cleanup
      this._setStep('cleanup');
      const hand = this.players[ap].hand;
      if (hand.length > this.opts.handSize) {
        const n = hand.length - this.opts.handSize;
        const cards = yield* this.chooseCards(ap, hand.map(id => this.card(id)), n, n, `Discard ${n} card(s) to hand size.`, { reason: 'cleanupDiscard' });
        for (const c of cards) this.discard(c);
      }
      this._cleanupEffects();
      yield* this._checkStateAndTriggers();
      if (this.stack.length) yield* this._priorityRound();
      this._emptyPools();
    }

    /** Additional combat phases (each followed by an additional main phase) granted this turn. */
    *_extraCombats() {
      while (this.extraCombats > 0) {
        this.extraCombats--;
        this.log('Additional combat phase.');
        yield* this._combatPhase();
        this._setStep('main2');
        yield* this._priorityRound();
      }
    }

    _setStep(step) {
      this._emptyPools();
      this.step = step;
      this._changed();
    }

    _emptyPools() { for (const p of this.players) p.manaPool = emptyPool(); }

    _cleanupEffects() {
      for (const id of this.battlefield.slice()) {
        const c = this.card(id);
        c.damage = 0;
        c.deathtouched = false;
        c.damagedBy = null;
        c.damagedThisTurn = false;
        c.eot = null;
        c.shields = [];
        c.regen = 0;
        if (c.eotController !== null) {
          c.eotController = null;
          c.controlTs = this.turnNumber;
        }
      }
      this.preventAllCombatDamage = false;
      for (const P of this.players) P.shields = [];
      this.delayedTriggers = this.delayedTriggers.filter(t => !t.thisTurn);
    }

    // ----- priority ------------------------------------------------------------
    *_priorityRound() {
      let passes = 0;
      let p = this.activePlayer;
      let actions = 0;
      for (;;) {
        yield* this._checkStateAndTriggers();
        this.priorityPlayer = p;
        const legal = this.legalActions(p);
        const a = yield* this.ask(p, { type: 'priority', actions: legal, step: this.step, stackSize: this.stack.length, prompt: this._priorityPrompt(p) });
        if (a.type === 'pass') {
          passes++;
          if (passes >= this.players.length) {
            if (!this.stack.length) { this.priorityPlayer = null; return; }
            yield* this._resolveTop();
            passes = 0;
            p = this.activePlayer;
            continue;
          }
          p = this.opponent(p);
          continue;
        }
        if (++actions > 300) { this.log('Action limit reached; passing.'); passes++; p = this.opponent(p); continue; }
        if (a.type === 'mana') { yield* this.activateManaAbility(p, this.card(a.cardId), a.ability, a.color); continue; }
        let did = false;
        if (a.type === 'playLand') did = this._playLand(p, this.card(a.cardId));
        else if (a.type === 'cast') did = yield* this.castSpell(p, this.card(a.cardId), a.alt);
        else if (a.type === 'activate') did = yield* this.activateAbility(p, this.card(a.cardId), a.ability);
        if (did) passes = 0;
      }
    }

    _priorityPrompt(p) {
      if (this.stack.length) {
        const top = this.stack[this.stack.length - 1];
        return `${top.name} is on the stack. Respond or pass.`;
      }
      return STEP_NAMES[this.step] + (p === this.activePlayer ? '' : ` (${this.players[this.activePlayer].name}'s turn)`);
    }

    // ----- state-based actions and triggers -------------------------------------
    *_checkStateAndTriggers() {
      for (let guard = 0; guard < 100; guard++) {
        const acted = yield* this._stateBasedActions();
        if (acted) continue;
        if (this.pendingTriggers.length) {
          yield* this._putTriggersOnStack();
          continue;
        }
        return;
      }
    }

    *_stateBasedActions() {
      let acted = false;
      // Players
      const losers = this.players.filter(p => !p.lost && (p.life <= 0 || p.drewFromEmpty));
      if (losers.length) {
        for (const p of losers) {
          p.lost = true;
          this.log(`${p.name} loses the game (${p.life <= 0 ? 'life total 0 or less' : 'drew from an empty library'}).`);
        }
        const alive = this.players.filter(p => !p.lost);
        this.winner = alive.length === 1 ? alive[0].index : -1;
        this.endReason = losers.map(p => p.life <= 0 ? 'life' : 'decking').join(',');
        throw new GameOver();
      }
      const toGrave = [], toDestroy = [];
      for (const id of this.battlefield) {
        const c = this.card(id);
        if (this.isCreature(c)) {
          const t = this.toughness(c);
          if (t <= 0) toGrave.push(c);
          else if (!this.has(c, 'indestructible') && ((c.damage >= t && c.damage > 0) || c.deathtouched)) toDestroy.push(c);
        }
        if (this.isAura(c)) {
          const host = c.attachedTo ? this.card(c.attachedTo) : null;
          if (!host || host.zone !== 'battlefield' || !this._legalAuraHost(c, host) || this.protectedFrom(host, c)) toGrave.push(c);
        }
        if (this.isEquipment(c) && c.attachedTo) {
          const host = this.card(c.attachedTo);
          if (!host || host.zone !== 'battlefield' || !this.isCreature(host) || this.protectedFrom(host, c)) { c.attachedTo = null; acted = true; }
        }
      }
      if (toGrave.length || toDestroy.length) {
        this._beginBatch();
        for (const c of toGrave) if (c.zone === 'battlefield') this.moveToZone(c, 'graveyard');
        for (const c of toDestroy) if (c.zone === 'battlefield' && !toGrave.includes(c)) this.destroy(c);
        this._endBatch();
        acted = true;
      }
      // Legend rule
      const groups = {};
      for (const id of this.battlefield) {
        const c = this.card(id);
        if (!c.def.supertypes.includes('Legendary')) continue;
        const k = this.controllerOf(c) + '|' + c.name;
        (groups[k] = groups[k] || []).push(c);
      }
      for (const k in groups) {
        const g = groups[k];
        if (g.length < 2) continue;
        const ctrl = this.controllerOf(g[0]);
        const keep = yield* this.chooseCards(ctrl, g, 1, 1, `Legend rule: choose the ${g[0].name} to keep.`, { reason: 'legendRule' });
        this._beginBatch();
        for (const c of g) if (c !== keep[0]) this.moveToZone(c, 'graveyard');
        this._endBatch();
        acted = true;
      }
      return acted;
    }

    *_putTriggersOnStack() {
      const pend = this.pendingTriggers;
      this.pendingTriggers = [];
      // APNAP: active player's triggers go on the stack first (resolve last).
      const order = [this.activePlayer, this.opponent(this.activePlayer)];
      for (const p of order) {
        let mine = pend.filter(t => t.controller === p);
        // Inherit triggers go on first so other ETB effects (e.g. loot) resolve before them.
        mine.sort((a, b) => (b.trig.isInherit ? 1 : 0) - (a.trig.isInherit ? 1 : 0));
        for (const t of mine) {
          const item = {
            sid: this.nextSid++, kind: 'trigger', controller: p, source: t.source, sourceZcc: t.sourceZcc,
            ability: t.trig, evt: t.evt, targets: [], name: t.source.name, text: t.trig.text || abilityText(t.source, t.trig),
            sourceId: t.source.id,
          };
          if (t.trig.condition && !t.trig.condition(this, t.source, t.evt)) continue;
          if (t.trig.targets && t.trig.targets.length) {
            const ok = yield* this._chooseAllTargets(p, item, t.trig.targets, false);
            if (!ok) { this.log(`[[${t.source.name}]]'s ability has no legal targets and is removed.`); continue; }
          }
          this.stack.push(item);
          this.log(`[[${t.source.name}]] triggers: ${item.text}`);
        }
      }
    }

    emit(evt) {
      const observers = [];
      if (evt.leaves && this._lookback) {
        for (const lki of this._lookback) observers.push(lki);
      } else {
        for (const id of this.battlefield) observers.push(this.card(id));
        if (evt.leaves && evt.lki && !observers.includes(evt.lki)) observers.push(evt.lki);
      }
      for (const src of observers) {
        const trigs = src.def.triggers;
        for (const trig of trigs) {
          if (trig.event !== evt.type) continue;
          let ok = false;
          try { ok = trig.match ? trig.match(this, src, evt) : true; } catch (e) { ok = false; console.error(e); }
          if (!ok) continue;
          if (trig.condition && !trig.condition(this, src, evt)) continue;
          if (trig.oncePerTurn) {
            // "This ability triggers only once each turn."
            const trKey = src.def.name + ':' + trigs.indexOf(trig);
            const key = src.id + ':' + src.zcc + ':' + trKey;
            this.onceTriggers = this.onceTriggers || {};
            if (this.onceTriggers[key] === this.turnNumber) continue;
            const liveObj = src.isLKI ? this.card(src.id) : src;
            if (liveObj && liveObj.zcc === src.zcc && liveObj._trUsedTurn && liveObj._trUsedTurn[trKey] === this.turnNumber) continue;
            this.onceTriggers[key] = this.turnNumber;
            if (liveObj && liveObj.zcc === src.zcc) (liveObj._trUsedTurn = liveObj._trUsedTurn || {})[trKey] = this.turnNumber;
          }
          const live = src.isLKI ? this.card(src.id) : src;
          // Look-back snapshots of permanents still in play (same zcc) resolve with the live object.
          const stillHere = src.isLKI && live && live.zone === 'battlefield' && live.zcc === src.zcc;
          this.pendingTriggers.push({ source: src.isLKI && !stillHere ? src : live, sourceZcc: src.zcc, trig, evt, controller: this.controllerOf(src) });
        }
      }
      for (const dt of this.delayedTriggers.slice()) {
        if (dt.event !== evt.type) continue;
        if (dt.match && !dt.match(this, evt)) continue;
        if (dt.once) this.delayedTriggers.splice(this.delayedTriggers.indexOf(dt), 1);
        this.pendingTriggers.push({ source: dt.source, sourceZcc: dt.sourceZcc, trig: dt, evt, controller: dt.controller });
      }
    }

    _beginBatch() {
      if (this._batchDepth) { this._batchDepth++; return; }
      this._batchDepth = 1;
      this._lookback = this.battlefield.map(id => this.lki(this.card(id)));
      this._batchEvents = [];
    }
    _endBatch() {
      if (--this._batchDepth > 0) return;
      const evts = this._batchEvents;
      this._batchEvents = null;
      for (const e of evts) this.emit(e);
      this._lookback = null;
    }
    _emitOrQueue(evt) {
      if (this._batchEvents) this._batchEvents.push(evt); else this.emit(evt);
    }

    // ----- zones ---------------------------------------------------------------
    _zoneList(card, zone, owner) {
      const P = this.players[owner];
      switch (zone) {
        case 'library': return P.library;
        case 'hand': return P.hand;
        case 'graveyard': return P.graveyard;
        case 'exile': return P.exile;
        case 'battlefield': return this.battlefield;
        default: return null;
      }
    }

    _removeFromZone(card) {
      if (!card.zone) return;
      if (card.zone === 'battlefield') this._bfv = (this._bfv || 0) + 1;
      const list = this._zoneList(card, card.zone, card.owner);
      if (list) { const i = list.indexOf(card.id); if (i >= 0) list.splice(i, 1); }
    }

    _placeInZone(card, zone, owner, position) {
      const fromLibrary = card.zone === 'library';
      this._removeFromZone(card);
      if (fromLibrary && zone === 'graveyard' && !card.token) this._emitOrQueue({ type: 'libraryToGraveyard', card, player: card.owner });
      card.zone = zone;
      const list = this._zoneList(card, zone, owner);
      if (list) {
        if (position === 'bottom') list.unshift(card.id);   // library top is the END of the array
        else if (position === 'random') list.splice(this.rng.int(list.length + 1), 0, card.id);
        else list.push(card.id);
      }
    }

    _resetObject(card) {
      card.zcc++;
      card.tapped = false; card.damage = 0; card.counters = { p1p1: 0 }; card.attachedTo = null;
      card.eot = null; card.perm = { kw: [] }; card.shields = []; card.regen = 0; card.chosenType = null;
      card.skipNextUntap = false; card.abilityUses = {}; card._abUsedTurn = {}; card._trUsedTurn = {}; card.eotController = null; card.controller = card.owner;
      card.lastPaid = null; card.castInfo = null; card.damagedBy = null; card.deathtouched = false; card.damagedThisTurn = false;
      if (card.frontDef && (card.transformed || card.def !== card.frontDef)) { card.def = card.frontDef; card.baseDef = card.frontDef; card.name = card.frontDef.name; }
      else if (card.baseDef && card.def !== card.baseDef) { card.def = card.baseDef; card.name = card.baseDef.name; }
      card.transformed = false;
      card.cloneOf = null;
    }

    /** Last known information snapshot of a permanent. */
    lki(card) {
      return {
        isLKI: true, id: card.id, zcc: card.zcc, name: card.name, def: card.def, owner: card.owner,
        controller: this.controllerOf(card), token: card.token,
        types: this.typesOf(card), subtypes: this.subtypesOf(card), supertypes: card.def.supertypes,
        colors: this.colorsOf(card), power: this.power(card), toughness: this.toughness(card),
        counters: Object.assign({}, card.counters), chosenType: card.chosenType, attachedTo: card.attachedTo,
        manaValue: card.def.manaValue, wasCreature: this.isCreature(card), damagedBy: (card.damagedBy || []).slice(), cloneOf: card.cloneOf || null,
      };
    }

    /** Move a card to a non-battlefield zone. Emits leave/dies events. */
    moveToZone(card, zone, opts) {
      opts = opts || {};
      const from = card.zone;
      let lki = null;
      if (from === 'battlefield') {
        lki = this.lki(card);
        this._leaveBattlefieldCleanup(card);
      }
      if (from === 'stack') {
        const i = this.stack.findIndex(s => s.kind === 'spell' && s.card === card && !s.isCopy);
        if (i >= 0) this.stack.splice(i, 1);
      }
      this._resetObject(card);
      if (card.token) {
        this._removeFromZone(card);
        card.zone = 'none';
      } else {
        this._placeInZone(card, zone, card.owner, opts.position || 'top');
      }
      if (from === 'graveyard' && zone !== 'graveyard') this._emitOrQueue({ type: 'leftGraveyard', card, player: card.owner, to: zone });
      if (from === 'battlefield') {
        const evt = { type: 'leaves', leaves: true, card, lki, from, to: zone };
        this._emitOrQueue(evt);
        if (zone === 'graveyard') {
          if (lki.wasCreature) {
            this.players[lki.controller].creaturesDiedThisTurn = (this.players[lki.controller].creaturesDiedThisTurn || 0) + 1;
            if (this.turnStats) {
              this.turnStats.anyCreatureDied = true;
              if (!lki.token) {
                this.turnStats.nontokenDied[lki.controller] = (this.turnStats.nontokenDied[lki.controller] || 0) + 1;
                if (this.turnStats.diedCardIds[lki.controller]) this.turnStats.diedCardIds[lki.controller].push(card.id);
              }
              if (lki.subtypes && lki.subtypes.includes('Jedi')) {
                this.turnStats.jediDied[lki.controller] = (this.turnStats.jediDied[lki.controller] || 0) + 1;
              }
            }
          }
          this._emitOrQueue({ type: 'dies', leaves: true, card, lki, from, to: zone });
        }
      }
      this._changed();
      return card;
    }

    _leaveBattlefieldCleanup(card) {
      if (this.combat) this._leaveCombat(card);
      if (card.attachedTo) card.attachedTo = null;
    }

    /** Put a card onto the battlefield (from anywhere). Handles "as enters" choices. */
    *putOntoBattlefield(card, controller, opts) {
      opts = opts || {};
      if (controller === undefined || controller === null) controller = card.owner;
      const from = card.zone;
      if (from === 'stack') {
        const i = this.stack.findIndex(s => s.kind === 'spell' && s.card === card && !s.isCopy);
        if (i >= 0) this.stack.splice(i, 1);
      }
      if (from === 'battlefield') return card;
      if ((card.def.enterUnderOpponent || opts.underOpponent) && !opts.ignoreEnterUnderOpponent) {
        controller = this.opponent(controller);
        this.log(`[[${card.name}]] enters the battlefield under ${this.players[controller].name}'s control.`);
      }
      const castInfo = from === 'stack' ? card.castInfo : null;
      this._resetObject(card);
      card.castInfo = castInfo;
      card.controller = controller;
      this._removeFromZone(card);
      card.zone = 'entering';
      // Sunburst: a counter for each color of mana spent to cast it.
      if (card.def.sunburst) {
        const n = castInfo ? castInfo.colorsSpent : 0;
        if (n) card.counters[card.def.sunburst] = (card.counters[card.def.sunburst] || 0) + n;
      }
      // Revan's Road Beyond: a double-faced card may enter back face up (this is not "turning").
      if (opts.backFace && card.backDef) { card.transformed = true; card.def = card.backDef; card.baseDef = card.backDef; card.name = card.backDef.name; }
      if (card.def.onEnter) yield* card.def.onEnter(this, card, castInfo);
      if (opts.attachTo) card.attachedTo = opts.attachTo;
      card.tapped = !!opts.tapped || card.def.entersTapped;
      card.controlTs = this.turnNumber;
      card.ts = ++this.timestamp;
      card.zone = 'battlefield';
      this.battlefield.push(card.id);
      this._bfv = (this._bfv || 0) + 1;
      if (from === 'graveyard') this._emitOrQueue({ type: 'leftGraveyard', card, player: card.owner, to: 'battlefield' });
      this._emitOrQueue({ type: 'etb', card, controller });
      this._changed();
      return card;
    }

    // ----- characteristics -------------------------------------------------------
    controllerOf(c) {
      if (c.isLKI) return c.controller;
      if (c.zone === 'battlefield' && c.eotController !== null && c.eotController !== undefined) return c.eotController;
      return c.controller;
    }
    typesOf(c) { return c.isLKI ? c.types : c.def.types; }
    subtypesOf(c) { return c.isLKI ? c.subtypes : c.def.subtypes; }
    colorsOf(c) {
      if (c.isLKI) return c.colors;
      if (c.zone === 'battlefield' && c.eot && c.eot.colors) return c.eot.colors;
      if (c.zone === 'battlefield') {
        for (const { src, st } of this._statics()) if (st.colors) { const r = st.colors(this, src, c); if (r) return r; }
      }
      return c.def.colors;
    }
    isMulticolored(c) { return this.colorsOf(c).length >= 2; }
    /** Number of distinct colors among permanents player p controls (Concord). */
    colorsAmong(p) {
      const set = new Set();
      for (const id of this.battlefield) { const c = this.card(id); if (this.controllerOf(c) === p) for (const k of this.colorsOf(c)) set.add(k); }
      return set.size;
    }
    concord(p) { return this.colorsAmong(p) >= 3; }
    controlsMulticolored(p, filter) {
      return this.battlefield.some(id => { const c = this.card(id); return this.controllerOf(c) === p && this.isMulticolored(c) && (!filter || filter(c)); });
    }
    /** Colors a permanent has protection from. */
    protections(c) {
      const out = [];
      if (c.eot && c.eot.protection) out.push(...c.eot.protection);
      return out;
    }
    protectedFrom(c, source) {
      if (!source || c.isLKI) return false;
      const prot = this.protections(c);
      if (!prot.length) return false;
      return this.colorsOf(source).some(k => prot.includes(k));
    }
    isEquipment(c) { return this.isArtifact(c) && this.subtypesOf(c).includes('Equipment'); }
    attach(eq, host) { eq.attachedTo = host.id; this._changed(); }
    /** Mana a player must pay per creature attacking `defender` (Law of Shared Shelter style effects). */
    attackTax(defender) {
      let n = 0;
      for (const { src, st } of this._statics()) if (st.attackTax && this.controllerOf(src) === defender) n += st.attackTax;
      return n;
    }
    /** Permanent change of control (until the permanent leaves play). */
    setController(c, p) {
      if (c.zone !== 'battlefield' || this.controllerOf(c) === p) return;
      c.controller = p; c.eotController = null; c.controlTs = this.turnNumber;
      if (this.combat) this._leaveCombat(c);
      this._changed();
    }
    /** Make a permanent a copy of another card definition (clone); undone when it changes zones. */
    becomeCopy(c, def) { c.def = def; c.name = def.name; c.cloneOf = def.name; this._bfv = (this._bfv || 0) + 1; this._changed(); }
    setColorsEOT(c, colors) { const e = this._eot(c); e.colors = colors.slice(); this._changed(); }
    addCounter(c, kind, n) { if (c.zone !== 'battlefield') return; c.counters[kind] = (c.counters[kind] || 0) + (n || 1); this._changed(); }
    counterCount(c, kind) { return (c.counters && c.counters[kind]) || 0; }
    attacking(c) { return !!(this.combat && this.combat.attackers.some(a => a.id === c.id)); }
    blocking(c) { return !!(this.combat && this.combat.blockers[c.id]); }
    isType(c, t) { return this.typesOf(c).includes(t); }
    isCreature(c) { return this.isType(c, 'Creature'); }
    isLand(c) { return this.isType(c, 'Land'); }
    isArtifact(c) { return this.isType(c, 'Artifact'); }
    isEnchantment(c) { return this.isType(c, 'Enchantment'); }
    isAura(c) { return this.isEnchantment(c) && this.subtypesOf(c).includes('Aura'); }
    hasFirstStrike(c) { return this.has(c, 'firstStrike') || this.has(c, 'doubleStrike'); }
    isBasicLand(c) { return this.isLand(c) && c.def.supertypes.includes('Basic'); }
    isColor(c, col) { return this.colorsOf(c).includes(col); }
    isCreatureCard(c) { return c && !c.token && this.isCreature(c); }
    isPermanentCard(c) { return ['Creature', 'Artifact', 'Enchantment', 'Land'].some(t => this.isType(c, t)); }
    manaValue(c) { return c.isLKI ? c.manaValue : c.def.manaValue; }
    sharesCreatureType(a, b) {
      const sa = this.subtypesOf(a), sb = this.subtypesOf(b);
      return sa.some(t => sb.includes(t));
    }
    hasCounter(c) { return (c.counters && c.counters.p1p1 > 0); }
    charge(c) { return (c.counters && c.counters.charge) || 0; }
    isOnBattlefield(c, zcc) { return c && !c.isLKI && c.zone === 'battlefield' && (zcc === undefined || c.zcc === zcc); }
    threshold(p) { return this.players[p].graveyard.length >= 7; }

    /** All static effects currently active: [{src, st}] */
    _statics() {
      if (this._staticsCache && this._staticsKey === this._bfv) return this._staticsCache;
      const out = [];
      for (const id of this.battlefield) {
        const src = this.card(id);
        for (const st of src.def.statics) out.push({ src, st });
      }
      this._staticsCache = out;
      this._staticsKey = this._bfv;
      return out;
    }

    power(c) {
      if (c.isLKI) return c.power;
      if (!this.isCreature(c)) return null;
      let p = c.def.power + (c.counters.p1p1 || 0) + (c.eot ? c.eot.power : 0);
      if (c.zone === 'battlefield') for (const { src, st } of this._statics()) if (st.pt) { const r = st.pt(this, src, c); if (r) p += r[0]; }
      return p;
    }
    toughness(c) {
      if (c.isLKI) return c.toughness;
      if (!this.isCreature(c)) return null;
      let t = c.def.toughness + (c.counters.p1p1 || 0) + (c.eot ? c.eot.toughness : 0);
      if (c.zone === 'battlefield') for (const { src, st } of this._statics()) if (st.pt) { const r = st.pt(this, src, c); if (r) t += r[1]; }
      return t;
    }

    /** Keyword / flag check. Flags: flying firstStrike trample haste vigilance reach cantBlock cantAttack
     *  unblockable noActivated doesntUntap untargetable */
    has(c, kw) {
      if (kw === 'flying' && !c.isLKI && c.zone === 'battlefield' && this._hasRaw(c, 'noFlying')) return false;
      return this._hasRaw(c, kw);
    }
    _hasRaw(c, kw) {
      if (c.isLKI) return c.def.keywords.includes(kw);
      if (c.def.keywords.includes(kw)) return true;
      if (c.perm && c.perm.kw.includes(kw)) return true;
      if (c.eot && c.eot.kw.includes(kw)) return true;
      if (c.zone === 'battlefield') {
        for (const { src, st } of this._statics()) {
          if (st.keywords) { const r = st.keywords(this, src, c); if (r && r.includes(kw)) return true; }
        }
      }
      return false;
    }

    keywordsOf(c) {
      const all = ['flying', 'firstStrike', 'doubleStrike', 'trample', 'haste', 'vigilance', 'reach', 'defender', 'fear', 'deathtouch', 'lifelink', 'shroud', 'flash', 'flanking', 'menace', 'indestructible', 'maxOneBlocker', 'canBlockOnlyFlying', 'unblockableAlone', 'cantBlock', 'cantAttack', 'unblockable', 'noActivated', 'doesntUntap', 'untargetable', 'hexproofOpp', 'mustBeBlocked', 'mustAttack', 'extraBlock', 'noFlying', 'mountainwalk', 'islandwalk', 'swampwalk', 'forestwalk', 'plainswalk'];
      return all.filter(k => this.has(c, k));
    }

    _eot(c) { if (!c.eot) c.eot = { power: 0, toughness: 0, kw: [] }; return c.eot; }
    pump(c, dp, dt) { const e = this._eot(c); e.power += dp; e.toughness += dt; this._changed(); }
    grantEOT(c, kw) { const e = this._eot(c); if (!e.kw.includes(kw)) e.kw.push(kw); this._changed(); }
    grantPermanent(c, kw) { if (!c.perm.kw.includes(kw)) c.perm.kw.push(kw); }

    isSick(c) {
      if (!this.isCreature(c)) return false;
      const ctrl = this.controllerOf(c);
      return c.controlTs >= this.players[ctrl].lastTurnStarted && !this.has(c, 'haste');
    }

    /** Activated abilities of a card, including granted ones. */
    activatedAbilities(c) {
      const list = c.def.activated.slice();
      if (c.zone === 'battlefield') {
        for (const { src, st } of this._statics()) {
          if (st.grantAbilities) { const r = st.grantAbilities(this, src, c); if (r) for (const a of r) list.push(a); }
        }
      }
      return list;
    }

    canBlock(blocker, attacker) {
      if (!this.isCreature(blocker) || blocker.tapped) return false;
      if (this.has(blocker, 'cantBlock')) return false;
      if (this.has(blocker, 'canBlockOnlyFlying') && !this.has(attacker, 'flying')) return false;
      if (this.has(attacker, 'unblockable')) return false;
      if (this.has(attacker, 'unblockableAlone') && this.combat && this.combat.attackers.length === 1) return false;
      if (this.has(attacker, 'flying') && !this.has(blocker, 'flying') && !this.has(blocker, 'reach')) return false;
      if (this.has(attacker, 'fear') && !(this.isArtifact(blocker) || this.isColor(blocker, 'B'))) return false;
      for (const land of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
        if (this.has(attacker, land.toLowerCase() + 'walk') && this.battlefield.some(id => { const x = this.card(id); return this.controllerOf(x) === this.controllerOf(blocker) && this.isLand(x) && this.subtypesOf(x).includes(land); })) return false;
      }
      if (this.protectedFrom(attacker, blocker)) return false;
      if (attacker.def.blockRestriction && !attacker.def.blockRestriction(this, attacker, blocker)) return false;
      for (const { src, st } of this._statics()) {
        if (st.canBlock && !st.canBlock(this, src, attacker, blocker)) return false;
      }
      return true;
    }

    canAttack(c) {
      return this.isCreature(c) && !c.tapped && !this.isSick(c) && !this.has(c, 'cantAttack') && !this.has(c, 'defender') && this.controllerOf(c) === this.activePlayer && !(c.def.attackRestriction && !c.def.attackRestriction(this, c));
    }

    rulesActive(rule) {
      return this._statics().some(({ src, st }) => st.rule === rule);
    }

    // ----- basic actions -----------------------------------------------------------
    shuffle(p) { this.rng.shuffle(this.players[p].library); this._changed(); }

    draw(p, n, silent) {
      const P = this.players[p];
      const drawn = [];
      for (let i = 0; i < n; i++) {
        if (!P.library.length) { P.drewFromEmpty = true; break; }
        const c = this.card(P.library[P.library.length - 1]);
        this._placeInZone(c, 'hand', p, 'top');
        drawn.push(c);
      }
      if (!silent && drawn.length) this.log(`${P.name} draws ${drawn.length === 1 ? 'a card' : drawn.length + ' cards'}.`);
      this._changed();
      return drawn;
    }

    discard(c) {
      if (c.zone !== 'hand') return;
      this.moveToZone(c, 'graveyard');
      this.log(`${this.players[c.owner].name} discards [[${c.name}]].`);
      this.players[c.owner].discardedThisTurn = (this.players[c.owner].discardedThisTurn || 0) + 1;
      this.emit({ type: 'discard', card: c, player: c.owner });
    }

    *discardChoose(p, n, prompt) {
      const hand = this.players[p].hand.map(id => this.card(id));
      n = Math.min(n, hand.length);
      if (n <= 0) return [];
      const cards = yield* this.chooseCards(p, hand, n, n, prompt || `Discard ${n} card(s).`, { reason: 'discard' });
      for (const c of cards) this.discard(c);
      return cards;
    }

    discardRandom(p, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const hand = this.players[p].hand;
        if (!hand.length) break;
        const c = this.card(hand[this.rng.int(hand.length)]);
        this.discard(c);
        out.push(c);
      }
      return out;
    }

    mill(p, n) {
      const P = this.players[p];
      const out = [];
      for (let i = 0; i < n && P.library.length; i++) {
        const c = this.card(P.library[P.library.length - 1]);
        this.moveToZone(c, 'graveyard');
        out.push(c);
      }
      if (out.length) this.log(`${P.name} puts ${out.map(c => `[[${c.name}]]`).join(', ')} from the top of their library into their graveyard.`);
      return out;
    }

    topCards(p, n) {
      const lib = this.players[p].library;
      return lib.slice(Math.max(0, lib.length - n)).reverse().map(id => this.card(id));
    }

    gainLife(p, n) {
      if (n <= 0) return;
      this.players[p].life += n; this.players[p].lifeGainedThisTurn = (this.players[p].lifeGainedThisTurn || 0) + n;
      this.log(`${this.players[p].name} gains ${n} life.`);
      this._emitOrQueue({ type: 'lifeGained', player: p, amount: n });
    }
    loseLife(p, n) {
      if (n <= 0) return;
      this.players[p].life -= n;
      if (this.turnStats && this.turnStats.lifeLost[p] !== undefined) this.turnStats.lifeLost[p] += n;
      this.log(`${this.players[p].name} loses ${n} life.`);
    }

    /** Deal damage. target is a card or a player object. Returns damage actually dealt. */
    damage(source, target, amount, opts) {
      opts = opts || {};
      if (amount <= 0) return 0;
      if (opts.combat && this.preventAllCombatDamage) return 0;
      const srcName = source ? source.name : 'Damage';
      if (target.isPlayer) {
        let dmgP = amount;
        while (dmgP > 0 && target.shields && target.shields.length) {
          const s = target.shields[0];
          const used = Math.min(s.amount, dmgP);
          s.amount -= used; dmgP -= used;
          if (s.amount <= 0) target.shields.shift();
        }
        if (dmgP < amount) this.log(`${amount - dmgP} damage to ${target.name} is prevented.`);
        if (dmgP <= 0) return 0;
        target.life -= dmgP;
        if (this.turnStats && this.turnStats.lifeLost[target.index] !== undefined) this.turnStats.lifeLost[target.index] += dmgP;
        this.log(`[[${srcName}]] deals ${dmgP} damage to ${target.name}.`);
        this._lifelink(source, dmgP);
        if (opts.combat) this._emitOrQueue({ type: 'combatDamagePlayer', source, player: target.index, amount: dmgP });
        if (source) this._emitOrQueue({ type: 'damageDealt', source, target, amount: dmgP, combat: !!opts.combat });
        return dmgP;
      }
      if (target.zone !== 'battlefield' || !this.isCreature(target)) return 0;
      if (source && this.protectedFrom(target, source)) { this.log(`Damage to [[${target.name}]] is prevented (protection).`); return 0; }
      let dmg = amount;
      while (dmg > 0 && target.shields.length) {
        const s = target.shields[0];
        const used = Math.min(s.amount, dmg);
        s.amount -= used; dmg -= used;
        if (s.amount <= 0) target.shields.shift();
      }
      if (dmg < amount) this.log(`${amount - dmg} damage to [[${target.name}]] is prevented.`);
      if (dmg <= 0) return 0;
      target.damage += dmg;
      if (source && source.id) (target.damagedBy = target.damagedBy || []).push(source.id);
      target.damagedThisTurn = true;
      if (source && !source.isPlayer && source.def && this.has(source, 'deathtouch')) target.deathtouched = true;
      this.log(`[[${srcName}]] deals ${dmg} damage to [[${target.name}]].`);
      this._lifelink(source, dmg);
      if (source) this._emitOrQueue({ type: 'damageDealt', source, target, amount: dmg, combat: !!opts.combat });
      this._changed();
      return dmg;
    }

    _lifelink(source, n) {
      if (!source || source.isPlayer || !source.def || n <= 0 || !this.has(source, 'lifelink')) return;
      this.gainLife(this.controllerOf(source), n);
    }

    // ----- Force counters (The Old Republic) -----------------------------------------
    gainForce(p, n) {
      if (n <= 0) return;
      this.players[p].force += n;
      this.log(`${this.players[p].name} gets ${n} Force counter${n === 1 ? '' : 's'} (${this.players[p].force}).`);
      this._emitOrQueue({ type: 'forceGained', player: p, amount: n });
      this._changed();
    }
    canPayForce(p, n) { return this.players[p].force >= n; }
    payForce(p, n) {
      if (n <= 0) return true;
      const P = this.players[p];
      if (P.force < n) return false;
      P.force -= n; P.forceSpentThisTurn += n;
      this.log(`${P.name} uses the Force (${n}); ${P.force} left.`);
      this._emitOrQueue({ type: 'forceSpent', player: p, amount: n });
      this._changed();
      return true;
    }
    /** Attunement: has player p spent a Force counter this turn? */
    spentForceThisTurn(p) { return this.players[p].forceSpentThisTurn > 0; }
    /** Optional Force payment during resolution ("you may pay N Force counters"). */
    *payForceOptional(p, n, prompt, sourceId) {
      if (!this.canPayForce(p, n)) return false;
      const a = yield* this.ask(p, { type: 'yesNo', prompt: prompt || `Pay ${n} Force counter${n === 1 ? '' : 's'}?`, reason: 'payForce', amount: n, sourceId });
      if (!a.yes) return false;
      return this.payForce(p, n);
    }

    /** Compromise N: give an opponent N Force counters, or lose N life. Returns 'force' | 'life'. */
    *compromise(p, n, opts) {
      opts = opts || {};
      if (!n || n <= 0) return null;
      const s = n === 1 ? '' : 's';
      const options = [
        { id: 'force', label: `Give opponent ${n} Force counter${s}` },
        { id: 'life', label: `Lose ${n} life` },
      ];
      const prompt = opts.prompt || `Compromise ${n}: give an opponent ${n} Force counter${s}, or lose ${n} life.`;
      const choice = yield* this.chooseOption(p, options, prompt, {
        reason: 'compromise', amount: n, sourceId: opts.sourceId,
      });
      if (choice === 'force') {
        const opp = this.opponent(p);
        this.log(`${this.players[p].name} compromises ${n}: ${this.players[opp].name} gets ${n} Force counter${s}.`);
        this.gainForce(opp, n);
        return 'force';
      }
      this.log(`${this.players[p].name} compromises ${n}: loses ${n} life.`);
      this.loseLife(p, n);
      return 'life';
    }

    /** Optional Compromise N ("you may compromise N"): give opponent N Force, lose N life, or decline. Returns true if compromised. */
    *mayCompromise(p, n, opts) {
      opts = opts || {};
      if (!n || n <= 0) return false;
      const s = n === 1 ? '' : 's';
      const options = [
        { id: 'force', label: `Give opponent ${n} Force counter${s}` },
        { id: 'life', label: `Lose ${n} life` },
        { id: 'decline', label: "Don't compromise" },
      ];
      const prompt = opts.prompt || `You may compromise ${n}: give an opponent ${n} Force counter${s}, or lose ${n} life.`;
      const choice = yield* this.chooseOption(p, options, prompt, {
        reason: 'mayCompromise', amount: n, sourceId: opts.sourceId, benefit: opts.benefit,
      });
      if (choice === 'force') {
        const opp = this.opponent(p);
        this.log(`${this.players[p].name} compromises ${n}: ${this.players[opp].name} gets ${n} Force counter${s}.`);
        this.gainForce(opp, n);
        return true;
      }
      if (choice === 'life') {
        this.log(`${this.players[p].name} compromises ${n}: loses ${n} life.`);
        this.loseLife(p, n);
        return true;
      }
      return false;
    }

    // ----- double-faced cards ("turns to the Dark Side / Light Side") -----------------
    isDFC(c) { return !!(c.frontDef && c.backDef); }
    /** Side currently shown: 'light' | 'dark' | null. */
    sideOf(c) { return c.def && c.def.side || null; }
    /** Transform a permanent in place. Returns true if it turned. toSide optional ('light'|'dark'): no-op if already showing it. */
    transform(c, toSide) {
      if (!this.isDFC(c) || c.zone !== 'battlefield') return false;
      const target = c.transformed ? c.frontDef : c.backDef;
      if (toSide && this.sideOf(c) === toSide) return false;
      c.transformed = !c.transformed;
      c.def = target; c.baseDef = target; c.name = target.name;
      this._bfv = (this._bfv || 0) + 1;
      const side = target.side;
      this.log(`[[${c.name}]] turns to the ${side === 'dark' ? 'Dark' : 'Light'} Side.`);
      this._emitOrQueue({ type: 'transformed', card: c, toSide: side });
      this._changed();
      return true;
    }

    preventNext(c, n) { (c.shields = c.shields || []).push({ amount: n }); this._changed(); }
    grantProtection(c, color) { const e = this._eot(c); e.protection = e.protection || []; if (!e.protection.includes(color)) e.protection.push(color); this._changed(); }
    regenShield(c) { c.regen++; this._changed(); }

    /** Destroy a permanent (indestructible prevents, regeneration may replace). Returns true if it left. */
    destroy(c, opts) {
      opts = opts || {};
      if (c.zone !== 'battlefield') return false;
      if (this.has(c, 'indestructible') && !opts.ignoreIndestructible) {
        this.log(`[[${c.name}]] is indestructible and can't be destroyed.`);
        return false;
      }
      if (c.regen > 0 && !opts.noRegen && this.isCreature(c)) {
        c.regen--;
        c.tapped = true; c.damage = 0; c.deathtouched = false;
        this._leaveCombat(c);
        this.log(`[[${c.name}]] regenerates.`);
        return false;
      }
      this.moveToZone(c, 'graveyard');
      this.log(`[[${c.name}]] is destroyed.`);
      return true;
    }

    /** Two creatures on the battlefield fight: each simultaneously deals damage equal to its power to the other. */
    fight(a, b) {
      if (!a || !b || a.id === b.id) return false;
      if (!this.isOnBattlefield(a) || !this.isOnBattlefield(b)) return false;
      if (!this.isCreature(a) || !this.isCreature(b)) return false;
      const pa = this.power(a) || 0;
      const pb = this.power(b) || 0;
      this.log(`[[${a.name}]] fights [[${b.name}]].`);
      this._beginBatch();
      if (pa > 0) this.damage(a, b, pa);
      if (pb > 0) this.damage(b, a, pb);
      this._endBatch();
      return true;
    }

    _leaveCombat(c) {
      if (!this.combat) return;
      this.combat.attackers = this.combat.attackers.filter(a => a.id !== c.id);
      for (const a of this.combat.attackers) a.blockers = a.blockers.filter(b => b !== c.id);
      delete this.combat.blockers[c.id];
      if (this.combat.blockAssign) delete this.combat.blockAssign[c.id];
    }

    sacrifice(c) {
      if (c.zone !== 'battlefield') return false;
      const who = this.players[this.controllerOf(c)].name;
      this.moveToZone(c, 'graveyard');
      this.log(`${who} sacrifices [[${c.name}]].`);
      return true;
    }

    *sacrificeChoose(p, filter, n, prompt) {
      const cands = this.battlefield.map(id => this.card(id)).filter(c => this.controllerOf(c) === p && (!filter || filter(c)));
      n = Math.min(n || 1, cands.length);
      if (!n) return [];
      const chosen = yield* this.chooseCards(p, cands, n, n, prompt || `Sacrifice ${n === 1 ? 'a permanent' : n + ' permanents'}.`, { reason: 'sacrifice' });
      this._beginBatch();
      for (const c of chosen) this.sacrifice(c);
      this._endBatch();
      return chosen;
    }

    exile(c) {
      const from = c.zone;
      if (from === 'stack') { this.moveToZone(c, 'exile'); return; }
      this.moveToZone(c, 'exile');
      this.log(`[[${c.name}]] is removed from the game.`);
    }

    bounce(c) {
      if (c.zone !== 'battlefield') return;
      this.moveToZone(c, 'hand');
      this.log(`[[${c.name}]] is returned to ${this.players[c.owner].name}'s hand.`);
    }

    toHand(c) { this.moveToZone(c, 'hand'); }

    tap(c) { if (!c.tapped) { c.tapped = true; this._changed(); } }
    untap(c) { if (c.tapped) { c.tapped = false; this._changed(); } }

    addCounters(c, n) {
      if (c.zone !== 'battlefield' || n <= 0) return;
      c.counters.p1p1 = (c.counters.p1p1 || 0) + n;
      this._changed();
    }
    removeCounters(c, n, kind) { kind = kind || 'p1p1'; c.counters[kind] = Math.max(0, (c.counters[kind] || 0) - n); this._changed(); }
    addCharge(c, n) { if (c.zone !== 'battlefield') return; c.counters.charge = (c.counters.charge || 0) + n; this._changed(); }

    gainControlEOT(c, p) {
      if (c.zone !== 'battlefield' || this.controllerOf(c) === p) return;
      c.eotController = p;
      c.controlTs = this.turnNumber;
      if (this.combat) this._leaveCombat(c);
      this._changed();
    }

    *createToken(p, tokenName, count, opts) {
      opts = opts || {};
      const made = [];
      for (let i = 0; i < (count || 1); i++) {
        let card;
        if (opts.copyOf) {
          card = this._makeCard(opts.copyOf.name, p, null);
        } else {
          card = this._makeCard(tokenName, p, null);
        }
        card.token = true;
        yield* this.putOntoBattlefield(card, p, { tapped: opts.tapped || opts.attacking });
        if (opts.haste) this.grantPermanent(card, 'haste');
        if (opts.attacking) this.addAttacker(card);
        made.push(card);
      }
      const nm = made.length ? made[0].name : tokenName;
      this.log(`${this.players[p].name} puts ${made.length === 1 ? 'a' : made.length} ${nm} token${made.length === 1 ? '' : 's'} into play.`);
      return made;
    }

    extraTurn(p) { this.extraTurns.unshift(p); this.log(`${this.players[p].name} will take an extra turn.`); }

    winGame(p, reason) {
      for (const q of this.players) if (q.index !== p) q.lost = true;
      this.winner = p; this.endReason = reason || 'card';
      this.log(`${this.players[p].name} wins the game${reason ? ' (' + reason + ')' : ''}.`);
      throw new GameOver();
    }
    _lose(p, reason) {
      this.players[p].lost = true;
      const alive = this.players.filter(q => !q.lost);
      this.winner = alive.length === 1 ? alive[0].index : -1;
      this.endReason = reason;
    }

    reveal(p, cards, text) {
      this.reveals.push({ player: p, cards: cards.map(c => c.id), text: text || '', seq: ++this.seq });
      this.log(`${this.players[p].name} reveals ${cards.length ? cards.map(c => `[[${c.name}]]`).join(', ') : 'no cards'}.`);
    }

    counterItem(item, opts) {
      const i = this.stack.indexOf(item);
      if (i < 0) return false;
      this.stack.splice(i, 1);
      if (item.kind === 'spell' && !item.isCopy) {
        this.moveToZone(item.card, (opts && opts.exile) || item.afterimage ? 'exile' : 'graveyard');
      }
      this.log(`[[${item.name}]] is countered.`);
      this._changed();
      return true;
    }

    // ----- decisions helpers for scripts ----------------------------------------
    *chooseCards(p, cards, min, max, prompt, opts) {
      opts = opts || {};
      cards = cards.filter(Boolean);
      max = Math.min(max, cards.length);
      min = Math.min(min, max);
      if (max <= 0) return [];
      if (min === max && max === cards.length && !opts.alwaysAsk) return cards.slice();
      const a = yield* this.ask(p, Object.assign({ type: 'chooseCards', cards: cards.map(c => c.id), min, max, prompt }, opts));
      return a.cards.map(id => this.card(id));
    }

    *chooseNumber(p, min, max, prompt, opts) {
      if (max <= min) return min;
      const a = yield* this.ask(p, Object.assign({ type: 'chooseNumber', min, max, prompt }, opts || {}));
      return a.number;
    }

    *yesNo(p, prompt, opts) {
      const a = yield* this.ask(p, Object.assign({ type: 'yesNo', prompt }, opts || {}));
      return a.yes;
    }

    *chooseColor(p, prompt, colors, opts) {
      const a = yield* this.ask(p, Object.assign({ type: 'chooseColor', colors: colors || COLORS.slice(), prompt: prompt || 'Choose a color.' }, opts || {}));
      return a.color;
    }

    *chooseOption(p, options, prompt, opts) {
      const a = yield* this.ask(p, Object.assign({ type: 'chooseOption', options, prompt }, opts || {}));
      return a.choice;
    }

    *chooseCreatureType(p, prompt) {
      const types = OF.allCreatureTypes();
      const choice = yield* this.chooseOption(p, types.map(t => ({ id: t, label: t })), prompt || 'Choose a creature type.', { reason: 'creatureType' });
      return choice;
    }

    *orderCards(p, cards, prompt) {
      if (cards.length <= 1) return cards.slice();
      const a = yield* this.ask(p, { type: 'orderCards', cards: cards.map(c => c.id), prompt: prompt || 'Order these cards (first = top).' });
      return a.order.map(id => this.card(id));
    }

    /** Ask a player to optionally pay a mana cost. Returns true if paid. */
    *payOptional(p, costStr, prompt, sourceId, reason) {
      const cost = parseCost(costStr);
      if (!this.canAfford(p, cost)) return false;
      return yield* this.payMana(p, cost, { cancellable: true, prompt: prompt || `Pay ${costStr}?`, sourceId, optional: true, reason });
    }

    *searchLibrary(p, filter, max, prompt) {
      const lib = this.players[p].library.map(id => this.card(id));
      const cands = lib.filter(filter);
      const a = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(c => c.id), min: 0, max: Math.min(max, cands.length), prompt, reason: 'search', library: lib.map(c => c.id) });
      return a.cards.map(id => this.card(id));
    }

    // ----- mana ------------------------------------------------------------------
    /** Mana abilities of a permanent, with their indices. */
    _manaAbilities(c) {
      const out = [];
      const abs = this.activatedAbilities(c);
      abs.forEach((ab, i) => { if (ab.mana) out.push({ ab, index: i }); });
      return out;
    }

    _canActivateMana(p, c, idx) {
      if (!c || c.zone !== 'battlefield' || this.controllerOf(c) !== p) return false;
      const ab = this.activatedAbilities(c)[idx];
      if (!ab || !ab.mana) return false;
      return this._manaAbilityUsable(p, c, ab, true);
    }

    /** Can this Aura legally enchant host? def.enchant = {type:'artifact'|'creature'|'enchantment'|'land'|'permanent'|[...]} (default creature). */
    _legalAuraHost(aura, host) {
      const sp = aura.def.enchant;
      if (!sp) return this.isCreature(host);
      return [].concat(sp.type).some(k => k === 'permanent' || (k === 'creature' && this.isCreature(host)) || (k === 'artifact' && this.isArtifact(host))
        || (k === 'enchantment' && this.isEnchantment(host)) || (k === 'land' && this.isLand(host)));
    }

    _tapCreatureCandidates(p, src, exclude) {
      return this.battlefield.map(id => this.card(id)).filter(x => x !== src && this.controllerOf(x) === p && this.isCreature(x) && !x.tapped && !(exclude && exclude.has(x.id)));
    }
    _manaAbilityUsable(p, c, ab, checkCost, spendFor) {
      const cost = ab.cost || {};
      if (cost.tap && (c.tapped || this.isSick(c))) return false;
      if (cost.removeCounters && (c.counters[cost.counterKind || 'p1p1'] || 0) < cost.removeCounters) return false;
      if (cost.force && this.players[p].force < cost.force) return false;
      if (cost.tapCreature && !this._tapCreatureCandidates(p, c, spendFor && spendFor.exclude).length) return false;
      if (this.isCreature(c) && (this.players[p].creatureAbilitiesLockedTurn === this.turnNumber || this.has(c, 'noActivated'))) return false;
      if (ab.condition && !ab.condition(this, c, p)) return false;
      if (ab.mana.spendOnly && !(spendFor && ab.mana.spendOnly(this, spendFor))) return false;
      if (checkCost && cost.mana) {
        if (!this.canAfford(p, parseCost(cost.mana), { exclude: new Set([c.id]) })) return false;
      }
      return true;
    }

    /** Units of mana an ability makes: array of 'W'..'G', 'C' or 'ANY'. */
    _manaUnits(c, ab) {
      const m = ab.mana;
      const amount = typeof m.amount === 'function' ? m.amount(this, c) : (m.amount === undefined ? 1 : m.amount);
      const out = [];
      if (amount <= 0) return out;
      if (m.produce === 'ANY' || m.produce === 'C') { for (let i = 0; i < amount; i++) out.push(m.produce); return out; }
      for (let i = 0; i < amount; i++) for (const ch of m.produce) out.push(ch);
      return out;
    }

    /** Activate a mana ability: pay its costs and add mana to the pool. */
    *activateManaAbility(p, c, idx, color, spendFor) {
      const ab = this.activatedAbilities(c)[idx];
      if (!ab || !ab.mana || !this._manaAbilityUsable(p, c, ab, true, spendFor)) return false;
      const cost = ab.cost || {};
      if (cost.force) this.payForce(p, cost.force);
      if (cost.tapCreature) { const t = this._tapCreatureCandidates(p, c)[0]; if (t) t.tapped = true; }
      if (cost.mana) {
        const ok = this._autoPayFromSources(p, parseCost(cost.mana), new Set([c.id]));
        if (!ok) return false;
      }
      if (cost.tap) c.tapped = true;
      if (cost.removeCounters) this.removeCounters(c, cost.removeCounters, cost.counterKind);
      const units = this._manaUnits(c, ab);
      const pool = this.players[p].manaPool;
      const anyCount = units.filter(u => u === 'ANY').length;
      for (const u of units) if (u !== 'ANY') pool[u] += 1;
      for (let i = 0; i < anyCount; i++) {
        let col = (i === 0 && color && COLORS.includes(color)) ? color : null;
        if (!col) col = yield* this.chooseColor(p, anyCount > 1 ? `Choose a color of mana to add (${i + 1} of ${anyCount}).` : 'Choose a color of mana to add.', null, { reason: 'mana', sourceId: c.id });
        pool[col] += 1;
      }
      this._changed();
      return true;
    }

    /** Apply pool mana to a cost (mutates remaining and pool). Returns the mana spent. */
    _applyPool(p, remaining, opts) {
      opts = opts || {};
      const pool = this.players[p].manaPool;
      const spent = emptyPool();
      const already = opts.alreadySpent || emptyPool();
      const use = (col, n) => { pool[col] -= n; spent[col] += n; };
      for (const col of COLORS) {
        const n = Math.min(pool[col], remaining[col]);
        if (n) { use(col, n); remaining[col] -= n; }
      }
      if (remaining.C) { const n = Math.min(pool.C, remaining.C); use('C', n); remaining.C -= n; }
      const hy = remaining.hybrid || [];
      for (let i = hy.length - 1; i >= 0; i--) {
        const opts2 = hy[i].filter(k => pool[k] > 0);
        if (!opts2.length) continue;
        opts2.sort((a, b) => opts.diverse ? ((already[a] + spent[a]) - (already[b] + spent[b])) : (pool[b] - pool[a]));
        use(opts2[0], 1);
        hy.splice(i, 1);
      }
      while (remaining.generic > 0) {
        let order;
        if (opts.diverse) order = COLORS.filter(k => pool[k] > 0 && !(already[k] + spent[k])).concat(COLORS.filter(k => pool[k] > 0), ['C']);
        else order = ['C', ...COLORS.slice().sort((a, b) => pool[b] - pool[a])];
        const col = order.find(k => pool[k] > 0);
        if (!col) break;
        use(col, 1); remaining.generic -= 1;
      }
      return spent;
    }

    /** List mana sources for the solver: [{card, opts:[{index, units, extra, counters}], tier}] */
    _manaSources(p, exclude, spendFor) {
      const out = [];
      for (const id of this.battlefield) {
        const c = this.card(id);
        if (this.controllerOf(c) !== p || (exclude && exclude.has(c.id))) continue;
        const abs = this._manaAbilities(c);
        if (!abs.length) continue;
        const tapOpts = [], counterOpts = [];
        for (const { ab, index } of abs) {
          if (!this._manaAbilityUsable(p, c, ab, false, spendFor)) continue;
          if (ab.cost && ab.cost.force && !(spendFor && spendFor.allowForceMana)) continue;
          if (ab.cost && ab.cost.tapCreature && !spendFor) continue;
          const units = this._manaUnits(c, ab);
          if (!units.length) continue;
          const extra = ab.cost && ab.cost.mana ? costTotal(parseCost(ab.cost.mana)) : 0;
          const o = { index, units, extra };
          if (ab.cost && ab.cost.removeCounters && !ab.cost.tap) counterOpts.push(o); else tapOpts.push(o);
        }
        const tier = this.isLand(c) ? 0 : (this.isCreature(c) ? 2 : 1);
        if (tapOpts.length) out.push({ card: c, opts: tapOpts, tier, key: c.id + ':t' });
        // abilities that remove counters (no tap) can be used once per counter
        for (const o of counterOpts) {
          const oc = this.activatedAbilities(c)[o.index].cost;
          const n = Math.floor((c.counters[oc.counterKind || 'p1p1'] || 0) / (oc.removeCounters || 1));
          for (let i = 0; i < n; i++) out.push({ card: c, opts: [o], tier: 3, key: c.id + ':c' + i });
        }
      }
      return out;
    }

    /**
     * Find mana activations that pay `cost` together with the current pool.
     * Returns [{card, index, colors:[for ANY units]}] (possibly empty) or null if impossible.
     * opts.exclude: Set of card ids not to use; opts.diverse: prefer spending many colors.
     */
    solveMana(p, cost, opts) {
      opts = opts || {};
      const need = U.cloneCost(cost);
      if (need.C) return null;
      const pool = this.players[p].manaPool;
      const baseUnits = { W: pool.W, U: pool.U, B: pool.B, R: pool.R, G: pool.G, C: pool.C, ANY: 0 };
      const sources = this._manaSources(p, opts.exclude, opts.spendFor);
      const pref = (s) => {
        const o = s.opts[0];
        const single = o.units.length === 1 && o.units[0] !== 'ANY' ? 0 : 1;
        return s.tier * 10 + single * 2 + (o.extra ? 3 : 0);
      };
      // Prefer tapping sources whose colors are least needed by the other cards in hand (keep scarce colors open).
      const demand = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ANY: 0 }, supply = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ANY: 0 };
      for (const id of this.players[p].hand) {
        const hc = this.card(id);
        if (this.isLand(hc)) continue;
        for (const k of COLORS) demand[k] += hc.def.cost[k] || 0;
        for (const h of hc.def.cost.hybrid || []) for (const k of h) demand[k] += 0.5;
      }
      for (const k of COLORS) demand[k] += need[k] || 0;
      for (const s of sources) for (const u of s.opts[0].units) supply[u] = (supply[u] || 0) + 1;
      const scarcity = (s) => { const u = s.opts[0].units[0]; return (u === 'ANY' || u === 'C') ? 0 : (demand[u] || 0) / Math.max(1, supply[u] || 0); };
      sources.sort((a, b) => pref(a) - pref(b) || scarcity(a) - scarcity(b));
      if (opts.diverse) {
        // round-robin across produced colors so the first plan found spends many colors
        const groups = {};
        for (const s of sources) { const k = s.opts[0].units[0]; (groups[k] = groups[k] || []).push(s); }
        const keys = Object.keys(groups).sort((a, b) => (a === 'ANY') - (b === 'ANY'));
        const rr = [];
        for (let i = 0; rr.length < sources.length; i++) for (const k of keys) if (groups[k][i]) rr.push(groups[k][i]);
        sources.length = 0; sources.push(...rr);
      }
      // deficit of a unit multiset against the requirement
      const deficit = (u, extra) => {
        const r = Object.assign({}, u);
        let unmet = 0;
        for (const k of COLORS) {
          let n = need[k];
          const a = Math.min(r[k], n); r[k] -= a; n -= a;
          const b = Math.min(r.ANY, n); r.ANY -= b; n -= b;
          unmet += n;
        }
        for (const h of need.hybrid) {
          const opts2 = h.filter(k => r[k] > 0).sort((a, b) => r[b] - r[a]);
          if (opts2.length) r[opts2[0]]--;
          else if (r.ANY > 0) r.ANY--;
          else unmet++;
        }
        const left = r.W + r.U + r.B + r.R + r.G + r.C + r.ANY;
        unmet += Math.max(0, need.generic + extra - left);
        return unmet;
      };
      let best = null, budget = 6000;
      const chosen = [];
      const remainingCap = sources.map((s, i) => sources.slice(i).reduce((a, x) => a + Math.max(...x.opts.map(o => o.units.length)), 0));
      const dfs = (i, units, extra) => {
        if (best || --budget < 0) return;
        const d = deficit(units, extra);
        if (d === 0) { best = chosen.slice(); return; }
        if (i >= sources.length) return;
        if (d > remainingCap[i]) return;
        const s = sources[i];
        for (const o of s.opts) {
          const nu = Object.assign({}, units);
          for (const x of o.units) nu[x] += 1;
          const ne = extra + o.extra;
          if (deficit(nu, ne) < d) {
            chosen.push({ s, o });
            dfs(i + 1, nu, ne);
            chosen.pop();
            if (best) return;
          }
        }
        dfs(i + 1, units, extra);
      };
      dfs(0, baseUnits, 0);
      if (!best) return null;
      // Colors for ANY units: cover unmet colored/hybrid needs first, then (diverse) new colors.
      const u = Object.assign({}, baseUnits);
      for (const { o } of best) for (const x of o.units) if (x !== 'ANY') u[x]++;
      const wants = [];
      for (const k of COLORS) for (let n = need[k] - u[k]; n > 0; n--) { wants.push(k); }
      for (const k of COLORS) u[k] = Math.max(0, u[k] - need[k]);
      for (const h of need.hybrid) { const k = h.find(x => u[x] > 0); if (k) u[k]--; else wants.push(h[0]); }
      if (opts.diverse) for (const k of COLORS) if (!wants.includes(k) && !(baseUnits[k] || best.some(b => b.o.units.includes(k)))) wants.push(k);
      const plan = [];
      for (const { s, o } of best) {
        const colors = [];
        for (const x of o.units) if (x === 'ANY') colors.push(wants.length ? wants.shift() : 'W');
        plan.push({ card: s.card, index: o.index, colors, extra: o.extra });
      }
      plan.sort((a, b) => (a.extra ? 1 : 0) - (b.extra ? 1 : 0));
      plan.exclude = opts.exclude;
      return plan;
    }

    targetCandidates(spec, controller, item) { return this._targetCandidates(spec, controller, item); }
    manaSources(p, exclude) { return this._manaSources(p, exclude); }
    staticEffects() { return this._statics(); }

    canAfford(p, cost, opts) {
      return !!this.solveMana(p, cost, opts);
    }

    /** Pay a mana cost automatically from pool + sources. Returns true on success. */
    _autoPayFromSources(p, cost, exclude, spendFor) {
      const plan = this.solveMana(p, cost, { exclude, spendFor });
      if (!plan) return false;
      this._executePlan(p, plan, cost);
      const rem = U.cloneCost(cost);
      this._applyPool(p, rem);
      return costTotal(rem) === 0;
    }

    _executePlan(p, plan, forCost) {
      const pool = this.players[p].manaPool;
      for (const step of plan) {
        const c = step.card;
        const ab = this.activatedAbilities(c)[step.index];
        if (ab.cost && ab.cost.mana) this._payFromPoolAvoiding(p, parseCost(ab.cost.mana), forCost);
        if (ab.cost && ab.cost.tap) c.tapped = true;
        if (ab.cost && ab.cost.removeCounters) this.removeCounters(c, ab.cost.removeCounters, ab.cost.counterKind);
        if (ab.cost && ab.cost.force) this.payForce(p, ab.cost.force);
        if (ab.cost && ab.cost.tapCreature) { const t = this._tapCreatureCandidates(p, c, plan.exclude)[0]; if (t) t.tapped = true; }
        const colors = (step.colors || []).slice();
        for (const x of this._manaUnits(c, ab)) pool[x === 'ANY' ? (colors.shift() || 'W') : x] += 1;
      }
      this._changed();
    }

    _payFromPoolAvoiding(p, sub, reserve) {
      const pool = this.players[p].manaPool;
      let g = sub.generic;
      const reserved = (k) => (reserve && reserve[k]) || 0;
      const order = ['C', ...COLORS.slice().sort((a, b) => reserved(a) - reserved(b))];
      for (const col of order) {
        const spare = pool[col] - reserved(col);
        const n = Math.min(Math.max(spare, 0), g);
        pool[col] -= n; g -= n;
      }
      for (const col of order) { const n = Math.min(pool[col], g); pool[col] -= n; g -= n; }
    }

    /** Interactive mana payment. Returns true if paid, false if cancelled. The mana spent is left in
     *  this.lastSpent ({W,U,B,R,G,C}). opts: cancellable, prompt, sourceId, optional, exclude, diverse. */
    *payMana(p, cost, opts) {
      opts = opts || {};
      const remaining = U.cloneCost(cost);
      const spentTotal = emptyPool();
      this.lastSpent = spentTotal;
      for (;;) {
        const spent = this._applyPool(p, remaining, { diverse: opts.diverse, alreadySpent: spentTotal });
        for (const k in spent) spentTotal[k] += spent[k];
        if (costTotal(remaining) === 0) { this.lastSpent = spentTotal; this._changed(); return true; }
        const canAuto = this.canAfford(p, remaining, { exclude: opts.exclude, spendFor: opts.spendFor });
        if (this.players[p].autoPay && canAuto) {
          const plan = this.solveMana(p, remaining, { exclude: opts.exclude, diverse: opts.diverse, spendFor: opts.spendFor });
          this._executePlan(p, plan, remaining);
          continue;
        }
        const a = yield* this.ask(p, {
          type: 'payMana', cost: U.cloneCost(remaining), costString: costToString(remaining),
          prompt: opts.prompt || `Pay ${costToString(remaining)}.`, cancellable: !!opts.cancellable, canAuto,
          sourceId: opts.sourceId, optional: !!opts.optional, exclude: opts.exclude ? [...opts.exclude] : [],
          diverse: !!opts.diverse, reason: opts.reason,
        });
        if (a.type === 'cancel') {
          const pool = this.players[p].manaPool;
          for (const k in spentTotal) pool[k] += spentTotal[k];
          this._changed();
          return false;
        }
        if (a.type === 'auto') {
          const plan = this.solveMana(p, remaining, { exclude: opts.exclude, diverse: opts.diverse, spendFor: opts.spendFor });
          if (plan) this._executePlan(p, plan, remaining);
          continue;
        }
        if (a.type === 'mana') {
          yield* this.activateManaAbility(p, this.card(a.cardId), a.ability, a.color, opts.spendFor);
          continue;
        }
      }
    }

    /** Number of distinct colors (W,U,B,R,G) in a spent-mana record. */
    colorsSpent(spent) { return spent ? COLORS.filter(k => spent[k] > 0).length : 0; }

    // ----- targeting ---------------------------------------------------------------
    _targetCandidates(spec, controller, item) {
      const out = [];
      const kinds = spec.type;
      const want = (k) => kinds === k || (Array.isArray(kinds) && kinds.includes(k));
      const consider = (ref) => { if (this._isLegalTarget(spec, ref, controller, item)) out.push(ref); };
      if (want('creature') || want('permanent') || want('any') || want('artifact') || want('enchantment') || want('land')) {
        for (const id of this.battlefield) consider({ kind: 'card', id, zcc: this.card(id).zcc });
      }
      if (want('player') || want('any') || want('opponent')) {
        for (const p of this.players) consider({ kind: 'player', idx: p.index });
      }
      if (want('card')) {
        const zone = spec.zone || 'graveyard';
        for (const p of this.players) {
          for (const id of this._zoneList(null, zone, p.index)) consider({ kind: 'card', id, zcc: this.card(id).zcc });
        }
      }
      if (want('spell') || want('ability')) {
        for (const s of this.stack) if (s !== item) consider({ kind: 'stack', sid: s.sid });
      }
      return out;
    }

    _isLegalTarget(spec, ref, controller, item) {
      const kinds = Array.isArray(spec.type) ? spec.type : [spec.type];
      const sourceCard = item ? item.source || item.card : null;
      if (ref.kind === 'player') {
        const P = this.players[ref.idx];
        if (!P || P.lost) return false;
        if (!(kinds.includes('player') || kinds.includes('any') || kinds.includes('opponent'))) return false;
        if (kinds.includes('opponent') && !kinds.includes('player') && !kinds.includes('any') && ref.idx === controller) return false;
        return spec.filter ? !!spec.filter(this, P, controller, item) : true;
      }
      if (ref.kind === 'stack') {
        const s = this.stack.find(x => x.sid === ref.sid);
        if (!s) return false;
        if (s.kind === 'spell' && !kinds.includes('spell')) return false;
        if (s.kind !== 'spell' && !kinds.includes('ability')) return false;
        return spec.filter ? !!spec.filter(this, s, controller, item) : true;
      }
      const c = this.card(ref.id);
      if (!c || c.zcc !== ref.zcc) return false;
      if (kinds.includes('card')) {
        if (c.zone !== (spec.zone || 'graveyard')) return false;
        if (spec.whose === 'you' && c.owner !== controller) return false;
        if (spec.whose === 'opponent' && c.owner === controller) return false;
        return spec.filter ? !!spec.filter(this, c, controller, item) : true;
      }
      if (c.zone !== 'battlefield') return false;
      if (this.has(c, 'untargetable') || this.has(c, 'shroud')) return false;
      if (this.has(c, 'hexproofOpp') && this.controllerOf(c) !== controller) return false;
      if (sourceCard && this.protectedFrom(c, sourceCard)) return false;
      let typeOk = false;
      if (kinds.includes('permanent')) typeOk = true;
      if ((kinds.includes('creature') || kinds.includes('any')) && this.isCreature(c)) typeOk = true;
      if (kinds.includes('artifact') && this.isArtifact(c)) typeOk = true;
      if (kinds.includes('enchantment') && this.isEnchantment(c)) typeOk = true;
      if (kinds.includes('land') && this.isLand(c)) typeOk = true;
      if (!typeOk) return false;
      if (spec.yours && this.controllerOf(c) !== controller) return false;
      if (spec.notSelf && sourceCard && c.id === sourceCard.id) return false;
      return spec.filter ? !!spec.filter(this, c, controller, item) : true;
    }

    _refObject(ref) {
      if (ref.kind === 'player') return this.players[ref.idx];
      if (ref.kind === 'stack') return this.stack.find(x => x.sid === ref.sid) || null;
      return this.card(ref.id);
    }

    /** Ask for targets for every spec. Returns false if impossible / cancelled. */
    *_chooseAllTargets(p, item, specs, cancellable) {
      item.targets = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const legal = this._targetCandidates(spec, p, item).filter(ref => {
          // A single object can't be chosen twice for the same "target" word across specs.
          return !(spec.distinctFrom !== undefined && item.targets[spec.distinctFrom] && item.targets[spec.distinctFrom].some(r => refKey(r) === refKey(ref)));
        });
        const min = spec.min !== undefined ? spec.min : 1;
        const max = spec.max !== undefined ? spec.max : 1;
        if (legal.length < min) return false;
        if (min === 2 && spec.group && !this._groupPairExists(spec, legal, p, item)) return false;
        if (max === 0 || (legal.length === 0 && min === 0)) { item.targets.push([]); continue; }
        const groupCheck = spec.group ? (refs) => spec.group(this, refs.map(r => this._refObject(r)), p, item) : null;
        const a = yield* this.ask(p, {
          type: 'chooseTargets', legal, min, max: Math.min(max, legal.length), prompt: spec.prompt || 'Choose a target.',
          cancellable, sourceId: item.sourceId, spec: { type: spec.type, zone: spec.zone }, groupCheck, index: i,
        });
        if (a.cancel) return false;
        item.targets.push(a.targets);
      }
      return true;
    }

    /** For two-target specs with a group constraint: does any legal pair exist? */
    _groupPairExists(spec, refs, p, item) {
      const objs = refs.map(r => this._refObject(r));
      for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) if (!spec.group(this, [objs[i], objs[j]], p, item)) return true;
      return false;
    }

    _hasAnyTargets(p, specs, item) {
      for (const spec of specs || []) {
        const min = spec.min !== undefined ? spec.min : 1;
        const cands = min > 0 ? this._targetCandidates(spec, p, item) : [];
        if (min > 0 && cands.length < min) return false;
        if (min === 2 && spec.group && !this._groupPairExists(spec, cands, p, item)) return false;
      }
      return true;
    }

    _makeCtx(item) {
      const g = this;
      const specs = item.kind === 'spell' ? this._spellSpecs(item.card, item.modeIndex) : (item.ability.targets || []);
      const ctx = {
        g, item, source: item.source || item.card, sourceZcc: item.sourceZcc, controller: item.controller,
        targets: item.targets, evt: item.evt, data: item.data || {}, paid: item.paid || {},
        x: item.x || 0, colorsSpent: item.colorsSpent || 0, isCopy: !!item.isCopy,
        ts(i) { return (item.targets[i || 0] || []).filter(r => g._isLegalTarget(specs[i || 0], r, item.controller, item)).map(r => g._refObject(r)); },
        t(i) { return ctx.ts(i)[0] || null; },
      };
      return ctx;
    }

    _allTargetsIllegal(item, specs) {
      if (!specs || !specs.length) return false;
      let any = false;
      for (let i = 0; i < specs.length; i++) {
        for (const r of item.targets[i] || []) {
          any = true;
          if (this._isLegalTarget(specs[i], r, item.controller, item)) return false;
        }
      }
      return any;
    }

    // ----- casting & activation ------------------------------------------------------
    _sorceryTiming(p) {
      return p === this.activePlayer && (this.step === 'main1' || this.step === 'main2') && this.stack.length === 0;
    }

    legalActions(p) {
      const out = [];
      const P = this.players[p];
      for (const id of P.hand) {
        const c = this.card(id);
        if (this.isLand(c)) {
          if (this._sorceryTiming(p) && P.landsPlayed < 1) out.push({ type: 'playLand', cardId: id, label: 'Play ' + c.name });
        } else if (this.canCast(p, c)) out.push({ type: 'cast', cardId: id, label: 'Cast ' + c.name });
        this.activatedAbilities(c).forEach((ab, i) => {
          if (ab.zone === 'hand' && this.canActivate(p, c, i)) out.push({ type: 'activate', cardId: id, ability: i, label: ab.text || 'Activate' });
        });
      }
      for (const id of P.graveyard) {
        const c = this.card(id);
        if (c.def.afterimage && this.canCast(p, c, 'afterimage')) out.push({ type: 'cast', cardId: id, alt: 'afterimage', label: `Cast ${c.name} (Afterimage ${c.def.afterimage})` });
      }
      for (const id of this.battlefield) {
        const c = this.card(id);
        if (this.controllerOf(c) !== p) continue;
        this.activatedAbilities(c).forEach((ab, i) => {
          if (ab.mana) {
            if (this._manaAbilityUsable(p, c, ab, true)) out.push({ type: 'mana', cardId: id, ability: i, label: ab.text || 'Add mana' });
          } else if (ab.zone !== 'hand' && this.canActivate(p, c, i)) out.push({ type: 'activate', cardId: id, ability: i, label: ab.text || 'Activate' });
        });
      }
      return out;
    }

    /** Target specs of a spell (mode-aware). */
    _spellSpecs(c, modeIndex) {
      const sp = c.def.spell;
      if (sp && sp.modes && modeIndex !== undefined && modeIndex !== null) return sp.modes[modeIndex].targets || [];
      return sp && sp.targets ? sp.targets : (this.isAura(c) ? [auraTargetSpec()] : []);
    }
    _availableModes(p, c) {
      const sp = c.def.spell;
      if (!sp || !sp.modes) return null;
      const fakeItem = { kind: 'spell', card: c, source: c, controller: p, sourceId: c.id };
      return sp.modes.map((m, i) => i).filter(i => this._hasAnyTargets(p, sp.modes[i].targets || [], fakeItem) && (!sp.modes[i].canChoose || sp.modes[i].canChoose(this, c, p)));
    }
    canCast(p, c, alt) {
      if (this.isLand(c)) return false;
      if (alt === 'afterimage') { if (c.zone !== 'graveyard' || c.owner !== p || !c.def.afterimage) return false; }
      else if (c.zone !== 'hand') return false;
      const def = c.def;
      const instant = this.isType(c, 'Instant') || this.has(c, 'flash');
      if (!instant && !this._sorceryTiming(p)) return false;
      const fakeItem = { kind: 'spell', card: c, source: c, controller: p, sourceId: c.id };
      if (def.spell && def.spell.modes) { if (!this._availableModes(p, c).length) return false; }
      else if (!this._hasAnyTargets(p, this._spellSpecs(c), fakeItem)) return false;
      const add = def.spell && def.spell.additionalCost;
      if (add && add.sacrifice) {
        if (this.rulesActive('noSacrificeCosts')) return false;
        if (!this._sacCandidates(p, add.sacrifice, c).length) return false;
      }
      if (def.spell && def.spell.canCast && !def.spell.canCast(this, c, p)) return false;
      const add2 = def.spell && def.spell.additionalCost;
      if (add2 && add2.discard && this.players[p].hand.filter(id => id !== c.id && (!add2.discard.filter || add2.discard.filter(this, this.card(id)))).length < 1) return false;
      const cost = alt === 'afterimage' ? parseCost(def.afterimage) : def.cost;
      return this.canAfford(p, cost, { spendFor: { kind: 'spell', card: c } });
    }

    _sacCandidates(p, sacSpec, source) {
      return this.battlefield.map(id => this.card(id)).filter(x => this.controllerOf(x) === p && (!sacSpec.other || x !== source) && (!sacSpec.filter || sacSpec.filter(this, x, source)));
    }

    canActivate(p, c, idx) {
      const ab = this.activatedAbilities(c)[idx];
      if (!ab || ab.mana) return false;
      const zone = ab.zone || 'battlefield';
      if (c.zone !== zone) return false;
      if (zone === 'battlefield' && this.controllerOf(c) !== p) return false;
      if (zone === 'hand' && c.owner !== p) return false;
      if (zone === 'battlefield' && this.has(c, 'noActivated')) return false;
      const cost = ab.cost || {};
      if (cost.tap && (c.tapped || this.isSick(c))) return false;
      if (cost.removeCounters && (c.counters[cost.counterKind || 'p1p1'] || 0) < cost.removeCounters) return false;
      if (cost.life && this.players[p].life < cost.life) return false;
      const abKey = c.def.name + ':' + idx;
      if (ab.oncePerTurn && ((c.abilityUses && c.abilityUses[abKey]) || (c._abUsedTurn && c._abUsedTurn[abKey] === this.turnNumber))) return false;
      if (cost.force && this.players[p].force < cost.force) return false;
      if (ab.yourTurn && this.activePlayer !== p) return false;
      if (zone === 'battlefield' && this.players[p].creatureAbilitiesLockedTurn === this.turnNumber && this.isCreature(c)) return false;
      if (ab.sorcery && !this._sorceryTiming(p)) return false;
      if (ab.condition && !ab.condition(this, c, p)) return false;
      if ((cost.sacSelf || cost.sacrifice) && this.isCreature(c) && cost.sacSelf && this.rulesActive('noSacrificeCosts')) return false;
      if (cost.sacrifice) {
        const cands = this._sacCandidates(p, cost.sacrifice, c);
        if (this.rulesActive('noSacrificeCosts') && cands.every(x => this.isCreature(x))) return false;
        if (cands.length < (cost.sacrifice.count || 1)) return false;
      }
      if (cost.exileFromGraveyard) {
        const cands = this.players[p].graveyard.map(id => this.card(id)).filter(x => !cost.exileFromGraveyard.filter || cost.exileFromGraveyard.filter(this, x, c));
        if (cands.length < (cost.exileFromGraveyard.count || 1)) return false;
      }
      if (cost.discard && this.players[p].hand.filter(id => id !== c.id && (!cost.discard.filter || cost.discard.filter(this, this.card(id)))).length < (cost.discard.count || 1)) return false;
      const fakeItem = { kind: 'ability', source: c, controller: p, ability: ab, sourceId: c.id };
      if (!this._hasAnyTargets(p, ab.targets, fakeItem)) return false;
      if (cost.mana) {
        const excl = cost.tap ? new Set([c.id]) : undefined;
        if (!this.canAfford(p, parseCost(cost.mana), { exclude: excl, spendFor: { kind: 'ability', source: c } })) return false;
      }
      return true;
    }

    _playLand(p, c) {
      if (!this._sorceryTiming(p) || this.players[p].landsPlayed >= 1 || c.zone !== 'hand' || !this.isLand(c)) return false;
      this.players[p].landsPlayed++;
      // Lands have no "as enters" choices here, so run the generator synchronously.
      const gen = this.putOntoBattlefield(c, p);
      let r = gen.next();
      while (!r.done) r = gen.next();
      this.log(`${this.players[p].name} plays [[${c.name}]].`);
      return true;
    }

    *castSpell(p, c, alt) {
      if (!this.canCast(p, c, alt)) return false;
      const def = c.def;
      const item = { sid: this.nextSid++, kind: 'spell', card: c, source: c, controller: p, name: c.name, sourceId: c.id, targets: [], paid: {}, data: {}, afterimage: alt === 'afterimage' };
      if (def.spell && def.spell.modes) {
        const avail = this._availableModes(p, c);
        const a = yield* this.ask(p, { type: 'chooseOption', options: avail.map(i => ({ id: 'm' + i, label: def.spell.modes[i].label || def.spell.modes[i].text || ('Mode ' + (i + 1)) })), prompt: `Choose one — ${c.name}`, reason: 'mode', sourceId: c.id, cancellable: true });
        if (a.cancel) return false;
        item.modeIndex = parseInt(String(a.choice).slice(1), 10);
      }
      const specs = this._spellSpecs(c, item.modeIndex);
      const ok = yield* this._chooseAllTargets(p, item, specs, true);
      if (!ok) return false;
      // Additional costs (choose before paying mana; performed after).
      let sacChoice = null;
      const add = def.spell && def.spell.additionalCost;
      if (add && add.sacrifice) {
        const cands = this._sacCandidates(p, add.sacrifice, c);
        const ch = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(x => x.id), min: 1, max: 1, prompt: add.sacrifice.prompt || 'Choose a creature to sacrifice.', cancellable: true, reason: 'sacrificeCost', sourceId: c.id });
        if (ch.cancel || !ch.cards.length) return false;
        sacChoice = this.card(ch.cards[0]);
      }
      let discardChoice = null;
      if (add && add.discard) {
        const cands = this.players[p].hand.filter(id => id !== c.id).map(id => this.card(id)).filter(x => !add.discard.filter || add.discard.filter(this, x));
        const ch = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(x => x.id), min: 1, max: 1, prompt: add.discard.prompt || 'Choose a card to discard.', cancellable: true, reason: 'discardCost', sourceId: c.id });
        if (ch.cancel || !ch.cards.length) return false;
        discardChoice = this.card(ch.cards[0]);
      }
      // X costs: choose X, then pay it as generic mana.
      let payCost = alt === 'afterimage' ? parseCost(def.afterimage) : def.cost;
      if (def.cost.X) {
        const max = this._maxX(p, def.cost);
        const a = yield* this.ask(p, { type: 'chooseNumber', min: 0, max, prompt: `Choose X for ${c.name} (0–${max}).`, cancellable: true, sourceId: c.id, reason: 'x' });
        if (a.cancel) return false;
        item.x = a.number;
        payCost = U.cloneCost(def.cost);
        payCost.generic += a.number * def.cost.X;
        payCost.X = 0;
      }
      if (def.spell && def.spell.chooseOnCast) { const okc = yield* def.spell.chooseOnCast(this, item); if (!okc) return false; }
      const paid = yield* this.payMana(p, payCost, { cancellable: true, prompt: `Pay ${costToString(payCost)} for ${c.name}${alt === 'afterimage' ? ' (Afterimage)' : ''}.`, sourceId: c.id, diverse: def.wantsColors, spendFor: { kind: 'spell', card: c } });
      if (!paid) return false;
      item.spent = Object.assign({}, this.lastSpent || emptyPool());
      item.colorsSpent = this.colorsSpent(item.spent);
      c.castInfo = { spent: item.spent, colorsSpent: item.colorsSpent, x: item.x || 0 };
      if (sacChoice) {
        item.paid.sacrificed = this.lki(sacChoice);
        this.sacrifice(sacChoice);
      }
      if (discardChoice) { item.paid.discarded = discardChoice; this.discard(discardChoice); }
      const fromZone = c.zone;
      this._removeFromZone(c);
      if (fromZone === 'graveyard') this._emitOrQueue({ type: 'leftGraveyard', card: c, player: c.owner, to: 'stack' });
      c.zone = 'stack';
      this.stack.push(item);
      this.players[p].spellsCastThisTurn = (this.players[p].spellsCastThisTurn || 0) + 1;
      item.nth = this.players[p].spellsCastThisTurn;
      const tdesc = this._describeTargets(item);
      if (this.isArtifact(c)) this.players[p].artifactSpellsThisTurn = (this.players[p].artifactSpellsThisTurn || 0) + 1;
      this.log(`${this.players[p].name} casts [[${c.name}]]${alt === 'afterimage' ? ' (Afterimage)' : ''}${item.x !== undefined ? ' (X=' + item.x + ')' : ''}${tdesc}.`);
      this.emit({ type: 'cast', card: c, player: p, item, nth: item.nth, multicolored: this.isMulticolored(c) });
      return true;
    }

    /** Largest X affordable for a cost with X. */
    _maxX(p, cost) {
      const base = U.cloneCost(cost); base.X = 0;
      let x = 0;
      for (let n = 1; n <= 20; n++) {
        const c2 = U.cloneCost(base); c2.generic += n * cost.X;
        if (this.canAfford(p, c2)) x = n; else break;
      }
      return x;
    }

    /** Put a copy of a spell on the stack (copies are not cast; no colors were spent on them). */
    *copySpell(item, controller, opts) {
      opts = opts || {};
      const copy = Object.assign({}, item, {
        sid: this.nextSid++, isCopy: true, controller, name: item.name + ' (copy)', paid: Object.assign({}, item.paid),
        data: {}, spent: emptyPool(), colorsSpent: 0, targets: (item.targets || []).map(l => Array.isArray(l) ? l.slice() : l),
      });
      const specs = this._spellSpecs(item.card, item.modeIndex);
      if (specs.length && opts.newTargets !== false) {
        const change = yield* this.yesNo(controller, `Choose new targets for the copy of ${item.name}?`, { reason: 'newTargets', sourceId: opts.sourceId || item.card.id });
        if (change) {
          const saved = copy.targets;
          const ok = yield* this._chooseAllTargets(controller, copy, specs, true);
          if (!ok) copy.targets = saved;
        }
      }
      this.stack.push(copy);
      this.log(`${this.players[controller].name} copies [[${item.name}]]${this._describeTargets(copy)}.`);
      this._changed();
      return copy;
    }

    /** Copy a spell on the stack for player p (convenience alias with (p, origItem, opts) order). */
    *copySpellOnStack(p, origItem, opts) {
      return yield* this.copySpell(origItem, p, opts);
    }

    _describeTargets(item) {
      const names = [];
      for (const list of item.targets || []) for (const r of list) {
        const o = this._refObject(r);
        if (!o) continue;
        names.push(o.isPlayer ? o.name : (r.kind === 'stack' ? `[[${o.name}]]` : `[[${o.name}]]`));
      }
      return names.length ? ' targeting ' + names.join(', ') : '';
    }

    *activateAbility(p, c, idx) {
      if (!this.canActivate(p, c, idx)) return false;
      const ab = this.activatedAbilities(c)[idx];
      const cost = ab.cost || {};
      const item = { sid: this.nextSid++, kind: 'ability', source: c, sourceZcc: c.zcc, controller: p, ability: ab, name: c.name, text: ab.text || abilityText(c, ab), sourceId: c.id, targets: [], paid: {}, data: {} };
      const ok = yield* this._chooseAllTargets(p, item, ab.targets || [], true);
      if (!ok) return false;
      let sacChoice = [], exileChoice = [];
      if (cost.sacrifice) {
        let cands = this._sacCandidates(p, cost.sacrifice, c);
        if (this.rulesActive('noSacrificeCosts')) cands = cands.filter(x => !this.isCreature(x));
        const n = cost.sacrifice.count || 1;
        const ch = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(x => x.id), min: n, max: n, prompt: cost.sacrifice.prompt || 'Choose a creature to sacrifice.', cancellable: true, reason: 'sacrificeCost', sourceId: c.id });
        if (ch.cancel || !ch.cards || ch.cards.length !== n) return false;
        sacChoice = ch.cards.map(id => this.card(id));
      }
      if (cost.exileFromGraveyard) {
        const cands = this.players[p].graveyard.map(id => this.card(id)).filter(x => !cost.exileFromGraveyard.filter || cost.exileFromGraveyard.filter(this, x, c));
        const n = cost.exileFromGraveyard.count || 1;
        const ch = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(x => x.id), min: n, max: n, prompt: cost.exileFromGraveyard.prompt || 'Choose a card to remove from the game.', cancellable: true, reason: 'exileCost', sourceId: c.id });
        if (ch.cancel || !ch.cards || ch.cards.length !== n) return false;
        exileChoice = ch.cards.map(id => this.card(id));
      }
      let discardChoice = [];
      if (cost.discard) {
        const cands = this.players[p].hand.filter(id => id !== c.id).map(id => this.card(id)).filter(x => !cost.discard.filter || cost.discard.filter(this, x));
        const n = cost.discard.count || 1;
        const ch = yield* this.ask(p, { type: 'chooseCards', cards: cands.map(x => x.id), min: n, max: n, prompt: cost.discard.prompt || 'Choose a card to discard.', cancellable: true, reason: 'discardCost', sourceId: c.id });
        if (ch.cancel || !ch.cards || ch.cards.length !== n) return false;
        discardChoice = ch.cards.map(id => this.card(id));
      }
      if (cost.mana) {
        const paid = yield* this.payMana(p, parseCost(cost.mana), { cancellable: true, prompt: `Pay ${cost.mana} to activate ${c.name}.`, sourceId: c.id, exclude: cost.tap ? new Set([c.id]) : undefined, spendFor: { kind: 'ability', source: c } });
        if (!paid) return false;
      }
      // Non-mana costs.
      if (cost.force && !this.payForce(p, cost.force)) return false;
      if (cost.tap) c.tapped = true;
      if (cost.removeCounters) this.removeCounters(c, cost.removeCounters, cost.counterKind);
      if (cost.life) {
        this.players[p].life -= cost.life;
        if (this.turnStats && this.turnStats.lifeLost[p] !== undefined) this.turnStats.lifeLost[p] += cost.life;
        this.log(`${this.players[p].name} pays ${cost.life} life.`);
      }
      item.paid.sacrificed = sacChoice.map(x => this.lki(x));
      if (sacChoice.length) { this._beginBatch(); for (const x of sacChoice) this.sacrifice(x); this._endBatch(); }
      for (const x of exileChoice) this.exile(x);
      item.paid.exiled = exileChoice;
      item.paid.discarded = discardChoice;
      for (const x of discardChoice) this.discard(x);
      if (cost.sacSelf) { item.paid.selfLKI = this.lki(c); this.sacrifice(c); }
      if (cost.discardSelf) { this.moveToZone(c, 'graveyard'); this.log(`${this.players[p].name} cycles [[${c.name}]].`); }
      const abKey = c.def.name + ':' + idx;
      c.abilityUses[abKey] = (c.abilityUses[abKey] || 0) + 1;
      (c._abUsedTurn = c._abUsedTurn || {})[abKey] = this.turnNumber;
      this.stack.push(item);
      if (!cost.discardSelf) this.log(`${this.players[p].name} activates [[${c.name}]]${this._describeTargets(item)}.`);
      return true;
    }

    *_resolveTop() {
      const item = this.stack[this.stack.length - 1];
      if (item.kind === 'spell') {
        const c = item.card;
        const def = c.def;
        const isAura = this.isAura(c);
        const specs = this._spellSpecs(c, item.modeIndex);
        if (this._allTargetsIllegal(item, specs)) {
          this.stack.pop();
          if (!item.isCopy) this.moveToZone(c, item.afterimage ? 'exile' : 'graveyard');
          this.log(`[[${item.name}]] is countered on resolution (no legal targets).`);
          return;
        }
        if (item.isCopy) {
          const ctx = this._makeCtx(item);
          const resolveFn = item.modeIndex !== undefined && def.spell && def.spell.modes ? def.spell.modes[item.modeIndex].resolve : def.spell && def.spell.resolve;
          if (resolveFn) yield* resolveFn(this, ctx);
          const ci = this.stack.indexOf(item);
          if (ci >= 0) this.stack.splice(ci, 1);
          this._changed();
          return;
        }
        if (this.isPermanentCard(c)) {
          this.stack.pop();
          if (isAura) {
            const ctx = this._makeCtx(item);
            const host = ctx.t(0);
            if (!host) { this.moveToZone(c, 'graveyard'); return; }
            yield* this.putOntoBattlefield(c, item.controller, { attachTo: host.id });
            this.log(`[[${c.name}]] enchants [[${host.name}]].`);
          } else {
            yield* this.putOntoBattlefield(c, item.controller);
            this.log(`[[${c.name}]] comes into play.`);
          }
          return;
        }
        const ctx = this._makeCtx(item);
        const resolveFn = item.modeIndex !== undefined && def.spell.modes ? def.spell.modes[item.modeIndex].resolve : def.spell && def.spell.resolve;
        if (resolveFn) yield* resolveFn(this, ctx);
        const idx = this.stack.indexOf(item);
        if (idx >= 0) this.stack.splice(idx, 1);
        if (c.zone === 'stack') {
          if (ctx.exileSelf || item.afterimage) { this._placeInZone(c, 'exile', c.owner); this._resetObject(c); this.log(`[[${c.name}]] is removed from the game.`); }
          else { this._resetObject(c); this._placeInZone(c, 'graveyard', c.owner); }
        }
        this._changed();
        return;
      }
      // ability / trigger
      const specs = item.ability.targets || [];
      if (this._allTargetsIllegal(item, specs)) {
        this.stack.pop();
        this.log(`[[${item.name}]]'s ability is countered on resolution (no legal targets).`);
        return;
      }
      const ctx = this._makeCtx(item);
      if (item.kind === 'trigger' && item.ability.condition && !item.ability.condition(this, item.source, item.evt)) {
        this.stack.pop();
        return;
      }
      if (item.ability.resolve) yield* item.ability.resolve(this, ctx);
      const idx = this.stack.indexOf(item);
      if (idx >= 0) this.stack.splice(idx, 1);
      this._changed();
    }

    // ----- combat --------------------------------------------------------------------
    *_combatPhase() {
      this.combatNumber = (this.combatNumber || 0) + 1;
      const ap = this.activePlayer, dp = this.opponent(ap);
      this._setStep('beginCombat');
      this.combat = { attackers: [], blockers: {}, defender: dp, firstStrikeDealt: new Set() };
      this.emit({ type: 'beginCombat', player: ap });
      yield* this._priorityRound();
      this._setStep('declareAttackers');
      const cands = this.battlefield.map(id => this.card(id)).filter(c => this.canAttack(c));
      let attackers = [];
      if (cands.length) {
        const mustAttack = cands.filter(c => this.has(c, 'mustAttack')).map(c => c.id);
        const a = yield* this.ask(ap, { type: 'declareAttackers', candidates: cands.map(c => c.id), mustAttack, attackTax: this.attackTax(dp), prompt: mustAttack.length ? 'Declare attackers. (Highlighted creatures attack each turn if able.)' : 'Declare attackers.' });
        attackers = a.attackers.map(id => this.card(id));
        // Attack tax (e.g. Law of Shared Shelter): pay for each attacker or the attack doesn't happen.
        const tax = this.attackTax(dp) * attackers.length;
        if (attackers.length && tax > 0) {
          const paid = yield* this.payOptional(ap, '{' + tax + '}', `Pay {${tax}} to attack with ${attackers.length} creature(s)?`, null, 'attackTax');
          if (!paid) { this.log(`${this.players[ap].name} does not pay the attack tax; no attack.`); attackers = []; }
        }
      }
      if (!attackers.length) {
        this.combat = null;
        this._setStep('endCombat');
        yield* this._priorityRound();
        return;
      }
      for (const c of attackers) {
        if (!this.has(c, 'vigilance')) c.tapped = true;
        this.combat.attackers.push({ id: c.id, blockers: [], blocked: false });
        if (this.turnStats && this.turnStats.attackedIds[ap] && !this.turnStats.attackedIds[ap].includes(c.id)) {
          this.turnStats.attackedIds[ap].push(c.id);
        }
      }
      this.log(`${this.players[ap].name} attacks with ${attackers.map(c => `[[${c.name}]]`).join(', ')}.`);
      this.combat.alone = attackers.length === 1;
      for (const c of attackers) this.emit({ type: 'attacks', card: c, alone: attackers.length === 1 });
      this.emit({ type: 'playerAttacks', player: ap, attackers: attackers.slice() });
      yield* this._priorityRound();
      if (!this.combat || !this.combat.attackers.length) {
        this.combat = null;
        this._setStep('endCombat');
        yield* this._priorityRound();
        return;
      }
      // Declare blockers
      this._setStep('declareBlockers');
      const candMap = {};
      for (const id of this.battlefield) {
        const b = this.card(id);
        if (this.controllerOf(b) !== dp || !this.isCreature(b)) continue;
        const legal = this.combat.attackers.map(a => this.card(a.id)).filter(a => this.canBlock(b, a)).map(a => a.id);
        if (legal.length) candMap[b.id] = legal;
      }
      if (Object.keys(candMap).length) {
        const must = this.combat.attackers.map(x => this.card(x.id)).filter(x => this.has(x, 'mustBeBlocked')).map(x => x.id);
        const extraBlockers = {};
        for (const bid in candMap) if (this.has(this.card(Number(bid)), 'extraBlock')) extraBlockers[bid] = 2;
        const maxOneBlocker = this.combat.attackers.map(x => this.card(x.id)).filter(x => this.has(x, 'maxOneBlocker')).map(x => x.id);
        const menace = this.combat.attackers.map(x => this.card(x.id)).filter(x => this.has(x, 'menace')).map(x => x.id);
        const a = yield* this.ask(dp, { type: 'declareBlockers', attackers: this.combat.attackers.map(x => x.id), candidates: candMap, mustBeBlocked: must, extraBlockers, maxOneBlocker, menace, prompt: must.length ? 'Declare blockers. (Highlighted attackers must be blocked if able.)' : 'Declare blockers.' });
        this.combat.blockAssign = {};
        for (const bl of a.blocks) {
          const at = this.combat.attackers.find(x => x.id === bl.attacker);
          if (!at) continue;
          at.blockers.push(bl.blocker);
          if (!this.combat.blockers[bl.blocker]) this.combat.blockers[bl.blocker] = bl.attacker;
          (this.combat.blockAssign[bl.blocker] = this.combat.blockAssign[bl.blocker] || []).push(bl.attacker);
        }
        if (a.blocks.length) {
          const desc = a.blocks.map(b => `[[${this.card(b.blocker).name}]] blocks [[${this.card(b.attacker).name}]]`).join('; ');
          this.log(desc + '.');
          // Flanking: a blocker without flanking gets -1/-1 until end of turn.
          for (const b of a.blocks) {
            const at = this.card(b.attacker), bl = this.card(b.blocker);
            if (this.has(at, 'flanking') && !this.has(bl, 'flanking')) { this.pump(bl, -1, -1); this.log(`[[${bl.name}]] gets -1/-1 (flanking).`); }
          }
        }
      }
      for (const at of this.combat.attackers) at.blocked = at.blockers.length > 0;
      for (const at of this.combat.attackers) if (at.blocked) this.emit({ type: 'blocked', card: this.card(at.id) });
      yield* this._priorityRound();
      // Damage
      if (this.combat && this.combat.attackers.length) {
        const inCombat = () => this.combat ? [...this.combat.attackers.map(a => a.id), ...Object.keys(this.combat.blockers).map(Number)] : [];
        const anyFS = inCombat().some(id => this.hasFirstStrike(this.card(id)));
        if (anyFS) {
          this._setStep('firstStrikeDamage');
          this._dealCombatDamage(true);
          yield* this._priorityRound();
        }
        if (this.combat && this.combat.attackers.length) {
          this._setStep('combatDamage');
          this._dealCombatDamage(false);
          yield* this._priorityRound();
        }
      }
      this._setStep('endCombat');
      this.emit({ type: 'endCombat', player: ap });
      yield* this._priorityRound();
      this.combat = null;
    }

    /** Put a creature into combat as an attacker (e.g. a token "tapped and attacking"). */
    addAttacker(c) {
      if (!this.combat || c.zone !== 'battlefield') return;
      if (!this.combat.attackers.some(a => a.id === c.id)) this.combat.attackers.push({ id: c.id, blockers: [], blocked: false });
      this._changed();
    }

    _dealCombatDamage(firstStrikeStep) {
      const cb = this.combat;
      const dealsNow = (c) => {
        const fs = this.hasFirstStrike(c);
        if (firstStrikeStep) return fs;
        return !cb.firstStrikeDealt.has(c.id) || this.has(c, 'doubleStrike');
      };
      const assignments = []; // {source, target, amount}
      const defender = this.players[cb.defender];
      for (const at of cb.attackers) {
        const a = this.card(at.id);
        if (!a || a.zone !== 'battlefield' || !dealsNow(a)) continue;
        const pow = this.power(a);
        if (pow <= 0) continue;
        if (!at.blocked) { assignments.push({ source: a, target: defender, amount: pow }); continue; }
        const blockers = at.blockers.map(id => this.card(id)).filter(b => b && b.zone === 'battlefield');
        if (!blockers.length) {
          if (this.has(a, 'trample')) assignments.push({ source: a, target: defender, amount: pow });
          continue;
        }
        let left = pow;
        // Attacker's controller assigns: kill the most valuable blockers it can.
        const order = blockers.slice().sort((x, y) => creatureValue(this, y) - creatureValue(this, x));
        const plan = new Map();
        const dt = this.has(a, 'deathtouch');
        for (const b of order) {
          const lethal = dt ? (this.toughness(b) > 0 ? 1 : 0) : Math.max(0, this.toughness(b) - b.damage);
          if (left >= lethal && lethal > 0) { plan.set(b, lethal); left -= lethal; }
        }
        if (left > 0) {
          if (this.has(a, 'trample') && order.every(b => plan.has(b) || Math.max(0, this.toughness(b) - b.damage) === 0)) {
            assignments.push({ source: a, target: defender, amount: left });
          } else {
            const tgt = order.find(b => !plan.has(b)) || order[0];
            plan.set(tgt, (plan.get(tgt) || 0) + left);
          }
        }
        for (const [b, n] of plan) if (n > 0) assignments.push({ source: a, target: b, amount: n });
      }
      for (const bid in cb.blockers) {
        const b = this.card(Number(bid));
        if (!b || b.zone !== 'battlefield' || !dealsNow(b)) continue;
        const ats = ((cb.blockAssign && cb.blockAssign[bid]) || [cb.blockers[bid]]).map(id => this.card(id)).filter(x => x && x.zone === 'battlefield' && cb.attackers.some(q => q.id === x.id));
        let pow = this.power(b);
        if (pow <= 0 || !ats.length) continue;
        // A blocker of several attackers divides its damage: kill what it can, cheapest first.
        ats.sort((x, y) => (this.toughness(x) - x.damage) - (this.toughness(y) - y.damage));
        for (let i = 0; i < ats.length && pow > 0; i++) {
          const need = Math.max(1, this.toughness(ats[i]) - ats[i].damage);
          const n = i === ats.length - 1 ? pow : Math.min(pow, need);
          assignments.push({ source: b, target: ats[i], amount: n });
          pow -= n;
        }
      }
      if (firstStrikeStep) {
        for (const at of cb.attackers) { const a = this.card(at.id); if (a && this.hasFirstStrike(a)) cb.firstStrikeDealt.add(a.id); }
        for (const bid in cb.blockers) { const b = this.card(Number(bid)); if (b && this.hasFirstStrike(b)) cb.firstStrikeDealt.add(b.id); }
      }
      this._beginBatch();
      for (const x of assignments) this.damage(x.source, x.target, x.amount, { combat: true });
      this._endBatch();
    }

    // ----- views for UI / AI ------------------------------------------------------------
    cardView(id) {
      const c = this.card(id);
      const v = {
        id: c.id, name: c.name, owner: c.owner, controller: this.controllerOf(c), zone: c.zone,
        tapped: c.tapped, damage: c.damage, counters: c.counters.p1p1 || 0, token: c.token,
        attachedTo: c.attachedTo, types: this.typesOf(c), subtypes: this.subtypesOf(c), colors: this.colorsOf(c),
        charge: c.counters.charge || 0, protection: this.protections(c), multicolored: this.isMulticolored(c),
        counterMap: Object.assign({}, c.counters), cloneOf: c.cloneOf || null, printedName: c.baseDef ? c.baseDef.name : c.name,
        image: c.def.data.image, art: c.def.data.art, chosenType: c.chosenType,
        dfc: this.isDFC(c), transformed: !!c.transformed, side: c.def.side || null, faceId: c.def.data.face_id || c.def.data.id,
        colorIndicator: c.def.data.colorIndicator || null, damagedThisTurn: !!c.damagedThisTurn,
      };
      if (this.isDFC(c)) {
        const o = c.transformed ? c.frontDef : c.backDef;
        v.otherFace = { name: o.name, faceId: o.data.face_id, side: o.side, type: o.data.printed_type || o.data.type, rules: o.data.printed_rules || o.data.rules, pt: o.data.pt, image: o.data.image };
      }
      if (this.isCreature(c)) {
        v.power = this.power(c); v.toughness = this.toughness(c);
        v.basePower = c.def.power; v.baseToughness = c.def.toughness;
        v.sick = c.zone === 'battlefield' && this.isSick(c);
      }
      if (c.zone === 'battlefield') {
        v.keywords = this.keywordsOf(c);
        v.attachments = this.battlefield.filter(x => this.card(x).attachedTo === c.id);
        if (this.combat) {
          v.attacking = this.combat.attackers.some(a => a.id === c.id);
          v.blocking = this.combat.blockers[c.id] || null;
        }
      }
      return v;
    }

    stackView() {
      return this.stack.map(s => ({
        sid: s.sid, kind: s.kind, controller: s.controller, name: s.name,
        cardId: s.kind === 'spell' ? s.card.id : s.sourceId, text: s.kind === 'spell' ? (s.card.def.data.printed_rules || '') : s.text,
        isCopy: !!s.isCopy, x: s.x,
        targets: (s.targets || []).flat().map(r => this._refObject(r)).filter(Boolean).map(o => o.isPlayer ? { player: o.index } : (o.sid ? { sid: o.sid } : { cardId: o.id })),
      }));
    }
  }

  function refKey(r) { return r.kind === 'player' ? 'p' + r.idx : r.kind === 'stack' ? 's' + r.sid : 'c' + r.id + ':' + r.zcc; }

  function auraTargetSpec() { return { type: 'creature', prompt: 'Choose a creature to enchant.' }; }

  function abilityText(card, ab) {
    if (ab.text) return ab.text;
    return card.name + ' ability';
  }

  /** Rough creature value used for damage assignment and as an AI helper. */
  function creatureValue(g, c) {
    const p = g.power(c) || 0, t = g.toughness(c) || 0;
    let v = p * 2 + t + c.def.manaValue * 0.5;
    for (const k of ['flying', 'firstStrike', 'trample', 'vigilance']) if (g.has(c, k)) v += 1.5;
    if (c.def.activated.length || c.def.triggers.length || c.def.statics.length) v += 1;
    if (c.token) v -= 1;
    return v;
  }

  OF.allCreatureTypes = function () {
    if (OF._ctypes) return OF._ctypes;
    const s = new Set();
    for (const c of (OF.CARD_DATA || []).concat(OF.TOKEN_DATA || [])) {
      const tl = parseTypeLine(c.type);
      if (tl.types.includes('Creature')) for (const t of tl.subtypes) s.add(t);
    }
    OF._ctypes = [...s].sort();
    return OF._ctypes;
  };

  OF.Game = Game;
  OF.STEPS = STEPS;
  OF.STEP_NAMES = STEP_NAMES;
  OF.refKey = refKey;
  OF.auraTargetSpec = auraTargetSpec;
  OF.creatureValue = creatureValue;
  OF.parseTypeLine = parseTypeLine;
  OF.engineFeatures = Object.assign(OF.engineFeatures || {}, {
    enchantSpec: true, leftGraveyard: true, discardCost: true,
    menace: true, indestructible: true, compromise: true, oncePerTurn: true, copySpell: true, turnStats: true,
  });
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
