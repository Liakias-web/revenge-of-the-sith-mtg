/* The Old Republic AI opponent (derived from the Mirrors of Mehrava / Zarazda / Oathfall AI).
 *
 * OF.AI.createController({level, seed}) -> { decide(game, decision) -> answer }
 * OF.AI.evaluateBoard(game, playerIndex) -> number
 *
 * The controller never reads the opponent's hand or any library contents (only counts),
 * except cards listed in decisions it receives or in g.reveals. It is stateful only for
 * bookkeeping within a turn step (planned targets / mode / sacrifice / discard for the spell or
 * ability it is activating, loop guards, the colour it intends to name for a protection effect).
 *
 * Set layer (The Old Republic): Force counters are valued as a resource (marginal value per counter
 * from the Force sinks we have), spent on the best "Use the Force" ability with reserves for
 * transforms / Darth Sion / protective abilities, and spent early when Attunement payoffs care;
 * double-faced cards transform when the other face is worth more than the cost; Afterimage casts
 * from the graveyard; modal spells are evaluated mode by mode; combat simulation understands
 * deathtouch, lifelink, double strike, fear, flanking and "can't be blocked by more than one creature".
 */
(function (OF) {
  'use strict';
  const U = OF.util;
  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const EMPTY = Object.freeze({});

  // ===========================================================================
  // Card knowledge for Revenge of the Sith (complements script `ai` hints and rules-text parsing).
  //  k: spell / permanent kind (modal spells: 'Name#m0', 'Name#m1' per mode)   v: extra value
  //  threat: strategic engine priority (raises removal/combat targeting priority over raw P/T)
  //  etb: creature ETB evaluator   dv: value left behind on death   atk: attack trigger for combat sim
  //  whenEq: keywords while equipped   hit: combat damage trigger value   attune: Attunement payoff
  //  onTurn: transform trigger value   compromise: Compromise N cost
  // ===========================================================================
  const KB = {
    // ----- White (001–017B)
    'Temple Initiate': { v: 0.4 },
    'Kamino Drill Squad': {},
    'Naboo Palace Guard': {},
    'Geonosis Relief Jedi': { v: 0.4 },
    'Sky Lane Escort': { v: 0.3 },
    'Senate Observer': { etb: 'tap', compromise: 1, v: 0.5 },
    'Halt the Advance': { k: 'burn', dmg: 3, combatOnly: true },
    'Seal the Archives': { k: 'permHarm', exile: true },
    'Clone Reinforcements': { k: 'token', tok: 'Clone Soldier', n: 2 },
    'Battle Meditation at First Light': { k: 'teamTrick', p: 1, t: 2, fs: true, untap: true },
    'Padmé Amidala, Civic Liaison': { v: 1.8, threat: 3.6 },
    'Unexpected Delegation': { etb: 'bounceOwnMay', v: 0.6 },
    'Jedi Battalion-General': { etb: 'token', tok: 'Clone Soldier', n: 1, atk: 'battalion', attune: { v: 1.2 }, threat: 3.6 },
    'Temple Vigil': { k: 'perm', v: 2.6 },
    'Mace Windu, Vaapad Master': { etb: 'exileOpp', atk: 'maceDT', v: 2.2, threat: 4.5 },
    'Rebuild the Order': { k: 'reanimate' },
    'Anakin, Hero With No Fear': { v: 2.4, threat: 5.4 },
    'Darth Vader, Iron Betrayal': { v: 3.2, atk: 'vaderSac', onTurn: 'edict', threat: 6.4 },
    // ----- Blue (018–034)
    'Kamino Sample Keeper': { v: 1.6, threat: 3.8 },
    'Turbolift Interceptor': { v: 0.2 },
    'Archive Night Shift': { v: 1.2, threat: 2.6 },
    'Cloudbank Courier': { etb: 'bounceOwnArt', v: 0.5 },
    'The Senate Surprised': { k: 'tapTwo', freeze: true },
    'Evasive Translation': { k: 'bounce' },
    'Flight Log Scrubber': { etb: 'loot', v: 0.5 },
    'Kamino Tidewall': { etb: 'tap', v: 0.4 },
    'Interdict the Channel': { k: 'counter', tax: 3 },
    'Shaak Ti, Citadel Mentor': { v: 1.8, threat: 3.8 },
    'Meditation in Formation': { k: 'perm', v: 2.4, attune: { v: 1.0 } },
    'Signal from the Underlevels': { k: 'auraBuff', p: 0, t: 0, auraHit: true },
    'Utapau Traffic Lock': { k: 'counter' },
    'Microjump Squadron': { etb: 'drawIfArt', v: 0.8 },
    'Obi-Wan Kenobi': { etb: 'bounceOpp', v: 1.8, threat: 3.0 },
    "Kamino's Sealed Orders": { k: 'draw', v: 5.4 },
    'Plo Koon, Fleet Protector': { v: 2.8, threat: 5.5 },
    // ----- Black (035–051)
    'Senate Blackmailer': { etb: 'drain', n: 1, v: 0.6 },
    'Underlevel Stalker': { hit: 0.9, v: 0.5, threat: 2.2 },
    'Extraction Overseer': { v: 1.0, threat: 2.2 },
    'Separatist Demolition Droid': { compromise: 2, v: 0.3 },
    'Skakoan Reclaimer': { etb: 'retArt', v: 0.6 },
    'Utapau Cave Scavenger': { dv: 1.4, v: 0.6 },
    'Abandon the Witness': { k: 'shrink', n: 3, attuneSpell: 0.9 },
    'Dark-Side Intercession': { k: 'recursion' },
    'Silence a Delegate': { k: 'destroy', compromise: 1 },
    'Underworld Peacekeeper': { dv: 1.5, v: 0.6 },
    'Savage Opress, Sith Enforcer': { v: 2.2, threat: 4.8 },
    'Fragments of a Sith Testament': { k: 'draw', v: 4.6, compromise: 3 },
    'By the Rule of Two': { k: 'perm', v: 2.6 },
    'Senate Shadow Detail': { k: 'shadowDetail', tok: 'Human Rogue', n: 2 },
    'Execute Order 66!': { k: 'order66' },
    'Unlimited Power!': { k: 'unlimitedPower' },
    'Darth Sidious, Sith Master': { v: 3.6, threat: 7.2 },
    // ----- Red (052–068)
    'Junkyard Witness': { dv: 0.7, v: 0.2 },
    'Geonosian Arena Runner': { v: -0.3 },
    'Hangar Sweep Droid': { v: 0.8, threat: 1.6 },
    'Sparks Before the Charge': { k: 'pump', p: 2, t: 0, fs: true },
    'Sandburn': { k: 'burn', dmg: 2 },
    'Scuttle the Turret': { k: 'permHarm', draw: true },
    'Scuttle the Turret#m0': { k: 'permHarm', draw: true },
    'Scuttle the Turret#m1': { k: 'cantBlock2', draw: true },
    'Canopy Strike Flyer': { v: 0.6 },
    'Outer Rim Blademaster': { whenEq: { fs: true }, v: 0.4 },
    'Kachirho Breaker': { etb: 'cantBlock', v: 0.4 },
    'Slagworks Overseer': { v: 2.2, threat: 4.6 },
    'Caldera Riposte': { k: 'burn', dmg: 3 },
    'Geonosis Salvage Crew': { v: 1.0, threat: 2.2 },
    'Cut the Pod Cable': { k: 'threaten1' },
    'Ryloth Fireteam': { atk: 'ryloPing', attune: { v: 1.2 }, v: 1.2, threat: 3.0 },
    'Sebulba, Grandstand Menace': { atk: 'sebulba', v: 2.4, threat: 4.8 },
    'Purge Transmission': { k: 'perm', v: 3.4 },
    'Jango Fett, Contract Hunter': { atk: 'jango', v: 2.8, threat: 5.2 },
    // ----- Green (069–085)
    'Wroshyr Seed Tender': { v: 1.0, threat: 2.6 },
    'Gungan Sacred Groveguard': { v: 0.4 },
    'Wroshyr Trailfinder': { etb: 'tutorBasic', v: 0.5 },
    'Grip of the Living Force': { k: 'pump', p: 2, t: 2 },
    'Leave No Metal': { k: 'permHarm' },
    'Kashyyyk Crossbow Post': { attune: { p: 1, t: 1 }, v: 0.6 },
    'Marshstep Initiate': { v: 0.9, threat: 1.5 },
    'Skewering Reed': { k: 'destroy' },
    'Opee Sea Killer': { v: 0.5 },
    'Chewbacca, Forest Defender': { etb: 'retArt', v: 1.0 },
    'Roots of the Living Force': { k: 'perm', v: 2.2 },
    'Battle Meditation, Canopy Chorus': { k: 'counters2' },
    'Beneath the Fallen Pillar': { k: 'fight', p: 2, t: 2 },
    'Sacred Place Guardian': { v: 1.2, threat: 2.2 },
    'Ahsoka Tano, Unbound Protector': { atk: 'otherPump', p: 2, t: 2, v: 2.6, threat: 5.4 },
    'Revelation of the Living Force': { k: 'revelation' },
    'Yoda, Keeper of the Living Force': { v: 3.5, threat: 6.8 },
    // ----- Multicolor (086–105 + backs)
    'Senate Garrison': { etb: 'drain', n: 1, dv: 0.5, v: 0.6 },
    'Vulture Wing': { etb: 'loot', v: 0.8 },
    'Felucian Grovekeeper': { v: 1.0, threat: 2.0 },
    'Wookiee Canopy Team': { v: 0.6 },
    'Polis Massa Midwives': { etb: 'reanimMV2', compromise: 2, v: 1.0 },
    'For The Better, Right?': { k: 'destroy', exile: true, compromise: 2 },
    'For The Better, Right?#m0': { k: 'destroy', exile: true, compromise: 2 },
    'For The Better, Right?#m1': { k: 'discard', pick: true, compromise: 2 },
    'Torrent Squadron Wingman': { etb: 'token', tok: 'Clone Soldier', n: 1, v: 0.9 },
    'Geonosian Signal Thief': { etb: 'sacArtDraw', v: 0.8 },
    'Reclaim the Wreck': { k: 'reclaimWreck' },
    'Separatist Signal Array': { k: 'rock', v: 1.2 },
    'Chart the Outer Rim': { k: 'ramp' },
    '501st Legion': { etb: 'token', tok: 'Clone Soldier', n: 1, v: 1.8, threat: 4.4 },
    '501st, Vader\u2019s Fist': { v: 2.6, onTurn: 'shrinkOpp', threat: 4.8 },
    'Asajj Ventress, Lost Padawan': { atk: 'otherLifelink', v: 2.0, threat: 4.4 },
    'Asajj Ventress, Dooku\u2019s Assassin': { v: 2.6, onTurn: 'destroyOpp', threat: 4.8 },
    'Empire by Acclamation': { k: 'perm', v: 3.2 },
    'Palpatine, Supreme Chancellor': { k: 'palpatine', v: 2.6 },
    'Qui-Gon Jinn, Living Force': { v: 2.6, threat: 5.2 },
    'Darth Maul, Shadow Apprentice': { hit: 1.4, v: 2.4, threat: 4.8 },
    'The Invisible Hand': { etb: 'token', tok: 'Droid', n: 2, v: 3.0, threat: 5.8 },
    'Count Dooku, Lost Idealist': { etb: 'dig3', v: 2.4, threat: 5.2 },
    'Darth Tyranus, Sith Count': { v: 3.4, onTurn: 'regrowSpell', threat: 6.4 },
    'General Grievous, Blade Collector': { etb: 'tutorEq', atk: 'grievous', v: 3.2, threat: 6.4 },
    // ----- Artifacts & Lands (106–120B)
    'B1 Droid Pair': { etb: 'token', tok: 'Droid', n: 1, v: 0.5 },
    'Medical Capsule': { k: 'perm', v: 1.6 },
    'Astromech Scout': { v: 1.0, threat: 2.4 },
    'Republic Gunship': { v: 0.4 },
    'Temple Training Holocron': { k: 'perm', v: 2.4 },
    'Comms Disruptor': { k: 'perm', v: 2.0 },
    'Jedi Lightsaber': { k: 'equipment', v: 1.2 },
    'Maul\u2019s Lightsaber': { k: 'equipment', v: 1.8 },
    'Frontier Supply Post': { v: 0.4 },
    'Envoy\u2019s Landing': { v: 0.4 },
    'Trade Route Junction': { v: 0.3 },
    'Geonosis, Foundry Spires': { v: 0.5 },
    'Kashyyyk, Tidal Canopy': { v: 0.5 },
    'Naboo, Lake Country': { v: 0.5 },
    'Jedi Temple, Coruscant': { v: 1.0 },
    'Imperial Palace': { v: 2.0, onTurn: 'tokens2' },
  };
  function kb(name) { return KB[name] || EMPTY; }
  // Shared wall-clock limit for the decision being computed (keeps worst case < 300ms).
  let DECISION_DEADLINE = Infinity;
  // Attack-evaluation weights (exposed as OF.AI.tune for experiments).
  const TUNE = { faceW: 1.3, crackW: 0.7, riskW: 0.7, hardMix: 'min', hardAggr: true, hardFaceW: 1.45, hardCrackW: 0.85, hardRiskW: 0.65, hardExactBlocks: true, hardRace: true, raceAhead: 1.3, raceBehind: 0.85, normalNoise: 0.15, easySkip: 0.45 };

  // ===========================================================================
  // Generic helpers
  // ===========================================================================
  const ctl = (g, c) => g.controllerOf(c);
  const bf = (g) => g.battlefield.map(id => g.card(id));
  const mineOf = (g, p) => bf(g).filter(c => ctl(g, c) === p);
  const creaturesOf = (g, p) => bf(g).filter(c => g.isCreature(c) && ctl(g, c) === p);
  const landsOf = (g, p) => bf(g).filter(c => g.isLand(c) && ctl(g, c) === p);
  const artifactsOf = (g, p) => bf(g).filter(c => g.isArtifact(c) && ctl(g, c) === p);
  const handOf = (g, p) => g.players[p].hand.map(id => g.card(id));
  const gyOf = (g, p) => g.players[p].graveyard.map(id => g.card(id));
  const refKey = (r) => r.kind === 'player' ? 'p' + r.idx : r.kind === 'stack' ? 's' + r.sid : 'c' + r.id;
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const isInstantDef = (def) => def.types.includes('Instant');
  const isSorceryDef = (def) => def.types.includes('Sorcery');
  const isCreatureDef = (def) => def.types.includes('Creature');
  const isLandDef = (def) => def.types.includes('Land');
  const isArtifactDef = (def) => def.types.includes('Artifact');
  const isPermDef = (def) => ['Creature', 'Artifact', 'Enchantment', 'Land'].some(t => def.types.includes(t));
  const named = (g, p, name) => bf(g).filter(c => c.name === name && ctl(g, c) === p);
  const hintOf = (def) => (def.spell && def.spell.ai) || def.ai || EMPTY;
  const rulesOf = (def) => (def.data && def.data.rules) || '';
  const isEquipped = (g, c) => g.battlefield.some(id => { const e = g.card(id); return e.attachedTo === c.id && safeBool(() => g.isEquipment(e)); });
  const isSithC = (c) => c.def.subtypes.includes('Sith');

  function lifeValue(L) { return L <= 0 ? -60 : 20 * Math.log(1 + L / 4); }
  /** Cost (in value units) of losing d life from L. Lethal = 1000. */
  function lifeCost(L, d) {
    if (d <= 0) return 0;
    if (L - d <= 0) return 1000;
    return lifeValue(L) - lifeValue(L - d);
  }
  /** Value of gaining n life at L (discounted: life gain is worth less than damage). */
  function lifeGainV(L, n) { return n > 0 ? lifeCost(L + n, n) * 0.6 : 0; }

  function shieldsOf(c) { let s = 0; for (const x of c.shields || []) s += x.amount; return s; }
  function remTough(g, c) { return (g.toughness(c) || 0) - (c.damage || 0) + shieldsOf(c); }
  function safeBool(fn) { try { return !!fn(); } catch (e) { return false; } }
  function safeNum(fn) { try { const v = fn(); return Number.isFinite(v) ? v : 0; } catch (e) { return 0; } }
  function protFrom(g, c, source) { try { return g.protectedFrom(c, source); } catch (e) { return false; } }
  const untargetableBy = (g, c, p) => g.has(c, 'shroud') || g.has(c, 'untargetable') || (g.has(c, 'hexproofOpp') && ctl(g, c) !== p);

  function refObj(g, r) {
    if (r.kind === 'player') return g.players[r.idx];
    if (r.kind === 'stack') return g.stack.find(s => s.sid === r.sid) || null;
    return g.card(r.id);
  }

  // ----- rules-text analysis (cached per card name) ----------------------------
  const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const numOf = (s) => NUMW[s] !== undefined ? NUMW[s] : (parseInt(s, 10) || 0);
  const textCache = {};
  /** Facts read from a card's rules text: Force gained on ETB / on cast / on death, Attunement, Force sinks, equipment stats. */
  function textInfo(def) {
    let t = textCache[def.name];
    if (t) return t;
    const r = rulesOf(def);
    t = { etbForce: 0, spellForce: 0, diesForce: 0, attune: /Attunement/.test(r), sinks: 0, eq: null };
    let m;
    if ((m = /When [^.]* enters the battlefield, you get (\w+) Force counters?/.exec(r))) t.etbForce = numOf(m[1]);
    if ((m = /When [^.]* dies, you get (\w+) Force counters?/.exec(r))) t.diesForce = numOf(m[1]);
    if (!isPermDef(def)) {
      // unconditional "You get N Force counters." sentences (not Attunement / "if" clauses)
      for (const line of r.split('\n')) {
        if (/^Attunement/.test(line)) continue;
        const mm = /(?:^|\. )You get (\w+) Force counters?\./.exec(line);
        if (mm) t.spellForce += numOf(mm[1]);
      }
    }
    t.sinks = (r.match(/Use the Force \d+/g) || []).length;
    if (def.subtypes.includes('Equipment')) {
      const e = { p: 0, t: 0, kw: [] };
      if ((m = /Equipped creature gets \+(\d+)\/\+(\d+)/.exec(r))) { e.p = parseInt(m[1], 10); e.t = parseInt(m[2], 10); }
      if ((m = /(?:and )?has ([a-z ]+?)(?:\.|$)/m.exec(r.split('\n')[0]))) {
        const kwMap = { 'first strike': 'firstStrike', 'vigilance': 'vigilance', 'reach': 'reach', 'trample': 'trample', 'flying': 'flying' };
        if (kwMap[m[1]]) e.kw.push(kwMap[m[1]]);
      }
      if (/deals combat damage to a player, you get/.test(r)) e.hitForce = 1;
      if (/attach .* to another target creature/.test(r)) e.moves = true;
      t.eq = e;
    }
    textCache[def.name] = t;
    return t;
  }

  // ----- colours ---------------------------------------------------------------
  /** Can a card be cast with only these colours available (hybrid symbols need either colour)? */
  function colorOK(def, cols) {
    const cost = def.cost;
    for (const k of COLORS) if (cost[k] > 0 && !cols.has(k)) return false;
    for (const h of cost.hybrid || []) if (!h.some(k => cols.has(k))) return false;
    return true;
  }
  /** Weighted colour demand of a cost (hybrid counts half for each of its colours). */
  function colorDemand(cost) {
    const d = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const k of COLORS) d[k] += cost[k] || 0;
    for (const h of cost.hybrid || []) for (const k of h) if (d[k] !== undefined) d[k] += 1 / h.length;
    return d;
  }
  const prodCache = {};
  function producedColors(def) {
    if (prodCache[def.name]) return prodCache[def.name];
    const out = new Set();
    for (const ab of def.activated || []) {
      if (!ab.mana || ab.mana.spendOnly) continue;
      const pr = ab.mana.produce;
      if (pr === 'ANY') COLORS.forEach(c => out.add(c));
      else if (pr !== 'C') for (const ch of pr) if (COLORS.includes(ch)) out.add(ch);
    }
    prodCache[def.name] = out;
    return out;
  }
  function colorSourceCounts(g, p) {
    const cnt = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const c of bf(g)) {
      if (ctl(g, c) !== p) continue;
      for (const col of producedColors(c.def)) cnt[col]++;
    }
    return cnt;
  }

  // ----- mana -------------------------------------------------------------------
  function manaSourcesSafe(g, p, exclude) {
    try { return g._manaSources(p, exclude); } catch (e) { return []; }
  }
  function availMana(g, p, exclude) {
    let n = U.poolTotal(g.players[p].manaPool);
    for (const s of manaSourcesSafe(g, p, exclude)) n += Math.max(0, ...s.opts.map(o => o.units.length - (o.extra || 0)));
    return n;
  }
  /** Permanents that make mana only by losing counters: kept out of normal plans. */
  function counterManaIds(g, p) {
    const out = new Set();
    for (const c of creaturesOf(g, p)) {
      if ((g.activatedAbilities(c) || []).some(ab => ab.mana && ab.cost && ab.cost.removeCounters && !ab.cost.tap)) out.add(c.id);
    }
    return out;
  }
  /** canAfford with optional exclusions and a spendFor (restricted mana: artifact-only etc.). */
  function canAfford(g, p, cost, exclude, spendFor) {
    try {
      const o = {};
      if (exclude && exclude.size) o.exclude = exclude;
      if (spendFor) o.spendFor = spendFor;
      return g.canAfford(p, cost, o);
    } catch (e) { return false; }
  }
  const spendForCard = (card) => ({ kind: 'spell', card });
  function maxXFor(g, p, cost, exclude) {
    const base = U.cloneCost(cost); base.X = 0;
    let x = 0;
    for (let n = 1; n <= 20; n++) {
      const c2 = U.cloneCost(base); c2.generic += n * (cost.X || 1);
      if (canAfford(g, p, c2, exclude)) x = n; else break;
    }
    return x;
  }
  const genericCost = (n) => ({ generic: n, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, X: 0, hybrid: [] });

  // ===========================================================================
  // Force economy
  // ===========================================================================
  const forceOf = (g, p) => (g.players[p] && g.players[p].force) || 0;
  const forceSpent = (g, p) => safeBool(() => g.spentForceThisTurn(p));
  /** Force sinks p can use repeatedly (permanents) plus some credit for cards in hand that use Force. */
  function sinkScore(g, p) {
    let s = 0;
    for (const c of mineOf(g, p)) {
      for (const ab of g.activatedAbilities(c)) if (ab.cost && ab.cost.force && !ab.mana) { s += ab.isTurn ? 0.5 : 1; }
      if (textInfo(c.def).attune) s += 0.4;
      if (/pay (one|two|\w+) Force counters?/.test(rulesOf(c.def))) s += 0.5;
    }
    for (const c of handOf(g, p)) { const ti = textInfo(c.def); if (ti.sinks) s += 0.4; else if (ti.attune) s += 0.2; }
    for (const c of gyOf(g, p)) if (c.name === 'Darth Sion, Held by Pain') s += 1;
    return s;
  }
  /** Marginal value of one more Force counter for player p (value units; a card is ~2.5). */
  /** Opportunity cost of spending one Force counter now (Force left at the end of the game is worth nothing, so low). */
  function forceUnit(g, p, extra) {
    const s = sinkScore(g, p);
    let v = 0.15 + 0.12 * Math.min(3, s);
    const pool = forceOf(g, p) + (extra || 0);
    if (pool >= 9) v *= 0.5; else if (pool >= 5) v *= 0.75;
    return v;
  }
  /** Value of gaining n Force counters (what they will turn into through our sinks). */
  function forceGainValue(g, p, n) {
    if (n <= 0) return 0;
    const s = sinkScore(g, p);
    let v = 0.3 + 0.2 * Math.min(3, s);
    if (forceOf(g, p) >= 8) v *= 0.6;
    return n * v;
  }
  /** Force counters to keep for important uses (Darth Sion's return, a wanted transform, protective abilities). */
  function forceReserve(g, p) {
    let r = 0;
    if (gyOf(g, p).some(c => c.name === 'Darth Sion, Held by Pain')) r = Math.max(r, 2);
    for (const c of mineOf(g, p)) {
      for (const ab of g.activatedAbilities(c)) {
        if (!ab.cost || !ab.cost.force || ab.mana) continue;
        const cls = classifyAbility(ab);
        if (cls.kind === 'regen' || cls.kind === 'shield' || cls.kind === 'bounceOwn') r = Math.max(r, ab.cost.force);
        if (cls.kind === 'fog') {
          const threat = sum(creaturesOf(g, 1 - p), x => Math.max(0, g.power(x) || 0));
          if (threat >= g.players[p].life * 0.6) r = Math.max(r, ab.cost.force);
        }
      }
    }
    return r;
  }
  /** Value of spending the first Force counter this turn (Attunement payoffs that would matter now). */
  function attuneBonus(g, p) {
    if (forceSpent(g, p)) return 0;
    const my = g.activePlayer === p;
    const pre = my && (g.step === 'main1' || g.step === 'beginCombat' || g.step === 'upkeep' || g.step === 'draw');
    const q = 1 - p;
    const oppCre = creaturesOf(g, q);
    let v = 0;
    for (const c of mineOf(g, p)) {
      const A = kb(c.name).attune;
      if (!A) continue;
      if (!g.isCreature(c)) { v += A.v || 0; continue; }
      const canAtk = pre && canAttackHyp(g, c);
      if (A.p && canAtk) v += 1.2;
      if (A.fear && canAtk && oppCre.some(b => !b.tapped && !(g.isArtifact(b) || g.isColor(b, 'B')))) v += 1.6;
      if (A.fs && (canAtk || (!my && g.step !== 'end'))) v += 0.8;
      if (A.reach && !my && oppCre.some(x => g.has(x, 'flying'))) v += 1;
      if (A.v) v += (c.name === 'Meditation in Formation' || canAtk) ? A.v : 0;
    }
    if (my && (g.step === 'main1' || g.step === 'main2')) {
      for (const c of handOf(g, p)) { const K = kb(c.name); if (K.attuneSpell && canAfford(g, p, c.def.cost)) v += K.attuneSpell; }
      if (handOf(g, p).some(c => c.name === 'Abandon the Witness')) v += 0.5;
    }
    return v;
  }

  // ===========================================================================
  // Values
  // ===========================================================================
  function auraHostBonus(g, c) {
    let v = 0;
    for (const id of g.battlefield) {
      const a = g.card(id);
      if (a.attachedTo !== c.id) continue;
      const k = spellKind(a.def);
      if ((k === 'auraBuff' || k === 'equipment') && ctl(g, a) === ctl(g, c)) v += 1.5;
    }
    return v;
  }
  function hasRegen(c) { return (c.def.activated || []).some(ab => /Regenerate/.test(ab.text || '') && !(ab.targets && ab.targets.length)); }
  function landwalks(g, c) {
    const out = [];
    for (const lw of ['plainswalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk']) if (g.has(c, lw)) out.push(lw);
    return out;
  }
  const LW_LAND = { plainswalk: 'Plains', islandwalk: 'Island', swampwalk: 'Swamp', mountainwalk: 'Mountain', forestwalk: 'Forest' };
  function controlsLandType(g, p, type) { return bf(g).some(x => ctl(g, x) === p && g.isLand(x) && g.subtypesOf(x).includes(type)); }

  /** Keyword part of a creature's value (shared by battlefield / card / other-face valuations). */
  function kwValue(has, p, t) {
    let v = 0;
    for (const k of ['flying', 'firstStrike', 'trample', 'vigilance']) if (has(k)) v += 1.5;
    if (has('doubleStrike')) v += 1.5 + Math.max(0, p);
    if (has('deathtouch')) v += 1 + Math.max(0, 4 - p) * 0.6;
    if (has('lifelink')) v += 0.6 + Math.max(0, p) * 0.5;
    if (has('fear')) v += 1.3;
    if (has('menace')) v += 1.5 + Math.max(0, p) * 0.28;
    if (has('indestructible')) v += 2.6 + Math.max(0, p) * 0.3;
    if (has('unblockableAlone')) v += 1.5;
    if (has('flanking')) v += 0.8;
    if (has('maxOneBlocker')) v += 0.4 + Math.max(0, p - 3) * 0.2;
    if (has('reach')) v += 0.5;
    if (has('canBlockOnlyFlying')) v -= 0.4;
    if (has('shroud')) v += 0.8;
    if (has('hexproofOpp') || has('untargetable')) v += 1;
    if (has('unblockable')) v += 2;
    if (has('cantBlock')) v -= 0.8;
    if (has('mustAttack')) v -= 0.5;
    if (has('defender') || has('cantAttack')) v -= Math.max(0, p) * 1.2;
    return v;
  }

  /** Value of a creature on the battlefield (weights engine/ability threats over raw P/T). */
  function cval(g, c) {
    // Palpatine, Supreme Chancellor donated to an opponent is a liability to its controller!
    if (c.name === 'Palpatine, Supreme Chancellor' && c.owner !== ctl(g, c)) {
      return -5.5 - (c.counters && c.counters.influence ? c.counters.influence * 1.5 : 0);
    }
    const p = g.power(c) || 0, t = g.toughness(c) || 0;
    let v = Math.max(0, p) * 1.7 + t * 0.9 + c.def.manaValue * 0.45;
    const has = (k) => g.has(c, k);
    v += kwValue(has, p, t);
    for (const lw of landwalks(g, c)) v += controlsLandType(g, 1 - ctl(g, c), LW_LAND[lw]) ? 2 : 0.3;
    if (c.def.activated.length || c.def.triggers.length || c.def.statics.length) v += 1.0;
    if (hasRegen(c)) v += 1.5;
    if (c.token) v -= 0.9;
    const K = kb(c.name);
    if (K.v) v += K.v;
    if (K.threat) v += K.threat;
    if (K.hit) v += K.hit * 0.5;
    if (K.dv) v += K.dv * 0.3;
    // Unflipped DFCs with deadly Dark Side backs are high-priority targets before they flip
    if (c.backDef && !c.transformed) v += 1.8;
    const ti = textInfo(c.def);
    if (ti.diesForce) v += ti.diesForce * 0.2;
    if (c.def.blockRestriction) v += 1.2;
    if (has('cantAttack') && has('cantBlock')) v *= 0.2;
    else if (has('doesntUntap') && c.tapped) v *= 0.35;
    v += auraHostBonus(g, c);
    return Math.max(0.5, v);
  }

  /** Value of creature c if it showed face `def` (transform evaluation): keeps counters, pumps and granted keywords. */
  function cvalAs(g, c, def) {
    if (!isCreatureDef(def)) return permValDef(g, c, def);
    const dp = (g.power(c) || 0) - (c.def.power || 0), dt = (g.toughness(c) || 0) - (c.def.toughness || 0);
    const p = (def.power || 0) + dp, t = (def.toughness || 0) + dt;
    let v = Math.max(0, p) * 2 + t + c.def.manaValue * 0.5;
    const granted = (k) => (c.eot && c.eot.kw.includes(k)) || (c.perm && c.perm.kw.includes(k));
    const has = (k) => def.keywords.includes(k) || granted(k);
    v += kwValue(has, p, t);
    if (def.activated.length || def.triggers.length || def.statics.length) v += 1;
    const K = kb(def.name);
    if (K.v) v += K.v;
    if (K.hit) v += K.hit * 0.3;
    v += auraHostBonus(g, c);
    return Math.max(0.5, v);
  }
  function permValDef(g, c, def) {
    const K = kb(def.name);
    if (isLandDef(def)) return 3.5 + (K.v || 0);
    return K.v ? K.v + 1.5 : def.manaValue * 1.1 + 1;
  }

  /** Static value of a card from its definition (hand / graveyard). */
  function sval(def) {
    if (!isCreatureDef(def)) return ncVal(def);
    const pw = def.power || 0, tg = def.toughness || 0;
    let v = pw * 2 + tg + def.manaValue * 0.5;
    const kw = def.keywords;
    v += kwValue((k) => kw.includes(k), pw, tg);
    if (kw.some(k => /walk$/.test(k))) v += 0.8;
    if (def.activated.length || def.triggers.length || def.statics.length) v += 1;
    const K = kb(def.name);
    v += (K.v || 0) + (K.hit || 0) * 0.3 + (K.dv || 0) * 0.3;
    const ti = textInfo(def);
    v += ti.etbForce * 0.6 + ti.diesForce * 0.4;
    if (K.etb && K.etb !== 'bounceOwnMay') v += 1;
    return v;
  }

  /** Rough worth of a noncreature card. */
  function ncVal(def) {
    if (isLandDef(def)) return 3;
    const k = spellKind(def);
    const K = kb(def.name);
    switch (k) {
      case 'destroy': case 'burn': case 'shrink': case 'edict': case 'fight': return 6;
      case 'stealArt': case 'threaten2': return 5;
      case 'counter': return 5;
      case 'wrath': case 'massShrink': case 'sweep': case 'warEnds': return 5;
      case 'draw': return K.v || 4;
      case 'token': return 5;
      case 'reanimate': case 'graveFleet': case 'rebuild': return 5.5;
      case 'tutorLegend': return 6;
      case 'auraDebuff': case 'auraShrink': return 5;
      case 'teamPump': case 'massWeaken': case 'teamTrick': case 'battleMed': return 4.5;
      case 'pump': case 'pumpRegen': case 'protection': case 'flicker': case 'refit': case 'counters2': return 3.5;
      case 'tapOne': case 'tapTwo': case 'cantBlock2': case 'burnAttackers': return 3;
      case 'rock': return 3;
      case 'equipment': return 3.5;
      case 'drain': return 3.5;
      default: return K.v ? K.v + 2 : def.manaValue * 1.1 + 1;
    }
  }

  function permVal(g, c) {
    if (g.isCreature(c)) return cval(g, c);
    if (g.isLand(c)) return g.isBasicLand(c) ? 3 : 3.5 + (kb(c.name).v || 0) + (c.def.activated.length > 1 ? 0.5 : 0);
    const K = kb(c.name);
    const k = spellKind(c.def);
    if (k === 'auraDebuff' || k === 'auraShrink') return ctl(g, c) === (c.attachedTo ? ctl(g, g.card(c.attachedTo)) : -1) ? 0.5 : 4;
    if (k === 'stealArt') return c.attachedTo ? 2 + permVal(g, g.card(c.attachedTo)) : 2;
    if (k === 'equipment') { const e = textInfo(c.def).eq || {}; return 2 + (e.p || 0) * 0.8 + (e.t || 0) * 0.4 + (e.kw ? e.kw.length : 0) * 0.6; }
    if (k === 'auraBuff') return 3;
    if (k === 'rock') return 2.5;
    return K.v ? K.v + 1.5 : c.def.manaValue * 1.1 + 1;
  }

  /** Our kind for a card (KB first, then script hint, then rules text). */
  const kindCache = {};
  function spellKind(def) {
    if (kindCache[def.name] !== undefined) return kindCache[def.name];
    let k = kb(def.name).k;
    if (!k) {
      if (isCreatureDef(def)) k = 'creature';
      else if (isLandDef(def)) k = 'land';
      else {
        const rules = rulesOf(def);
        const h = hintOf(def);
        const hint = h.kind || '';
        if (def.subtypes.includes('Aura')) k = /You control enchanted/.test(rules) ? 'stealArt' : (/gets \+|has /.test(rules) ? 'auraBuff' : 'auraDebuff');
        else if (def.subtypes.includes('Equipment')) k = 'equipment';
        else if (def.types.includes('Enchantment') || def.types.includes('Artifact')) k = 'perm';
        else if (hint === 'counter' || /Counter target/.test(rules)) k = 'counter';
        else if (hint === 'burn' || /deals? \d+ damage to (any target|target)/.test(rules)) k = 'burn';
        else if (hint === 'removal' && h.edict) k = 'edict';
        else if (hint === 'removal' && h.bounce) k = 'bounce';
        else if (hint === 'removal' && h.shrink) k = 'shrink';
        else if (hint === 'removal' || /Destroy target creature|Exile target creature/.test(rules)) k = 'destroy';
        else if (hint === 'wrath') k = 'wrath';
        else if (hint === 'artifactRemoval' || hint === 'enchantRemoval' || /Destroy target artifact/.test(rules)) k = 'permHarm';
        else if (hint === 'landRemoval') k = 'landHarm';
        else if (hint === 'pump' && h.team) k = 'teamPump';
        else if (hint === 'pump' || /gets [+]\d/.test(rules)) k = 'pump';
        else if (hint === 'protect') k = 'protection';
        else if (hint === 'tap') k = 'tapOne';
        else if (hint === 'discard') k = 'discard';
        else if (hint === 'reanimate') k = 'reanimate';
        else if (hint === 'recursion') k = 'recursion';
        else if (hint === 'ramp') k = 'ramp';
        else if (hint === 'graveyardHate') k = 'gyHate';
        else if (hint === 'drain') k = 'drain';
        else if (/gets -\d/.test(rules)) k = 'shrink';
        else if (hint === 'draw' || /[Dd]raw/.test(rules)) k = 'draw';
        else if (hint === 'token' || /token/.test(rules)) k = 'token';
        else k = 'other';
      }
    }
    kindCache[def.name] = k;
    return k;
  }

  function burnDamage(g, p, def) {
    const K = kb(def.name);
    let d = K.dmg;
    if (d === undefined) d = hintOf(def).dmg !== undefined ? hintOf(def).dmg : hintOf(def).amount;
    if (d === undefined) { const m = /deals? (\d+) damage/.exec(rulesOf(def)); d = m ? parseInt(m[1], 10) : 2; }
    return d;
  }
  function pumpStats(g, p, def) {
    const K = kb(def.name);
    let pp = K.p, tt = K.t;
    if (pp === undefined) { const m = /gets \+(\d+)\/\+(\d+)/.exec(rulesOf(def)); pp = m ? parseInt(m[1], 10) : 0; tt = m ? parseInt(m[2], 10) : 0; }
    return { p: pp || 0, t: tt || 0, fs: !!K.fs || /first strike/.test(rulesOf(def)), ds: !!K.ds, tr: !!K.tr, regen: K.k === 'pumpRegen' };
  }
  function shrinkN(g, p, def) {
    const K = kb(def.name);
    return K.n || hintOf(def).shrink || 2;
  }

  // ----- modal spells: one pseudo-definition per mode ----------------------------
  const modeDefCache = new Map();
  /** Definition for mode i of a modal spell (its own targets, hint, text and KB entry 'Name#mi'). */
  function modeDef(def, i) {
    const key = def.name + '#m' + i;
    let md = modeDefCache.get(key);
    if (md && md.__base === def) return md;
    const mode = def.spell.modes[i];
    const label = mode.label || mode.text || '';
    md = Object.assign({}, def, {
      name: key, __base: def, __mode: i,
      spell: Object.assign({}, def.spell, { modes: null, targets: mode.targets || [], ai: mode.ai || def.spell.ai || null, resolve: mode.resolve }),
      data: Object.assign({}, def.data, { rules: label }),
    });
    modeDefCache.set(key, md);
    return md;
  }
  /** A card-like view of `card` showing mode i's definition (same id: engine lookups still use the real card). */
  function modeCard(card, i) { const v = Object.create(card); v.def = modeDef(card.def, i); v.__mode = i; return v; }
  const isModal = (def) => !!(def.spell && def.spell.modes && def.spell.modes.length);

  // ----- targeting helpers ----------------------------------------------------
  function auraSpec() { return { type: 'creature', prompt: 'Choose a creature to enchant.' }; }
  function spellSpecs(def) {
    if (def.spell && def.spell.targets) return def.spell.targets;
    if (def.subtypes.includes('Aura')) return [auraSpec()];
    return [];
  }
  function legalFor(g, p, spec, item) {
    try { return g._targetCandidates(spec, p, item); } catch (e) { return []; }
  }
  function spellItem(card, p) { const real = Object.getPrototypeOf(card) && card.__mode !== undefined ? Object.getPrototypeOf(card) : card; return { kind: 'spell', card: real, source: real, controller: p, sourceId: card.id, targets: [], modeIndex: card.__mode }; }
  function abilityItem(card, ab, p) { return { kind: 'ability', source: card, sourceZcc: card.zcc, controller: p, ability: ab, sourceId: card.id, targets: [] }; }

  /** Pick a set of refs in [min,max] maximizing score, respecting an optional group check. */
  function selectRefs(g, refs, scoreFn, min, max, groupFn) {
    const scored = refs.map(r => ({ r, s: scoreFn(r) })).sort((a, b) => b.s - a.s);
    const chosen = [];
    for (const x of scored) {
      if (chosen.length >= max) break;
      if (x.s <= 0 && chosen.length >= min) break;
      const trial = chosen.concat([x.r]);
      if (groupFn) { let err = null; try { err = groupFn(trial); } catch (e) { err = 'err'; } if (err) continue; }
      chosen.push(x.r);
    }
    if (chosen.length < min) {
      const top = scored.slice(0, 8).map(x => x.r);
      let best = null, bestS = -Infinity;
      const rec = (i, cur) => {
        if (cur.length === min) {
          let err = null;
          if (groupFn) { try { err = groupFn(cur); } catch (e) { err = 'err'; } }
          if (!err) { const s = sum(cur, r => scoreFn(r)); if (s > bestS) { bestS = s; best = cur.slice(); } }
          return;
        }
        for (let j = i; j < top.length; j++) { cur.push(top[j]); rec(j + 1, cur); cur.pop(); }
      };
      rec(0, []);
      return best;
    }
    return chosen;
  }

  // ===========================================================================
  // Target scoring by effect polarity
  // ===========================================================================
  function scoreRef(g, p, ref, eff) {
    const o = refObj(g, ref);
    if (!o) return -1;
    if (eff.exclude && eff.exclude.has(refKey(ref))) return -0.5;
    if (ref.kind === 'player') {
      const mine = ref.idx === p;
      const L = o.life;
      if (eff.k === 'burn') return mine ? -100 : (eff.dmg >= L ? 1000 : lifeCost(L, eff.dmg) * 0.7 + 0.05);
      if (eff.k === 'playerHelp' || eff.k === 'shield') return mine ? (eff.k === 'shield' ? 0.3 : 5) : -5;
      if (eff.k === 'help') return mine ? 1 : -1;
      return mine ? -5 : 5;
    }
    if (ref.kind === 'stack') {
      if (o.controller === p) return -100;
      return itemInfo(g, p, o).impact;
    }
    const c = o;
    if (c.zone === 'battlefield') {
      const mine = ctl(g, c) === p;
      const cr = g.isCreature(c);
      const val = permVal(g, c);
      switch (eff.k) {
        case 'burn': {
          if (!cr) return -1;
          const d = eff.dmgFor ? eff.dmgFor(c) : eff.dmg;
          const ind = g.has(c, 'indestructible');
          const kills = !ind && d >= remTough(g, c) && !(c.regen > 0);
          if (mine) return -val;
          if (val < 0) return -10;
          return kills ? val + 0.1 : (ind ? -2 : 0.05 * val);
        }
        case 'harm': {
          if (mine) return -val;
          if (val < 0) return -10;
          if (!cr && (eff.sub === 'shrink' || eff.sub === 'aura' || eff.sub === 'tap')) return -1;
          switch (eff.sub) {
            case 'destroy': return g.has(c, 'indestructible') ? -10 : (c.regen > 0 && !eff.noRegen ? val * 0.2 : val);
            case 'steal': return val * 1.6 - (c.token ? 0.5 : 0);
            case 'exile': return val + (c.token ? 0 : 0.3);
            case 'auraShrink': {
              if (!cr) return -1;
              const t = (g.toughness(c) || 0) - (eff.t || 0);
              return (t <= 0 || c.damage >= t) ? val + 0.1 : Math.min(Math.max(0, g.power(c) || 0), eff.p || 0) * 1.1 + 0.2;
            }
            case 'shrink': {
              const t = (g.toughness(c) || 0) - eff.n;
              return (t <= 0 || c.damage >= t) ? val + 0.1 : 0.08 * val;
            }
            case 'bounce': return c.token ? val + 0.5 : val * 0.4 + 0.3 * (c.def.manaValue);
            case 'aura': {
              if (g.has(c, 'cantAttack') && g.has(c, 'cantBlock')) return 0.1;
              if (g.has(c, 'doesntUntap')) return 0.1;
              return val * 0.85;
            }
            case 'tap': return c.tapped ? 0 : val * 0.3;
            case 'cantBlock': return c.tapped ? 0 : val * 0.3;
            default: return val;
          }
        }
        case 'help': {
          if (!mine) return -val;
          if (!cr) return eff.art && g.isArtifact(c) ? 1 : 0.5;
          let s = val;
          if (eff.untap) s = c.tapped ? val * 0.5 : 0.05;
          if (eff.aura) {
            if (g.has(c, 'cantAttack') && g.has(c, 'cantBlock')) return 0.1;
            if (g.has(c, 'defender')) s *= 0.4;
            if (g.has(c, 'flying') || g.has(c, 'unblockable') || g.has(c, 'fear')) s += 2;
            if (g.has(c, 'doubleStrike')) s += 2;
          }
          if (g.combat) {
            const inC = g.combat.attackers.some(a => a.id === c.id) || g.combat.blockers[c.id];
            if (inC) s += 3;
          }
          return s;
        }
        case 'bounceOwn': {
          if (!mine) return -10;
          if (eff.sourceId && c.id === eff.sourceId) return -25; // Never bounce self in an infinite loop!
          // Rescue a creature currently targeted by an opponent's harmful spell/ability on the stack
          const inDanger = g.stack.some(s => s.controller !== p && (s.targets || []).some(l => l.some(r => r.kind === 'card' && r.id === c.id)));
          if (inDanger && !c.token) return val + 5;
          // Rescue a disabled creature (Pacifism / frozen)
          if (cr && !c.token && ((g.has(c, 'cantAttack') && g.has(c, 'cantBlock')) || (g.has(c, 'doesntUntap') && c.tapped))) return val * 0.6;
          // Replay cheap non-creature ETB artifacts (Medical Capsule, Comms Disruptor, Holocron, Signal Array)
          if (!cr && g.isArtifact(c) && !c.token && ['Medical Capsule', 'Comms Disruptor', 'Temple Training Holocron', 'Separatist Signal Array'].includes(c.name)) {
            return availMana(g, p) >= c.def.manaValue ? 2.2 : 0.4;
          }
          // Otherwise DO NOT bounce your own healthy attacker/blocker/land!
          return -Math.max(2, val);
        }
        case 'shield': return mine && cr ? 0.5 + (g.combat && (g.attacking(c) || g.combat.blockers[c.id]) ? 2 : 0) : -0.5;
        case 'permHarm': return mine ? -val : (g.isLand(c) ? (eff.landOk ? 2 : 0.5) : val);
        case 'stealArt': return mine ? -val : (g.isArtifact(c) ? val * 1.5 : -1);
        case 'landHarm': {
          if (!g.isLand(c)) return mine ? -val : val;
          return mine ? -5 : (g.isBasicLand(c) ? 2 : 3.5);
        }
        case 'gyHate': case 'gyReturn': return -1;
        default: return mine ? val * 0.2 : -0.1;
      }
    }
    // cards in graveyards (or other zones)
    const mine = c.owner === p;
    const cr = g.isCreatureCard ? g.isCreatureCard(c) : g.isCreature(c);
    switch (eff.k) {
      case 'gyReturn': {
        if (!mine) return eff.anyOwner && cr ? sval(c.def) : -1;
        if (cr) return sval(c.def);
        if (g.isLand(c)) return g.isBasicLand(c) ? 2 : 2.5;
        return ncVal(c.def) * 0.9;
      }
      case 'gyHate': {
        if (mine) return -(cr ? sval(c.def) * 0.3 + 0.3 : 0.2) + (eff.ownOk && cr ? 1 : 0);
        return cr ? sval(c.def) * 0.5 + 1 + (c.name === 'Darth Sion, Held by Pain' ? 4 : 0) : 0.6;
      }
      default: return mine ? 0.5 : -0.5;
    }
  }

  /** Polarity for a spell's targets (array for multi-spec spells). */
  function spellEff(g, p, def, opts) {
    const K = kb(def.name);
    const k = spellKind(def);
    switch (k) {
      case 'burn': return { k: 'burn', dmg: burnDamage(g, p, def) };
      case 'destroy': return { k: 'harm', sub: K.exile || hintOf(def).exile ? 'exile' : 'destroy' };
      case 'edict': case 'discard': case 'drain': return { k: 'playerHarm' };
      case 'shrink': return { k: 'harm', sub: 'shrink', n: shrinkN(g, p, def) };
      case 'bounce': return { k: 'harm', sub: 'bounce' };
      case 'auraDebuff': return { k: 'harm', sub: 'aura' };
      case 'auraShrink': return { k: 'harm', sub: 'auraShrink', p: K.p || 2, t: K.t || 0 };
      case 'stealArt': return { k: 'stealArt' };
      case 'threaten2': return { k: 'harm', sub: 'other' };
      case 'tapOne': case 'tapTwo': return { k: 'harm', sub: 'tap' };
      case 'cantBlock2': return { k: 'harm', sub: 'cantBlock' };
      case 'auraBuff': case 'equipment': return { k: 'help', aura: true };
      case 'pump': case 'protection': case 'pumpRegen': case 'flicker': case 'counters2': case 'battleMed': return { k: 'help' };
      case 'token': return { k: 'help' };
      case 'counter': return { k: 'counter' };
      case 'reanimate': return { k: 'gyReturn', anyOwner: !!K.anyGy };
      case 'recursion': case 'rebuild': return { k: 'gyReturn' };
      case 'gyHate': return { k: 'gyHate' };
      case 'landHarm': return { k: 'landHarm' };
      case 'permHarm': return { k: 'permHarm' };
      case 'draw': return { k: 'playerHarm' };
      case 'fight': return [{ k: 'help' }, { k: 'harm', sub: 'destroy' }];
      case 'refit': return [{ k: 'help', art: true }, { k: 'help' }];
      case 'massWeaken': return { k: 'playerHarm' };
      case 'nudge': return { k: 'help', art: true };
      default: return inferEffFromText(def);
    }
  }
  function inferEffFromText(def) {
    const r = rulesOf(def);
    let m;
    if ((m = /deals? (\d+) damage to (any target|target)/.exec(r))) return { k: 'burn', dmg: parseInt(m[1], 10) };
    if (/[Rr]eturn (up to \w+ )?target .*card.* from your graveyard/.test(r)) return { k: 'gyReturn' };
    if (/(Exile|Remove) (up to \w+ )?target .*cards? .*graveyard/.test(r)) return { k: 'gyHate' };
    if (/target creature you control|\+1\/\+1 counter on (up to one )?target/.test(r)) return { k: 'help' };
    if (/[Tt]ap (up to \w+ )?target creature/.test(r)) return { k: 'harm', sub: 'tap' };
    if (/target (opponent|player) (discards|loses|reveals)/.test(r)) return { k: 'playerHarm' };
    if (/Destroy (up to one )?target|Exile target creature|gets -/.test(r)) return { k: 'harm', sub: 'destroy' };
    if (/gets \+/.test(r)) return { k: 'help' };
    return { k: 'harm', sub: 'other' };
  }

  // ===========================================================================
  // Activated ability classification (by text, then script hint)
  // ===========================================================================
  const abCache = new WeakMap();
  function classifyAbility(ab) {
    if (!ab) return { kind: 'unknown' };
    let r = abCache.get(ab);
    if (r) return r;
    const t = (ab.text || '').replace(/Activate only [^.]*\./g, '');
    const h = ab.ai || EMPTY;
    const cost = ab.cost || {};
    let m;
    if (ab.mana) r = { kind: 'mana' };
    else if (ab.isTurn || h.kind === 'transform') r = { kind: 'transform', toSide: h.toSide };
    else if (ab.isCycling) r = { kind: 'cycling' };
    else if (ab.isEquip || h.kind === 'equip') r = { kind: 'equip' };
    else if (h.kind === 'counter' || /Counter target spell/.test(t)) { m = /pays \{(\d+)\}/.exec(t); r = { kind: 'taxCounter', tax: h.soft || (m ? parseInt(m[1], 10) : 0) }; }
    else if (/Prevent all combat damage/.test(t)) r = { kind: 'fog' };
    else if ((m = /Prevent the next (\d+) damage/.exec(t))) r = { kind: 'shield', n: parseInt(m[1], 10) };
    else if (/Regenerate/.test(t) || h.regen) r = { kind: 'regen', targeted: !!(ab.targets && ab.targets.length) };
    else if (/gains indestructible/.test(t)) r = { kind: 'regen', targeted: !!(ab.targets && ab.targets.length), indestructible: true };
    else if (/Put two \+1\/\+1 counters on each creature you control/.test(t)) r = { kind: 'teamPumpAb' };
    else if (/gains shroud/.test(t)) r = { kind: 'hexAb' };
    else if (/Exile target tapped creature|Destroy target tapped creature/.test(t)) r = { kind: 'assassin' };
    else if (/Return another target creature you control to its owner's hand/.test(t)) r = { kind: 'bounceOwn' };
    else if (/[Aa]ctivated abilities of your opponents/.test(t)) r = { kind: 'jammer' };
    else if (/[Tt]arget (opponent|player) (reveals|discards)/.test(t)) r = { kind: 'discardAb' };
    else if (/sacrifice another creature: .*\+(\d+)\/\+(\d+)/i.test(t)) { m = /\+(\d+)\/\+(\d+)/.exec(t); r = { kind: 'sacPump', p: parseInt(m[1], 10), t: parseInt(m[2], 10) }; }
    else if (/Each opponent loses (\d+) life/.test(t) && !/[Ss]acrifice/.test(t)) { m = /loses (\d+) life/.exec(t); r = { kind: 'drainAb', n: parseInt(m[1], 10), gain: /gain life/.test(t) }; }
    else if (/Target opponent loses (\d+) life/.test(t)) { m = /loses (\d+) life/.exec(t); r = { kind: 'drainAb', n: parseInt(m[1], 10), targeted: true }; }
    else if ((m = /(\d+) damage to (any target|target)/.exec(t))) r = { kind: 'ping', n: parseInt(m[1], 10), combatOnly: /attacking or blocking/.test(t), damagedOnly: /was dealt damage/.test(t), sac: !!(cost.sacrifice || cost.sacSelf) };
    else if (h.sacOutlet || h.kind === 'sacrificeOutlet' || (cost.sacrifice && !cost.sacSelf)) {
      r = { kind: 'sacOutlet', dmg: /damage to target player/.test(t) ? 1 : 0, draw: /[Dd]raw (a card|two cards)/.test(t) ? (/two cards/.test(t) ? 2 : 1) : 0,
        recur: /Return target .*card/.test(t), art: /artifact/.test((cost.sacrifice && (cost.sacrifice.label || cost.sacrifice.prompt)) || t) };
    }
    else if (/Tap target (untapped )?creature/.test(t)) r = { kind: 'tapper', draws: /draw a card/.test(t) };
    else if (/Untap target creature/.test(t)) r = { kind: 'untapper' };
    else if (/can[’']t block this turn/.test(t)) r = { kind: 'cantBlock' };
    else if (/Destroy target artifact/.test(t)) r = { kind: 'artKill' };
    else if (/Exile target card from a graveyard/.test(t)) r = { kind: 'gyHate', drain: /loses 2 life/.test(t) };
    else if (h.kind === 'loot' || /Draw a card, then discard a card/.test(t)) r = { kind: 'loot' };
    else if (/Search (your library )?for a basic land/.test(t)) r = { kind: 'fetch' };
    else if (/^[^:]*:\s*Scry (\d+)|Scry \d+\.$/.test(t)) { m = /Scry (\d+)/.exec(t); r = { kind: 'scry', n: m ? parseInt(m[1], 10) : 1 }; }
    else if (/Look at the top (three|two|\w+) cards of your library/.test(t)) r = { kind: 'dig', land: /land card/.test(t) };
    else if (/[Mm]ill (\w+) cards/.test(t)) r = { kind: 'selfMill' };
    else if (/Return target .*card/.test(t)) r = { kind: 'recursion', toBf: /to the battlefield/.test(t) };
    else if (/forge counter|survey counter/.test(t) && !/Equipment/.test(t)) r = { kind: 'chargeAdd' };
    else if (/put an Equipment card from your hand/.test(t)) r = { kind: 'anvil' };
    else if (h.kind === 'draw' || /Draw a card/.test(t)) r = { kind: 'drawAb', n: 1, life: 0 };
    else if (h.kind === 'token' || /token/.test(t)) r = { kind: 'token', big: /3\/3/.test(t), dt: /deathtouch/.test(t) };
    else if (/You gain (\d+) life/.test(t)) { m = /You gain (\d+) life/.exec(t); r = { kind: 'lifeAb', n: parseInt(m[1], 10) }; }
    else if (/\+1\/\+1 counter on (another )?target/.test(t)) r = { kind: 'counterTarget', untap: /Untap it/.test(t) };
    else if ((m = /[Tt]arget creature gets -(\d+)\/-(\d+)/.exec(t))) r = { kind: 'shrinkAb', n: parseInt(m[2], 10), p: parseInt(m[1], 10) };
    else if ((m = /[Tt]arget creature gets -(\d+)\/-0/.exec(t))) r = { kind: 'weakenAb', p: parseInt(m[1], 10), force: /Force counter/.test(t) };
    else if ((m = /[Tt]arget (legendary )?creature (you control )?gets \+(\d+)\/\+(\d+)/.exec(t))) r = { kind: 'pumpTarget', p: parseInt(m[3], 10), t: parseInt(m[4], 10) };
    else if (/[Tt]arget (artifact )?creature (you control )?gains flying/.test(t)) r = { kind: 'evasionAb' };
    else if (/[Tt]arget creature gains reach/.test(t)) r = { kind: 'reachAb' };
    else if ((m = /([+-]\d+)\/([+-]\d+) until end of turn/.exec(t))) r = { kind: 'selfPump', p: parseInt(m[1], 10), t: parseInt(m[2], 10), once: !!ab.oncePerTurn };
    else if (/gains flying/.test(t)) r = { kind: 'selfKw', kw: 'flying' };
    else if (/gains deathtouch/.test(t)) r = { kind: 'selfKw', kw: 'deathtouch' };
    else if (/first strike/.test(t)) r = { kind: 'selfKw', kw: 'firstStrike' };
    else if (/trample/.test(t)) r = { kind: 'selfKw', kw: 'trample' };
    else if (/You get (\d+) Force counters?/.test(t)) { m = /You get (\d+) Force/.exec(t); r = { kind: 'forceAb', n: parseInt(m[1], 10) }; }
    else {
      const map = { loot: 'loot', draw: 'drawAb', token: 'token', ramp: 'fetch', recursion: 'recursion', tap: 'tapper', graveyardHate: 'gyHate', protect: 'shield', drain: 'drainAb', lifegain: 'lifeAb' };
      r = { kind: map[h.kind] || 'unknown' };
      if (r.kind === 'shield') r.n = 1;
      if (r.kind === 'drawAb') { r.n = 1; r.life = 0; }
      if (r.kind === 'lifeAb') r.n = h.life || 2;
      if (r.kind === 'drainAb') r.n = h.amount || 2;
    }
    abCache.set(ab, r);
    return r;
  }

  function abilityCostValue(g, p, card, ab, opts) {
    const cost = ab.cost || {};
    let v = 0;
    if (cost.mana) v += U.costTotal(U.parseCost(cost.mana)) * 0.3;
    if (cost.tap && g.isCreature(card)) v += 0.4;
    if (cost.sacSelf) v += g.isLand(card) ? (landsOf(g, p).length >= 7 ? 1.5 : landsOf(g, p).length >= 5 ? 3.5 : 6) : permVal(g, card);
    if (cost.removeCounters) {
      const kind = cost.counterKind || 'p1p1';
      v += (kind === 'p1p1' ? 2 : 0.5) * cost.removeCounters;
    }
    if (cost.life) v += lifeCost(g.players[p].life, cost.life);
    if (cost.exileFromGraveyard) v += 0.5 * (cost.exileFromGraveyard.count || 1);
    if (cost.discard) v += 2.2 * (cost.discard.count || 1);
    if (cost.force) v += forceSpendCost(g, p, cost.force, opts && opts.reserved);
    return v;
  }
  /** Cost of spending n Force now: marginal value, plus a penalty for dipping into the reserve, minus the Attunement payoff. */
  function forceSpendCost(g, p, n, reservedUse) {
    const have = forceOf(g, p);
    let v = n * forceUnit(g, p, -n * 0.5);
    if (!reservedUse) {
      const res = forceReserve(g, p);
      const short = Math.max(0, res - (have - n));
      if (short > 0) v += short * 1.2;
    }
    v -= attuneBonus(g, p);
    return v;
  }

  // ===========================================================================
  // Stack item analysis (impact of letting it resolve, from p's perspective)
  // ===========================================================================
  function itemInfo(g, p, item) {
    const info = { impact: 0, harm: null, dmg: 0, n: 0, mine: [], gyTargets: [], theirTargets: [], src: null, single: false };
    const objs = [];
    for (const list of item.targets || []) for (const r of list) { const o = refObj(g, r); if (o) objs.push({ r, o }); }
    info.single = objs.length === 1;
    for (const { r, o } of objs) {
      if (r.kind === 'card' && o.zone === 'battlefield') { if (ctl(g, o) === p) info.mine.push(o); else info.theirTargets.push(o); }
      if (r.kind === 'card' && o.zone === 'graveyard') info.gyTargets.push(o);
    }
    info.src = item.kind === 'spell' ? item.card : item.source;
    const targetsMe = objs.some(x => x.r.kind === 'player' && x.r.idx === p);
    info.targetsMe = targetsMe;
    const minesVal = sum(info.mine, c => cval(g, c));
    const ctrl = item.controller;
    if (item.kind === 'spell') {
      let def = item.card.def;
      if (isModal(def) && item.modeIndex !== undefined && item.modeIndex !== null) def = modeDef(def, item.modeIndex);
      const K = kb(def.name);
      const k = spellKind(def);
      if (isCreatureDef(def)) { info.impact = sval(def) * 0.8; return info; }
      switch (k) {
        case 'burn': {
          const d = burnDamage(g, ctrl, def);
          info.harm = 'damage'; info.dmg = d;
          if (info.mine.length) info.impact = sum(info.mine, c => d >= remTough(g, c) ? cval(g, c) : 1);
          else if (targetsMe) info.impact = lifeCost(g.players[p].life, d);
          else info.impact = 1;
          break;
        }
        case 'destroy': info.harm = 'destroy'; info.impact = minesVal; break;
        case 'shrink': info.harm = 'shrink'; info.n = shrinkN(g, ctrl, def);
          info.impact = info.mine.length && (g.toughness(info.mine[0]) - info.n <= info.mine[0].damage) ? minesVal : 1; break;
        case 'bounce': info.harm = 'bounce'; info.impact = info.mine.length ? sum(info.mine, c => c.token ? cval(g, c) : cval(g, c) * 0.4 + 1) : 1; break;
        case 'auraDebuff': case 'auraShrink': info.harm = 'aura'; info.impact = minesVal * 0.85; break;
        case 'stealArt': info.harm = 'steal'; info.impact = sum(info.mine, c => permVal(g, c)) * 1.5 + 0.5; break;
        case 'threaten2': info.harm = 'steal'; info.impact = info.mine.length ? minesVal * 0.5 + 2 : 1; break;
        case 'fight': info.harm = 'damage'; info.dmg = info.theirTargets.length ? (g.power(info.theirTargets[0]) || 0) + (K.p || 0) : 2;
          info.impact = info.mine.length && info.dmg >= remTough(g, info.mine[0]) ? minesVal : 1; break;
        case 'auraBuff': case 'pump': case 'protection': case 'pumpRegen': case 'flicker': case 'refit':
          info.impact = info.theirTargets.length ? 3.5 : 1; break;
        case 'teamPump': case 'teamTrick': case 'battleMed': info.impact = 4; break;
        case 'massWeaken': info.impact = g.combat ? 4 : 2; break;
        case 'wrath': case 'warEnds': info.impact = Math.max(1, sum(creaturesOf(g, p), c => cval(g, c)) - sum(creaturesOf(g, ctrl), c => cval(g, c))); info.harm = 'wrath'; break;
        case 'massShrink': case 'sweep': {
          const n = K.n || 2;
          const dies = (c) => (g.toughness(c) || 0) - n <= (c.damage || 0) && !(K.nonFly && g.has(c, 'flying'));
          info.impact = Math.max(1, sum(creaturesOf(g, p).filter(dies), c => cval(g, c)) - (K.oppOnly || K.oneSided ? 0 : sum(creaturesOf(g, ctrl).filter(dies), c => cval(g, c))));
          if (K.players) info.impact += lifeCost(g.players[p].life, K.players);
          info.harm = 'wrath'; info.n = n; info.nonFly = !!K.nonFly;
          break;
        }
        case 'artWrath': info.impact = Math.max(1, sum(mineOf(g, p).filter(c => g.isArtifact(c) || g.isEnchantment(c)), c => permVal(g, c))); break;
        case 'edict': { const mine = creaturesOf(g, p).map(c => cval(g, c)).sort((a, b) => a - b); info.impact = mine.length ? mine[0] : 0.5; info.harm = 'edict'; break; }
        case 'counter': {
          const tgt = objs.find(x => x.r.kind === 'stack');
          info.impact = tgt && tgt.o.controller === p ? spellWorth(g, p, tgt.o) : 1;
          break;
        }
        case 'redirect': info.impact = 2; break;
        case 'tapOne': case 'tapTwo': case 'cantBlock2': info.impact = info.mine.length * 1.2 + 1; break;
        case 'burnAttackers': info.impact = sum(info.mine, c => 2 >= remTough(g, c) ? cval(g, c) : 0.5) + 0.5; info.harm = 'damage'; info.dmg = 2; break;
        case 'token': info.impact = (K.n || 2) * 2.5; break;
        case 'reanimate': case 'rebuild': case 'graveFleet': info.impact = sum(info.gyTargets, c => sval(c.def)) || 3; break;
        case 'recursion': info.impact = sum(info.gyTargets, c => sval(c.def) * 0.5) || 1.5; break;
        case 'discard': info.impact = targetsMe ? 1.8 * (K.n || 1) + 1 : 0.5; break;
        case 'drain': info.impact = targetsMe ? lifeCost(g.players[p].life, K.n || 2) + 1 : 1; break;
        case 'draw': info.impact = (K.v || 3.5) * 0.9; break;
        case 'landHarm': info.impact = info.mine.length ? 3.5 : 2; break;
        case 'permHarm': info.impact = sum(info.mine, c => permVal(g, c)); info.harm = info.mine.length ? 'destroy' : null; break;
        case 'tutorLegend': info.impact = 5; break;
        case 'perm': case 'rock': case 'equipment': info.impact = (K.v || ncVal(def)) * 0.9; break;
        default: info.impact = (K.v || def.manaValue) * 1.1 + 1;
      }
      return info;
    }
    // ability / trigger
    const ab = item.ability || {};
    const cls = item.kind === 'ability' ? classifyAbility(ab) : { kind: 'trigger' };
    const t = item.text || ab.text || '';
    let m;
    if (cls.kind === 'transform') { info.impact = 2.5; return info; }
    if ((m = /(\d+) damage to (any target|target|up to one target)/.exec(t))) {
      info.harm = 'damage'; info.dmg = parseInt(m[1], 10);
      info.impact = info.mine.length ? (info.dmg >= remTough(g, info.mine[0]) ? minesVal : 0.5) : (targetsMe ? lifeCost(g.players[p].life, info.dmg) : 0.5);
    } else if (cls.kind === 'taxCounter') {
      const tgt = objs.find(x => x.r.kind === 'stack');
      info.impact = tgt && tgt.o.controller === p ? spellWorth(g, p, tgt.o) : 1;
    } else if ((m = /gets -(\d+)\/-(\d+)/.exec(t)) && info.mine.length) {
      info.harm = 'shrink'; info.n = parseInt(m[2], 10);
      info.impact = (g.toughness(info.mine[0]) - info.n <= info.mine[0].damage) ? minesVal : 1;
    } else if (/[Tt]ap (up to one )?target/.test(t)) { info.harm = 'tap'; info.impact = info.mine.length ? 1.5 : 0.3; }
    else if (/Destroy (up to one )?target|Exile (up to one )?target (tapped )?creature/.test(t)) { info.harm = 'destroy'; info.impact = minesVal || sum(info.mine, c => permVal(g, c)); }
    else if (/[Rr]eturn (up to one )?target creature to/.test(t)) { info.harm = 'bounce'; info.impact = info.mine.length ? sum(info.mine, c => c.token ? cval(g, c) : cval(g, c) * 0.4 + 1) : 1; }
    else if (info.gyTargets.length && /[Rr]eturn/.test(t)) info.impact = sum(info.gyTargets, c => sval(c.def) * 0.5);
    else if (targetsMe && /loses \d+ life/.test(t)) info.impact = lifeCost(g.players[p].life, 2) + 0.5;
    else info.impact = info.mine.length ? 1.5 : 1;
    return info;
  }

  /** How much p values its own spell item resolving. */
  function spellWorth(g, p, item) {
    if (item.kind !== 'spell') return 2;
    const def = item.card.def;
    if (isCreatureDef(def)) return sval(def) * 0.8;
    return ncVal(def);
  }

  // ===========================================================================
  // Combat simulation (deathtouch, lifelink, first/double strike, flanking, trample, shields, regeneration)
  // ===========================================================================
  /** Can c's controller regenerate it with a non-sacrifice ability right now (mana / Force available)? */
  function regenReady(g, c) {
    try {
      if (c.regen > 0) return true;
      const p = ctl(g, c);
      for (const ab of g.activatedAbilities(c)) {
        const cls = classifyAbility(ab);
        if (cls.kind !== 'regen' || cls.targeted) continue;
        const cost = ab.cost || {};
        if (cost.sacrifice || cost.tap || cost.sacSelf) continue;
        if (cost.force && forceOf(g, p) < cost.force) continue;
        if (cost.life && g.players[p].life <= cost.life + 1) continue;
        if (!cost.mana || canAfford(g, p, U.parseCost(cost.mana))) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function unit(g, c, mod, potRegen) {
    const pow = g.power(c) || 0;
    const u = {
      id: c.id, c, pow, tough: g.toughness(c) || 0, dmg: c.damage || 0,
      shield: shieldsOf(c), fs: g.has(c, 'firstStrike') || g.has(c, 'doubleStrike'), ds: g.has(c, 'doubleStrike'), tr: g.has(c, 'trample'),
      regen: (c.regen || 0) > 0, val: cval(g, c), flying: g.has(c, 'flying'), removed: false,
      cols: g.colorsOf(c), prot: g.protections(c), vig: g.has(c, 'vigilance'),
      dt: g.has(c, 'deathtouch'), ll: g.has(c, 'lifelink'), flank: g.has(c, 'flanking'), m1: g.has(c, 'maxOneBlocker'), xb: g.has(c, 'extraBlock'),
      men: g.has(c, 'menace'), ind: g.has(c, 'indestructible'), uAlone: g.has(c, 'unblockableAlone'),
    };
    if (potRegen && !u.regen && regenReady(g, c)) u.regen = true;
    if (mod) applyMod(u, mod);
    return u;
  }
  function applyMod(u, mod) {
    u.pow += mod.p || 0; u.tough += mod.t || 0; u.dmg += mod.dmg || 0;
    if (mod.fs) u.fs = true;
    if (mod.ds) { u.ds = true; u.fs = true; }
    if (mod.tr) u.tr = true;
    if (mod.shield) u.shield += mod.shield;
    if (mod.regen) u.regen = true;
    if (mod.removed) u.removed = true;
    if (mod.vig) u.vig = true;
    if (mod.prot) u.prot = u.prot.concat(mod.prot);
    if (mod.val !== undefined) u.val = mod.val;
    if (mod.dt) u.dt = true;
    if (mod.ll) u.ll = true;
    if (mod.flying) u.flying = true;
    if (mod.ind) u.ind = true;
    if (mod.men) u.men = true;
    return u;
  }
  const epow = (u) => Math.max(0, u.pow) * (u.ds ? 2 : 1);

  /** Resolve one attacker vs its blockers. Returns {aDies, dead:Set(blocker ids), toPlayer, gainA, gainB}. */
  function fight(a, bs0) {
    const res = { aDies: false, dead: new Set(), toPlayer: 0, gainA: 0, gainB: 0 };
    if (!bs0.length) { res.toPlayer = epow(a); if (a.ll) res.gainA = res.toPlayer; return res; }
    // Flanking: each blocker without flanking gets -1/-1.
    const bs = a.flank ? bs0.map(b => b.flank ? b : Object.assign({}, b, { pow: b.pow - 1, tough: b.tough - 1 })) : bs0;
    const all = [a].concat(bs);
    const dmg = new Map(), shield = new Map(), out = new Set(), died = new Set(), dtHit = new Set();
    for (const u of all) { dmg.set(u.id, 0); shield.set(u.id, u.shield); if (u.tough - u.dmg <= 0) { out.add(u.id); if (!u.regen || u.tough <= 0) died.add(u.id); } }
    const anyFS = all.some(u => u.fs || u.ds);
    const steps = anyFS ? [true, false] : [false];
    const dealtFS = new Set();
    const left = (u) => u.tough - u.dmg - dmg.get(u.id);
    const blocked = (target, src) => target.prot && target.prot.length && src.cols && src.cols.some(k => target.prot.includes(k));
    for (const fsStep of steps) {
      const deals = (u) => !out.has(u.id) && (fsStep ? (u.fs || u.ds) : (!dealtFS.has(u.id) || u.ds));
      const assigns = [];
      if (deals(a) && a.pow > 0) {
        const live = bs.filter(b => !out.has(b.id));
        if (!live.length) { if (a.tr) { res.toPlayer += a.pow; if (a.ll) res.gainA += a.pow; } }
        else {
          let rem = a.pow;
          const order = live.slice().sort((x, y) => y.val - x.val);
          const plan = new Map();
          for (const b of order) { const l = Math.max(0, left(b)); if (rem >= l && l > 0) { plan.set(b, l); rem -= l; } }
          if (rem > 0) {
            if (a.tr && order.every(b => plan.has(b) || Math.max(0, left(b)) === 0)) { res.toPlayer += rem; if (a.ll) res.gainA += rem; }
            else { const tg = order.find(b => !plan.has(b)) || order[0]; plan.set(tg, (plan.get(tg) || 0) + rem); }
          }
          for (const [b, n] of plan) assigns.push([b, n, a]);
        }
      }
      for (const b of bs) if (deals(b) && b.pow > 0 && !out.has(a.id)) assigns.push([a, b.pow, b]);
      if (fsStep) for (const u of all) if ((u.fs || u.ds) && !out.has(u.id)) dealtFS.add(u.id);
      for (const [u, n, src] of assigns) {
        if (blocked(u, src)) continue;
        let x = n; const s = shield.get(u.id); const used = Math.min(s, x);
        shield.set(u.id, s - used); x -= used;
        dmg.set(u.id, dmg.get(u.id) + x);
        if (x > 0 && src.dt) dtHit.add(u.id);
        if (x > 0 && src.ll) { if (src === a) res.gainA += x; else res.gainB += x; }
      }
      for (const u of all) {
        if (out.has(u.id)) continue;
        if ((dmg.get(u.id) > 0 && u.dmg + dmg.get(u.id) >= u.tough) || dtHit.has(u.id)) {
          if (!u.ind) {
            out.add(u.id);
            if (!u.regen) died.add(u.id);
          }
        }
      }
    }
    res.aDies = died.has(a.id);
    for (const b of bs) if (died.has(b.id)) res.dead.add(b.id);
    return res;
  }

  /** Defender's blocking plan. o: {atk, blk, can(b,a), life, risk, mode, pump:{p,t,cost}, must:Set, oppLife} */
  function planBlocks(o) {
    const blocks = new Map();
    const used = new Set();
    let pumpUse = null;
    const atk = o.atk.filter(a => !a.removed);
    const total = sum(atk, a => epow(a));
    let w = 0;
    if (total > 0) {
      if (total >= o.life) w = o.life > 1 ? (lifeValue(o.life) - lifeValue(1)) / (o.life - 1) : 6;
      else w = lifeCost(o.life, total) / total;
    }
    const gainW = o.life > 0 ? 0.6 * 20 / (4 + o.life) : 1;
    const aggr = o.mode === 'aggr';
    const thresh = aggr ? -1.5 : 0.5;
    const order = atk.slice().sort((x, y) => (y.val + epow(y)) - (x.val + epow(x)));
    for (const a of order) {
      if (a.men) continue; // Menace attackers cannot be blocked by a single creature
      let best = null, bestS = thresh, bestPump = false;
      for (const b of o.blk) {
        if (used.has(b.id) || !o.can(b, a)) continue;
        const r = fight(a, [b]);
        const bDies = r.dead.has(b.id);
        let s = (r.aDies ? a.val : 0) - (bDies ? b.val : 0) + (epow(a) - r.toPlayer) * w + (r.gainB - (r.gainA - (a.ll ? epow(a) : 0))) * gainW * 0.5;
        if (o.risk) s -= o.risk * 0.25 * b.val;
        if (s > bestS) { bestS = s; best = b; bestPump = false; }
        if (o.pump && !pumpUse && (bDies || !r.aDies)) {
          const pb = Object.assign({}, b, { pow: b.pow + o.pump.p, tough: b.tough + o.pump.t });
          const r2 = fight(a, [pb]);
          if (r2.aDies && !r2.dead.has(b.id)) {
            const s2 = a.val + (epow(a) - r2.toPlayer) * w - o.pump.cost;
            if (s2 > bestS + 0.5) { bestS = s2; best = b; bestPump = true; }
          }
        }
      }
      if (best) { blocks.set(a.id, [best]); used.add(best.id); if (bestPump) pumpUse = { blocker: best.id, attacker: a.id }; }
    }
    // Double blocks on Menace attackers or big attackers nobody can handle alone.
    for (const a of order) {
      if (blocks.has(a.id) || (!a.men && a.val < 5) || a.m1) continue;
      const free = o.blk.filter(b => !used.has(b.id) && o.can(b, a)).slice(0, 7);
      if (free.length < 2) continue;
      let best = null, bestS = a.men ? thresh : 1.5;
      for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
        const r = fight(a, [free[i], free[j]]);
        if (!a.men && !r.aDies) continue;
        let s = (r.aDies ? a.val : 0) + (epow(a) - r.toPlayer) * w;
        for (const b of [free[i], free[j]]) if (r.dead.has(b.id)) s -= b.val;
        if (s > bestS) { bestS = s; best = [free[i], free[j]]; }
      }
      if (best) { blocks.set(a.id, best); for (const b of best) used.add(b.id); }
    }
    // Survival: chump until not lethal.
    const incoming = () => sum(atk, a => blocks.has(a.id) ? fight(a, blocks.get(a.id)).toPlayer : epow(a)) + (o.drain || 0);
    for (let guard = 0; guard < 20; guard++) {
      const inc = incoming();
      if (inc < o.life) break;
      let bestPair = null, bestK = -Infinity;
      for (const a of atk) {
        const cur = blocks.get(a.id) || [];
        if (a.m1 && cur.length) continue;
        const curTo = cur.length ? fight(a, cur).toPlayer : epow(a);
        if (curTo <= 0) continue;
        if (a.men && cur.length === 0) {
          const free = o.blk.filter(b => !used.has(b.id) && o.can(b, a)).slice(0, 7);
          for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
            const pair = [free[i], free[j]];
            const r = fight(a, pair);
            const red = curTo - r.toPlayer;
            if (red <= 0) continue;
            const loss = (r.dead.has(pair[0].id) ? pair[0].val : 0) + (r.dead.has(pair[1].id) ? pair[1].val : 0);
            const k = red * 100 - loss + (r.aDies ? a.val : 0);
            if (k > bestK) { bestK = k; bestPair = [a, pair]; }
          }
          continue;
        }
        for (const b of o.blk) {
          if (used.has(b.id) || !o.can(b, a)) continue;
          const r = fight(a, cur.concat([b]));
          const red = curTo - r.toPlayer;
          if (red <= 0) continue;
          const k = red * 100 - (r.dead.has(b.id) ? b.val : 0) + (r.aDies ? a.val : 0);
          if (k > bestK) { bestK = k; bestPair = [a, [b]]; }
        }
      }
      if (!bestPair) break;
      const [a, bsAdd] = bestPair;
      blocks.set(a.id, (blocks.get(a.id) || []).concat(bsAdd));
      for (const b of bsAdd) used.add(b.id);
      if (pumpUse && pumpUse.attacker === a.id) pumpUse = null;
    }
    // Clean-slate Survival-First Reclaim Solver: if still taking lethal damage (e.g. a greedy single block
    // starved a lethal Menace attacker like Darth Vader of a 2nd blocker!), rebuild from scratch prioritizing survival!
    if (incoming() >= o.life && o.blk.length > 0) {
      const sBlocks = new Map();
      const sUsed = new Set();
      const sIncoming = () => sum(atk, a => sBlocks.has(a.id) ? fight(a, sBlocks.get(a.id)).toPlayer : epow(a)) + (o.drain || 0);
      const sGain = () => sum(atk, a => sBlocks.has(a.id) ? fight(a, sBlocks.get(a.id)).gainB : 0);
      for (let g2 = 0; g2 < 20; g2++) {
        if (sIncoming() < o.life + sGain()) break;
        let bestPick = null, bestScore = -Infinity;
        for (const a of atk) {
          const cur = sBlocks.get(a.id) || [];
          if (a.m1 && cur.length) continue;
          const curR = cur.length ? fight(a, cur) : { toPlayer: epow(a), gainB: 0 };
          if (curR.toPlayer <= 0) continue;
          if (a.men && cur.length === 0) {
            const free = o.blk.filter(b => !sUsed.has(b.id) && o.can(b, a)).sort((x, y) => x.val - y.val).slice(0, 8);
            for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
              const pair = [free[i], free[j]];
              const r = fight(a, pair);
              const saved = (curR.toPlayer - r.toPlayer) + (r.gainB - curR.gainB);
              if (saved <= 0) continue;
              const loss = (r.dead.has(pair[0].id) ? pair[0].val : 0) + (r.dead.has(pair[1].id) ? pair[1].val : 0);
              const sc = saved * 120 - loss + (r.aDies ? a.val : 0);
              if (sc > bestScore) { bestScore = sc; bestPick = [a, pair]; }
            }
            continue;
          }
          for (const b of o.blk) {
            if (sUsed.has(b.id) || !o.can(b, a)) continue;
            const r = fight(a, cur.concat([b]));
            const saved = (curR.toPlayer - r.toPlayer) + (r.gainB - curR.gainB);
            if (saved <= 0) continue;
            const sc = saved * 120 - (r.dead.has(b.id) ? b.val : 0) + (r.aDies ? a.val : 0);
            if (sc > bestScore) { bestScore = sc; bestPick = [a, [b]]; }
          }
        }
        if (!bestPick) break;
        const [a, bsAdd] = bestPick;
        sBlocks.set(a.id, (sBlocks.get(a.id) || []).concat(bsAdd));
        for (const b of bsAdd) sUsed.add(b.id);
      }
      if (sIncoming() < o.life + sGain() || sIncoming() < incoming()) {
        blocks.clear(); used.clear();
        for (const [k, v] of sBlocks) { blocks.set(k, v); for (const b of v) used.add(b.id); }
        pumpUse = null;
      }
    }
    if (o.must && o.must.size) satisfyMust(blocks, used, atk, o.blk, o.can, o.must);
    blocks.pumpUse = pumpUse;
    return blocks;
  }

  /** Value (for the defender) of a complete block assignment. Surviving lethal ALWAYS dominates dying. */
  function blockOutcome(atk, blocks, life, drain) {
    let v = 0, dmg = drain || 0, gainD = 0, gainA = 0;
    for (const a of atk) {
      if (a.removed) continue;
      const bs = blocks.get(a.id) || [];
      const r = fight(a, bs);
      dmg += r.toPlayer; gainD += r.gainB; gainA += r.gainA;
      if (r.aDies) v += a.val;
      for (const b of bs) if (r.dead.has(b.id)) v -= b.val;
    }
    if (dmg >= life + gainD) {
      // Playing to outs: dying on board is catastrophically worse than chump-blocking to survive another turn!
      v -= 10000 + dmg * 10;
    } else {
      v -= lifeCost(life + gainD, dmg) - (gainD > 0 ? lifeGainV(life, gainD) : 0);
    }
    return { v, dmg, gainA };
  }
  /** Exhaustive block search (hard level) seeded with the greedy plan; falls back to greedy when too large. */
  function exactBlocks(o, greedy) {
    const atk = o.atk.filter(a => !a.removed);
    const blk = o.blk;
    const opts = blk.map(b => [null].concat(atk.filter(a => o.can(b, a)).map(a => a.id)));
    let combos = 1;
    for (const x of opts) { combos *= x.length; if (combos > 6000) return greedy; }
    const best = { v: blockOutcome(atk, greedy, o.life, o.drain).v, map: greedy };
    const cur = new Array(blk.length).fill(null);
    const rec = (i) => {
      if (i === blk.length) {
        const m = new Map();
        for (let j = 0; j < blk.length; j++) if (cur[j] !== null) { if (!m.has(cur[j])) m.set(cur[j], []); m.get(cur[j]).push(blk[j]); }
        for (const a of atk) {
          const len = (m.get(a.id) || []).length;
          if (a.m1 && len > 1) return;
          if (a.men && len === 1) return;
        }
        if (o.must && o.must.size) for (const a of atk) if (o.must.has(a.id) && !(m.get(a.id) || []).length && blk.some(b => o.can(b, a))) return;
        const r = blockOutcome(atk, m, o.life, o.drain);
        if (r.v > best.v + 0.05) { best.v = r.v; best.map = m; }
        return;
      }
      for (const x of opts[i]) { cur[i] = x; rec(i + 1); }
    };
    rec(0);
    best.map.pumpUse = greedy.pumpUse && best.map === greedy ? greedy.pumpUse : null;
    return best.map;
  }

  function satisfyMust(blocks, used, atk, blk, can, must) {
    const scoreB = (a, b) => { const r = fight(a, [b]); return (r.aDies ? a.val : 0) - (r.dead.has(b.id) ? b.val : 0); };
    for (const a of atk) {
      if (!must.has(a.id) || (blocks.get(a.id) || []).length) continue;
      const able = blk.filter(b => can(b, a));
      if (!able.length) continue;
      const free = able.filter(b => !used.has(b.id));
      let pick = null;
      if (free.length) pick = free.sort((x, y) => scoreB(a, y) - scoreB(a, x))[0];
      else {
        let bestD = null, bestS = -Infinity;
        for (const b of able) {
          for (const [aid, bs] of blocks) {
            if (!bs.includes(b)) continue;
            if (must.has(aid) && bs.length < 2) continue;
            const s = scoreB(a, b) - (bs.length < 2 ? 1 : 0);
            if (s > bestS) { bestS = s; bestD = { b, aid }; }
          }
        }
        if (!bestD) continue;
        const rest = blocks.get(bestD.aid).filter(x => x !== bestD.b);
        if (rest.length) blocks.set(bestD.aid, rest); else blocks.delete(bestD.aid);
        pick = bestD.b;
      }
      blocks.set(a.id, [pick]);
      used.add(pick.id);
    }
  }

  function canBlockLoose(g, b, a) {
    try {
      if (!a) return !g.has(b, 'cantBlock');
      if (!g.isCreature(b) || g.has(b, 'cantBlock')) return false;
      if (g.has(a, 'unblockable')) return false;
      if (g.has(b, 'canBlockOnlyFlying') && !g.has(a, 'flying')) return false;
      if (g.has(a, 'flying') && !g.has(b, 'flying') && !g.has(b, 'reach')) return false;
      if (g.has(a, 'fear') && !(g.isArtifact(b) || g.isColor(b, 'B'))) return false;
      if (protFrom(g, a, b)) return false;
      for (const lw of landwalks(g, a)) if (controlsLandType(g, ctl(g, b), LW_LAND[lw])) return false;
      if (a.def.blockRestriction && !a.def.blockRestriction(g, a, b)) return false;
      for (const { src, st } of g._statics()) if (st.canBlock && !st.canBlock(g, src, a, b)) return false;
      return true;
    } catch (e) { return true; }
  }

  /** Estimated damage the attackers can push through the blockers next turn (Menace & Trample aware). */
  function crackback(g, attackers, blockers) {
    const avail = blockers.slice();
    let dmg = 0;
    const at = attackers.slice().sort((x, y) => epow(y) - epow(x));
    for (const a of at) {
      if (a.pow <= 0) continue;
      if (a.uAlone && at.length === 1) { dmg += epow(a); continue; }
      const able = [];
      for (let i = 0; i < avail.length; i++) {
        if (canBlockLoose(g, avail[i].c, a.c)) able.push({ i, u: avail[i] });
      }
      able.sort((x, y) => x.u.val - y.u.val);
      if (a.men) {
        if (able.length >= 2) {
          const b1 = able[0], b2 = able[1];
          if (a.tr) {
            const abs = Math.max(0, b1.u.tough - b1.u.dmg) + Math.max(0, b2.u.tough - b2.u.dmg);
            dmg += Math.max(0, epow(a) - abs);
          }
          // remove highest index first
          const hi = Math.max(b1.i, b2.i), lo = Math.min(b1.i, b2.i);
          avail.splice(hi, 1); avail.splice(lo, 1);
        } else {
          dmg += epow(a);
        }
      } else if (able.length >= 1) {
        const b1 = able[0];
        if (a.tr) dmg += Math.max(0, epow(a) - Math.max(0, b1.u.tough - b1.u.dmg));
        avail.splice(b1.i, 1);
      } else {
        dmg += epow(a);
      }
    }
    return dmg;
  }

  function canAttackHyp(g, c, mod) {
    if (!g.isCreature(c) || (c.tapped && !(mod && mod.untap)) || g.has(c, 'cantAttack') || g.has(c, 'defender')) return false;
    if (c.def.attackRestriction && !safeBool(() => c.def.attackRestriction(g, c))) return false;
    if (mod && mod.haste) return true;
    return !g.isSick(c);
  }

  /** Attack-related permanents of player p. */
  function attackEnv(g, p) {
    const env = { armory: 0, arts: 0, sacArts: [], gyRegrow: false, myLife: g.players[p].life };
    for (const c of mineOf(g, p)) {
      if (c.name === 'Grove Armory') env.armory++;
      if (g.isArtifact(c)) { env.arts++; if (!g.isCreature(c) || c.token) env.sacArts.push(c); }
    }
    env.gyRegrow = gyOf(g, p).some(c => g.isCreatureCard(c) && c.def.manaValue <= 2);
    return env;
  }
  /** Value of a creature connecting with the defending player (combat-damage triggers). */
  function hitValue(g, u, env) {
    if (!u.c) return 0;
    const K = kb(u.c.name);
    let v = K.hit || 0;
    for (const id of g.battlefield) {
      const e = g.card(id);
      if (e.attachedTo !== u.id) continue;
      if (e.name === 'Lesson of the Open Vein') v += 1.5;
      const ti = textInfo(e.def);
      if (ti.eq && ti.eq.hitForce) v += 0.6;
    }
    return v;
  }
  const ATK_NAMES = new Set(Object.keys(KB).filter(n => KB[n].atk || KB[n].eqAtk));

  /** Search the best attack. opts: {mods, candidates(ids), noBlock:Set, tapAll, extraMine, stolen:Set, level, must:Set, exclude:Set,
   *  forced:Set (must be in the attack), maxAttackers, perAttackerCost, oppOpen, budgetMs} */
  function attackSearch(g, p, opts) {
    opts = opts || {};
    const q = 1 - p;
    const mods = opts.mods || new Map();
    const stolen = opts.stolen || new Set();
    const forced = opts.forced || new Set();
    const env = attackEnv(g, p);
    const myAll = creaturesOf(g, p).filter(c => !stolen.has(c.id)).concat(opts.extraMine || []);
    let candCards;
    if (opts.candidates) candCards = opts.candidates.map(id => g.card(id)).filter(Boolean);
    else candCards = myAll.filter(c => canAttackHyp(g, c, mods.get(c.id)));
    if (opts.exclude) candCards = candCards.filter(c => !opts.exclude.has(c.id) || forced.has(c.id));
    const cand = candCards.map(c => unit(g, c, mods.get(c.id), true))
      .filter(u => forced.has(u.id) || u.pow > 0 || (mods.get(u.id) && mods.get(u.id).p) || ATK_NAMES.has(u.c.name));
    const maxA = opts.maxAttackers !== undefined ? Math.max(0, opts.maxAttackers) : Infinity;
    const perCost = opts.perAttackerCost || 0;
    const oppLife = g.players[q].life, myLife = g.players[p].life;
    const oppCre = creaturesOf(g, q).filter(c => !stolen.has(c.id));
    const blk0 = oppCre.filter(c => !c.tapped && !opts.tapAll && !(opts.noBlock && opts.noBlock.has(c.id)) && !g.has(c, 'cantBlock'))
      .map(c => unit(g, c, opts.oppMods && opts.oppMods.get(c.id), true)).filter(u => u.tough - u.dmg > 0 || u.regen);
    const can = (b, a) => {
      const m = mods.get(a.id);
      if (m && m.unblockable) return false;
      if (!a.c) return !g.has(b.c, 'cantBlock');
      if (a.prot && a.prot.length && b.cols.some(k => a.prot.includes(k))) return false;
      if (g.has(b.c, 'canBlockOnlyFlying') && !a.flying && !g.has(a.c, 'flying')) return false;
      if (a.flying && !(b.flying || g.has(b.c, 'reach')) && !g.has(a.c, 'flying')) return false;
      if (m && m.fear && !(g.isArtifact(b.c) || g.isColor(b.c, 'B'))) return false;
      try { return g.canBlock(b.c, a.c); } catch (e) { return false; }
    };
    const theirNext = opts.tapAll ? [] : oppCre.concat(creaturesOf(g, q).filter(c => stolen.has(c.id)))
      .filter(c => !g.has(c, 'cantAttack') && !g.has(c, 'defender') && !(c.tapped && (g.has(c, 'doesntUntap') || c.skipNextUntap)))
      .map(c => unit(g, c));
    const myUntapped = myAll.filter(c => (!c.tapped || (mods.get(c.id) && mods.get(c.id).untap)) && !stolen.has(c.id) && !g.has(c, 'cantBlock'));
    const myUntappedU = myUntapped.map(c => unit(g, c));
    const cbNone = crackback(g, theirNext, myUntappedU);
    const cbNoneCost = lifeCost(myLife, cbNone);
    const oppOpen = opts.oppOpen !== undefined ? opts.oppOpen : 0;
    const oppHand = g.players[q].hand.length;
    const riskW = (opts.level === 'easy') ? 0 : (oppOpen >= 1 && oppHand >= 1 ? Math.min(1, oppOpen / 2) : 0);
    const hard = opts.level === 'hard';
    // Dead-on-board detection: even holding back every single blocker leaves opponent with lethal crackback!
    const deadOnBoard = hard && myLife > 0 && cbNone >= myLife && theirNext.length > 0;
    const modes = hard && TUNE.hardAggr ? ['normal', 'aggr'] : ['normal'];
    let faceW = hard ? TUNE.hardFaceW : TUNE.faceW, crackW = hard ? TUNE.hardCrackW : TUNE.crackW;
    if (hard && TUNE.hardRace) {
      const myPow = sum(myAll.filter(c => !g.has(c, 'defender') && !g.has(c, 'cantAttack')), c => Math.max(0, g.power(c) || 0) * (g.has(c, 'doubleStrike') ? 2 : 1));
      const thPow = sum(theirNext, u => epow(u));
      const myClock = Math.ceil(oppLife / Math.max(1, myPow)), thClock = Math.ceil(myLife / Math.max(1, thPow));
      if (myClock < thClock) { faceW *= TUNE.raceAhead; crackW *= 0.7; }
      else if (myClock > thClock + 1) { faceW *= TUNE.raceBehind; crackW *= 1.3; }
    }
    if (deadOnBoard) {
      // Desperation / long-shot mode: never sit back and die passively when holding blockers still loses!
      faceW *= 2.3;
    }
    const attuned = forceSpent(g, p);

    /** Apply set-dependent bonuses (attack triggers, equipped triggers). */
    function buildSet(S0) {
      let S = S0, blk = blk0, drain = 0, extra = 0;
      const needCopy = env.armory || S0.some(u => u.c && ATK_NAMES.has(u.c.name));
      if (!needCopy) return { S, blk, drain, extra };
      S = S0.map(u => Object.assign({}, u));
      const bestOther = (u, f) => S.filter(x => x.id !== u.id && x.c && (!f || f(x))).sort((x, y) => (y.val + epow(y)) - (x.val + epow(x)))[0];
      let sacUsed = 0;
      const canSac = () => env.sacArts.length > sacUsed;
      const added = [];
      const freeEq = bf(g).some(x => ctl(g, x) === p && g.isEquipment(x));
      const hasFodder = myAll.some(x => x.token || cval(g, x) <= 3.5);
      for (const u of S) {
        if (!u.c) continue;
        const K = kb(u.c.name);
        if (K.atk === 'otherPump') { const o = bestOther(u); if (o) { o.pow += K.p || 2; o.tough += K.t || 2; } }
        else if (K.atk === 'otherLifelink') { const o = bestOther(u); if (o) o.ll = true; }
        else if (K.atk === 'battalion' && attuned) { for (const x of S) if (x.c && x.c.token) x.pow += 1; }
        else if (K.atk === 'vaderSac' && hasFodder && S.length >= 1) { u.pow += 2; u.ind = true; extra -= 1.2; }
        else if (K.atk === 'maceDT' && myLife > 3 && canAfford(g, p, U.parseCost('{B}'))) { u.dt = true; extra -= 0.4; }
        else if (K.atk === 'grievous' && freeEq) { u.ds = true; u.tr = true; }
        else if (K.atk === 'ryloPing' && attuned && blk.length) {
          const killable = blk.filter(b => b.tough - b.dmg <= 1 && !b.regen && !b.ind).sort((x, y) => y.val - x.val);
          const tgt = killable[0] || blk.slice().sort((x, y) => y.val - x.val)[0];
          if (tgt) { if (killable[0]) extra += tgt.val; blk = blk.map(b => b === tgt ? Object.assign({}, b, { dmg: b.dmg + 1 }) : b).filter(b => b.tough - b.dmg > 0 || b.regen || b.ind); }
        }
        else if (K.atk === 'sebulba' && canSac() && blk.length) {
          const killable = blk.filter(b => b.tough - b.dmg <= 3 && !b.regen && !b.ind).sort((x, y) => y.val - x.val);
          if (killable[0] && killable[0].val >= 3) {
            sacUsed++; extra += killable[0].val - 1.5;
            blk = blk.filter(b => b !== killable[0]);
          }
        }
        else if (K.atk === 'jango' && blk.length) {
          const killable = blk.filter(b => b.tough - b.dmg <= 2 && !b.regen && !b.ind).sort((x, y) => y.val - x.val);
          const tgt = killable[0] || blk.slice().sort((x, y) => y.val - x.val)[0];
          if (tgt) { if (killable[0]) extra += tgt.val; blk = blk.map(b => b === tgt ? Object.assign({}, b, { dmg: b.dmg + 2 }) : b).filter(b => b.tough - b.dmg > 0 || b.regen || b.ind); }
        }
      }
      // Signal from the Underlevels: unblockable if attacking alone
      if (S.length === 1 && S[0].uAlone) {
        return { S: S.concat(added), blk: [], drain, extra };
      }
      // 501st Legion transform incentive when attacking with 3+ creatures
      if (S.length >= 3 && S.some(u => u.c && u.c.name === '501st Legion' && !u.c.transformed)) extra += 1.8;
      // By the Rule of Two incentive when attacking with exactly 2 creatures
      if (S.length === 2 && mineOf(g, p).some(c => c.name === 'By the Rule of Two')) extra += 1.6;
      return { S: S.concat(added), blk, drain, extra };
    }

    function evalSet(S0) {
      if (!S0.length) return { score: 0, dmg: 0 };
      const { S, blk, drain, extra } = buildSet(S0);
      const must = new Set(S.filter(u => (u.c && safeBool(() => g.has(u.c, 'mustBeBlocked'))) || (opts.must && opts.must.has(u.id))).map(u => u.id));
      let worst = Infinity, worstDmg = 0, total = 0;
      for (const mode of modes) {
        const blocks = planBlocks({ atk: S, blk, can, life: oppLife, risk: 0, mode, must, drain });
        let dmg = drain, myLoss = 0, theirLoss = 0, riskPen = 0, hits = 0, gain = 0;
        const deadMine = new Set(), deadTheirs = new Set();
        for (const a of S) {
          if (a.tough - a.dmg <= 0 && !a.regen) { myLoss += a.val; deadMine.add(a.id); continue; }
          const bs = blocks.get(a.id) || [];
          const r = fight(a, bs);
          dmg += r.toPlayer; gain += r.gainA;
          if (r.toPlayer > 0) hits += hitValue(g, a, env);
          if (r.aDies) { myLoss += a.val; deadMine.add(a.id); }
          for (const b of bs) if (r.dead.has(b.id)) { theirLoss += b.val; deadTheirs.add(b.id); }
          if (bs.length) riskPen += a.val * 0.15;
        }
        let score;
        if (dmg >= oppLife) score = 1000 + dmg - myLoss * 0.01;
        else {
          const lossW = deadOnBoard ? 0.35 : 1.0;
          const rW = deadOnBoard ? 0.1 : (hard ? TUNE.hardRiskW : TUNE.riskW);
          score = theirLoss * (deadOnBoard ? 1.5 : 1.0) - myLoss * lossW + lifeCost(oppLife, dmg) * faceW + hits + extra + lifeGainV(myLife, gain) - riskW * riskPen * rW;
          if (opts.level !== 'easy') {
            const Sids = new Set(S.map(u => u.id));
            const vigIds = new Set(S.filter(u => u.vig).map(u => u.id));
            const myBlk = myUntappedU.filter(u => !deadMine.has(u.id) && (!Sids.has(u.id) || vigIds.has(u.id)));
            const their = theirNext.filter(u => !deadTheirs.has(u.id));
            const cb = crackback(g, their, myBlk);
            score -= (lifeCost(myLife + gain, cb) - cbNoneCost) * crackW;
            // If dead-on-board and this attack forces blocks/kills that save us from lethal crackback, huge bonus!
            if (deadOnBoard && cb < myLife + gain) score += 28;
            // Hard mode: avoid needless attacks that TURN a safe board into lethal crackback for the opponent!
            if (hard && !deadOnBoard && cbNone < myLife && cb >= myLife + gain) score -= 24;
          }
        }
        score -= perCost * S0.length;
        if (score < worst) { worst = score; worstDmg = dmg; }
        total += score;
      }
      if (TUNE.hardMix === 'avg' && modes.length > 1) return { score: total / modes.length, dmg: worstDmg };
      return { score: worst, dmg: worstDmg };
    }

    const forcedU = cand.filter(u => forced.has(u.id));
    const free = cand.filter(u => !forced.has(u.id));
    const maxEnum = opts.level === 'easy' ? 4 : 7;
    const deadline = Math.min(Date.now() + (opts.budgetMs || 90), DECISION_DEADLINE);
    let best = forcedU.length ? { score: evalSet(forcedU).score, set: forcedU.slice() } : { score: 0, set: [] };
    if (forcedU.length > maxA) return { score: best.score, ids: best.set.map(u => u.id), env };
    if (free.length <= maxEnum) {
      const n = free.length;
      for (let mask = 1; mask < (1 << n); mask++) {
        if ((mask & 15) === 0 && Date.now() > deadline) break;
        const S = forcedU.slice();
        for (let i = 0; i < n; i++) if (mask & (1 << i)) S.push(free[i]);
        if (S.length > maxA) continue;
        const e = evalSet(S);
        if (e.score > best.score + 1e-9 || (Math.abs(e.score - best.score) < 1e-9 && S.length > best.set.length && e.score > 0)) best = { score: e.score, set: S };
      }
    } else {
      const trim = (list) => {
        if (list.length <= maxA) return list;
        const f = list.filter(u => forced.has(u.id)), o = list.filter(u => !forced.has(u.id)).sort((x, y) => (epow(y) + y.val * 0.2) - (epow(x) + x.val * 0.2));
        return f.concat(o).slice(0, maxA);
      };
      const startAll = evalSet(trim(cand));
      let cur = startAll.score > 0 ? trim(cand) : trim(forcedU.concat(free.filter(a => evalSet(forcedU.concat([a])).score > 0)));
      let curS = evalSet(cur).score;
      if (startAll.score > curS) { cur = trim(cand); curS = startAll.score; }
      // Also test wide evasive / top-N power swarms so wide armies never stall out
      const byPow = free.slice().sort((x, y) => (epow(y) + (y.flying || y.men ? 3 : 0)) - (epow(x) + (x.flying || x.men ? 3 : 0)));
      for (const k of [Math.ceil(free.length * 0.5), Math.ceil(free.length * 0.75), free.length]) {
        const trial = trim(forcedU.concat(byPow.slice(0, k)));
        const ts = evalSet(trial).score;
        if (ts > curS) { cur = trial; curS = ts; }
      }
      for (let pass = 0; pass < 3; pass++) {
        let improved = false;
        for (const a of free) {
          if (Date.now() > deadline) break;
          const has = cur.includes(a);
          const trial = has ? cur.filter(x => x !== a) : cur.concat([a]);
          if (trial.length > maxA) continue;
          const s = evalSet(trial).score;
          if (s > curS + 0.01) { cur = trial; curS = s; improved = true; }
        }
        if (!improved) break;
      }
      if (curS > best.score) best = { score: curS, set: cur };
      for (const a of free) {
        if (Date.now() > deadline) break;
        const S = forcedU.concat([a]);
        if (S.length > maxA) continue;
        const s = evalSet(S).score;
        if (s > best.score + 0.01) best = { score: s, set: S };
      }
    }
    return { score: best.score, ids: best.set.map(u => u.id), env };
  }

  /** Opponent untapped mana count (public info). */
  function openMana(g, p) { return availMana(g, p); }

  /** Evaluate current combat (during blockers/damage steps) from p's view, with optional mods. */
  function combatValue(g, p, mods, fog) {
    const cb = g.combat;
    const out = { value: 0, dying: new Set(), dmgToDef: 0 };
    if (!cb) return out;
    const defP = cb.defender;
    let dmg = 0, gainAtk = 0, gainDef = 0;
    const fsDone = g.step === 'combatDamage';
    for (const at of cb.attackers) {
      const ac = g.card(at.id);
      if (!ac || ac.zone !== 'battlefield') continue;
      const a = unit(g, ac, mods.get(ac.id));
      if (a.removed) continue;
      // flanking was already applied when blockers were declared
      a.flank = false;
      if (fsDone && cb.firstStrikeDealt && cb.firstStrikeDealt.has(a.id) && !a.ds) a.pow = 0;
      const bs = at.blockers.map(id => g.card(id)).filter(b => b && b.zone === 'battlefield').map(b => unit(g, b, mods.get(b.id))).filter(u => !u.removed);
      let r;
      if (fog) r = { aDies: false, dead: new Set(), toPlayer: 0, gainA: 0, gainB: 0 };
      else if (!at.blocked) { const tp = fsDone ? Math.max(0, a.pow) : epow(a); r = { aDies: a.tough - a.dmg <= 0, dead: new Set(), toPlayer: tp, gainA: a.ll ? tp : 0, gainB: 0 }; }
      else if (!bs.length) { const tp = a.tr ? (fsDone ? Math.max(0, a.pow) : epow(a)) : 0; r = { aDies: false, dead: new Set(), toPlayer: tp, gainA: a.ll ? tp : 0, gainB: 0 }; }
      else r = fight(a, bs);
      const sign = ctl(g, ac) === p ? 1 : -1;
      if (r.aDies) { out.value -= sign * a.val; out.dying.add(a.id); }
      for (const b of bs) if (r.dead.has(b.id)) { out.value += sign * b.val; out.dying.add(b.id); }
      dmg += r.toPlayer; gainAtk += r.gainA; gainDef += r.gainB;
    }
    out.dmgToDef = dmg;
    const atkP = 1 - defP;
    const lc = lifeCost(g.players[defP].life + gainDef, dmg);
    out.value += defP === p ? -lc : lc;
    const gv = lifeGainV(g.players[atkP].life, gainAtk) - lifeGainV(g.players[defP].life, gainDef);
    out.value += atkP === p ? gv : -gv;
    return out;
  }

  // ===========================================================================
  // Hand evaluation
  // ===========================================================================
  function handValue(g, p, c, handCards) {
    handCards = handCards || handOf(g, p);
    const def = c.def;
    const myLands = landsOf(g, p).length;
    if (isLandDef(def)) {
      const otherLands = handCards.filter(x => x !== c && isLandDef(x.def)).length;
      const total = myLands + otherLands;
      const spells = handCards.filter(x => !isLandDef(x.def));
      const maxMV = spells.length ? Math.max(...spells.map(x => x.def.manaValue)) : 0;
      let v;
      if (total >= 6 || (total >= 4 && total >= maxMV + 1)) v = 1.2;
      else if (total >= 4) v = 3.5;
      else if (total >= 3) v = 6;
      else v = 9;
      const have = colorSourceCounts(g, p);
      for (const col of producedColors(def)) if (!have[col] && spells.some(x => colorDemand(x.def.cost)[col] > 0)) v += 2.5;
      return v;
    }
    let v = isCreatureDef(def) ? sval(def) * 0.6 : ncVal(def) * 0.8;
    const have = colorSourceCounts(g, p);
    const cols = new Set(COLORS.filter(k => have[k] > 0));
    for (const x of handCards) if (isLandDef(x.def)) for (const col of producedColors(x.def)) cols.add(col);
    if (!colorOK(def, cols)) v *= 0.55;
    if (def.manaValue > myLands + 2) v *= 0.8;
    if (!def.implemented && !isCreatureDef(def) && !def.types.includes('Enchantment') && !def.types.includes('Artifact')) v *= 0.3;
    v *= situational(g, p, c);
    return v;
  }

  /** Multiplier for cards that currently have nothing useful to do. */
  function situational(g, p, c) {
    try {
      const def = c.def;
      const k = spellKind(def);
      const q = 1 - p;
      if (k === 'recursion' || k === 'reanimate') return gyOf(g, p).some(x => g.isCreatureCard(x)) ? 1 : 0.5;
      if (k === 'permHarm') return bf(g).some(x => ctl(g, x) === q && (g.isArtifact(x) || g.isEnchantment(x))) ? 1 : 0.35;
      if (k === 'equipment') return creaturesOf(g, p).length ? 1 : 0.7;
      if (['destroy', 'burn', 'shrink', 'auraDebuff', 'auraShrink', 'edict', 'fight'].includes(k)) return creaturesOf(g, q).length ? 1 : 0.45;
      if (k === 'counter') return 0.9;
      return 1;
    } catch (e) { return 1; }
  }

  function chooseWorst(g, p, cards, n, bonus) {
    const pool = cards.slice();
    const out = [];
    for (let i = 0; i < n && pool.length; i++) {
      const hand = handOf(g, p).filter(x => !out.includes(x));
      let wi = 0, wv = Infinity;
      pool.forEach((c, j) => { const v = handValue(g, p, c, hand) - (bonus ? bonus(c) : 0); if (v < wv) { wv = v; wi = j; } });
      out.push(pool[wi]);
      pool.splice(wi, 1);
    }
    return out;
  }

  /** Colour-need score of a land (for land drops, searches and lands put into play). */
  function landScore(g, p, def, handCards, have) {
    have = have || colorSourceCounts(g, p);
    const spells = (handCards || handOf(g, p)).filter(c => !isLandDef(c.def));
    const need = { W: 0, U: 0, B: 0, R: 0, G: 0 }, cnt = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const c of spells) { const d = colorDemand(c.def.cost); for (const col of COLORS) if (d[col]) { need[col] = Math.max(need[col], d[col]); cnt[col]++; } }
    let s = 0;
    for (const col of producedColors(def)) {
      if (!cnt[col]) { s += 0.15; continue; }
      s += (have[col] < need[col] ? 6 : 1) * Math.sqrt(cnt[col]);
    }
    return s;
  }

  // ===========================================================================
  // Spell evaluation (main phase)
  // ===========================================================================
  function planSpellTargets(g, p, card, eff, exclude) {
    const def = card.def;
    const specs = spellSpecs(def);
    const item = spellItem(card, p);
    const tg = [];
    let first = 0, total = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      let legal = legalFor(g, p, spec, item);
      if (spec.distinctFrom !== undefined && item.targets[spec.distinctFrom]) legal = legal.filter(r => !item.targets[spec.distinctFrom].some(x => refKey(x) === refKey(r)));
      const min = spec.min !== undefined ? spec.min : 1;
      const max = spec.max !== undefined ? spec.max : 1;
      const groupFn = spec.group ? (refs) => spec.group(g, refs.map(r => refObj(g, r)), p, item) : null;
      let e = Array.isArray(eff) ? eff[i] || eff[0] : eff;
      if (exclude && exclude.size) e = Object.assign({}, e, { exclude });
      const sel = selectRefs(g, legal, r => scoreRef(g, p, r, e), min, Math.min(max, legal.length), groupFn);
      if (!sel) return null;
      const sc = sum(sel, r => scoreRef(g, p, r, e));
      if (i === 0) first = sel.length ? scoreRef(g, p, sel[0], e) : 0;
      total += sc;
      tg.push(sel.map(refKey));
      item.targets.push(sel);
    }
    return { tg, first, total };
  }

  function tokenValue(g, p, name, n) {
    const base = { 'Human Soldier': 2.4, 'Jedi': 4, 'Human Jedi': 2.4, 'Human Jedi (2/2)': 4, 'Insect': 2.6, 'Plant': 1.8, 'Beast': 4, 'Mandalorian Warrior': 2.4,
      'Warrior': 1.6, 'Droid': 2.6, 'Droid (3/3)': 6 };
    let v = base[name] !== undefined ? base[name] : 2.4;
    if (named(g, p, 'Sanctuary Interpreter').length) v += 0.6;
    return v * n;
  }

  /** Cheapest permanent to sacrifice for an additional / activation cost (null = nothing acceptable). */
  function sacPlan(g, p, cands, avoidId) {
    const list = cands.filter(c => c.id !== avoidId);
    if (!list.length) return null;
    const v = (c) => {
      let x = permVal(g, c);
      if (c.token) x -= 0.8;
      const K = kb(c.name);
      if (K.dv) x -= K.dv;
      const ti = textInfo(c.def);
      if (ti.diesForce) x -= forceGainValue(g, p, ti.diesForce);
      if (g.isLand(c)) x += 4;
      if (g.combat && g.isCreature(c) && safeNum(() => combatValue(g, p, new Map(), false).dying.has(c.id) ? 1 : 0)) x *= 0.2;
      return x;
    };
    list.sort((a, b) => v(a) - v(b));
    return { card: list[0], cost: Math.max(0, v(list[0])) };
  }

  function etbValue(g, p, card, K, phase) {
    const q = 1 - p;
    const myCre = creaturesOf(g, p), oppCre = creaturesOf(g, q);
    const lib = g.players[p].library.length;
    let v = 0;
    const ti = textInfo(card.def);
    if (ti.etbForce) v += forceGainValue(g, p, ti.etbForce);
    switch (K.etb) {
      case 'life': v += lifeGainV(g.players[p].life, K.life || 2) + 0.2; break;
      case 'token': v += tokenValue(g, p, K.tok || 'Human Soldier', K.n || 1) + (K.life ? lifeGainV(g.players[p].life, K.life) : 0); break;
      case 'drain': v += lifeCost(g.players[q].life, K.n || 1) * 0.8 + lifeGainV(g.players[p].life, K.n || 1); break;
      case 'oppDiscard': v += Math.min(g.players[q].hand.length, K.n || 1) * 2; break;
      case 'loot': v += lib > 3 ? 0.9 : 0; break;
      case 'surveil': v += 0.3; break;
      case 'mill1': v += 0.3; break;
      case 'digArt': v += 1.2; break;
      case 'tap': v += phase === 'main1' && oppCre.some(c => !c.tapped) && myCre.some(c => canAttackHyp(g, c)) ? 1.2 : 0.3; break;
      case 'pumpOther': v += phase === 'main1' && myCre.some(c => canAttackHyp(g, c)) ? 0.8 : 0.1; break;
      case 'artKill': { const a = bf(g).filter(c => g.isArtifact(c) && ctl(g, c) !== p); v += a.length ? Math.max(...a.map(c => permVal(g, c))) : 0; break; }
      case 'forceArtKill': {
        const a = bf(g).filter(c => (g.isArtifact(c) || g.isEnchantment(c)) && ctl(g, c) !== p);
        const have = forceOf(g, p) + ti.etbForce;
        if (a.length && have >= 2) v += Math.max(0, Math.max(...a.map(c => permVal(g, c))) - 2 * forceUnit(g, p));
        break;
      }
      case 'retArt': { const a = gyOf(g, p).filter(c => g.isArtifact(c) && (card.name !== 'Ebon Hawk' || c.def.manaValue <= 2)); v += a.length ? Math.max(...a.map(c => sval(c.def))) * 0.5 + 0.5 : 0; break; }
      case 'reanimMV1': { const a = gyOf(g, p).filter(c => g.isCreatureCard(c) && c.def.manaValue === 1); v += a.length ? Math.max(...a.map(c => sval(c.def))) * 0.8 : 0; break; }
      case 'eqFromGy': { const a = gyOf(g, p).filter(c => c.def.subtypes.includes('Equipment') && c.def.manaValue <= 2); v += a.length ? 3 : 0; break; }
      case 'attachEq': v += artifactsOf(g, p).some(c => safeBool(() => g.isEquipment(c))) ? 1.5 : 0; break;
      case 'exileOpp': case 'exileArtCre': {
        const t = oppCre.filter(c => !untargetableBy(g, c, p) && (K.etb === 'exileOpp' || g.isArtifact(c)));
        v += t.length ? Math.max(...t.map(c => cval(g, c))) * 0.85 : 0;
        break;
      }
      case 'edictOpp': v += oppCre.length ? Math.min(...oppCre.map(c => cval(g, c))) : 0; break;
      case 'nihilus': {
        const theirs = oppCre.length ? Math.min(...oppCre.map(c => cval(g, c))) : 0;
        const mine = myCre.length ? Math.min(...myCre.map(c => cval(g, c) - (c.token ? 1 : 0))) : 0;
        v += theirs - mine + forceGainValue(g, p, (oppCre.length ? 1 : 0) + (myCre.length ? 1 : 0));
        break;
      }
      case 'hammerhead': {
        const t = oppCre.filter(c => !untargetableBy(g, c, p));
        v += t.length ? Math.max(...t.map(c => c.token ? cval(g, c) : cval(g, c) * 0.4 + c.def.manaValue * 0.3)) : 0;
        break;
      }
      case 'bounceOpp': {
        const t = mineOf(g, q).filter(c => (g.isCreature(c) || g.isArtifact(c)) && !untargetableBy(g, c, p));
        v += t.length ? Math.max(...t.map(c => c.token ? permVal(g, c) : permVal(g, c) * 0.4 + c.def.manaValue * 0.3)) : 0;
        break;
      }
      case 'gyExile': v += gyOf(g, q).some(c => g.isCreatureCard(c)) ? 0.8 : 0.1; break;
      case 'counters': v += Math.min(3, myCre.length) * 2 * 0.9; break;
      case 'landFromHand': v += handOf(g, p).some(c => isLandDef(c.def) && c.id !== card.id) ? 2 : 0; break;
      case 'landBack': v += gyOf(g, p).some(c => g.isLand(c)) ? 1.2 : 0; break;
      case 'prevent': v += 0.2; break;
      case 'sacArtRegrow': {
        const fod = artifactsOf(g, p).filter(c => c.token || !g.isCreature(c) || cval(g, c) < 4);
        const gy = gyOf(g, p).filter(c => g.isCreatureCard(c));
        if (fod.length && gy.length) v += Math.max(0, Math.max(...gy.map(c => sval(c.def))) * 0.5 - Math.min(...fod.map(c => permVal(g, c))) * 0.6);
        break;
      }
      case 'pressGang': {
        const fod = myCre.filter(c => c.token || cval(g, c) < 3.5);
        if (fod.length) v += Math.max(0, lifeCost(g.players[q].life, 2) + 1 - Math.min(...fod.map(c => cval(g, c))) * 0.8);
        break;
      }
      case 'reclaimWing': {
        const fod = mineOf(g, p).filter(c => (g.isCreature(c) || g.isArtifact(c)) && (c.token || permVal(g, c) < 3.5));
        if (fod.length) v += Math.max(0, 6.5 - Math.min(...fod.map(c => permVal(g, c))));
        break;
      }
      case 'reliefWing': v += Math.min(2, myCre.length) * 1.8 + (myCre.length >= 2 ? 2.2 : 0); break;
      case 'bounceOwnMay': {
        const others = myCre.filter(c => !c.token);
        v += others.length ? Math.max(0, Math.max(...others.map(c => etbReplayValue(g, p, c) - c.def.manaValue * 0.6))) : 0;
        break;
      }
      default: break;
    }
    return v;
  }
  /** Value of re-casting a creature's ETB when it is returned to hand / flickered. */
  function etbReplayValue(g, p, c) {
    if (c.token) return -5;
    const K = kb(c.name);
    const ti = textInfo(c.def);
    if (!K.etb && !ti.etbForce) return 0;
    if (K.etb === 'bounceOwnMay') return 0;
    try { return Math.max(0, etbValue(g, p, c, K, 'main2')); } catch (e) { return 0; }
  }

  /** Value of a team pump (attack with it this turn). */
  function teamPumpGain(g, p, K, level, extraMods) {
    const mods = new Map();
    for (const c of creaturesOf(g, p)) mods.set(c.id, Object.assign({ p: K.p || 0, t: K.t || 0, tr: !!K.tr, haste: !!K.haste, ds: !!K.ds }, extraMods || {}));
    const base = attackSearch(g, p, { level, budgetMs: 40 });
    const w = attackSearch(g, p, { mods, level, budgetMs: 40 });
    return { gain: w.score - base.score, lethal: w.score >= 1000, count: w.ids.length };
  }

  /** Best (mine, theirs) pair for a fight spell. */
  function fightPlan(g, p, card) {
    const specs = spellSpecs(card.def);
    if (specs.length < 2) return null;
    const item = spellItem(card, p);
    const mineR = legalFor(g, p, specs[0], item).filter(r => r.kind === 'card');
    const theirR = legalFor(g, p, specs[1], item).filter(r => r.kind === 'card' && ctl(g, g.card(r.id)) !== p);
    const bonus = kb(card.def.name).p || 0;
    let best = null;
    for (const m of mineR) {
      const a = g.card(m.id);
      const ap = (g.power(a) || 0) + bonus, at = remTough(g, a) + bonus;
      for (const t of theirR) {
        const b = g.card(t.id);
        const kills = (ap >= remTough(g, b) || (g.has(a, 'deathtouch') && ap > 0)) && !(b.regen > 0);
        const dies = (g.power(b) || 0) >= at || (g.has(b, 'deathtouch') && (g.power(b) || 0) > 0);
        const s = (kills ? cval(g, b) : 0) - (dies ? cval(g, a) : 0);
        if (!best || s > best.s) best = { s, tg: [[refKey(m)], [refKey(t)]] };
      }
    }
    return best;
  }

  /** Main-phase value of casting a card. Returns {score, tg, when, kind, sac?, discard?, mode?} or null. */
  function evalSpell(g, p, card, phase, ctx) {
    ctx = ctx || {};
    const def = card.def;
    const K = kb(def.name);
    const k = spellKind(def);
    const q = 1 - p;
    const res = { score: 0, tg: null, when: 'any', kind: k };
    const myCre = creaturesOf(g, p), oppCre = creaturesOf(g, q);
    const inst = isInstantDef(def) || def.keywords.includes('flash');
    const myLife = g.players[p].life, oppLife = g.players[q].life;
    const lifeV = (n) => lifeGainV(myLife, n);
    const ti = textInfo(def.__base || def);
    if (isCreatureDef(def)) {
      if (def.name === 'Palpatine, Supreme Chancellor') {
        if (bf(g).some(c => c.name === def.name)) return null;
        res.score = 6.5; res.when = 'main2'; return res;
      }
      if (def.supertypes.includes('Legendary') && bf(g).some(c => c.name === def.name && ctl(g, c) === p)) return null;
      let s = sval(def) * 0.9 + 1 + etbValue(g, p, card, K, phase) - ti.etbForce * 0.6;
      if (K.etb === 'bounceOwnMay' && !myCre.some(c => !c.token)) s -= 0.5;
      const haste = def.keywords.includes('haste');
      res.when = haste || K.etb === 'tap' || K.etb === 'pumpOther' ? 'main1' : (ctx.deferCreatures ? 'main2' : 'any');
      if (def.keywords.includes('flash') && !haste && ctx.level !== 'easy' && g.activePlayer === p) res.when = res.when === 'main1' ? 'main1' : 'main2';
      res.score = s;
      return res;
    }
    // additional costs
    const add = def.spell && def.spell.additionalCost;
    let addCost = 0;
    if (add && add.sacrifice) {
      let cands = [];
      try { cands = g._sacCandidates(p, add.sacrifice, card); } catch (e) { cands = []; }
      const sp = sacPlan(g, p, cands, card.id);
      if (!sp) return null;
      res.sac = [sp.card.id];
      addCost += sp.cost;
    }
    if (add && add.discard) {
      const hand = handOf(g, p).filter(c => c.id !== card.id && (!add.discard.filter || safeBool(() => add.discard.filter(g, c))));
      if (!hand.length) return null;
      const artBonus = def.name === 'Scour for Parts' ? (c) => (isArtifactDef(c.def) ? forceGainValue(g, p, 2) : 0) : null;
      const w = chooseWorst(g, p, hand, 1, artBonus)[0];
      res.discard = [w.id];
      addCost += Math.max(0.3, handValue(g, p, w, handOf(g, p)) - (artBonus ? artBonus(w) : 0));
    }
    const spellForce = ti.spellForce ? forceGainValue(g, p, ti.spellForce) : 0;
    const specs = spellSpecs(def);
    const eff = spellEff(g, p, def, { level: ctx.level });
    let pt = null;
    if (specs.length && !['fight', 'threaten2', 'threaten1', 'unlimitedPower'].includes(k)) {
      pt = planSpellTargets(g, p, card, eff, ctx.exclude);
      if (!pt) return null;
      res.tg = pt.tg;
    }
    const best = pt ? pt.first : 0;
    const drawV = K.draw ? 2.2 : 0;
    switch (k) {
      case 'burn': {
        if (K.combatOnly) { res.when = 'hold'; break; }
        if (best >= 1000) { res.score = 1000; res.when = 'any'; break; }
        res.score = best >= 3 ? best : (best > 1.2 ? best * 0.8 : 0);
        if (inst && best < 9) res.when = 'hold';
        break;
      }
      case 'destroy': {
        res.score = best >= 3.5 ? best : 0;
        if (K.combatOnly) { res.when = 'hold'; res.score = 0; break; }
        if (inst && best < 9) res.when = 'hold';
        break;
      }
      case 'shrink': res.score = best >= 3 ? best : 0; if (inst && best < 9) res.when = 'hold'; break;
      case 'edict': {
        if (!oppCre.length || !pt || !pt.tg[0].length || pt.tg[0][0] !== 'p' + q) break;
        const worst = Math.min(...oppCre.map(c => cval(g, c)));
        res.score = worst >= 3 ? worst : 0;
        break;
      }
      case 'fight': {
        const fp = fightPlan(g, p, card);
        if (fp && fp.s >= 3) { res.score = fp.s; res.tg = fp.tg; }
        break;
      }
      case 'bounce': res.when = 'hold'; break;
      case 'auraDebuff': res.score = best >= 3 ? best : 0; res.when = 'main1'; break;
      case 'auraShrink': res.score = best >= 2.5 ? best + 0.5 : 0; res.when = 'main1'; break;
      case 'stealArt': res.score = best >= 3 ? best : 0; break;
      case 'threaten2': {
        if (phase !== 'main1') break;
        const legal = legalFor(g, p, specs[0], spellItem(card, p)).filter(r => r.kind === 'card' && ctl(g, g.card(r.id)) === q && g.isCreature(g.card(r.id)));
        if (!legal.length) break;
        const base = attackSearch(g, p, { level: ctx.level, budgetMs: 30 });
        const ranked = legal.map(r => ({ r, c: g.card(r.id) })).sort((x, y) => cval(g, y.c) - cval(g, x.c)).slice(0, 4);
        const pick = [];
        for (const x of ranked) { if (pick.length >= 2) break; if (pick.length && pick[0].c.def.manaValue === x.c.def.manaValue) continue; pick.push(x); }
        const mods = new Map(pick.map(x => [x.c.id, { haste: true, untap: true }]));
        const w = attackSearch(g, p, { mods, stolen: new Set(pick.map(x => x.c.id)), extraMine: pick.map(x => x.c), level: ctx.level, budgetMs: 40 });
        const gain = w.score - base.score;
        if (gain >= 5) { res.score = gain >= 1000 ? 1000 : gain; res.tg = [pick.map(x => refKey(x.r))]; res.when = 'main1'; }
        break;
      }
      case 'auraBuff': {
        const ps = pumpStats(g, p, def);
        res.score = best > 0 ? 2.5 + ps.p * 0.8 + ps.t * 0.3 + (K.auraHit ? 1 : 0) : 0;
        res.when = 'main1';
        break;
      }
      case 'equipment': {
        const e = ti.eq || {};
        res.score = (myCre.length ? 2.4 : 1.4) + (e.p || 0) * 0.5 + (e.kw ? e.kw.length * 0.4 : 0);
        res.when = 'main1';
        break;
      }
      case 'pump': case 'protection': case 'counter': case 'tapOne': case 'tapTwo': case 'pumpRegen': case 'flicker': case 'teamTrick':
      case 'battleMed': case 'refit': case 'redirect': case 'burnAttackers': res.when = 'hold'; break;
      case 'massWeaken': case 'cantBlock2': res.when = 'hold'; break;
      case 'counters2': {
        // instant +1/+1 counters: fine at the end of the opponent's turn; in main 2 when we have nothing else
        res.when = 'hold';
        break;
      }
      case 'gyHate': res.when = 'hold'; if (!inst) res.score = best; break;
      case 'teamPump': {
        if (phase !== 'main1' || (!myCre.length && !K.tok)) break;
        const tp = teamPumpGain(g, p, K, ctx.level);
        const extra = (K.tok ? tokenValue(g, p, K.tok, K.n || 1) * 0.8 : 0) + (K.draw ? 2.2 : 0);
        res.score = tp.lethal ? 1000 : (tp.gain + extra >= 4 ? tp.gain + extra : 0);
        res.when = 'main1';
        break;
      }
      case 'wrath': {
        const d = sum(oppCre, c => cval(g, c)) - sum(myCre, c => cval(g, c));
        res.score = (d >= 6 && oppCre.length >= 2) || (d >= 4 && myLife <= 8) ? d : 0;
        res.when = 'main2';
        break;
      }
      case 'order66': {
        const isJ = (c) => c.def.subtypes && c.def.subtypes.includes('Jedi') && !g.has(c, 'indestructible');
        const oppJedi = oppCre.filter(isJ);
        const myJedi = myCre.filter(isJ);
        const myFlips = mineOf(g, p).filter(c => c.backDef && !c.transformed && c.backDef.side === 'dark' && !(c.def.subtypes && c.def.subtypes.includes('Jedi'))).length;
        const oppFlips = mineOf(g, q).filter(c => c.backDef && !c.transformed && c.backDef.side === 'dark' && !(c.def.subtypes && c.def.subtypes.includes('Jedi'))).length;
        let d = sum(oppJedi, c => cval(g, c)) - sum(myJedi, c => cval(g, c)) + myFlips * 5 - oppFlips * 4;
        if (!oppJedi.length && oppCre.length) d += Math.min(...oppCre.map(c => cval(g, c)));
        res.score = d >= 3.5 ? d : 0;
        res.when = 'main2';
        break;
      }
      case 'unlimitedPower': {
        const legal = legalFor(g, p, specs[0], spellItem(card, p)).filter(r => r.kind === 'card');
        const oppT = legal.map(r => ({ r, c: g.card(r.id) })).filter(x => ctl(g, x.c) === q && !g.has(x.c, 'indestructible') && cval(g, x.c) > 0)
          .sort((a, b) => cval(g, b.c) - cval(g, a.c)).slice(0, 3);
        if (!oppT.length) break;
        const have8 = forceOf(g, p) >= 8;
        const picked = [];
        let totPow = 0, totVal = 0;
        for (const x of oppT) {
          const pw = Math.max(0, g.power(x.c) || 0);
          if (!have8 && totPow + pw >= myLife) continue;
          picked.push(x); totPow += pw; totVal += cval(g, x.c);
        }
        if (!picked.length) break;
        const lifeSwing = have8 ? (totPow >= oppLife ? 1000 : lifeCost(oppLife, totPow) + lifeGainV(myLife, totPow)) : -lifeCost(myLife, totPow);
        const sc = lifeSwing >= 1000 ? 1000 : totVal + lifeSwing;
        if (sc >= 4) { res.score = sc; res.tg = [picked.map(x => refKey(x.r))]; res.when = 'main2'; }
        break;
      }
      case 'threaten1': {
        if (phase !== 'main1') break;
        const legal = legalFor(g, p, specs[0], spellItem(card, p)).filter(r => r.kind === 'card' && ctl(g, g.card(r.id)) === q && g.isCreature(g.card(r.id)));
        if (!legal.length) break;
        const base = attackSearch(g, p, { level: ctx.level, budgetMs: 25 });
        let bestS = 0, bestR = null;
        for (const r of legal.slice(0, 5)) {
          const c = g.card(r.id);
          const mods = new Map([[c.id, { haste: true, untap: true }]]);
          const w = attackSearch(g, p, { mods, stolen: new Set([c.id]), extraMine: [c], level: ctx.level, budgetMs: 30 });
          const gain = w.score - base.score;
          if (gain > bestS) { bestS = gain; bestR = r; }
        }
        if (bestS >= 4.5 && bestR) { res.score = bestS >= 1000 ? 1000 : bestS; res.tg = [[refKey(bestR)]]; res.when = 'main1'; }
        break;
      }
      case 'shadowDetail': {
        const kills = oppCre.filter(c => (g.toughness(c) || 0) - 1 <= (c.damage || 0));
        res.score = tokenValue(g, p, 'Human Rogue', 2) + sum(kills, c => cval(g, c)) + 0.6;
        res.when = kills.length ? 'main1' : 'main2';
        break;
      }
      case 'revelation': {
        res.score = 6.5 + forceGainValue(g, p, 3);
        res.when = 'main1';
        break;
      }
      case 'reclaimWreck': {
        const best0 = pt && pt.tg[0] && pt.tg[0].length ? pt.first : 0;
        const tot = pt ? pt.total : 0;
        res.score = tot >= 3 ? tot * 0.7 : 0;
        res.when = best0 >= 4 ? 'any' : 'hold';
        break;
      }
      case 'palpatine': {
        res.score = 6.2;
        res.when = 'main2';
        break;
      }
      case 'warEnds': {
        const sideV = (pl) => sum(mineOf(g, pl).filter(c => g.isCreature(c) || g.isArtifact(c)), c => permVal(g, c)) - creaturesOf(g, pl).filter(c => !c.token).length * 2.4;
        const d = sideV(q) - sideV(p);
        res.score = d >= 6 ? d : 0;
        res.when = 'main2';
        break;
      }
      case 'massShrink': case 'sweep': {
        const n = K.n || 2;
        const dies = (c) => (g.toughness(c) || 0) - n <= (c.damage || 0) && !(K.nonFly && g.has(c, 'flying')) && !(k === 'sweep' && c.regen > 0);
        let d = sum(oppCre.filter(dies), c => cval(g, c)) - (K.oppOnly || K.oneSided ? 0 : sum(myCre.filter(dies), c => cval(g, c)));
        if (K.oppOnly) d -= sum(myCre.filter(dies), c => cval(g, c));
        if (K.players) {
          if (oppLife <= K.players) { res.score = 1000; break; }
          d += lifeCost(oppLife, K.players);
        }
        if (def.name === 'Taris Bombardment' && pt && pt.tg[0] && pt.tg[0].length) d += best > 0 ? 1.5 : -3;  // one-sided sweep (balance change)
        res.score = d >= 4.5 ? d : 0;
        res.when = 'main2';
        break;
      }
      case 'artWrath': {
        const v = (pl) => sum(mineOf(g, pl).filter(c => g.isArtifact(c) || g.isEnchantment(c)), c => permVal(g, c) - 1.8);
        const d = v(q) - v(p);
        res.score = d >= 4 ? d : 0;
        break;
      }
      case 'token': {
        const n = K.n || 2;
        let v = tokenValue(g, p, K.tok || 'Clone Soldier', n) - 0.5 + lifeV(K.life || 0) + drawV;
        // Playing to outs: creating extra blockers is huge when facing lethal/Menace pressure!
        if (oppCre.some(c => g.has(c, 'menace')) || sum(oppCre, c => Math.max(0, g.power(c) || 0)) >= myLife) v += 1.6;
        res.score = v;
        if (!inst) res.when = ctx.deferCreatures ? 'main2' : 'any';
        break;
      }
      case 'draw': {
        let v = K.v || 3.5;
        if (g.players[p].library.length <= 4) v = 0;
        if (add && add.sacrifice && myCre.length && !res.sac) v = 0;
        const oppThreatPow = sum(oppCre, c => Math.max(0, g.power(c) || 0));
        const diggingForOuts = oppThreatPow >= myLife && myLife > 0;
        if (diggingForOuts && v > 0) v += 2.0; // Play to outs: dig in Main 1 for removal/blockers!
        res.score = v;
        const needLand = g.players[p].landsPlayed === 0 && !handOf(g, p).some(c => isLandDef(c.def));
        res.when = inst ? (diggingForOuts ? 'main1' : 'hold') : ((needLand || diggingForOuts) ? 'main1' : 'main2');
        res.digForLand = needLand;
        break;
      }
      case 'drain': {
        const n = K.n || 2;
        if (oppLife <= n) { res.score = 1000; break; }
        res.score = lifeCost(oppLife, n) * 0.9 + lifeV(n);
        res.when = 'main2';
        break;
      }
      case 'ramp': {
        const L = landsOf(g, p).length;
        res.score = (K.big ? (L <= 6 ? 6 : 2.5) : (L <= 5 ? 4 : 1.6));
        res.when = 'main1';
        break;
      }
      case 'reanimate': {
        res.score = pt && pt.total >= 4 ? pt.total * 0.9 - (K.lifeLoss ? lifeCost(myLife, K.lifeLoss) : 0) : 0;
        break;
      }
      case 'rebuild': res.score = (pt ? pt.total * 0.85 : 0) + tokenValue(g, p, 'Human Jedi', 2); break;
      case 'graveFleet': {
        const gy = gyOf(g, p).filter(c => g.isCreatureCard(c)).map(c => sval(c.def)).sort((a, b) => b - a);
        res.score = 3 + (gy[0] || 0) * 0.8 + (gy[1] || 0) * 0.3;
        break;
      }
      case 'tutorLegend': res.score = 7; break;
      case 'recursion': {
        let v = (pt ? pt.total : 0) * 0.55 + drawV;
        if (K.art && pt && pt.total > 0) v += 0.8;
        res.score = v >= 2.5 ? v : 0;
        res.when = inst ? 'hold' : 'main2';
        break;
      }
      case 'discard': {
        const oh = g.players[q].hand.length;
        if (!pt || !pt.tg[0].length || pt.tg[0][0] !== 'p' + q) break;
        res.score = oh ? Math.min(oh, K.n || 1) * 2 + (K.pick ? 1.2 : 0) : 0;
        break;
      }
      case 'landHarm': if (best > 0) res.score = landsOf(g, q).length <= 3 ? 4 : 1.5; break;
      case 'permHarm': {
        const bonus = drawV + lifeV(K.life || 0) + (K.loot ? 0.6 : 0);
        res.score = best >= 2.5 ? best + bonus : 0;
        if (inst && best < 9) res.when = 'hold';
        break;
      }
      case 'nudge': res.when = 'hold'; break;
      case 'rock': {
        const L = landsOf(g, p).length;
        res.score = (L <= 5 ? 3 : 1) + (K.v || 0);
        res.when = 'main1';
        break;
      }
      case 'perm': {
        res.score = (K.v || 2) + 0.5 + (ti.etbForce ? forceGainValue(g, p, ti.etbForce) : 0);
        if (def.name === 'Riot of the Empty Pits' || def.name === 'Grove Armory') res.when = 'main1';
        break;
      }
      default: res.score = def.implemented ? 1.5 + def.manaValue * 0.3 : 0;
    }
    if (res.score > 0 && res.score < 1000) res.score += spellForce - addCost;
    return res;
  }

  // ===========================================================================
  // Transforms
  // ===========================================================================
  function onTurnValue(g, p, def) {
    const K = kb(def.name);
    if (K.onTurn === 'oppDiscard') return g.players[1 - p].hand.length ? 2.2 : 0;
    if (K.onTurn === 'visasLight') { const gy = gyOf(g, p).filter(c => g.isCreatureCard(c) && c.def.manaValue <= 2); return gy.length ? Math.max(...gy.map(c => sval(c.def))) * 0.8 : 0; }
    return 0;
  }
  /** Extra situational worth of a face (attack triggers that matter now). */
  function faceExtra(g, p, def) {
    const K = kb(def.name);
    const q = 1 - p;
    let v = 0;
    if (K.atk === 'gain') v += lifeGainV(g.players[p].life, K.n || 2) * 2;
    if (K.atk === 'drain') v += lifeCost(g.players[q].life, K.n || 1) * 0.8;
    if (K.atk === 'regrow') v += gyOf(g, p).some(c => g.isCreatureCard(c) && c.def.manaValue <= 2) ? 1.5 : 0;
    if (def.name === 'Lehon, Temple of the Ancients') v += g.players[p].life <= 8 ? 2 : 0;
    if (def.name === 'Lehon, Seal of Dominion') v += 1.5 + (g.players[q].life <= 6 ? 2 : 0);
    if (def.name === 'Dominion Lens') v += 2;
    if (def.name === 'Meetra Surik, Wound Unbound') v += 0.5;
    return v;
  }
  function faceValue(g, p, c, def) {
    return (g.isCreature(c) || isCreatureDef(def) ? cvalAs(g, c, def) : permValDef(g, c, def)) + faceExtra(g, p, def);
  }
  /** Gain of turning card c to its other face now (ignoring the ability's cost). */
  function transformGain(g, p, c) {
    if (!c.frontDef || !c.backDef) return -100;
    const other = c.transformed ? c.frontDef : c.backDef;
    return faceValue(g, p, c, other) - faceValue(g, p, c, c.def) + onTurnValue(g, p, other);
  }

  // ===========================================================================
  // Controller
  // ===========================================================================
  class Controller {
    constructor(opts) {
      opts = opts || {};
      this.level = ['easy', 'normal', 'hard'].includes(opts.level) ? opts.level : 'normal';
      this.rng = U.makeRng(opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2 ** 31));
      this.stepKey = null;
      this.counts = {};
      this.total = 0;
      this.plan = null;
      this.protPlan = null;
      this.lastError = null;
      this.stats = { decisions: 0, fallbacks: 0, ms: 0, worst: 0 };
    }

    decide(g, d) {
      const t0 = Date.now();
      DECISION_DEADLINE = t0 + 200;
      let ans = null;
      try {
        ans = this._decide(g, d);
        ans = this._sanitize(g, d, ans);
      } catch (e) {
        this.lastError = e;
        if (OF.AI.debug) console.error('AI error', d && d.type, e && e.stack);
        ans = null;
      }
      if (!ans) { this.stats.fallbacks++; ans = fallbackAnswer(g, d); }
      const dt = Date.now() - t0;
      this.stats.decisions++; this.stats.ms += dt; if (dt > this.stats.worst) this.stats.worst = dt;
      return ans;
    }

    _decide(g, d) {
      const p = d.player;
      switch (d.type) {
        case 'playFirst': return { first: true };
        case 'mulligan': return { keep: this.keepHand(g, p, d) };
        case 'priority': {
          const res = this.priority(g, p, d);
          // "easy" sometimes overlooks a play (never land drops), so it is clearly weaker than normal.
          if (this.level === 'easy' && res && (res.type === 'cast' || res.type === 'activate') && this.rng() < TUNE.easySkip) return { type: 'pass' };
          return res;
        }
        case 'payMana': return this.payMana(g, p, d);
        case 'chooseTargets': return this.chooseTargets(g, p, d);
        case 'chooseCards': return this.chooseCards(g, p, d);
        case 'yesNo': return { yes: this.yesNo(g, p, d) };
        case 'chooseColor': return { color: this.chooseColor(g, p, d) };
        case 'chooseOption': return { choice: this.chooseOption(g, p, d) };
        case 'chooseNumber': return this.chooseNumber(g, p, d);
        case 'orderCards': {
          const cards = d.cards.map(id => g.card(id));
          const hand = handOf(g, p);
          const mine = cards.every(c => c.owner === p);
          cards.sort((a, b) => (handValue(g, p, b, hand) - handValue(g, p, a, hand)) * (mine ? 1 : -1));
          return { order: cards.map(c => c.id) };
        }
        case 'declareAttackers': return { attackers: this.declareAttackers(g, p, d) };
        case 'declareBlockers': return { blocks: this.declareBlockers(g, p, d) };
        default: return null;
      }
    }

    // ----- validation -----------------------------------------------------------
    _sanitize(g, d, a) {
      if (!a || typeof a !== 'object') return null;
      switch (d.type) {
        case 'chooseTargets': {
          if (a.cancel) return d.cancellable ? a : null;
          if (!Array.isArray(a.targets)) return null;
          if (a.targets.length < d.min || a.targets.length > d.max) return null;
          const lk = d.legal.map(OF.refKey);
          const ks = a.targets.map(OF.refKey);
          if (new Set(ks).size !== ks.length || !ks.every(k => lk.includes(k))) return null;
          if (d.groupCheck && d.groupCheck(a.targets)) return null;
          return a;
        }
        case 'chooseCards': {
          if (a.cancel) return d.cancellable ? a : null;
          if (!Array.isArray(a.cards) || a.cards.length < d.min || a.cards.length > d.max) return null;
          if (new Set(a.cards).size !== a.cards.length || !a.cards.every(id => d.cards.includes(id))) return null;
          if (d.validate && d.validate(a.cards)) return null;
          return a;
        }
        case 'priority': {
          if (a.type === 'pass') return a;
          const ok = d.actions.some(x => x.type === a.type && x.cardId === a.cardId && (a.type !== 'activate' || x.ability === a.ability) && (a.type !== 'cast' || (x.alt || null) === (a.alt || null)));
          return ok && a.type !== 'mana' ? a : null;
        }
        case 'payMana': {
          if (a.type === 'cancel') return d.cancellable ? a : null;
          if (a.type === 'auto') return d.canAuto ? a : null;
          if (a.type === 'mana') return (d.exclude || []).includes(a.cardId) ? null : a;
          return null;
        }
        case 'declareBlockers': {
          if (!Array.isArray(a.blocks)) return null;
          const seen = {};
          for (const b of a.blocks) {
            const lim = (d.extraBlockers && d.extraBlockers[b.blocker]) || 1;
            seen[b.blocker] = seen[b.blocker] || [];
            if (seen[b.blocker].includes(b.attacker) || seen[b.blocker].length >= lim) return null;
            seen[b.blocker].push(b.attacker);
            if (!d.candidates[b.blocker] || !d.candidates[b.blocker].includes(b.attacker)) return null;
          }
          return { blocks: enforceMust(d, enforceMaxOne(d, a.blocks)) };
        }
        case 'declareAttackers': {
          if (!Array.isArray(a.attackers) || !a.attackers.every(id => d.candidates.includes(id))) return null;
          if (new Set(a.attackers).size !== a.attackers.length) return null;
          if (!(d.attackTax > 0)) for (const id of d.mustAttack || []) if (d.candidates.includes(id) && !a.attackers.includes(id)) a.attackers.push(id);
          return a;
        }
        case 'chooseNumber': {
          if (a.cancel) return d.cancellable ? a : null;
          if (!Number.isInteger(a.number)) return null;
          return { number: Math.max(d.min, Math.min(d.max, a.number)) };
        }
        case 'chooseColor': return d.colors.includes(a.color) ? a : null;
        case 'chooseOption': if (a.cancel) return d.cancellable ? a : null; return d.options.some(o => o.id === a.choice) ? a : null;
        case 'orderCards': return Array.isArray(a.order) && a.order.length === d.cards.length && d.cards.every(id => a.order.includes(id)) ? a : null;
        case 'yesNo': return typeof a.yes === 'boolean' ? a : null;
        case 'mulligan': return typeof a.keep === 'boolean' ? a : null;
        case 'playFirst': return typeof a.first === 'boolean' ? a : null;
        default: return a;
      }
    }

    // ----- bookkeeping --------------------------------------------------------------
    _touchStep(g) {
      const key = g.turnNumber + '|' + g.step + '|' + (g.combatNumber || 0);
      if (key !== this.stepKey) { this.stepKey = key; this.counts = {}; this.total = 0; }
    }
    _actKey(a) { return a.type + ':' + a.cardId + ':' + (a.ability === undefined ? '' : a.ability) + ':' + (a.alt || ''); }
    _allowed(a, limit) {
      const n = this.counts[this._actKey(a)] || 0;
      return n < (limit || 2);
    }
    _take(g, a, plan) {
      const k = this._actKey(a);
      this.counts[k] = (this.counts[k] || 0) + 1;
      this.total++;
      this.plan = Object.assign({ cardId: a.cardId, ability: a.ability, type: a.type }, plan || {});
      if (plan && plan.protColor) this.protPlan = { cardId: a.cardId, color: plan.protColor };
      const out = { type: a.type, cardId: a.cardId, ability: a.ability };
      if (a.alt) out.alt = a.alt;
      return out;
    }
    /** Priority actions expanded per mode for modal spells: [{a, card, mode}] (card is a mode view for modal spells). */
    entries(g, acts) {
      const out = [];
      for (const a of acts) {
        const card = g.card(a.cardId);
        if (a.type === 'cast' && card && isModal(card.def)) {
          for (let i = 0; i < card.def.spell.modes.length; i++) out.push({ a, card: modeCard(card, i), mode: 'm' + i });
        } else out.push({ a, card, mode: null });
      }
      return out;
    }
    _castCost(g, x) { return x.a.alt === 'afterimage' && x.card.def.afterimage ? U.parseCost(x.card.def.afterimage) : x.card.def.cost; }

    // ----- mulligan -------------------------------------------------------------------
    keepHand(g, p, d) {
      const hand = d.hand.map(id => g.card(id));
      const lands = hand.filter(c => isLandDef(c.def)).length;
      if (d.mulligans >= 2) return true;
      const cols = new Set();
      for (const c of hand) if (isLandDef(c.def)) for (const col of producedColors(c.def)) cols.add(col);
      if (d.mulligans === 1) return lands >= 2 && lands <= 5 || (lands === 1 && hand.filter(c => !isLandDef(c.def) && c.def.manaValue <= 2).length >= 3);
      if (lands < 2 || lands > 5) return false;
      const castable = hand.filter(c => !isLandDef(c.def) && c.def.manaValue <= Math.max(3, lands + 1) && colorOK(c.def, cols));
      if (!castable.length) return false;
      if (this.level === 'easy') return true;
      if (lands === 2) return hand.some(c => !isLandDef(c.def) && c.def.manaValue <= 2) || castable.length >= 2;
      return true;
    }

    // ----- priority ---------------------------------------------------------------------
    priority(g, p, d) {
      this._touchStep(g);
      this.plan = null;
      const acts = d.actions.filter(a => a.type !== 'mana');
      if (!acts.length) return { type: 'pass' };
      if (this.total >= 14) return { type: 'pass' };
      const my = g.activePlayer === p;
      const step = g.step;
      if (g.stack.length) {
        const top = g.stack[g.stack.length - 1];
        if (top.controller === p) return { type: 'pass' };
        return this.respond(g, p, d, acts) || { type: 'pass' };
      }
      if (my) {
        if (step === 'main1' || step === 'main2') return this.mainPhase(g, p, d, acts) || { type: 'pass' };
        if (step === 'beginCombat') return this.myBeginCombat(g, p, acts) || { type: 'pass' };
        if (step === 'declareAttackers') return this.myAttackStep(g, p, acts) || { type: 'pass' };
        if (step === 'declareBlockers' || step === 'firstStrikeDamage') return this.combatTricks(g, p, acts) || { type: 'pass' };
        if (step === 'end') return this.endStepSinks(g, p, acts, true) || { type: 'pass' };
        return { type: 'pass' };
      }
      if (step === 'beginCombat') return this.oppBeginCombat(g, p, acts) || { type: 'pass' };
      if (step === 'declareAttackers') return this.oppAttackStep(g, p, acts) || { type: 'pass' };
      if (step === 'declareBlockers' || step === 'firstStrikeDamage') return this.combatTricks(g, p, acts) || { type: 'pass' };
      if (step === 'end') return this.oppEndStep(g, p, acts) || { type: 'pass' };
      return { type: 'pass' };
    }

    // ----- main phase ---------------------------------------------------------------------
    mainPhase(g, p, d, acts) {
      const phase = g.step;
      const landActs = acts.filter(a => a.type === 'playLand');
      if (landActs.length) {
        const la = this.chooseLand(g, p, landActs);
        if (la) return this._take(g, la);
      }
      const hand = handOf(g, p);
      const myCre = creaturesOf(g, p);
      const holdsTrick = this.level !== 'easy' && hand.some(c => isInstantDef(c.def) && ['pump', 'burn', 'shrink', 'destroy', 'pumpRegen', 'protection', 'teamTrick', 'refit', 'battleMed'].includes(spellKind(c.def)));
      const willAttack = myCre.some(c => canAttackHyp(g, c));
      const excl = counterManaIds(g, p);
      const ctx = { level: this.level, deferCreatures: phase === 'main1' && holdsTrick && willAttack, excl };
      const cands = [];
      const seenCard = new Set();
      for (const x of this.entries(g, acts)) {
        const a = x.a;
        if (!this._allowed(a, 2)) continue;
        if (a.type === 'cast') {
          const card = x.card;
          const e = evalSpell(g, p, card, phase, ctx);
          if (!e || e.when === 'hold' || e.score < 1) continue;
          if (this.level !== 'easy' && phase === 'main1' && e.when === 'main2') continue;
          const cost = this._castCost(g, x);
          const key = a.cardId + (a.alt || '');
          // keep the best mode of a modal spell only
          const prev = cands.find(y => y.key === key);
          if (prev) { if (prev.e.score >= e.score) continue; cands.splice(cands.indexOf(prev), 1); }
          if (a.alt === 'afterimage') e.score += 0.2;   // the card is otherwise dead in the graveyard
          seenCard.add(key);
          cands.push({ a, e, cost, card: g.card(a.cardId), mode: x.mode, key, art: isArtifactDef(card.def), attune: !!kb(card.def.name).attuneSpell });
        } else if (a.type === 'activate') {
          const e = this.evalActivation(g, p, a, phase);
          if (e && e.score >= 1) cands.push({ a, e, cost: e.cost, card: g.card(a.cardId), isAct: true, key: this._actKey(a), forceAct: !!e.force });
        }
      }
      if (!cands.length) return null;
      let chosen;
      if (this.level === 'easy') {
        const real = cands.slice().sort((x, y) => (y.card.def.manaValue - x.card.def.manaValue) || (y.e.score - x.e.score));
        chosen = [real[0]];
      } else {
        const reserve = this.counterReserve(g, p);
        const full = this.knapsack(g, p, cands, U.emptyCost(), excl);
        chosen = full.set;
        if (reserve && full.set.length) {
          const withRes = this.knapsack(g, p, cands, reserve, excl);
          if (withRes.score >= full.score * 0.6) { chosen = withRes.set; this.reserve = reserve; }
        }
      }
      if (!chosen.length) { this.reserve = null; return null; }
      const pri = (x) => {
        const k = x.e.kind || '';
        if (x.e.digForLand) return 0;
        if (x.forceAct && x.e.attune) return 0.3;       // spend Force before Attunement spells / attacks
        if (x.attune) return 0.8;
        if (['destroy', 'burn', 'shrink', 'wrath', 'auraDebuff', 'fight', 'edict'].includes(k)) return 1;
        if (k === 'creature') return x.card.def.statics.length ? 2 : 3;
        if (k === 'transform') return 3.5;
        if (k === 'auraBuff' || k === 'equipment') return 5;
        if (x.a.type === 'activate') return k === 'equip' ? 6.5 : 6;
        return 4;
      };
      chosen.sort((x, y) => pri(x) - pri(y) || y.card.def.manaValue - x.card.def.manaValue);
      const first = chosen[0];
      let future = U.emptyCost();
      for (const x of chosen.slice(1)) future = U.addCosts(future, x.cost);
      if (this.reserve) future = U.addCosts(future, this.reserve);
      this.reserve = null;
      return this._take(g, first.a, { tg: first.e.tg, sac: first.e.sac, discard: first.e.discard, x: first.e.x, future, protColor: first.e.protColor, mode: first.mode, exile: first.e.exile });
    }

    knapsack(g, p, cands, reserve, excl) {
      const list = cands.slice().sort((a, b) => b.e.score - a.e.score).slice(0, 9);
      let best = { score: 0, set: [] };
      const cache = new Map();
      const feasible = (cost, cur) => {
        const arts = cur.filter(x => x.art);
        const key = U.costToString(cost) + '|' + (arts.length === cur.length && cur.length ? 'A' : '') + (cur.length === 1 ? cur[0].key : '');
        if (!cache.has(key)) {
          let ok = canAfford(g, p, cost, excl);
          if (!ok && cur.length && arts.length === cur.length) ok = canAfford(g, p, cost, excl, spendForCard(arts[0].card));
          if (!ok && cur.length === 1 && !cur[0].isAct) ok = canAfford(g, p, cost, excl, spendForCard(cur[0].card));
          if (!ok && cur.length === 1 && cur[0].isAct) ok = canAfford(g, p, cost, excl, { kind: 'ability', source: cur[0].card });
          cache.set(key, ok);
        }
        return cache.get(key);
      };
      // Force budget: activations in one set may not spend more Force than we have
      const forceNeed = (cur) => sum(cur, x => x.e.force || 0);
      let budget = 600;
      const rec = (i, cur, cost, score) => {
        if (--budget < 0) return;
        if (score > best.score) best = { score, set: cur.slice() };
        if (i >= list.length) return;
        const c = list[i];
        const nc = U.addCosts(cost, c.cost);
        cur.push(c);
        if (forceNeed(cur) <= forceOf(g, p) && feasible(U.addCosts(nc, reserve), cur)) rec(i + 1, cur, nc, score + c.e.score);
        cur.pop();
        rec(i + 1, cur, cost, score);
      };
      rec(0, [], U.emptyCost(), 0);
      if (!best.set.length && excl && excl.size) {
        for (const c of list) if (c.e.score >= 8 && canAfford(g, p, c.cost)) { best = { score: c.e.score, set: [c] }; break; }
      }
      return best;
    }

    counterReserve(g, p) {
      if (this.level === 'easy') return null;
      const q = 1 - p;
      if (!g.players[q].hand.length) return null;
      const counters = handOf(g, p).filter(c => ['counter', 'protection', 'redirect'].includes(spellKind(c.def)) || (isModal(c.def) && c.name === 'Intercept the Consignment'));
      if (!counters.length) return null;
      counters.sort((a, b) => a.def.manaValue - b.def.manaValue);
      return counters[0].def.cost;
    }

    chooseLand(g, p, landActs) {
      const hand = handOf(g, p);
      const spells = hand.filter(c => !isLandDef(c.def));
      const have = colorSourceCounts(g, p);
      const avail = availMana(g, p);
      const mvs = spells.map(c => c.def.manaValue);
      const bestSum = (cap) => { let b = 0; const n = Math.min(mvs.length, 10); for (let m = 0; m < (1 << n); m++) { let s = 0; for (let i = 0; i < n; i++) if (m & (1 << i)) s += mvs[i]; if (s <= cap && s > b) b = s; } return b; };
      const needExtra = bestSum(avail + 1) > bestSum(avail);
      let best = null, bestS = -Infinity;
      for (const a of landActs) {
        const c = g.card(a.cardId);
        let s = landScore(g, p, c.def, hand, have);
        if (c.def.entersTapped) s += needExtra ? -6 : 0.8;
        else s += 0.3;
        if (!g.isBasicLand(c)) s += 0.2 + (c.def.activated.length > 1 ? 0.2 : 0);
        if (c.def.supertypes.includes('Legendary') && bf(g).some(x => x.name === c.name && ctl(g, x) === p)) s -= 20;
        s += this.rng() * 0.01;
        if (s > bestS) { bestS = s; best = a; }
      }
      if (best && bestS < -15) return null;
      return best || landActs[0];
    }

    /** Main-phase value of an activated ability. Returns {score, cost, tg, kind, force?, attune?, sac?} or null. */
    evalActivation(g, p, a, phase) {
      const card = g.card(a.cardId);
      const ab = g.activatedAbilities(card)[a.ability];
      if (!ab) return null;
      const cls = classifyAbility(ab);
      const cost = ab.cost && ab.cost.mana ? U.parseCost(ab.cost.mana) : U.emptyCost();
      const fc = (ab.cost && ab.cost.force) || 0;
      const reservedUse = cls.kind === 'transform';
      const cv = abilityCostValue(g, p, card, ab, { reserved: reservedUse });
      const res = { score: 0, cost, tg: null, kind: cls.kind, force: fc, attune: fc > 0 && attuneBonus(g, p) > 0 };
      const hand = handOf(g, p);
      const q = 1 - p;
      const lib = g.players[p].library.length;
      const main1 = phase === 'main1';
      const base = () => this._base || (this._base = attackSearch(g, p, { level: this.level, budgetMs: 40 }));
      this._base = null;
      switch (cls.kind) {
        case 'transform': {
          const gain = transformGain(g, p, card);
          if (gain - cv > 0.8) res.score = gain - cv;
          if (ab.cost && ab.cost.discard) res.discard = chooseWorst(g, p, hand, 1).map(c => c.id);
          break;
        }
        case 'equip': {
          if (!main1 && !(phase === 'main2' && !card.attachedTo)) break;
          const plan = this.equipPlan(g, p, card, ab, main1);
          if (!plan) break;
          res.score = Math.max(1.1, plan.gain - cv); res.tg = plan.tg;
          break;
        }
        case 'tapper': {
          if (!main1 || !(ab.sorcery || ab.yourTurn)) break;
          const t = this.bestNoBlock(g, p, card, ab, base);
          if (t && t.gain - cv > 1) { res.score = t.gain - cv; res.tg = t.tg; }
          break;
        }
        case 'shrinkAb': case 'ping': {
          if (cls.combatOnly || cls.damagedOnly) break;
          const eff = cls.kind === 'ping' ? { k: 'burn', dmg: cls.n } : { k: 'harm', sub: 'shrink', n: cls.n };
          const pt = this.planAbilityTargets(g, p, card, ab, eff);
          if (pt && pt.first >= 1000) { res.score = 1000; res.tg = pt.tg; break; }
          if (pt && pt.first >= 3 && pt.tg[0][0][0] === 'c') { res.score = pt.first - cv - (g.isCreature(card) && ab.cost && ab.cost.tap ? 0.6 : 0); res.tg = pt.tg; if (ab.cost && ab.cost.sacrifice) res.sac = this.cheapestSac(g, p, card, ab); }
          break;
        }
        case 'token': if (phase === 'main2' || ab.sorcery) { const v = (cls.big ? 6 : cls.dt ? 3.2 : 4) - cv; if (v > 0.5) res.score = v; } break;
        case 'teamPumpAb': if (phase === 'main1' && creaturesOf(g, p).length >= 2) { res.score = creaturesOf(g, p).length * 4.5 - cv; } break;
        case 'counterTarget': {
          if (!(ab.sorcery || phase === 'main2')) break;
          const pt = this.planAbilityTargets(g, p, card, ab, { k: 'help' });
          if (pt && pt.first > 0) { res.score = 2 - cv + (cls.untap ? 0.3 : 0); res.tg = pt.tg; }
          break;
        }
        case 'fetch': if (main1 || ab.sorcery) { const v = (landsOf(g, p).length <= 7 ? 2.6 : 0.8) - cv + (ab.cost && ab.cost.sacSelf ? permVal(g, card) : 0); if (v > 0.5) res.score = v; } break;
        case 'recursion': {
          if (!(ab.sorcery || phase === 'main2')) break;
          const pt = this.planAbilityTargets(g, p, card, ab, { k: 'gyReturn' });
          if (pt && pt.first >= 2.5) { res.score = pt.first * (cls.toBf ? 0.9 : 0.55) - cv; res.tg = pt.tg; if (ab.cost && ab.cost.sacrifice) res.sac = this.cheapestSac(g, p, card, ab); }
          break;
        }
        case 'drawAb': {
          if (!ab.sorcery && phase !== 'main2') break;
          if (!ab.sorcery && this.level !== 'easy') break;  // instant-speed draws wait for the end step
          if (lib <= 3) break;
          let pay = 0;
          if (ab.cost && ab.cost.sacrifice) { const s = this.cheapestSac(g, p, card, ab); if (!s) break; res.sac = s; pay = permVal(g, g.card(s[0])); }
          const v = 2.4 - cv - pay;
          if (v > 0.3) res.score = Math.max(1, v);
          break;
        }
        case 'drainAb': {
          const n = cls.n || 2;
          if (g.players[q].life <= n) { res.score = 1000; res.tg = cls.targeted ? [['p' + q]] : null; break; }
          if (phase !== 'main2') break;
          const v = lifeCost(g.players[q].life, n) * 0.9 + (cls.gain ? lifeGainV(g.players[p].life, n) : 0) - cv;
          if (v > 0.6) { res.score = Math.max(1, v); res.tg = cls.targeted ? [['p' + q]] : null; }
          break;
        }
        case 'artKill': {
          const pt = this.planAbilityTargets(g, p, card, ab, { k: 'permHarm' });
          if (pt && pt.first >= 3) { res.score = pt.first - cv; res.tg = pt.tg; }
          break;
        }
        case 'assassin': {
          const pt = this.planAbilityTargets(g, p, card, ab, { k: 'harm', sub: 'exile' });
          if (pt && pt.first >= 4) { res.score = pt.first - cv; res.tg = pt.tg; }
          break;
        }
        case 'selfPump': {
          // spend a cheap Force sink before attacking when Attunement payoffs care
          if (!main1 || !fc || !res.attune || !canAttackHyp(g, card)) break;
          const v = attuneBonus(g, p) + 0.4 - (cv + attuneBonus(g, p));
          if (attuneBonus(g, p) >= 0.8 && v > -0.6) res.score = 1;
          break;
        }
        case 'sacOutlet': {
          if (cls.dmg) {
            const fodder = creaturesOf(g, p).filter(c => c.id !== card.id).length;
            if (fodder >= g.players[q].life) { res.score = 1000; res.tg = [['p' + q]]; res.sac = this.cheapestSac(g, p, card, ab); }
          } else if (cls.draw && (ab.sorcery || phase === 'main2') && lib > 4) {
            const sac = this.cheapestSac(g, p, card, ab);
            if (sac) { const v = cls.draw * 2.4 - permVal(g, g.card(sac[0])) - cv; if (v > 0.5 && (ab.sorcery || this.level === 'easy')) { res.score = Math.max(1, v); res.sac = sac; } }
          }
          break;
        }
        case 'anvil': {
          const eqs = hand.filter(c => c.def.subtypes.includes('Equipment'));
          if (eqs.length && creaturesOf(g, p).length && main1) res.score = 2.5 + Math.max(...eqs.map(c => c.def.manaValue)) * 0.5 - cv;
          break;
        }
        case 'chargeAdd': if (phase === 'main2' && !(ab.cost && ab.cost.mana)) res.score = 0; break;
        default: break;
      }
      if (res.score > 0 && res.score < 1000 && res.attune && cls.kind !== 'selfPump') res.score += 0.01;
      return res;
    }

    /** Best carrier for an Equipment (equip ability); null if staying put is as good. */
    equipPlan(g, p, card, ab, main1) {
      const e = textInfo(card.def).eq || { p: 0, t: 0, kw: [] };
      const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature', yours: true }, abilityItem(card, ab, p)).filter(r => r.kind === 'card');
      const score = (t) => {
        if (!t || t.zone !== 'battlefield' || ctl(g, t) !== p || !g.isCreature(t)) return -100;
        if (g.has(t, 'defender') || (g.has(t, 'cantAttack') && g.has(t, 'cantBlock'))) return -5;
        const K = kb(t.name);
        let s = e.p * 1.6 + e.t * 0.7;
        for (const kw of e.kw || []) if (!g.has(t, kw)) s += kw === 'firstStrike' ? 1.2 + Math.max(0, g.power(t) || 0) * 0.2 : 0.8;
        if (g.has(t, 'flying') || g.has(t, 'fear') || g.has(t, 'unblockable')) s += e.p * 0.8;
        if (g.has(t, 'doubleStrike')) s += e.p;
        if (g.has(t, 'trample')) s += e.p * 0.3;
        if (K.whenEq && !isEquipped(g, t)) s += K.whenEq.fs ? 1.5 : 1;
        if (K.eqAtk && !isEquipped(g, t)) s += 1.8;
        if (t.token && t.name === 'Warrior') s += 2;   // Riot of the Empty Pits: equipped tokens stay
        if (main1 && canAttackHyp(g, t)) s += 0.8;
        s += Math.max(0, g.power(t) || 0) * 0.15 + (t.token ? -0.5 : 0);
        return s;
      };
      let best = null, bs = -Infinity;
      for (const r of legal) { const s = score(g.card(r.id)); if (s > bs) { bs = s; best = r; } }
      if (!best || bs <= 0) return null;
      if (card.attachedTo) {
        const host = g.card(card.attachedTo);
        if (host && host.zone === 'battlefield' && ctl(g, host) === p) {
          if (host.id === best.id) return null;
          // score of the current host was computed with it already equipped: compare fairly
          const hs = score(host) + (kb(host.name).whenEq ? 1.5 : 0) + (kb(host.name).eqAtk ? 1.8 : 0);
          if (bs < hs + 2.5) return null;
        }
      }
      return { gain: 1.5 + bs * 0.4, tg: [[refKey(best)]] };
    }

    /** Best opposing blocker to tap / stop blocking with an ability; {gain, tg}. */
    bestNoBlock(g, p, card, ab, base) {
      const q = 1 - p;
      const item = abilityItem(card, ab, p);
      const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, item);
      let best = null;
      for (const r of legal) {
        if (r.kind !== 'card') continue;
        const t = g.card(r.id);
        if (ctl(g, t) !== q || t.tapped || !g.isCreature(t)) continue;
        const w = attackSearch(g, p, { noBlock: new Set([t.id]), level: this.level, budgetMs: 30 });
        const gain = w.score - base().score;
        if (!best || gain > best.gain) best = { gain, tg: [[refKey(r)]] };
      }
      return best;
    }

    planAbilityTargets(g, p, card, ab, eff) {
      const specs = ab.targets || [];
      const item = abilityItem(card, ab, p);
      const tg = [];
      let first = 0, total = 0;
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const legal = legalFor(g, p, spec, item);
        const min = spec.min !== undefined ? spec.min : 1;
        const max = spec.max !== undefined ? spec.max : 1;
        const groupFn = spec.group ? (refs) => spec.group(g, refs.map(r => refObj(g, r)), p, item) : null;
        const e = Array.isArray(eff) ? eff[i] || eff[0] : eff;
        const sel = selectRefs(g, legal, r => scoreRef(g, p, r, e), min, Math.min(max, legal.length), groupFn);
        if (!sel) return null;
        if (i === 0) first = sel.length ? scoreRef(g, p, sel[0], e) : 0;
        total += sum(sel, r => scoreRef(g, p, r, e));
        tg.push(sel.map(refKey));
        item.targets.push(sel);
      }
      return { tg, first, total };
    }

    cheapestSac(g, p, source, ab, avoid) {
      const cost = ab.cost || {};
      const spec = cost.sacrifice;
      let cands = [];
      try { cands = spec ? g._sacCandidates(p, spec, source) : creaturesOf(g, p); } catch (e) { cands = []; }
      cands = cands.filter(x => x !== source && (!avoid || !avoid.has(x.id)));
      const sp = sacPlan(g, p, cands, source.id);
      return sp ? [sp.card.id] : null;
    }

    // ----- combat-related steps ---------------------------------------------------------------
    myBeginCombat(g, p, acts) {
      if (this.level === 'easy') return null;
      const q = 1 - p;
      const options = [];
      let base = null;
      const getBase = () => base || (base = attackSearch(g, p, { level: this.level }));
      const blockers = creaturesOf(g, q).filter(c => !c.tapped && !g.has(c, 'cantBlock'));
      if (!blockers.length || !creaturesOf(g, p).some(c => canAttackHyp(g, c))) return null;
      for (const x of this.entries(g, acts)) {
        const a = x.a, card = x.card;
        if (!this._allowed(a, 1)) continue;
        if (a.type === 'cast') {
          const tk = spellKind(card.def);
          const K2 = kb(card.def.name);
          const ti = textInfo(card.def);
          if (tk === 'tapTwo' || tk === 'tapOne' || tk === 'cantBlock2') {
            const legal = legalFor(g, p, spellSpecs(card.def)[0], spellItem(card, p)).filter(r => r.kind === 'card' && blockers.some(b => b.id === r.id));
            const sorted = legal.map(r => ({ r, v: cval(g, g.card(r.id)) })).sort((x1, y) => y.v - x1.v).slice(0, tk === 'tapOne' ? 1 : 2);
            if (!sorted.length) continue;
            const w = attackSearch(g, p, { noBlock: new Set(sorted.map(y => y.r.id)), level: this.level });
            const gain = w.score - getBase().score + forceGainValue(g, p, ti.spellForce) + (K2.freeze ? 1.5 : 0) - 3;
            if (gain > 1.5 || w.score >= 1000) options.push({ a, gain: w.score >= 1000 ? 1000 : gain, tg: [sorted.map(y => refKey(y.r))], mode: x.mode });
            continue;
          }
          if (tk === 'massWeaken') {
            const oppMods = new Map(creaturesOf(g, q).map(c => [c.id, { p: -2, t: -1 }]));
            const w = attackSearch(g, p, { tapAll: true, level: this.level });
            const dies = sum(creaturesOf(g, q).filter(c => remTough(g, c) <= 1), c => cval(g, c));
            const gain = w.score - getBase().score + dies * 0.5 + forceGainValue(g, p, 2) - 3.5;
            void oppMods;
            const pt = planSpellTargets(g, p, card, { k: 'playerHarm' });
            if ((gain > 2 || w.score >= 1000) && pt) options.push({ a, gain: w.score >= 1000 ? 1000 : gain, tg: pt.tg, mode: x.mode });
            continue;
          }
          continue;
        }
        if (a.type !== 'activate') continue;
        const ab = g.activatedAbilities(card)[a.ability];
        const cls = classifyAbility(ab);
        if (cls.kind !== 'tapper' && cls.kind !== 'cantBlock') continue;
        const cv = abilityCostValue(g, p, card, ab);
        const t = this.bestNoBlock(g, p, card, ab, getBase);
        if (t && t.gain - cv > 1.5) options.push({ a, gain: t.gain - cv, tg: t.tg });
      }
      if (!options.length) return null;
      options.sort((x, y) => y.gain - x.gain);
      return this._take(g, options[0].a, { tg: options[0].tg, mode: options[0].mode });
    }

    oppBeginCombat(g, p, acts) {
      if (this.level === 'easy') return null;
      const q = 1 - p;
      for (const x of this.entries(g, acts)) {
        const a = x.a, card = x.card;
        if (!this._allowed(a, 1)) continue;
        if (a.type === 'cast' && (spellKind(card.def) === 'tapTwo' || spellKind(card.def) === 'tapOne')) {
          const tk = spellKind(card.def);
          const attackers = creaturesOf(g, q).filter(c => canAttackHyp(g, c));
          if (!attackers.length) continue;
          const base = attackSearch(g, q, { level: 'normal' });
          if (base.score <= 1 || !base.ids.length) continue;
          const legal = legalFor(g, p, spellSpecs(card.def)[0], spellItem(card, p)).filter(r => r.kind === 'card' && base.ids.includes(r.id));
          const sorted = legal.map(r => ({ r, v: (g.power(g.card(r.id)) || 0) * 2 + cval(g, g.card(r.id)) * 0.3 })).sort((x1, y) => y.v - x1.v).slice(0, tk === 'tapTwo' ? 2 : 1);
          if (!sorted.length) continue;
          const after = attackSearch(g, q, { level: 'normal', exclude: new Set(sorted.map(y => y.r.id)) });
          const gain = (base.score - after.score) * 0.6 + forceGainValue(g, p, textInfo(card.def).spellForce) + (kb(card.def.name).freeze ? 1.5 : 0) - 3;
          if (gain > 1.5) return this._take(g, a, { tg: [sorted.map(y => refKey(y.r))], mode: x.mode });
          continue;
        }
        if (a.type !== 'activate') continue;
        const ab = g.activatedAbilities(card)[a.ability];
        if (classifyAbility(ab).kind !== 'tapper') continue;
        const item = abilityItem(card, ab, p);
        const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, item);
        let best = null, bestS = 2 + abilityCostValue(g, p, card, ab) * 0.5;
        for (const r of legal) {
          if (r.kind !== 'card') continue;
          const t = g.card(r.id);
          if (ctl(g, t) !== q || t.tapped || !canAttackHyp(g, t)) continue;
          const s = (g.power(t) || 0) * 1.5 + cval(g, t) * 0.2 + (g.has(t, 'flying') ? 1 : 0);
          if (s > bestS) { bestS = s; best = r; }
        }
        if (best) {
          const res = this.counterReserve(g, p);
          if (res && !canAfford(g, p, U.addCosts(res, U.parseCost((ab.cost && ab.cost.mana) || '')))) continue;
          return this._take(g, a, { tg: [[refKey(best)]] });
        }
      }
      return null;
    }

    /** After attackers are declared (my turn): evasion before blocks. */
    myAttackStep(g, p, acts) {
      if (this.level === 'easy' || !g.combat || !g.combat.attackers.length) return null;
      const q = 1 - p;
      const atk = g.combat.attackers.map(x => g.card(x.id)).filter(Boolean).map(c => unit(g, c));
      const blk = creaturesOf(g, q).filter(c => !c.tapped).map(c => unit(g, c));
      if (!blk.length) return null;
      const can = (b, x) => safeBool(() => g.canBlock(b.c, x.c));
      const oppLife = g.players[q].life;
      const evalB = (A, canF) => {
        const blocks = planBlocks({ atk: A, blk, can: canF, life: oppLife, risk: 0 });
        let v = 0, dmg = 0;
        for (const a of A) { const bs = blocks.get(a.id) || []; const r = fight(a, bs); dmg += r.toPlayer; if (r.aDies) v -= a.val; for (const b of bs) if (r.dead.has(b.id)) v += b.val; }
        return v + (dmg >= oppLife ? 1000 : lifeCost(oppLife, dmg));
      };
      const base = evalB(atk, can);
      const options = [];
      for (const a of acts) {
        if (!this._allowed(a, 1) || a.type !== 'activate') continue;
        const card = g.card(a.cardId);
        const ab = g.activatedAbilities(card)[a.ability];
        const cls = classifyAbility(ab);
        const cv = abilityCostValue(g, p, card, ab);
        let ids = [], tgF = null;
        if (cls.kind === 'evasionAb') {
          const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
          for (const r of legal) if (r.kind === 'card' && atk.some(u => u.id === r.id)) ids.push({ id: r.id, r });
          tgF = (r) => [[refKey(r)]];
        } else if (cls.kind === 'selfKw' && cls.kw === 'flying' && atk.some(u => u.id === card.id)) ids = [{ id: card.id }];
        else continue;
        for (const it of ids) {
          if (g.has(g.card(it.id), 'flying')) continue;
          const can2 = (b, x) => (x.id !== it.id || b.flying || g.has(b.c, 'reach')) && can(b, x);
          const gain = evalB(atk, can2) - base - cv;
          if (gain > 1.2) options.push({ a, gain, tg: it.r && tgF ? tgF(it.r) : null });
        }
      }
      if (!options.length) return null;
      options.sort((x, y) => y.gain - x.gain);
      return this._take(g, options[0].a, { tg: options[0].tg });
    }

    oppAttackStep(g, p, acts) {
      if (this.level === 'easy' || !g.combat || !g.combat.attackers.length) return null;
      const myLife = g.players[p].life;
      const attackers = g.combat.attackers.map(x => g.card(x.id)).filter(Boolean);
      const totalPow = sum(attackers, c => g.power(c) || 0);
      const options = [];
      for (const x of this.entries(g, acts)) {
        const a = x.a, card = x.card;
        if (!this._allowed(a, 1)) continue;
        if (a.type === 'activate') {
          const ab = g.activatedAbilities(card)[a.ability];
          const cls = classifyAbility(ab);
          if (!['assassin', 'ping', 'shrinkAb'].includes(cls.kind) || cls.damagedOnly) continue;
          const eff = cls.kind === 'assassin' ? { k: 'harm', sub: 'exile' } : cls.kind === 'ping' ? { k: 'burn', dmg: cls.n } : { k: 'harm', sub: 'shrink', n: cls.n };
          const pt = this.planAbilityTargets(g, p, card, ab, eff);
          if (!pt || !pt.tg[0] || !pt.tg[0].length || pt.tg[0][0][0] !== 'c') continue;
          const t = g.card(Number(pt.tg[0][0].slice(1)));
          if (!t || !attackers.includes(t) || pt.first < 3) continue;
          options.push({ a, gain: pt.first - abilityCostValue(g, p, card, ab), tg: pt.tg, sac: ab.cost && ab.cost.sacrifice ? this.cheapestSac(g, p, card, ab) : null });
          continue;
        }
        if (a.type !== 'cast') continue;
        const def = card.def;
        const k = spellKind(def);
        const K = kb(def.name);
        if (k === 'burnAttackers') {
          const ks = attackers.filter(c => remTough(g, c) <= (K.dmg || 2) && !(c.regen > 0)).sort((x1, y) => cval(g, y) - cval(g, x1)).slice(0, 2);
          if (!ks.length) continue;
          const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p));
          const refs = ks.map(c => legal.find(r => r.kind === 'card' && r.id === c.id)).filter(Boolean);
          const gain = sum(ks, c => cval(g, c)) - 2.5;
          if (refs.length && gain > 1.5) options.push({ a, gain, tg: [refs.map(refKey)] });
          continue;
        }
        if (!['burn', 'destroy', 'shrink', 'bounce'].includes(k) || K.blockingOnly) continue;
        if (K.minPow) { /* Arrest the Vanguard: target filter does it */ }
        const eff = spellEff(g, p, def, {});
        const pt = planSpellTargets(g, p, card, eff);
        if (!pt || !pt.tg[0].length) continue;
        const key = pt.tg[0][0];
        if (key[0] !== 'c') continue;
        const t = g.card(Number(key.slice(1)));
        if (!t || !attackers.includes(t)) continue;
        if (pt.first < 3 && !(k === 'bounce' && t.token)) continue;
        let gain = pt.first - 2.5 + lifeCost(myLife, Math.min(totalPow, g.power(t) || 0)) * 0.5 + (K.combatOnly ? 1.5 : 0) + forceGainValue(g, p, textInfo(def).spellForce);
        if (k === 'bounce' && !t.token) gain = (myLife <= 8 ? lifeCost(myLife, g.power(t) || 0) : 0) - 1;
        if (gain > 1.5) options.push({ a, gain, tg: pt.tg, mode: x.mode, sac: evalSacOf(g, p, card) });
      }
      if (!options.length) return null;
      options.sort((x, y) => y.gain - x.gain);
      const o = options[0];
      return this._take(g, o.a, { tg: o.tg, mode: o.mode, sac: o.sac });
    }

    /** Combat tricks after blockers are declared (either side). */
    combatTricks(g, p, acts) {
      if (!g.combat || !g.combat.attackers.length) return null;
      const lvl = this.level;
      const minGain = lvl === 'easy' ? 4 : lvl === 'hard' ? 0.8 : 1.0;
      const cb = g.combat;
      const inCombat = new Set();
      const partners = new Map();
      for (const at of cb.attackers) {
        inCombat.add(at.id);
        for (const b of at.blockers) {
          inCombat.add(b);
          (partners.get(at.id) || partners.set(at.id, []).get(at.id)).push(b);
          (partners.get(b) || partners.set(b, []).get(b)).push(at.id);
        }
      }
      const base = combatValue(g, p, new Map(), false);
      const options = [];
      const my = g.activePlayer === p;
      const consider = (a, mods, extra, cost, tg, sac, more) => {
        const v = combatValue(g, p, mods, false);
        const gain = v.value - base.value + (extra || 0) - cost;
        if (gain >= minGain) options.push(Object.assign({ a, gain, tg, sac }, more || {}));
      };
      const myCombatants = creaturesOf(g, p).filter(c => inCombat.has(c.id));
      for (const x of this.entries(g, acts)) {
        const a = x.a, card = x.card;
        if (!this._allowed(a, a.type === 'activate' ? 6 : 1)) continue;
        if (a.type === 'cast') {
          const def = card.def;
          const k = spellKind(def);
          const K = kb(def.name);
          const ti = textInfo(def.__base || def);
          const cardCost = 2.2 + def.manaValue * 0.1 - (K.draw ? 2 : 0) - forceGainValue(g, p, ti.spellForce);
          const more = { mode: x.mode, sac: evalSacOf(g, p, card) };
          if (k === 'teamTrick') {
            if (K.attackOnly && !my) continue;
            if (g.step === 'combatDamage') continue;
            const mods = new Map();
            for (const c of myCombatants) if (!K.attackOnly || g.attacking(c)) mods.set(c.id, { p: K.p || 0, t: K.t || 0, fs: !!K.fs, ds: !!K.ds });
            if (mods.size) consider(a, mods, 0, cardCost, null, null, more);
            continue;
          }
          if (k === 'battleMed') {
            const spec = spellSpecs(def)[0];
            const legal = legalFor(g, p, spec, spellItem(card, p)).filter(r => r.kind === 'card' && ctl(g, g.card(r.id)) === p);
            const pick = legal.filter(r => inCombat.has(r.id)).slice(0, 3);
            if (!pick.length) continue;
            const mods = new Map(pick.map(r => [r.id, { p: K.p || 1, t: K.t || 2 }]));
            const untapV = my ? pick.filter(r => g.card(r.id).tapped).length * 0.6 : 0;
            consider(a, mods, untapV, cardCost - 2.2, [pick.map(refKey)], null, more);
            continue;
          }
          if (k === 'refit') {
            if (g.step === 'combatDamage') continue;
            const specs = spellSpecs(def);
            const eqs = legalFor(g, p, specs[0], spellItem(card, p)).filter(r => r.kind === 'card');
            const cre = legalFor(g, p, specs[1], spellItem(card, p)).filter(r => r.kind === 'card' && inCombat.has(r.id));
            for (const er of eqs.slice(0, 3)) {
              const ec = g.card(er.id);
              const e = textInfo(ec.def).eq || { p: 0, t: 0, kw: [] };
              for (const cr of cre) {
                const already = ec.attachedTo === cr.id;
                const mod = { ds: true, p: already ? 0 : e.p, t: already ? 0 : e.t, fs: !already && (e.kw || []).includes('firstStrike') };
                consider(a, new Map([[cr.id, mod]]), 0, cardCost, [[refKey(er)], [refKey(cr)]], null, more);
              }
            }
            continue;
          }
          if (k === 'pumpRegen') {
            const legal = legalFor(g, p, spellSpecs(def)[0] || { type: 'creature' }, spellItem(card, p));
            for (const r of legal) {
              if (r.kind !== 'card' || !inCombat.has(r.id) || ctl(g, g.card(r.id)) !== p) continue;
              consider(a, new Map([[r.id, { p: K.p || 2, t: K.t || 2, regen: true }]]), 0, cardCost, [[refKey(r)]], null, more);
            }
            continue;
          }
          if (k === 'protection') {
            if (g.step === 'combatDamage') continue;
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p));
            for (const r of legal) {
              if (r.kind !== 'card' || !inCombat.has(r.id)) continue;
              const opp = (partners.get(r.id) || []).map(id => g.card(id)).filter(Boolean);
              const cols = new Set();
              for (const o of opp) for (const col of g.colorsOf(o)) cols.add(col);
              for (const col of cols) consider(a, new Map([[r.id, { prot: [col] }]]), 0, cardCost, [[refKey(r)]], null, Object.assign({ protColor: col }, more));
            }
            continue;
          }
          if (k === 'burnAttackers' && !my) {
            const atkC = cb.attackers.map(at => g.card(at.id)).filter(Boolean);
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p)).filter(r => r.kind === 'card');
            const ranked = legal.map(r => g.card(r.id)).filter(c => atkC.includes(c)).sort((x1, y) => cval(g, y) - cval(g, x1));
            const pick = ranked.filter(c => remTough(g, c) <= 2).concat(ranked.filter(c => remTough(g, c) > 2)).slice(0, 2);
            if (!pick.length) continue;
            const mods = new Map();
            let extra = 0;
            for (const c of pick) { if (remTough(g, c) <= 2) { mods.set(c.id, { removed: true }); extra += cval(g, c); } else mods.set(c.id, { dmg: 2 }); }
            consider(a, mods, extra, cardCost, [pick.map(c => refKey(legal.find(r => r.id === c.id)))], null, more);
            continue;
          }
          if (k === 'counters2') {
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p)).filter(r => r.kind === 'card' && ctl(g, g.card(r.id)) === p);
            const pick = legal.filter(r => inCombat.has(r.id)).concat(legal.filter(r => !inCombat.has(r.id))).slice(0, 2);
            if (!pick.length) continue;
            const mods = new Map(pick.filter(r => inCombat.has(r.id)).map(r => [r.id, { p: 1, t: 1 }]));
            consider(a, mods, pick.length * 1.4, cardCost, [pick.map(refKey)], null, more);
            continue;
          }
          if (!['pump', 'burn', 'shrink', 'destroy', 'bounce', 'fight'].includes(k)) continue;
          if (k === 'fight') continue;
          const spec = spellSpecs(def)[0];
          if (!spec) continue;
          const legal = legalFor(g, p, spec, spellItem(card, p));
          for (const r of legal) {
            if (r.kind !== 'card') continue;
            const t = g.card(r.id);
            if (!g.isCreature(t)) continue;
            const mine = ctl(g, t) === p;
            const mods = new Map();
            let extra = 0;
            if (k === 'pump') {
              if (!mine || !inCombat.has(t.id)) continue;
              const ps = pumpStats(g, p, def);
              mods.set(t.id, { p: ps.p, t: ps.t, ds: ps.ds, fs: ps.fs, tr: ps.tr });
            } else if (k === 'burn') {
              if (mine) continue;
              const dmg = burnDamage(g, p, def);
              if (dmg >= remTough(g, t) && !(t.regen > 0)) { mods.set(t.id, { removed: true }); extra = inCombat.has(t.id) ? cval(g, t) : cval(g, t) * 0.9; }
              else if (inCombat.has(t.id)) mods.set(t.id, { dmg: Math.max(0, dmg - shieldsOf(t)) });
              else continue;
            } else if (k === 'shrink') {
              if (mine) continue;
              const n = shrinkN(g, p, def);
              if ((g.toughness(t) || 0) - n <= t.damage) { mods.set(t.id, { removed: true }); extra = cval(g, t); }
              else if (inCombat.has(t.id)) mods.set(t.id, { p: -n, t: -n });
              else continue;
            } else if (k === 'destroy') {
              if (mine || t.regen > 0) continue;
              mods.set(t.id, { removed: true }); extra = cval(g, t);
            } else if (k === 'bounce') {
              if (!inCombat.has(t.id)) continue;
              mods.set(t.id, { removed: true });
              extra = mine ? -(t.token ? cval(g, t) : cval(g, t) * 0.35) : (t.token ? cval(g, t) : cval(g, t) * 0.35);
            }
            consider(a, mods, extra, cardCost + (more.sac ? permVal(g, g.card(more.sac[0])) * 0.8 : 0), [[refKey(r)]], null, more);
          }
        } else if (a.type === 'activate') {
          const ab = g.activatedAbilities(card)[a.ability];
          if (!ab) continue;
          const cls = classifyAbility(ab);
          const cv = abilityCostValue(g, p, card, ab);
          if (cls.kind === 'fog') {
            if (my) continue;
            const v = combatValue(g, p, new Map(), true);
            const gainF = v.value - base.value - cv;
            if (gainF >= minGain + 1) options.push({ a, gain: gainF });
            continue;
          }
          if (cls.kind === 'sacPump') {
            if (!inCombat.has(card.id)) continue;
            const fodder = creaturesOf(g, p).filter(c => c.id !== card.id).sort((x1, y) => (base.dying.has(y.id) ? 1 : 0) - (base.dying.has(x1.id) ? 1 : 0) || permVal(g, x1) - permVal(g, y));
            if (!fodder.length) continue;
            const f = fodder[0];
            const mods = new Map([[card.id, { p: cls.p, t: cls.t, ll: /lifelink/.test(ab.text || '') }]]);
            if (inCombat.has(f.id)) mods.set(f.id, { removed: true });
            consider(a, mods, base.dying.has(f.id) ? 0 : -permVal(g, f), cv, null, [f.id]);
            continue;
          }
          if (cls.kind === 'selfPump' || cls.kind === 'selfKw') {
            if (!inCombat.has(card.id)) continue;
            const mods = new Map([[card.id, cls.kind === 'selfPump' ? { p: cls.p, t: cls.t } : (cls.kw === 'firstStrike' ? { fs: true } : cls.kw === 'trample' ? { tr: true } : {})]]);
            consider(a, mods, 0, cv, null);
          } else if (cls.kind === 'pumpTarget' || cls.kind === 'counterTarget') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            for (const r of legal) {
              if (r.kind !== 'card' || !inCombat.has(r.id) || ctl(g, g.card(r.id)) !== p) continue;
              const pp = cls.kind === 'counterTarget' ? 1 : cls.p, tt = cls.kind === 'counterTarget' ? 1 : cls.t;
              consider(a, new Map([[r.id, { p: pp || 0, t: tt || 0 }]]), cls.kind === 'counterTarget' ? 1.2 : 0, cv, [[refKey(r)]]);
            }
          } else if (cls.kind === 'weakenAb') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            for (const r of legal) {
              if (r.kind !== 'card' || !inCombat.has(r.id) || ctl(g, g.card(r.id)) === p) continue;
              consider(a, new Map([[r.id, { p: -(cls.p || 1) }]]), cls.force ? forceUnit(g, p) : 0, cv, [[refKey(r)]]);
            }
          } else if (cls.kind === 'shrinkAb') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            for (const r of legal) {
              if (r.kind !== 'card') continue;
              const t = g.card(r.id);
              if (!g.isCreature(t) || ctl(g, t) === p) continue;
              if ((g.toughness(t) || 0) - cls.n <= t.damage) consider(a, new Map([[t.id, { removed: true }]]), cval(g, t), cv, [[refKey(r)]]);
              else if (inCombat.has(t.id)) consider(a, new Map([[t.id, { p: -cls.p, t: -cls.n }]]), 0, cv, [[refKey(r)]]);
            }
          } else if (cls.kind === 'ping') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            const sac = ab.cost && ab.cost.sacrifice ? this.cheapestSac(g, p, card, ab) : null;
            if (ab.cost && ab.cost.sacrifice && !sac) continue;
            const sacV = sac ? permVal(g, g.card(sac[0])) : 0;
            for (const r of legal) {
              if (r.kind !== 'card') continue;
              const t = g.card(r.id);
              if (!g.isCreature(t) || ctl(g, t) === p) continue;
              if (cls.n >= remTough(g, t) && !(t.regen > 0)) consider(a, new Map([[t.id, { removed: true }]]), cval(g, t), cv + sacV, [[refKey(r)]], sac);
              else if (inCombat.has(t.id)) consider(a, new Map([[t.id, { dmg: cls.n }]]), 0, cv + sacV, [[refKey(r)]], sac);
            }
          } else if (cls.kind === 'shield') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            for (const r of legal) {
              if (r.kind !== 'card') continue;
              const t = g.card(r.id);
              if (ctl(g, t) !== p || !inCombat.has(t.id)) continue;
              consider(a, new Map([[t.id, { shield: cls.n }]]), 0, cv, [[refKey(r)]]);
            }
          } else if (cls.kind === 'regen') {
            const opt = this.regenOption(g, p, a, card, ab, cls, (c) => inCombat.has(c.id) && base.dying.has(c.id));
            if (!opt) continue;
            const mods = new Map([[opt.target.id, { regen: true }]]);
            consider(a, mods, 0, cv, opt.tg, opt.sac);
          } else if (cls.kind === 'sacOutlet') {
            this.sacOutletOptions(g, p, a, card, ab, cls, base, options, minGain);
          }
        }
      }
      if (!options.length) return null;
      options.sort((x, y) => y.gain - x.gain);
      const o = options[0];
      return this._take(g, o.a, { tg: o.tg, sac: o.sac, protColor: o.protColor, mode: o.mode });
    }

    /** A regeneration ability usable on one of my creatures matching `want`. */
    regenOption(g, p, a, card, ab, cls, want) {
      if (cls.targeted) {
        const legal = legalFor(g, p, ab.targets[0], abilityItem(card, ab, p));
        let best = null;
        for (const r of legal) {
          if (r.kind !== 'card') continue;
          const t = g.card(r.id);
          if (ctl(g, t) !== p || !g.isCreature(t) || t.regen > 0 || !want(t)) continue;
          if (!best || cval(g, t) > cval(g, best.target)) best = { target: t, tg: [[refKey(r)]] };
        }
        return best;
      }
      if (card.regen > 0 || !want(card)) return null;
      let sac = null;
      if (ab.cost && ab.cost.sacrifice) {
        sac = this.cheapestSac(g, p, card, ab);
        if (!sac) return null;
        if (permVal(g, g.card(sac[0])) >= cval(g, card) - 0.5) return null;
      }
      return { target: card, tg: null, sac };
    }

    sacOutletGain(g, p, card, ab, cls) {
      const q = 1 - p;
      let v = 0;
      if (cls.dmg) v += lifeCost(g.players[q].life, 1) + 0.3;
      if (cls.draw) v += 2.4;
      if (cls.recur) {
        const gy = gyOf(g, p).filter(c => g.isCreatureCard(c));
        v += (gy.length ? Math.max(...gy.map(c => sval(c.def))) * 0.5 : -100) + 1.2;
      }
      return v - abilityCostValue(g, p, card, ab);
    }
    sacTargets(g, p, card, ab, cls) {
      const q = 1 - p;
      if (cls.dmg) return [['p' + q]];
      if (!ab.targets || !ab.targets.length) return null;
      const pt = this.planAbilityTargets(g, p, card, ab, [{ k: 'gyReturn' }, { k: 'help' }]);
      return pt ? pt.tg : null;
    }
    sacOutletOptions(g, p, a, card, ab, cls, base, options, minGain) {
      const dying = creaturesOf(g, p).filter(c => base.dying.has(c.id) && c !== card);
      for (const d of dying) {
        const spec = ab.cost && ab.cost.sacrifice;
        if (spec && spec.filter && !safeBool(() => spec.filter(g, d, card))) continue;
        if (spec && spec.other && d === card) continue;
        const gain = this.sacOutletGain(g, p, card, ab, cls);
        if (gain <= 0) continue;
        const v = combatValue(g, p, new Map([[d.id, { removed: true }]]), false);
        const total = v.value - cval(g, d) - base.value + gain;
        const tg = this.sacTargets(g, p, card, ab, cls);
        if (ab.targets && ab.targets.length && !tg) continue;
        if (total >= minGain) options.push({ a, gain: total, tg, sac: [d.id] });
      }
    }

    // ----- end steps: spend Force / instant-speed value ------------------------------------
    /** Instant-speed activations worth using at an end step (both turns). */
    endStepOptions(g, p, acts, myTurn) {
      const q = 1 - p;
      const options = [];
      const lib = g.players[p].library.length;
      for (const a of acts) {
        if (a.type !== 'activate' || !this._allowed(a, 1)) continue;
        const card = g.card(a.cardId);
        const ab = g.activatedAbilities(card)[a.ability];
        if (!ab) continue;
        const cls = classifyAbility(ab);
        const cv = abilityCostValue(g, p, card, ab);
        // tapping a creature on our own end step costs it as a blocker
        const tapPen = myTurn && ab.cost && ab.cost.tap && g.isCreature(card) ? 1 + (g.power(card) || 0) * 0.3 : 0;
        switch (cls.kind) {
          case 'loot': if (lib > 3 && handOf(g, p).length) options.push({ a, gain: 1.4 - cv - tapPen }); break;
          case 'drawAb': {
            if (lib <= 3) break;
            let sac = null, sv = 0;
            if (ab.cost && ab.cost.sacrifice) { sac = this.cheapestSac(g, p, card, ab); if (!sac) break; sv = permVal(g, g.card(sac[0])); }
            options.push({ a, gain: 2.4 - cv - tapPen - sv, sac });
            break;
          }
          case 'jammer': if (!myTurn) options.push({ a, gain: 2.4 - cv - 1 }); break;
          case 'scry': options.push({ a, gain: 0.25 * (cls.n || 1) + 0.2 - cv }); break;
          case 'dig': options.push({ a, gain: (cls.land ? (landsOf(g, p).length < 6 ? 1.8 : 0.5) : 2.6) - cv - tapPen }); break;
          case 'drainAb': {
            const n = cls.n || 2;
            const v = g.players[q].life <= n ? 1000 : lifeCost(g.players[q].life, n) * 0.9 + (cls.gain ? lifeGainV(g.players[p].life, n) : 0) - cv;
            options.push({ a, gain: v, tg: cls.targeted ? [['p' + q]] : null });
            break;
          }
          case 'lifeAb': options.push({ a, gain: lifeGainV(g.players[p].life, cls.n || 2) * 1.2 - cv }); break;
          case 'ping': {
            if (cls.combatOnly || cls.damagedOnly) break;
            const pt = this.planAbilityTargets(g, p, card, ab, { k: 'burn', dmg: cls.n });
            const sac = ab.cost && ab.cost.sacrifice ? this.cheapestSac(g, p, card, ab) : null;
            if (ab.cost && ab.cost.sacrifice && !sac) break;
            if (pt && pt.tg[0] && pt.tg[0].length && pt.first > 0.3) options.push({ a, gain: Math.min(1000, pt.first) - cv * 0.8 - tapPen - (sac ? permVal(g, g.card(sac[0])) : 0), tg: pt.tg, sac });
            break;
          }
          case 'weakenAb': if (cls.force && !myTurn) { const pt = this.planAbilityTargets(g, p, card, ab, { k: 'harm', sub: 'other' }); options.push({ a, gain: forceGainValue(g, p, 1) - cv + 0.2, tg: pt ? pt.tg : null }); } break;
          case 'forceAb': options.push({ a, gain: forceGainValue(g, p, cls.n) - cv }); break;
          case 'counterTarget': {
            if (ab.sorcery) break;
            const pt = this.planAbilityTargets(g, p, card, ab, { k: 'help' });
            if (pt && pt.first > 0) options.push({ a, gain: 2 - cv + (cls.untap && !myTurn ? 0.2 : 0), tg: pt.tg });
            break;
          }
          case 'token': if (!ab.sorcery) options.push({ a, gain: (cls.big ? 6 : 4) - cv }); break;
          case 'gyHate': {
            const pt = this.planAbilityTargets(g, p, card, ab, { k: 'gyHate' });
            if (pt && pt.tg[0] && pt.tg[0].length) {
              const t = g.card(Number(pt.tg[0][0].slice(1)));
              const v = pt.first * 0.6 + (cls.drain && t && g.isCreatureCard(t) && t.owner !== p ? lifeCost(g.players[q].life, 2) : 0) - cv;
              options.push({ a, gain: v, tg: pt.tg });
            }
            break;
          }
          case 'chargeAdd': if (!myTurn || !(ab.cost && ab.cost.mana)) options.push({ a, gain: 0.6 - cv }); break;
          case 'selfMill': if (!myTurn) options.push({ a, gain: 0.5 - cv }); break;
          case 'recursion': {
            if (ab.sorcery) break;
            const pt = this.planAbilityTargets(g, p, card, ab, { k: 'gyReturn' });
            const sac = ab.cost && ab.cost.sacrifice ? this.cheapestSac(g, p, card, ab) : null;
            if (ab.cost && ab.cost.sacrifice && !sac) break;
            if (pt && pt.first >= 3) options.push({ a, gain: pt.first * 0.6 - cv - (sac ? permVal(g, g.card(sac[0])) : 0), tg: pt.tg, sac });
            break;
          }
          case 'sacOutlet': {
            if (cls.dmg && g.players[q].life <= 1) options.push({ a, gain: 1000, tg: [['p' + q]], sac: this.cheapestSac(g, p, card, ab) });
            else if (cls.draw && lib > 4 && !ab.sorcery) {
              const sac = this.cheapestSac(g, p, card, ab);
              if (sac) { const v = permVal(g, g.card(sac[0])); const gain = cls.draw * 2.4 - v - cv; if (gain > 0.3) options.push({ a, gain, sac }); }
            }
            break;
          }
          default: break;
        }
      }
      return options;
    }
    endStepSinks(g, p, acts, myTurn) {
      if (this.level === 'easy') return null;
      const good = this.endStepOptions(g, p, acts, myTurn).filter(o => o.gain > 0.3);
      if (!good.length) return null;
      good.sort((x, y) => y.gain - x.gain);
      const o = good[0];
      return this._take(g, o.a, { tg: o.tg, sac: o.sac });
    }

    oppEndStep(g, p, acts) {
      const options = this.level === 'easy' ? [] : this.endStepOptions(g, p, acts, false);
      const hand = handOf(g, p);
      for (const x of this.entries(g, acts)) {
        const a = x.a, card = x.card;
        if (a.type !== 'cast' || !this._allowed(a, 1)) continue;
        if (this.level === 'easy') continue;
        const def = card.def;
        const k = spellKind(def);
        const K = kb(def.name);
        const ti = textInfo(def.__base || def);
        const fv = forceGainValue(g, p, ti.spellForce);
        const sac = evalSacOf(g, p, card);
        const sacV = sac ? permVal(g, g.card(sac[0])) : 0;
        const more = { mode: x.mode, sac };
        if (['burn', 'destroy', 'shrink', 'permHarm'].includes(k)) {
          if (K.combatOnly) continue;
          const pt = planSpellTargets(g, p, card, spellEff(g, p, def, {}));
          if (!pt || !pt.tg[0].length) continue;
          if (pt.first >= 1000) { options.push(Object.assign({ a, gain: 1000, tg: pt.tg }, more)); continue; }
          if (pt.first >= 4) options.push(Object.assign({ a, gain: pt.first - 2.5 + fv - sacV }, more, { tg: pt.tg }));
        } else if (k === 'bounce') {
          const pt = planSpellTargets(g, p, card, spellEff(g, p, def));
          if (!pt || !pt.tg[0].length) continue;
          const t = refObj(g, { kind: 'card', id: Number(pt.tg[0][0].slice(1)) });
          if (t && t.token && pt.first >= 2) options.push(Object.assign({ a, gain: pt.first - 1.5 }, more, { tg: pt.tg }));
        } else if (k === 'recursion' && (isInstantDef(def) || def.keywords.includes('flash'))) {
          const pt = planSpellTargets(g, p, card, { k: 'gyReturn' });
          if (pt && pt.total >= 4) options.push(Object.assign({ a, gain: pt.total * 0.5 + (K.draw ? 2.2 : 0) - 1 }, more, { tg: pt.tg }));
        } else if (k === 'draw' && isInstantDef(def)) {
          options.push(Object.assign({ a, gain: (K.v || 3) - 1 + fv }, more));
        } else if (k === 'counters2') {
          const pt = planSpellTargets(g, p, card, { k: 'help' });
          if (pt && pt.tg[0] && pt.tg[0].length) options.push(Object.assign({ a, gain: pt.tg[0].length * 1.6 - 1.2 }, more, { tg: pt.tg }));
        } else if (isCreatureDef(def) && def.keywords.includes('flash')) {
          const e = evalSpell(g, p, card, 'main2', { level: this.level });
          if (e && e.score > 2) options.push(Object.assign({ a, gain: e.score - 1 }, more, { tg: e.tg }));
        }
        void hand;
      }
      const good = options.filter(o => o.gain > 0.3);
      if (!good.length) return null;
      good.sort((x, y) => y.gain - x.gain);
      const o = good[0];
      return this._take(g, o.a, { tg: o.tg, sac: o.sac, mode: o.mode });
    }

    // ----- responses ------------------------------------------------------------------------------
    respond(g, p, d, acts) {
      const top = g.stack[g.stack.length - 1];
      if (!top || top.controller === p) return null;
      if (this.level === 'easy') return null;
      const q = 1 - p;
      const info = itemInfo(g, p, top);
      const options = [];
      const srcCols = (() => { try { return info.src ? g.colorsOf(info.src) : []; } catch (e) { return []; } })();
      const x0 = info.mine[0];
      const lethalTo = (x) => x && (info.harm === 'destroy' || (info.harm === 'damage' && info.dmg >= remTough(g, x)) || (info.harm === 'shrink' && g.toughness(x) - info.n <= x.damage));
      for (const ent of this.entries(g, acts)) {
        const a = ent.a, card = ent.card;
        if (!this._allowed(a, 1)) continue;
        if (a.type === 'cast') {
          const def = card.def;
          const k = spellKind(def);
          const K = kb(def.name);
          const more = { mode: ent.mode, sac: evalSacOf(g, p, card) };
          if (k === 'counter') {
            const legal = legalFor(g, p, spellSpecs(def)[0] || { type: 'spell' }, spellItem(card, p));
            const r = legal.find(x => x.kind === 'stack' && x.sid === top.sid);
            if (!r) continue;
            const tax = K.tax || hintOf(def).soft || 0;
            if (tax && canAfford(g, q, genericCost(tax))) continue;
            const bonus = forceGainValue(g, p, textInfo(def.__base || def).spellForce);
            if (info.impact >= 4.5 - Math.min(1.5, bonus)) options.push(Object.assign({ a, gain: info.impact - 3 + bonus, tg: [[refKey(r)]] }, more));
            continue;
          }
          if (k === 'redirect') {
            if (top.kind !== 'spell' || !info.single || info.impact < 3) continue;
            if (!(info.mine.length || info.targetsMe)) continue;
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p));
            const r = legal.find(x => x.kind === 'stack' && x.sid === top.sid);
            if (r) options.push(Object.assign({ a, gain: info.impact - 2, tg: [[refKey(r)]] }, more));
            continue;
          }
          // kill the target of their pump/aura in response
          if ((k === 'burn' || k === 'shrink' || k === 'destroy') && top.kind === 'spell' && info.theirTargets.length && ['pump', 'auraBuff', 'protection', 'equipment', 'refit', 'pumpRegen'].includes(spellKind(top.card.def)) && !kb(def.name).combatOnly) {
            const t = info.theirTargets[0];
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p));
            const r = legal.find(x => x.kind === 'card' && x.id === t.id);
            if (!r) continue;
            const s = scoreRef(g, p, r, spellEff(g, p, def));
            if (s >= 3) options.push(Object.assign({ a, gain: s + 3 - 2.5, tg: [[refKey(r)]] }, more));
            continue;
          }
          if (x0 && info.harm) {
            const xv = cval(g, x0);
            const legal = () => legalFor(g, p, spellSpecs(def)[0], spellItem(card, p));
            if (k === 'protection' && srcCols.length && info.harm !== 'edict' && info.harm !== 'wrath') {
              const r = legal().find(y => y.kind === 'card' && y.id === x0.id);
              if (r && info.impact >= 2.5) options.push(Object.assign({ a, gain: info.impact - 2, tg: [[refKey(r)]], protColor: srcCols[0] }, more));
            } else if (k === 'pumpRegen' && lethalTo(x0) && info.harm !== 'bounce') {
              const r = legal().find(y => y.kind === 'card' && y.id === x0.id);
              if (r && info.impact >= 2.5) options.push(Object.assign({ a, gain: info.impact - 2, tg: [[refKey(r)]] }, more));
            } else if (k === 'pump' && (info.harm === 'damage' || info.harm === 'shrink')) {
              const tb = pumpStats(g, p, def).t;
              const survives = info.harm === 'damage' ? info.dmg < remTough(g, x0) + tb : (g.toughness(x0) + tb - info.n > x0.damage);
              const r = legal().find(y => y.kind === 'card' && y.id === x0.id);
              if (survives && r && tb > 0 && info.impact >= 2.5) options.push(Object.assign({ a, gain: xv - 2.5 + forceGainValue(g, p, textInfo(def.__base || def).spellForce), tg: [[refKey(r)]] }, more));
            } else if (k === 'flicker' && !x0.token && (lethalTo(x0) || ['aura', 'steal', 'bounce'].includes(info.harm))) {
              const r = legal().find(y => y.kind === 'card' && y.id === x0.id);
              if (r && info.impact >= 2.5) options.push(Object.assign({ a, gain: info.impact - 2 + etbReplayValue(g, p, x0) * 0.5, tg: [[refKey(r)]] }, more));
            } else if (k === 'bounce' && !x0.token && ['destroy', 'damage', 'shrink', 'aura', 'steal'].includes(info.harm) && lethalTo(x0)) {
              const r = legal().find(y => y.kind === 'card' && y.id === x0.id);
              if (r && xv >= 6) options.push(Object.assign({ a, gain: xv * 0.6 - 2.5 + etbReplayValue(g, p, x0) * 0.5, tg: [[refKey(r)]] }, more));
            }
          }
          // wrath on the stack: cash in a flicker on our best creature
          if (k === 'flicker' && top.kind === 'spell' && info.harm === 'wrath') {
            const legal = legalFor(g, p, spellSpecs(def)[0], spellItem(card, p)).filter(r => r.kind === 'card');
            const best = legal.map(r => g.card(r.id)).filter(c => !c.token).sort((x1, y) => cval(g, y) - cval(g, x1))[0];
            if (best) options.push(Object.assign({ a, gain: cval(g, best) - 2.5, tg: [[refKey(legal.find(r => r.id === best.id))]] }, more));
          }
        } else if (a.type === 'activate') {
          const ab = g.activatedAbilities(card)[a.ability];
          if (!ab) continue;
          const cls = classifyAbility(ab);
          const cv = abilityCostValue(g, p, card, ab, { reserved: true });
          if (cls.kind === 'taxCounter' && top.kind === 'spell') {
            const legal = legalFor(g, p, ab.targets[0], abilityItem(card, ab, p));
            const r = legal.find(x => x.kind === 'stack' && x.sid === top.sid);
            if (!r) continue;
            if (cls.tax && canAfford(g, q, genericCost(cls.tax))) continue;
            if (info.impact >= 3) options.push({ a, gain: info.impact - cv, tg: [[refKey(r)]] });
            continue;
          }
          // wrath on the stack: sacrifice outlets
          if (top.kind === 'spell' && info.harm === 'wrath') {
            const mine = creaturesOf(g, p);
            const n = info.n || 99;
            const doomed = info.n ? mine.filter(c => (g.toughness(c) || 0) - n <= (c.damage || 0) && !(info.nonFly && g.has(c, 'flying'))) : mine;
            if (cls.kind === 'sacOutlet') {
              const fodder = doomed.filter(c => c !== card && !(ab.cost.sacrifice && ab.cost.sacrifice.filter && !safeBool(() => ab.cost.sacrifice.filter(g, c, card))));
              const gain = this.sacOutletGain(g, p, card, ab, cls);
              const tg = this.sacTargets(g, p, card, ab, cls);
              if (fodder.length && gain > 0 && (tg || !ab.targets || !ab.targets.length)) {
                fodder.sort((x1, y) => cval(g, x1) - cval(g, y));
                options.push({ a, gain: gain + 0.5, tg, sac: [fodder[0].id] });
              }
            } else if (cls.kind === 'regen' && info.n && doomed.includes(card)) {
              const opt = this.regenOption(g, p, a, card, ab, cls, (c) => doomed.includes(c));
              if (opt) options.push({ a, gain: cval(g, opt.target) - cv, tg: opt.tg, sac: opt.sac });
            }
            continue;
          }
          if (cls.kind === 'gyHate' && info.gyTargets.length && info.impact >= 3) {
            const gt = info.gyTargets[0];
            const legal = legalFor(g, p, ab.targets[0], abilityItem(card, ab, p));
            const r = legal.find(y => y.kind === 'card' && y.id === gt.id);
            if (r) options.push({ a, gain: info.impact - cv - 0.5, tg: [[refKey(r)]] });
            continue;
          }
          if (!x0 || !info.harm) continue;
          const xv = cval(g, x0);
          const lethal = lethalTo(x0);
          if (cls.kind === 'hexAb') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            const r = legal.find(y => y.kind === 'card' && y.id === x0.id);
            if (r && info.impact >= 2.5 && info.harm !== 'wrath' && info.harm !== 'edict') options.push({ a, gain: info.impact - cv, tg: [[refKey(r)]] });
            continue;
          }
          if (cls.kind === 'shield' && info.harm === 'damage') {
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            const r = legal.find(y => y.kind === 'card' && y.id === x0.id);
            if (r && info.dmg >= remTough(g, x0) && info.dmg - cls.n < remTough(g, x0) && info.impact >= 2) options.push({ a, gain: info.impact - cv, tg: [[refKey(r)]] });
            continue;
          }
          if (cls.kind === 'selfPump' && card.id === x0.id && cls.t > 0) {
            const survives = info.harm === 'damage' ? info.dmg < remTough(g, x0) + cls.t : (info.harm === 'shrink' && g.toughness(x0) + cls.t - info.n > x0.damage);
            if (survives && lethal) options.push({ a, gain: info.impact - cv });
            continue;
          }
          if (cls.kind === 'pumpTarget' && cls.t > 0 && (info.harm === 'damage' || info.harm === 'shrink')) {
            const survives = info.harm === 'damage' ? info.dmg < remTough(g, x0) + cls.t : (g.toughness(x0) + cls.t - info.n > x0.damage);
            const legal = legalFor(g, p, (ab.targets || [])[0] || { type: 'creature' }, abilityItem(card, ab, p));
            const r = legal.find(y => y.kind === 'card' && y.id === x0.id);
            if (survives && r && lethal) options.push({ a, gain: info.impact - cv, tg: [[refKey(r)]] });
            continue;
          }
          if (cls.kind === 'regen' && (info.harm === 'destroy' || (info.harm === 'damage' && lethal))) {
            const opt = this.regenOption(g, p, a, card, ab, cls, (c) => c.id === x0.id);
            if (opt) {
              const sv = opt.sac ? permVal(g, g.card(opt.sac[0])) : 0;
              if (xv - sv - cv > 1) options.push({ a, gain: xv - sv - cv, tg: opt.tg, sac: opt.sac });
            }
            continue;
          }
          if (cls.kind === 'bounceOwn' && card.id !== x0.id && !x0.token && (lethal || ['aura', 'steal'].includes(info.harm))) {
            const legal = legalFor(g, p, ab.targets[0], abilityItem(card, ab, p));
            const r = legal.find(y => y.kind === 'card' && y.id === x0.id);
            if (r && info.impact >= 2.5) options.push({ a, gain: info.impact * 0.7 - cv + lifeGainV(g.players[p].life, g.toughness(x0) || 0), tg: [[refKey(r)]] });
            continue;
          }
          if (cls.kind === 'sacOutlet' && card.id !== x0.id && (lethal || info.harm === 'aura' || info.harm === 'steal') && info.impact >= xv * 0.7) {
            const spec = ab.cost && ab.cost.sacrifice;
            if (spec && spec.filter && !safeBool(() => spec.filter(g, x0, card))) continue;
            const gain = this.sacOutletGain(g, p, card, ab, cls);
            const tg = this.sacTargets(g, p, card, ab, cls);
            if (ab.targets && ab.targets.length && !tg) continue;
            if (gain > -0.5) options.push({ a, gain: gain + 1, tg, sac: [x0.id] });
            continue;
          }
        }
      }
      const good = options.filter(o => o.gain > 0.5);
      if (!good.length) return null;
      good.sort((x, y) => y.gain - x.gain);
      const o = good[0];
      return this._take(g, o.a, { tg: o.tg, sac: o.sac, protColor: o.protColor, mode: o.mode });
    }

    // ----- mana payment ------------------------------------------------------------------------------
    payMana(g, p, d) {
      if (d.optional) {
        const yes = this.wantOptionalPayment(g, p, d);
        if (yes && d.canAuto) return { type: 'auto' };
        return d.cancellable ? { type: 'cancel' } : { type: 'auto' };
      }
      if (!d.canAuto) return d.cancellable ? { type: 'cancel' } : { type: 'auto' };
      if (this.level !== 'easy' && this.plan && this.plan.future && U.costTotal(this.plan.future) > 0 && d.sourceId === this.plan.cardId && !d.diverse) {
        const step = this.smartTap(g, p, d.cost, this.plan.future, d.exclude);
        if (step) return step;
      }
      return { type: 'auto' };
    }

    smartTap(g, p, remaining, future, exclude) {
      let plan = null;
      const ex = new Set(exclude || []);
      try { plan = g.solveMana(p, remaining, { exclude: ex }); } catch (e) { plan = null; }
      if (!plan) return null;
      const excl = new Set(plan.map(s => s.card.id).concat([...ex]));
      let ok = false;
      try { ok = g.canAfford(p, future, { exclude: excl }); } catch (e) { ok = true; }
      if (ok) return null;
      const acts = g.legalActions(p).filter(a => a.type === 'mana' && !ex.has(a.cardId));
      const cands = [];
      for (const a of acts) {
        const c = g.card(a.cardId);
        const ab = g.activatedAbilities(c)[a.ability];
        if (!ab || !ab.mana || ab.mana.spendOnly || (ab.cost && (ab.cost.mana || ab.cost.removeCounters || ab.cost.force || ab.cost.tapCreature))) continue;
        let units = [];
        try { units = g._manaUnits(c, ab); } catch (e) { units = []; }
        if (!units.length) continue;
        const choices = units.includes('ANY') ? COLORS.map(col => units.map(u => u === 'ANY' ? col : u)) : [units];
        for (const us of choices) {
          const rem = U.cloneCost(remaining);
          let useful = 0;
          for (const col of us) {
            if (col !== 'C' && rem[col] > 0) { rem[col]--; useful++; continue; }
            if (col === 'C' && rem.C > 0) { rem.C--; useful++; continue; }
            const hi = (rem.hybrid || []).findIndex(h => h.includes(col));
            if (hi >= 0) { rem.hybrid.splice(hi, 1); useful++; continue; }
            if (rem.generic > 0) { rem.generic--; useful++; }
          }
          if (!useful || useful < us.length) continue;
          const tier = g.isLand(c) ? 0 : g.isCreature(c) ? 2 : 1;
          const col = units.includes('ANY') ? us[0] : undefined;
          const fut = sum(us, u => u === 'C' ? 0 : (future[u] || 0));
          cands.push({ a, col, rem, tier, any: units.includes('ANY'), futNeed: fut });
        }
      }
      cands.sort((x, y) => x.tier - y.tier || x.any - y.any || x.futNeed - y.futNeed);
      for (const cnd of cands) {
        let fine = false;
        try { fine = g.canAfford(p, U.addCosts(cnd.rem, future), { exclude: new Set([cnd.a.cardId, ...ex]) }); } catch (e) { fine = false; }
        if (fine) return { type: 'mana', cardId: cnd.a.cardId, ability: cnd.a.ability, color: cnd.col };
      }
      return null;
    }

    wantOptionalPayment(g, p, d) {
      const prompt = d.prompt || '';
      if (/countered/.test(prompt) || d.reason === 'attackTax') return true;
      if (this.level === 'easy') return true;
      const my = g.activePlayer === p;
      if (d.reason === 'tapUnlessPay') {
        // keep a creature untapped: worth it on the opponent's turn (a blocker) unless mana is needed
        return !my || availMana(g, p) >= 4;
      }
      if (my && (g.step === 'main1' || g.step === 'main2')) {
        const pend = handOf(g, p).filter(c => !isLandDef(c.def) && !isInstantDef(c.def));
        const cheapest = pend.length ? pend.reduce((a, b) => a.def.manaValue <= b.def.manaValue ? a : b) : null;
        if (cheapest && canAfford(g, p, cheapest.def.cost) && !canAfford(g, p, U.addCosts(cheapest.def.cost, d.cost)) && U.costTotal(d.cost) <= 2) return false;
      }
      if (/draw/i.test(prompt) && g.players[p].library.length <= 3) return false;
      return true;
    }

    // ----- targets ---------------------------------------------------------------------------------
    chooseTargets(g, p, d) {
      const legal = d.legal;
      const plan = this.plan;
      if (d.reason === 'redirect') return this.redirectTarget(g, p, d);
      if (plan && plan.tg && plan.cardId === d.sourceId && plan.tg[d.index]) {
        const want = plan.tg[d.index];
        const refs = [];
        for (const k of want) { const r = legal.find(x => refKey(x) === k); if (r) refs.push(r); }
        if (refs.length >= d.min && refs.length <= d.max && (!d.groupCheck || !d.groupCheck(refs))) return { targets: refs };
      }
      const eff = this.effForDecision(g, p, d);
      const groupFn = d.groupCheck ? (refs) => d.groupCheck(refs) : null;
      const sel = selectRefs(g, legal, r => scoreRef(g, p, r, eff), d.min, d.max, groupFn);
      if (!sel) return d.cancellable ? { cancel: true } : null;
      if (d.cancellable && sel.length && sum(sel, r => scoreRef(g, p, r, eff)) < 0 && !(plan && plan.cardId === d.sourceId && plan.forced)) return { cancel: true };
      return { targets: sel };
    }

    /** Redirect the Batteries: the best new target for the redirected spell from our point of view. */
    redirectTarget(g, p, d) {
      const s = g.stack.find(x => x.sid === d.stackSid);
      if (!s || !s.card) return { targets: [] };
      let def = s.card.def;
      if (isModal(def) && s.modeIndex !== undefined && s.modeIndex !== null) def = modeDef(def, s.modeIndex);
      const e0 = spellEff(g, s.controller, def, {});
      const i = (s.targets || []).findIndex(l => l.length === 1);
      const eff = Array.isArray(e0) ? (e0[i] || e0[0]) : e0;
      const cur = i >= 0 ? scoreRef(g, p, s.targets[i][0], eff) : 0;
      let best = null, bs = cur + 0.5;
      for (const r of d.legal) { const sc = scoreRef(g, p, r, eff); if (sc > bs) { bs = sc; best = r; } }
      return { targets: best ? [best] : (d.min > 0 ? [d.legal[0]] : []) };
    }

    effForDecision(g, p, d) {
      const src = d.sourceId ? g.card(d.sourceId) : null;
      if (!src) return { k: 'harm', sub: 'other' };
      let def = src.def;
      const zone = src.zone;
      const st = d.spec || {};
      const typ = Array.isArray(st.type) ? st.type : [st.type];
      if ((zone === 'stack' || zone === 'hand' || zone === 'graveyard') && !isCreatureDef(def) && (def.spell || def.subtypes.includes('Aura'))) {
        if (isModal(def)) {
          const item = g.stack.find(s => s.card === src);
          const mi = this.plan && this.plan.cardId === src.id && this.plan.mode ? parseInt(String(this.plan.mode).slice(1), 10) : (item ? item.modeIndex : 0);
          def = modeDef(def, mi || 0);
        }
        const e = spellEff(g, p, def, { level: this.level });
        return Array.isArray(e) ? (e[d.index || 0] || e[0]) : e;
      }
      const ab = (this.plan && this.plan.type === 'activate' && this.plan.cardId === src.id) ? g.activatedAbilities(src)[this.plan.ability] : null;
      if (ab) {
        const cls = classifyAbility(ab);
        if (cls.kind === 'ping') return { k: 'burn', dmg: cls.n };
        if (cls.kind === 'shield') return { k: 'shield' };
        if (['evasionAb', 'pumpTarget', 'equip', 'regen', 'untapper', 'counterTarget', 'hexAb', 'reachAb', 'bounceOwn'].includes(cls.kind)) return { k: 'help' };
        if (cls.kind === 'assassin') return { k: 'harm', sub: 'exile' };
        if (cls.kind === 'shrinkAb') return { k: 'harm', sub: 'shrink', n: cls.n };
        if (cls.kind === 'weakenAb') return { k: 'harm', sub: 'other' };
        if (cls.kind === 'tapper') return { k: 'harm', sub: 'tap' };
        if (cls.kind === 'gyHate') return { k: 'gyHate' };
        if (cls.kind === 'recursion' || (cls.kind === 'sacOutlet' && cls.recur && (d.index || 0) === 0)) return { k: 'gyReturn' };
        if (cls.kind === 'artKill') return { k: 'permHarm' };
        if (cls.kind === 'sacOutlet' || cls.kind === 'drainAb') return { k: 'playerHarm' };
        if (cls.kind === 'taxCounter') return { k: 'counter' };
      }
      // triggered abilities: by the card's text
      const r = rulesOf(def);
      const prompt = d.prompt || '';
      const txt = prompt + ' ' + r;
      if (typ.includes('card')) {
        if (/your graveyard/.test(prompt) || (/from your graveyard/.test(r) && !/from a graveyard/.test(prompt))) return { k: 'gyReturn' };
        return { k: 'gyHate' };
      }
      if (typ.includes('spell')) return { k: 'counter' };
      // Check bounce BEFORE generic /you control/ so Unexpected Delegation & Cloudbank Courier never treat self-bounce as 'help'!
      if (/[Rr]eturn (up to one )?(other )?target (permanent|artifact|creature) you control to its owner/i.test(r)) {
        return { k: 'bounceOwn', sourceId: src.id };
      }
      if (/[Rr]eturn (up to one )?(other )?target creature.*to its owner/i.test(r)) {
        return { k: 'harm', sub: 'bounce' };
      }
      if (src.name === 'Comms Disruptor' || /[Tt]ap up to one target/i.test(r)) return { k: 'harm', sub: 'tap' };
      if (/you control|another target creature you control|other target attacking|another target attacking/.test(prompt)) return { k: 'help' };
      if (/[Uu]ntap|\+1\/\+1 counter|gets \+|gains (first strike|flying|vigilance)/.test(prompt)) return { k: 'help' };
      if (/[Pp]revent/.test(prompt)) return { k: 'shield' };
      if (/[Ee]xile (up to one )?target (artifact )?creature/.test(txt) && !/you control/.test(prompt)) return { k: 'harm', sub: 'exile' };
      if (/[Tt]ap /.test(prompt)) return { k: 'harm', sub: 'tap' };
      if (/[Rr]eturn (up to one )?target creature you don't control|you don't control to its owner/.test(txt)) return { k: 'harm', sub: 'bounce' };
      if (/[Dd]estroy (up to one )?target artifact/.test(txt)) return { k: 'permHarm' };
      if (/damage/.test(prompt) || typ.includes('any')) { const m = /(\d+) damage/.exec(txt); return { k: 'burn', dmg: m ? parseInt(m[1], 10) : 1 }; }
      if (/opponent/.test(prompt) || typ.includes('opponent')) return { k: 'playerHarm' };
      return inferEffFromText(def);
    }

    // ----- chooseCards ------------------------------------------------------------------------------
    chooseCards(g, p, d) {
      const cards = d.cards.map(id => g.card(id));
      const reason = d.reason || 'misc';
      const plan = this.plan;
      const pickTop = (scoreFn, n) => cards.slice().sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, n).map(c => c.id);
      const pickLow = (scoreFn, n) => cards.slice().sort((a, b) => scoreFn(a) - scoreFn(b)).slice(0, n).map(c => c.id);
      const src = d.sourceId ? g.card(d.sourceId) : null;
      const srcName = src ? src.name : '';
      const lib = g.players[p].library.length;
      let out;
      switch (reason) {
        case 'mulliganBottom': out = this.mulliganBottom(g, p, cards, d.min); break;
        case 'discard': case 'cleanupDiscard': out = chooseWorst(g, p, cards, d.min).map(c => c.id); break;
        case 'discardCost': {
          if (plan && plan.discard && plan.discard.every(id => d.cards.includes(id)) && plan.discard.length >= d.min) { out = plan.discard.slice(0, Math.max(d.min, 1)); break; }
          const bonus = srcName === 'Scour for Parts' ? (c) => (isArtifactDef(c.def) ? forceGainValue(g, p, 2) : 0) : null;
          out = chooseWorst(g, p, cards, Math.max(d.min, 1), bonus).map(c => c.id);
          break;
        }
        case 'optionalDiscard': {
          // Beskar Scrapper / Junkyard Test Pilot: discard a weak card to draw
          if (lib <= 2) { out = []; break; }
          const w = chooseWorst(g, p, cards, 1)[0];
          out = w && handValue(g, p, w, handOf(g, p)) < 2.6 ? [w.id] : [];
          break;
        }
        case 'sacrifice': if (d.optional || (d.min === 0 && d.max >= 1)) { out = this.optionalSacrifice(g, p, d, cards); break; }
          out = pickLow(c => permVal(g, c) + (c.token ? -1 : 0) - (kb(c.name).dv || 0), d.min); break;
        case 'sacrificeCost': {
          if (plan && plan.sac && plan.sac.every(id => d.cards.includes(id)) && plan.sac.length >= d.min && plan.sac.length <= d.max) { out = plan.sac.slice(); break; }
          if (d.cancellable && this.level !== 'easy' && !(plan && plan.cardId === d.sourceId)) { out = null; break; }
          const sp = sacPlan(g, p, cards, d.sourceId);
          out = sp ? [sp.card.id] : pickLow(c => permVal(g, c), Math.max(d.min, 1));
          if (d.min > out.length) out = pickLow(c => permVal(g, c) + (c.id === d.sourceId ? 100 : 0), d.min);
          break;
        }
        case 'optionalSacrifice': out = this.optionalSacrifice(g, p, d, cards); break;
        case 'exileCost': out = pickLow(c => (g.isCreatureCard(c) ? sval(c.def) * 0.5 : 0.5) + (c.def.afterimage ? 2 : 0) + (c.name === 'Darth Sion, Held by Pain' ? 10 : 0), d.min); break;
        case 'exileFromGraveyard': {
          // Tuk'ata: exile the least useful creature card for +1/+1 and 2 Force (it's free value)
          const sc = (c) => sval(c.def) + (c.def.afterimage ? 2 : 0) + (c.name === 'Darth Sion, Held by Pain' ? 10 : 0);
          out = d.max >= 1 ? pickLow(sc, 1) : [];
          if (out.length && sc(g.card(out[0])) > 12 && d.min === 0) out = [];
          if (d.min > out.length) out = pickLow(sc, d.min);
          break;
        }
        case 'inherit': out = d.max < 1 ? [] : pickLow(c => sval(c.def), 1); break;
        case 'legendRule': out = pickTop(c => (g.isCreature(c) ? cval(g, c) : permVal(g, c)) + (c.tapped ? -0.5 : 0) + (c.counters.p1p1 || 0), 1); break;
        case 'search': {
          if (cards.every(c => isLandDef(c.def))) {
            const have = colorSourceCounts(g, p);
            const hand = handOf(g, p);
            const chosen = [];
            const pool = cards.slice();
            for (let i = 0; i < d.max && pool.length; i++) {
              pool.sort((a, b) => landScore(g, p, b.def, hand, have) - landScore(g, p, a.def, hand, have));
              const c = pool.shift();
              chosen.push(c.id);
              for (const col of producedColors(c.def)) have[col]++;
            }
            out = chosen;
          } else {
            const sc = (c) => (isCreatureDef(c.def) ? sval(c.def) : ncVal(c.def)) + (c.backDef ? Math.max(0, sval(c.backDef) - sval(c.def)) : 0) - (c.def.supertypes.includes('Legendary') && bf(g).some(x => x.name === c.name && ctl(g, x) === p) ? 50 : 0);
            out = pickTop(sc, Math.max(d.min, Math.min(1, d.max)));
          }
          break;
        }
        case 'toBattlefield': {
          const have = colorSourceCounts(g, p);
          const hand = handOf(g, p).filter(c => !d.cards.includes(c.id) || !isLandDef(c.def));
          if (cards.every(c => isLandDef(c.def))) {
            const sc = (c) => landScore(g, p, c.def, hand, have) + (c.def.entersTapped ? -0.3 : 0);
            out = pickTop(sc, Math.max(d.min, d.max));
          } else out = pickTop(c => isCreatureDef(c.def) ? sval(c.def) : permVal(g, c), Math.max(d.min, Math.min(d.max, 1)));
          break;
        }
        case 'toHand': {
          const hand = handOf(g, p);
          out = pickTop(c => handValue(g, p, c, hand), Math.max(d.min, Math.min(1, d.max)));
          break;
        }
        case 'toGraveyard': {
          const hand = handOf(g, p);
          if (d.min === 0) out = cards.filter(c => handValue(g, p, c, hand) < 2 || (c.def.afterimage && handValue(g, p, c, hand) < 3.5)).slice(0, d.max).map(c => c.id);
          else out = pickLow(c => handValue(g, p, c, hand) - (c.def.afterimage ? 1.5 : 0), d.min);
          break;
        }
        case 'scry': {
          const hand = handOf(g, p);
          out = cards.filter(c => handValue(g, p, c, hand) < 2.6).map(c => c.id).slice(0, d.max);
          break;
        }
        case 'modeTarget': {
          out = [pickTop(c => isCreatureDef(c.def) ? sval(c.def) : permVal(g, c), 1)[0]];
          break;
        }
        case 'attachEquipment': {
          // General Grievous: attach our strongest Equipment!
          out = d.max >= 1 && cards.length ? pickTop(c => permVal(g, c) + (c.name === 'Maul\u2019s Lightsaber' ? 5 : 2), 1) : [];
          break;
        }
        case 'freeze': {
          // The Senate Surprised: freeze the highest-threat opponent creature
          out = cards.length ? pickTop(c => ctl(g, c) !== p ? cval(g, c) : -cval(g, c), 1) : [];
          break;
        }
        case 'attachTo': {
          // Garrison Armorers: attach an Equipment to our best carrier
          const eq = d.targetId ? g.card(d.targetId) : null;
          const e = eq ? (textInfo(eq.def).eq || { p: 1, t: 1, kw: [] }) : { p: 1, t: 1, kw: [] };
          const sc = (c) => (g.has(c, 'defender') ? -5 : 0) + Math.max(0, g.power(c) || 0) * 0.3 + (kb(c.name).eqAtk || kb(c.name).whenEq ? 2 : 0) + (g.has(c, 'flying') ? e.p * 0.8 : 0) + (c.token ? -0.5 : 0) + (eq && eq.attachedTo === c.id ? -10 : 0);
          out = d.max >= 1 && cards.length ? pickTop(sc, 1) : [];
          if (out.length && sc(g.card(out[0])) < -2 && d.min === 0) out = [];
          break;
        }
        case 'toBottom': case 'toBottomOwn': case 'toBottomOpp': {
          const c = cards[0];
          const theirs = reason === 'toBottomOpp' || (c && c.owner !== p);
          if (!c || d.max < 1) { out = []; break; }
          if (theirs) out = (isLandDef(c.def) && landsOf(g, c.owner).length >= 5) ? [] : (isLandDef(c.def) && landsOf(g, c.owner).length < 3 ? [c.id] : (!isLandDef(c.def) ? [c.id] : []));
          else out = handValue(g, p, c, handOf(g, p)) < 3 ? [c.id] : [];
          break;
        }
        case 'opponentDiscard': out = pickTop(c => isLandDef(c.def) ? 1 : (isCreatureDef(c.def) ? sval(c.def) : ncVal(c.def)), Math.max(d.min, Math.min(1, d.max))); break;
        case 'returnFromGraveyard': {
          const n = d.toBattlefield ? d.max : Math.max(d.min, d.max >= 1 ? 1 : 0);
          const sc = (c) => isCreatureDef(c.def) ? sval(c.def) : ncVal(c.def);
          out = pickTop(sc, Math.min(n, d.max));
          if (d.validate && d.validate(out)) {
            // Raise the Grave Fleet: best pair within the mana value cap
            let best = null, bs = -1;
            for (let i = 0; i < cards.length; i++) {
              if (!d.validate([cards[i].id]) && sc(cards[i]) > bs) { bs = sc(cards[i]); best = [cards[i].id]; }
              for (let j = i + 1; j < cards.length; j++) { const s2 = sc(cards[i]) + sc(cards[j]); if (s2 > bs && !d.validate([cards[i].id, cards[j].id])) { bs = s2; best = [cards[i].id, cards[j].id]; } }
            }
            out = best || [];
          }
          break;
        }
        case 'upkeepCost': out = d.max >= 1 ? pickLow(c => (g.isCreature(c) && c.zone === 'battlefield') ? cval(g, c) : sval(c.def), Math.max(1, d.min)) : []; break;
        default: {
          const n = d.min > 0 ? d.min : Math.min(d.max, 1);
          const mineAll = cards.every(c => c.owner === p);
          if (/enchant/i.test(d.prompt || '')) {
            const eff = src ? spellEff(g, p, src.def, {}) : { k: 'help' };
            out = pickTop(c => scoreRef(g, p, { kind: 'card', id: c.id }, Array.isArray(eff) ? eff[0] : eff), n);
          } else out = pickTop(c => (isCreatureDef(c.def) ? sval(c.def) : ncVal(c.def)) * (mineAll ? 1 : 1), n);
        }
      }
      if (out === null) return d.cancellable ? { cancel: true } : { cards: d.cards.slice(0, d.min) };
      out = out.filter(id => id !== undefined && id !== null).slice(0, d.max);
      if (out.length < d.min) for (const id of d.cards) { if (out.length >= d.min) break; if (!out.includes(id)) out.push(id); }
      if (d.validate && d.validate(out)) {
        for (let t = 0; t < 30; t++) {
          const n = d.min + Math.floor(this.rng() * (d.max - d.min + 1));
          const s = d.cards.slice().sort(() => this.rng() - 0.5).slice(0, n);
          if (!d.validate(s)) return { cards: s };
        }
      }
      return { cards: out };
    }

    /** "You may sacrifice an artifact/creature" choices made at resolution (benefit by source). */
    optionalSacrifice(g, p, d, cards) {
      const src = d.sourceId ? g.card(d.sourceId) : null;
      const name = src ? src.name : '';
      const sp = sacPlan(g, p, cards, d.sourceId);
      if (!sp) return [];
      let benefit = 1.5;
      const q = 1 - p;
      switch (d.benefit || '') {
        case 'pump': case 'firstStrike': {
          if (!g.combat || !src) { benefit = 0; break; }
          const mod = d.benefit === 'pump' ? { p: 2 } : { fs: true };
          benefit = combatValue(g, p, new Map([[src.id, mod]]), false).value - combatValue(g, p, new Map(), false).value;
          if (!g.combat.attackers.find(at => at.id === src.id && at.blocked)) benefit = d.benefit === 'pump' ? lifeCost(g.players[q].life, 2) * 0.9 : 0;
          break;
        }
        case 'teamPump': {
          if (!g.combat) { benefit = 0; break; }
          const mods = new Map();
          for (const at of g.combat.attackers) if (at.id !== d.sourceId) mods.set(at.id, { p: 2, tr: true });
          benefit = combatValue(g, p, mods, false).value - combatValue(g, p, new Map(), false).value;
          break;
        }
        default: {
          if (name === 'Darth Vader, Iron Betrayal') {
            const vPow = src ? (g.power(src) || 5) : 5;
            const oppL = g.players[q].life;
            const blocked = g.combat && src && g.combat.attackers.some(at => at.id === src.id && at.blocked);
            if (!blocked && vPow < oppL && vPow + 2 >= oppL) benefit = 1000; // lethal!
            else if (blocked) benefit = 8.5; // saves Vader + +2/+0 indestructible!
            else benefit = lifeCost(oppL, 2) * 1.1;
          } else if (name === 'Empire by Acclamation') {
            const oppL = g.players[q].life;
            const myL = g.players[p].life;
            // Check if any candidate's power is exact lethal!
            const lethalC = cards.find(c => (g.power(c) || 0) >= oppL);
            if (lethalC) return [lethalC.id];
            // Check if we can sacrifice a donated Palpatine!
            const palp = cards.find(c => c.name === 'Palpatine, Supreme Chancellor' && c.owner !== p);
            if (palp) return [palp.id];
            const pw = Math.max(0, g.power(sp.card) || 0);
            benefit = lifeCost(oppL, pw) + lifeGainV(myL, pw);
          } else if (name === 'By the Rule of Two') {
            benefit = cards.length >= 2 ? 4.8 : 2.5;
          } else if (name === 'Geonosian Signal Thief') {
            benefit = 3.8;
          } else if (name === 'Sebulba, Grandstand Menace') {
            const oppK = creaturesOf(g, q).filter(c => remTough(g, c) <= 3 && !g.has(c, 'indestructible'));
            benefit = oppK.length ? Math.max(...oppK.map(c => cval(g, c))) : 0;
          } else if (/counters/.test(d.benefit || '')) benefit = 4;
          else benefit = 1.5;
        }
      }
      return benefit > sp.cost + 0.3 ? [sp.card.id] : [];
    }

    mulliganBottom(g, p, cards, n) {
      const kept = cards.slice();
      const out = [];
      for (let i = 0; i < n; i++) {
        const size = kept.length - 1;
        const ideal = Math.round(size * 0.42);
        const lands = kept.filter(c => isLandDef(c.def));
        let victim;
        if (lands.length > ideal) {
          const byName = {};
          for (const l of lands) byName[l.name] = (byName[l.name] || 0) + 1;
          const most = Object.keys(byName).sort((a, b) => byName[b] - byName[a])[0];
          victim = lands.find(l => l.name === most) || lands[lands.length - 1];
        } else {
          const spells = kept.filter(c => !isLandDef(c.def));
          const cols = new Set();
          for (const l of lands) for (const col of producedColors(l.def)) cols.add(col);
          const sc = (c) => (isCreatureDef(c.def) ? sval(c.def) * 0.6 : ncVal(c.def) * 0.8) - Math.max(0, c.def.manaValue - 3) * 1.2 - (colorOK(c.def, cols) ? 0 : 2);
          victim = (spells.length ? spells : kept).slice().sort((a, b) => sc(a) - sc(b))[0];
        }
        out.push(victim.id);
        kept.splice(kept.indexOf(victim), 1);
      }
      return out;
    }

    // ----- misc decisions -------------------------------------------------------------------------------
    yesNo(g, p, d) {
      const lib = g.players[p].library.length;
      const q = 1 - p;
      const L = g.players[p].life;
      const src = d.sourceId ? g.card(d.sourceId) : null;
      const name = src ? src.name : '';
      switch (d.reason) {
        case 'loot': return lib > 2;
        case 'draw': return lib > 2;
        case 'returnFromGraveyard': case 'beneficial': case 'redirect': case 'sacrificeForCounters': return true;
        case 'mill': return lib > 12 + (d.amount || 1);
        case 'toBattlefield': return true;
        case 'newTargets': return false;
        case 'payForce': {
          const n = d.amount || 1;
          if (forceOf(g, p) < n) return false;
          if (name === 'Darth Sion, Held by Pain' || d.life) {
            const life = d.life || 0;
            const threat = sum(creaturesOf(g, q), c => Math.max(0, g.power(c) || 0));
            return L - life > Math.max(3, Math.min(threat, 10) * 0.6);
          }
          let gain = 2;
          if (name === 'Unlimited Power!') return true;
          if (name === 'Plo Koon, Fleet Protector') return forceOf(g, p) >= n;
          if (name === 'Caldera Riposte') {
            const oL = g.players[q].life;
            if (oL <= 2) return true;
            gain = lifeCost(oL, 2) * 1.1;
          } else if (name === 'Battle Meditation at First Light') {
            gain = g.combat ? 3.5 : 0.2;
          }
          return gain - forceSpendCost(g, p, n, true) > 0.3;
        }
        case 'payLife': {
          const n = d.amount || 1;
          if (L <= n + 2) return false;
          if (name === 'Revan, Memory of the Mask') return L > 4;
          return forceGainValue(g, p, 1) > lifeCost(L, n) * 1.1;
        }
        case 'optionalAttach': {
          const t = d.targetId ? g.card(d.targetId) : null;
          const eqc = src;
          if (!t || !eqc) return false;
          const host = eqc.attachedTo ? g.card(eqc.attachedTo) : null;
          const sc = (c) => c ? (g.power(c) || 0) + (g.has(c, 'flying') ? 2 : 0) + (kb(c.name).eqAtk ? 2 : 0) + (c.tapped ? -1 : 0) : -10;
          return sc(t) > sc(host) + 1;
        }
        case 'backFace': {
          const c = d.cardId ? g.card(d.cardId) : null;
          if (!c || !c.backDef) return false;
          return sval(c.backDef) + onTurnValue(g, p, c.backDef) * 0 > sval(c.def) + 0.5;
        }
        case 'scryAll': {
          const shown = (d.shown || []).map(id => g.card(id)).filter(Boolean);
          if (!shown.length) return false;
          const hand = handOf(g, p);
          return sum(shown, c => handValue(g, p, c, hand)) / shown.length < 3;
        }
        case 'optionalSacrifice': {
          const t = d.targetId ? g.card(d.targetId) : null;
          if (!t || t.zone !== 'battlefield') return false;
          const others = creaturesOf(g, p).filter(c => c.id !== d.sourceId);
          if (!others.length) return false;
          return cval(g, t) - Math.min(...others.map(c => permVal(g, c))) > 1;
        }
        default: {
          const pr = d.prompt || '';
          if (/[Dd]raw/.test(pr) && lib <= 2) return false;
          if (/sacrifice|lose \d+ life|pay \d+ life/i.test(pr) && !/[Dd]raw/.test(pr)) return false;
          return true;
        }
      }
    }

    chooseColor(g, p, d) {
      const top = g.stack[g.stack.length - 1];
      const isProt = d.reason === 'protection' || /protection/i.test(d.prompt || '') || (top && top.kind === 'spell' && top.card && spellKind(top.card.def) === 'protection' && top.controller === p);
      if (isProt) return this.protectionColor(g, p, d, top);
      const hand = handOf(g, p);
      const have = colorSourceCounts(g, p);
      let best = d.colors[0], bestS = -Infinity;
      for (const col of d.colors) {
        const need = sum(hand.filter(c => !isLandDef(c.def)), c => colorDemand(c.def.cost)[col] || 0);
        const s = need * 2 - (have[col] || 0) + this.rng() * 0.01;
        if (s > bestS) { bestS = s; best = col; }
      }
      return best;
    }

    /** Protection colour: the colour of the threatening source (stack), else of its combat opponents. */
    protectionColor(g, p, d, top) {
      const q = 1 - p;
      if (this.protPlan && top && top.card && this.protPlan.cardId === top.card.id && d.colors.includes(this.protPlan.color)) return this.protPlan.color;
      let prot = null;
      try { const r = top && top.targets && top.targets[0] && top.targets[0][0]; prot = r ? refObj(g, r) : null; } catch (e) { prot = null; }
      const score = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      if (prot) {
        for (const s of g.stack) {
          if (s === top || s.controller === p) continue;
          const hits = (s.targets || []).some(l => l.some(r => r.kind === 'card' && r.id === prot.id));
          if (!hits) continue;
          const srcC = s.kind === 'spell' ? s.card : s.source;
          try { for (const k of g.colorsOf(srcC)) score[k] += 10; } catch (e) { /* ignore */ }
        }
        if (g.combat) {
          for (const at of g.combat.attackers) {
            const ids = at.id === prot.id ? at.blockers : (at.blockers.includes(prot.id) ? [at.id] : []);
            for (const id of ids) { const c = g.card(id); if (c) for (const k of g.colorsOf(c)) score[k] += 3 + (g.power(c) || 0); }
          }
        }
      }
      for (const c of mineOf(g, q)) { if (!g.isLand(c)) for (const k of g.colorsOf(c)) score[k] += g.isCreature(c) ? 0.5 + (g.power(c) || 0) * 0.1 : 0.2; }
      let best = d.colors[0], bs = -1;
      for (const col of d.colors) if ((score[col] || 0) > bs) { bs = score[col] || 0; best = col; }
      return best;
    }

    chooseOption(g, p, d) {
      if (d.reason === 'compromise' || d.reason === 'mayCompromise') {
        const q = 1 - p;
        const n = d.amount || 1;
        const L = g.players[p].life;
        // Estimate cost of giving opponent N Force counters vs losing N life
        const oppSinks = sinkScore(g, q);
        let oppForceDanger = n * (0.45 + 0.35 * Math.min(3, oppSinks));
        // Extra danger if opponent has Sacred Place Guardian (reaches 4 Force) or Plo Koon / Sidious / Yoda / Invisible Hand
        if (mineOf(g, q).some(c => c.name === 'Sacred Place Guardian') && forceOf(g, q) < 4 && forceOf(g, q) + n >= 4) oppForceDanger += 3.0;
        if (mineOf(g, q).some(c => ['Darth Sidious, Sith Master', 'Yoda, Keeper of the Living Force', 'The Invisible Hand', 'Darth Tyranus, Sith Count', 'Plo Koon, Fleet Protector'].includes(c.name))) oppForceDanger += n * 0.5;
        let myLifeDanger = L <= n ? 1000 : lifeCost(L, n);
        // Flipping our own Asajj Ventress, Lost Padawan if safe!
        if (L - n >= 5 && mineOf(g, p).some(c => c.name === 'Asajj Ventress, Lost Padawan' && !c.transformed) && safeNum(() => g.lifeLostThisTurn(p)) + n >= 4) {
          myLifeDanger *= 0.45;
        }
        const bestChoice = myLifeDanger < oppForceDanger ? 'life' : 'force';
        const minCost = Math.min(myLifeDanger, oppForceDanger);
        if (d.reason === 'mayCompromise') {
          const oppUntapped = creaturesOf(g, q).filter(c => !c.tapped && cval(g, c) >= 3.5);
          if (!oppUntapped.length || minCost > 5.0) return 'decline';
        }
        return bestChoice;
      }
      if (d.reason === 'mode') return this.chooseMode(g, p, d);
      if (d.reason === 'creatureType') {
        const counts = {};
        for (const c of creaturesOf(g, p).concat(handOf(g, p).filter(x => isCreatureDef(x.def)))) for (const t of c.def.subtypes) counts[t] = (counts[t] || 0) + 1;
        let best = null, bestS = -1;
        for (const o of d.options) { const s = counts[o.id] || 0; if (s > bestS) { bestS = s; best = o.id; } }
        return best !== null ? best : d.options[0].id;
      }
      return d.options[0].id;
    }

    /** Modal spell: the planned mode, else the best-valued available mode now. */
    chooseMode(g, p, d) {
      const plan = this.plan;
      if (plan && plan.cardId === d.sourceId && plan.mode && d.options.some(o => o.id === plan.mode)) return plan.mode;
      const card = g.card(d.sourceId);
      let best = d.options[0].id, bs = -Infinity;
      for (const o of d.options) {
        const i = parseInt(String(o.id).slice(1), 10);
        let v = -1;
        try {
          const mc = modeCard(card, i);
          const e = evalSpell(g, p, mc, g.step === 'main2' ? 'main2' : 'main1', { level: this.level });
          if (e) {
            v = e.score;
            if (e.when === 'hold') { const pt = planSpellTargets(g, p, mc, spellEff(g, p, mc.def, {})); v = pt ? pt.first * 0.6 : 0; }
            if (e.tg) { this.plan = Object.assign({}, this.plan || { cardId: d.sourceId, type: 'cast' }, { cardId: d.sourceId }); }
          }
        } catch (e2) { v = -1; }
        if (v > bs) { bs = v; best = o.id; }
      }
      if (this.plan && this.plan.cardId === d.sourceId) { this.plan.mode = best; this.plan.tg = null; }
      return best;
    }

    chooseNumber(g, p, d) {
      const clamp = (n) => Math.max(d.min, Math.min(d.max, Math.round(n)));
      if (d.reason === 'x' && this.plan && this.plan.cardId === d.sourceId && this.plan.x !== undefined && this.plan.x !== null) return { number: clamp(this.plan.x) };
      if (d.reason === 'distributeCounters') return { number: clamp(d.max) };
      if (/life/i.test(d.prompt || '')) return { number: d.min };
      return { number: d.max };
    }

    // ----- attacks / blocks -------------------------------------------------------------------------------
    declareAttackers(g, p, d) {
      const q = 1 - p;
      const tax = d.attackTax || 0;
      const forced = new Set(tax > 0 ? [] : (d.mustAttack || []).filter(id => d.candidates.includes(id)));
      const opts = { candidates: d.candidates, level: this.level, forced };
      if (tax > 0) {
        const mana = availMana(g, p);
        opts.maxAttackers = Math.floor(mana / tax);
        if (opts.maxAttackers <= 0) return [];
        opts.perAttackerCost = tax * 0.5;
      }
      if (this.level === 'easy') {
        const res = attackSearch(g, p, opts);
        if (res.score >= 1000) return res.ids;
        return res.ids.filter(id => forced.has(id) || this.rng() < 0.85);
      }
      opts.oppOpen = openMana(g, q);
      const res = attackSearch(g, p, opts);
      let ids = res.score > 0 ? res.ids : [];
      // "normal" makes the occasional cautious slip (TUNE.normalNoise): hard never does
      if (this.level === 'normal' && TUNE.normalNoise > 0 && res.score < 1000) ids = ids.filter(() => this.rng() >= TUNE.normalNoise);
      if (forced.size) return [...new Set([...forced, ...ids])];
      return ids;
    }

    declareBlockers(g, p, d) {
      const atk = d.attackers.map(id => g.card(id)).filter(Boolean).map(c => unit(g, c, null, this.level !== 'easy'));
      const blkIds = Object.keys(d.candidates).map(Number);
      const blk = blkIds.map(id => unit(g, g.card(id), null, this.level !== 'easy'));
      const can = (b, a) => (d.candidates[b.id] || []).includes(a.id);
      const q = 1 - p;
      let pump = null;
      if (this.level !== 'easy') {
        for (const c of handOf(g, p)) {
          if (!(isInstantDef(c.def) || c.def.keywords.includes('flash'))) continue;
          const k = isModal(c.def) ? spellKind(modeDef(c.def, c.def.spell.modes.length - 1)) : spellKind(c.def);
          if (k !== 'pump' && k !== 'pumpRegen') continue;
          if (!canAfford(g, p, c.def.cost)) continue;
          const ps = pumpStats(g, p, isModal(c.def) ? modeDef(c.def, c.def.spell.modes.length - 1) : c.def);
          if (!pump || ps.p + ps.t > pump.p + pump.t) pump = { p: ps.p, t: ps.t, cost: 2.5 };
        }
      }
      const drain = 0;
      const oppOpen = openMana(g, q);
      const risk = this.level === 'easy' ? 0 : (oppOpen >= 1 && g.players[q].hand.length ? Math.min(1, oppOpen / 3) : 0);
      const must = new Set(d.mustBeBlocked || []);
      const o = { atk, blk, can, life: g.players[p].life, risk, mode: 'normal', pump, must, drain };
      let blocks = planBlocks(o);
      if (this.level === 'hard' && TUNE.hardExactBlocks) blocks = exactBlocks(Object.assign({}, o, { risk: 0 }), blocks);
      let out = [];
      for (const [aid, bs] of blocks) { for (const b of bs) out.push({ blocker: b.id, attacker: aid }); }
      const menSet = new Set(d.menace || []);
      const totalInc = sum(atk, a => epow(a));
      if (this.level === 'easy') {
        if (totalInc < g.players[p].life - 4) out = out.filter(b => must.has(b.attacker) || menSet.has(b.attacker) || this.rng() < 0.7);
      } else if (this.level === 'normal' && TUNE.normalNoise > 0) {
        if (totalInc < g.players[p].life - 5) out = out.filter(b => must.has(b.attacker) || menSet.has(b.attacker) || this.rng() >= TUNE.normalNoise);
      }
      return enforceMust(d, enforceMenace(d, enforceMaxOne(d, out)));
    }
  }

  /** Spell additional sacrifice cost plan for a card cast outside the main-phase planner. */
  function evalSacOf(g, p, card) {
    const add = card.def.spell && card.def.spell.additionalCost;
    if (!add || !add.sacrifice) return null;
    let cands = [];
    try { cands = g._sacCandidates(p, add.sacrifice, card); } catch (e) { cands = []; }
    const sp = sacPlan(g, p, cands, card.id);
    return sp ? [sp.card.id] : null;
  }

  /** Keep at most one blocker on attackers that can't be blocked by more than one creature. */
  function enforceMaxOne(d, blocks) {
    const m1 = d.maxOneBlocker || [];
    if (!m1.length) return blocks;
    const seen = new Set();
    return blocks.filter(b => { if (!m1.includes(b.attacker)) return true; if (seen.has(b.attacker)) return false; seen.add(b.attacker); return true; });
  }

  /** Never leave exactly one blocker on a Menace attacker (either add a 2nd legal blocker or drop the 1st). */
  function enforceMenace(d, blocks) {
    const men = d.menace || [];
    if (!men.length) return blocks;
    let out = blocks.slice();
    for (const at of men) {
      const assigned = out.filter(b => b.attacker === at);
      if (assigned.length !== 1) continue;
      const used = new Set(out.map(b => b.blocker));
      const free = Object.keys(d.candidates || {}).map(Number).find(bid => !used.has(bid) && (d.candidates[bid] || []).includes(at));
      if (free !== undefined) out.push({ blocker: free, attacker: at });
      else out = out.filter(b => b.attacker !== at);
    }
    return out;
  }

  /** Make a block declaration satisfy declareBlockers.mustBeBlocked whenever that is possible. */
  function enforceMust(d, blocks) {
    const must = d.mustBeBlocked || [];
    if (!must.length) return blocks;
    let out = blocks.slice();
    const blockedBy = (at) => out.filter(b => b.attacker === at);
    for (const at of must) {
      if (blockedBy(at).length) continue;
      const able = Object.keys(d.candidates).map(Number).filter(bid => d.candidates[bid].includes(at));
      if (!able.length) continue;
      const free = able.find(bid => !out.some(b => b.blocker === bid));
      if (free !== undefined) { out.push({ blocker: free, attacker: at }); continue; }
      const donor = able.find(bid => { const cur = out.find(b => b.blocker === bid); return cur && (!must.includes(cur.attacker) || blockedBy(cur.attacker).length > 1); });
      if (donor !== undefined) { out = out.filter(b => b.blocker !== donor); out.push({ blocker: donor, attacker: at }); }
    }
    return out;
  }

  /** Always-valid answer for any decision. */
  function fallbackAnswer(g, d) {
    try {
      switch (d.type) {
        case 'playFirst': return { first: true };
        case 'mulligan': return { keep: true };
        case 'priority': return { type: 'pass' };
        case 'payMana': return d.canAuto ? { type: 'auto' } : (d.cancellable ? { type: 'cancel' } : { type: 'auto' });
        case 'chooseTargets': {
          if (d.cancellable) return { cancel: true };
          for (let n = d.min; n <= d.max; n++) {
            const s = d.legal.slice(0, n);
            if (!d.groupCheck || !d.groupCheck(s)) return { targets: s };
          }
          for (const r of d.legal) if (!d.groupCheck || !d.groupCheck([r])) return { targets: d.min <= 1 && d.max >= 1 ? [r] : d.legal.slice(0, d.min) };
          return { targets: d.legal.slice(0, d.min) };
        }
        case 'chooseCards': {
          if (d.cancellable) return { cancel: true };
          const s = d.cards.slice(0, d.min);
          if (!d.validate || !d.validate(s)) return { cards: s };
          for (let i = 0; i < d.cards.length; i++) {
            const t = d.cards.slice(i, i + d.min);
            if (t.length === d.min && (!d.validate || !d.validate(t))) return { cards: t };
          }
          return { cards: s };
        }
        case 'yesNo': return { yes: false };
        case 'chooseNumber': return { number: d.min };
        case 'chooseColor': return { color: d.colors[0] };
        case 'chooseOption': return d.cancellable && d.reason === 'mode' ? { choice: d.options[0].id } : { choice: d.options[0].id };
        case 'orderCards': return { order: d.cards.slice() };
        case 'declareAttackers': return { attackers: d.attackTax > 0 ? [] : (d.mustAttack || []).filter(id => d.candidates.includes(id)) };
        case 'declareBlockers': return { blocks: enforceMust(d, []) };
        default: return { type: 'pass' };
      }
    } catch (e) {
      return { type: 'pass' };
    }
  }

  function evaluateBoard(g, p) {
    try {
      const q = 1 - p;
      const mine = sum(bf(g).filter(c => ctl(g, c) === p && !g.isLand(c)), c => permVal(g, c));
      const theirs = sum(bf(g).filter(c => ctl(g, c) === q && !g.isLand(c)), c => permVal(g, c));
      const lands = landsOf(g, p).length - landsOf(g, q).length;
      const life = lifeValue(g.players[p].life) - lifeValue(g.players[q].life);
      const cards = (g.players[p].hand.length - g.players[q].hand.length) * 2.5;
      const force = forceOf(g, p) * forceUnit(g, p) - forceOf(g, q) * forceUnit(g, q);
      return mine - theirs + lands * 1.5 + life + cards + force;
    } catch (e) { return 0; }
  }

  OF.AI = {
    createController(opts) { return new Controller(opts); },
    evaluateBoard,
    tune: TUNE,
    debug: false,
    _internal: { fight, planBlocks, exactBlocks, attackSearch, cval, cvalAs, sval, lifeCost, itemInfo, evalSpell, spellKind, classifyAbility, handValue, KB,
      enforceMust, enforceMaxOne, forceUnit, forceReserve, attuneBonus, transformGain, textInfo, modeDef, modeCard, combatValue, unit },
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
