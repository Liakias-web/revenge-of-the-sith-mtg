/* Revenge of the Sith Limited pick ratings (0..5) for all 120 nonbasic cards, colour / fixing
 * helpers, signature coalitions (WB Fall of the Republic, GUR Separatist Coalition) and the ten
 * two-colour draft lanes.
 * Ratings are hand-assigned from each card's rules text:
 * 4.0+ bombs / premium removal, 3.0-3.8 strong playables and good removal,
 * 2.0-2.9 solid playables and curve fillers, 1.0-1.9 situational, below 1 sideboard only. */
(function (OF) {
  'use strict';

  const R = {
    // ---- White (ROTS-001 to ROTS-017) --------------------------------------
    'Temple Initiate': 2.0,
    'Kamino Drill Squad': 2.0,
    'Naboo Palace Guard': 2.1,
    'Geonosis Relief Jedi': 2.3,
    'Sky Lane Escort': 2.5,
    'Senate Observer': 2.4,
    'Halt the Advance': 3.0,              // efficient combat removal
    'Seal the Archives': 2.1,             // high artifact creature density in ROTS
    'Clone Reinforcements': 2.8,          // two tokens + Afterimage
    'Battle Meditation at First Light': 2.5,
    'Padmé Amidala, Civic Liaison': 2.9,  // lifegain + black deathtouch activation
    'Unexpected Delegation': 2.6,         // flash rescue / ETB reuse
    'Jedi Battalion-General': 3.2,        // 3/2 + 1/1 token + Attunement pump
    'Temple Vigil': 2.7,                  // +2 Force + repeatable combat pump
    'Mace Windu, Vaapad Master': 4.4,     // 4/4 first strike Banisher Priest + black deathtouch
    'Rebuild the Order': 3.4,             // double reanimate + Force for Jedi
    'Anakin, Hero With No Fear': 4.5,     // 3/4 vigilance Force engine -> 5/4 menace Vader

    // ---- Blue (ROTS-018 to ROTS-034) ---------------------------------------
    'Kamino Sample Keeper': 2.0,
    'Turbolift Interceptor': 2.3,
    'Archive Night Shift': 2.4,
    'Cloudbank Courier': 2.6,
    'The Senate Surprised': 2.3,
    'Evasive Translation': 2.9,           // bounce + Afterimage
    'Flight Log Scrubber': 2.5,           // droid + loot + Force
    'Kamino Tidewall': 2.3,
    'Interdict the Channel': 2.2,
    'Shaak Ti, Citadel Mentor': 3.1,      // Force + repeatable evasion
    'Meditation in Formation': 2.4,
    'Signal from the Underlevels': 2.1,
    'Utapau Traffic Lock': 2.5,
    'Microjump Squadron': 3.2,            // 3/3 flier that cantrips with an artifact
    'Obi-Wan Kenobi': 4.1,                // 3/3 flash Man-o'-War + Force
    "Kamino's Sealed Orders": 3.6,        // draw 3 discard 1 + 3 Force + Afterimage
    'Plo Koon, Fleet Protector': 4.0,     // 3/4 flier + 3 Force + spell copy

    // ---- Black (ROTS-035 to ROTS-051) --------------------------------------
    'Senate Blackmailer': 1.9,
    'Underlevel Stalker': 2.0,
    'Extraction Overseer': 2.2,
    'Separatist Demolition Droid': 2.6,   // 3/2 artifact for 2, compromise 2
    'Skakoan Reclaimer': 2.5,
    'Utapau Cave Scavenger': 2.7,         // 3/2 flier + drain 2 on death
    'Abandon the Witness': 3.4,           // instant -3/-3 (-4/-4 with Attunement)
    'Dark-Side Intercession': 2.5,        // Raise Dead + Afterimage
    'Silence a Delegate': 3.3,            // instant unconditional kill, compromise 1
    'Underworld Peacekeeper': 2.6,
    'Savage Opress, Sith Enforcer': 3.2,  // Force + repeatable -1/-1
    'Fragments of a Sith Testament': 3.0, // draw 2 for 2, compromise 3
    'By the Rule of Two': 2.7,
    'Senate Shadow Detail': 3.3,          // two 1/1s + one-sided -1/-1
    'Execute Order 66!': 3.5,             // mass Jedi wipe / edict + flips non-Jedi DFCs
    'Unlimited Power!': 3.8,              // triple kill + Force drain finisher
    'Darth Sidious, Sith Master': 4.7,    // 4/5 menace + 3 Force + repeatable -3/-3 drain

    // ---- Red (ROTS-052 to ROTS-068) ----------------------------------------
    'Junkyard Witness': 2.2,
    'Geonosian Arena Runner': 1.9,
    'Hangar Sweep Droid': 2.4,
    'Sparks Before the Charge': 2.1,
    'Sandburn': 3.4,                      // 2 damage instant + Afterimage
    'Scuttle the Turret': 2.6,            // artifact kill or falter + cantrip
    'Canopy Strike Flyer': 2.8,           // 3/2 flying haste starship
    'Outer Rim Blademaster': 2.3,
    'Kachirho Breaker': 2.5,
    'Slagworks Overseer': 2.5,
    'Caldera Riposte': 3.5,               // 3 damage instant + optional 2 to face
    'Geonosis Salvage Crew': 2.6,
    'Cut the Pod Cable': 2.4,             // Act of Treason (power <= 3) + Afterimage
    'Ryloth Fireteam': 2.8,               // 3/3 Attunement attacker ping
    'Sebulba, Grandstand Menace': 3.7,    // 3/3 haste + sac artifact for 3 dmg
    'Purge Transmission': 3.9,            // Shock ETB + double-spell ping engine
    'Jango Fett, Contract Hunter': 4.6,   // 3/3 flying haste + repeatable shock/shatter

    // ---- Green (ROTS-069 to ROTS-085) --------------------------------------
    'Wroshyr Seed Tender': 2.7,           // 1-drop mana dork
    'Gungan Sacred Groveguard': 2.3,
    'Wroshyr Trailfinder': 2.8,           // 2/2 Civic Wayfinder
    'Grip of the Living Force': 2.2,
    'Leave No Metal': 2.0,                // plenty of artifacts in ROTS
    'Kashyyyk Crossbow Post': 2.5,
    'Marshstep Initiate': 2.6,
    'Skewering Reed': 1.7,
    'Opee Sea Killer': 2.6,
    'Chewbacca, Forest Defender': 3.0,    // 3/3 + artifact regrowth
    'Roots of the Living Force': 2.4,
    'Battle Meditation, Canopy Chorus': 3.1, // permanent counters + Afterimage
    'Beneath the Fallen Pillar': 3.3,     // instant +2/+2 fight
    'Sacred Place Guardian': 2.7,
    'Ahsoka Tano, Unbound Protector': 4.1,// 3/4 + attack pump + Force regenerate
    'Revelation of the Living Force': 3.6,// +3 Force + cheat creature from top 7
    'Yoda, Keeper of the Living Force': 4.6, // 4/6 vigilance + combat pump + Force overrun

    // ---- Multicolour (ROTS-086 to ROTS-105) --------------------------------
    'Senate Garrison': 2.8,               // 2/3 drain 1 + Force on death
    'Vulture Wing': 3.0,                  // 2/2 flying artifact + rummage
    'Felucian Grovekeeper': 2.7,
    'Wookiee Canopy Team': 2.8,           // 3/2 for 2, trample with artifact
    'Polis Massa Midwives': 3.3,          // 2/4 reanimate MV<=2, compromise 2
    'For The Better, Right?': 3.3,        // exile tapped or Thoughtseize, compromise 2
    'Torrent Squadron Wingman': 3.3,      // 2/1 first strike + 1/1 token
    'Geonosian Signal Thief': 3.1,        // 3/3 reach + sac artifact for draw 2 discard 1
    'Reclaim the Wreck': 3.0,             // instant shatter + raise dead
    'Separatist Signal Array': 2.6,       // +3 Force + GUR mana rock
    'Chart the Outer Rim': 2.9,           // ramp + loot + Afterimage
    '501st Legion': 4.1,                  // 3/3 + 1/1 -> 5/4 menace + -3/-3
    'Asajj Ventress, Lost Padawan': 3.9,  // 2/4 lifelink -> 4/4 menace + kill MV<=4
    'Empire by Acclamation': 3.3,         // repeatable upkeep fling/drain
    'Palpatine, Supreme Chancellor': 3.5, // escalating upkeep drain + scry engine
    'Qui-Gon Jinn, Living Force': 4.2,    // 3/4 + Force + counters + repeatable recursion
    'Darth Maul, Shadow Apprentice': 4.1, // 3/2 first strike + Force + repeatable ping
    'The Invisible Hand': 4.3,            // 5/5 flier + two 1/1 droids + Bolt cannon
    'Count Dooku, Lost Idealist': 4.5,    // 3/3 first strike card advantage -> 5/4 Tyranus
    'General Grievous, Blade Collector': 4.2, // 4/5 Equipment tutor + double strike trample

    // ---- Colourless Artifacts (ROTS-106 to ROTS-113) -----------------------
    'B1 Droid Pair': 2.6,                 // 2/1 + 1/1 artifact bodies
    'Medical Capsule': 2.3,               // Force + cantrip + 3 life
    'Astromech Scout': 2.5,               // mana droid, any colour with Force
    'Republic Gunship': 2.4,              // 2/3 colourless flier
    'Temple Training Holocron': 2.6,      // +2 Force + repeatable card draw
    'Comms Disruptor': 2.5,               // tapper + shatter
    'Jedi Lightsaber': 3.6,               // +1/+1 first strike (+ vigilance on Jedi)
    'Maul’s Lightsaber': 4.0,             // double strike + Force on hit

    // ---- Nonbasic Lands (ROTS-114 to ROTS-120) -----------------------------
    'Frontier Supply Post': 2.0,          // +1 Force + any colour with Force
    'Envoy’s Landing': 2.0,               // fetches any basic tapped
    'Trade Route Junction': 1.9,          // filters {1} into any colour
    'Geonosis, Foundry Spires': 2.1,      // UR dual
    'Kashyyyk, Tidal Canopy': 2.1,        // RG dual
    'Naboo, Lake Country': 2.1,           // GU dual
    'Jedi Temple, Coruscant': 2.7,        // filter land that flips to Imperial Palace (2 tokens + WB)

    // ---- Basics ------------------------------------------------------------
    Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0,
  };

  const norm = (s) => String(s || '').replace(/[‘’]/g, "'");
  const TABLE = {};
  for (const k in R) TABLE[norm(k)] = R[k];

  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const BASIC_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  const COLOR_BASIC = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

  let dataByName = null;
  const backCache = {};
  /** Display record of a double-faced card's back face (front fields + back overrides). */
  function backFace(name) {
    const d = typeof name === 'string' ? frontData(name) : name;
    if (!d || !d.dfc || !d.back) return null;
    if (backCache[d.id]) return backCache[d.id];
    const b = d.back;
    const rec = Object.assign({}, d, {
      name: b.name, type: b.type, printed_type: b.printed_type || b.type, pt: b.pt || null, rules: b.rules || '',
      printed_rules: b.printed_rules || b.rules || '', flavor: b.flavor || '', side: b.side, image: b.image, art: b.art,
      face_id: b.face_id, cost: '', color: (b.color_indicator || []).slice(), color_indicator: (b.color_indicator || []).slice(),
      isBack: true, frontName: d.name, front: d,
    });
    delete rec.back;
    backCache[d.id] = rec;
    return rec;
  }
  function frontData(name) {
    if (!dataByName) {
      dataByName = {};
      for (const c of (OF.CARD_DATA || [])) dataByName[norm(c.name)] = c;
      for (const c of (OF.BASIC_LAND_DATA || [])) dataByName[norm(c.name)] = c;
      for (const c of (OF.TOKEN_DATA || [])) if (!dataByName[norm(c.name)]) dataByName[norm(c.name)] = c;
    }
    return dataByName[norm(name)] || null;
  }
  const backByName = {};
  /** CARD_DATA record by name. A back-face name returns the FRONT card record (deck lists use front names). */
  function data(name) {
    const d = frontData(name);
    if (d) return d;
    if (!Object.keys(backByName).length) for (const c of (OF.CARD_DATA || [])) if (c.dfc && c.back) backByName[norm(c.back.name)] = c;
    return backByName[norm(name)] || null;
  }
  function isDFC(name) { const d = data(name); return !!(d && d.dfc && d.back); }
  /** [front record, back record] of a DFC, or [record] of any other card. */
  function faceNames(name) { const d = data(name); if (!d) return []; return d.dfc && d.back ? [d.name, d.back.name] : [d.name]; }

  function rating(name) {
    const v = TABLE[norm(name)];
    return typeof v === 'number' ? v : 1.0;
  }

  // ------------------------------------------------------------------ mana cost analysis
  const costCache = {};
  /** {mono:{W..G}, hybrid:[['W','B'],...]} from the printed cost (cached). */
  function costInfo(name) {
    const key = norm(name);
    if (costCache[key]) return costCache[key];
    const d = data(name);
    const out = { mono: { W: 0, U: 0, B: 0, R: 0, G: 0 }, hybrid: [] };
    if (d && d.cost) {
      const re = /\{([^}]+)\}/g;
      let m;
      while ((m = re.exec(d.cost))) {
        const s = m[1].toUpperCase();
        if (s.indexOf('/') > 0) { const pr = s.split('/').filter(x => COLORS.indexOf(x) >= 0); if (pr.length === 2) out.hybrid.push(pr); }
        else if (out.mono[s] !== undefined) out.mono[s]++;
      }
    }
    costCache[key] = out;
    return out;
  }

  /** Colours of the card (from its mana cost; a hybrid symbol gives both colours). Lands/artifacts: []. */
  function colorsOf(name) {
    const ci = costInfo(name);
    const set = new Set();
    for (const k of COLORS) if (ci.mono[k]) set.add(k);
    for (const h of ci.hybrid) { set.add(h[0]); set.add(h[1]); }
    return COLORS.filter(k => set.has(k));
  }
  /** Number of single-coloured pips of each colour (hybrid symbols excluded). */
  function pips(name) { return Object.assign({}, costInfo(name).mono); }
  /** Hybrid symbols of the cost, e.g. [['W','B']]. */
  function hybridPips(name) { return costInfo(name).hybrid.map(h => h.slice()); }
  /** Coloured symbols counted for display: a hybrid {W/B} counts toward both W and B. */
  function symbolCounts(name) {
    const ci = costInfo(name);
    const p = Object.assign({}, ci.mono);
    for (const h of ci.hybrid) { p[h[0]]++; p[h[1]]++; }
    return p;
  }
  function isHybrid(name) { return costInfo(name).hybrid.length > 0; }
  /** Gold card: needs two or more different colours to cast (hybrid-only cards are not gold). */
  function isGold(name) { return COLORS.filter(k => costInfo(name).mono[k] > 0).length >= 2; }

  /**
   * Colours a deck of colours `cols` cannot supply for this card:
   * {colors:[letters], pips:n}. A hybrid symbol is satisfied by either half.
   */
  function offColor(name, cols) {
    const ci = costInfo(name);
    const set = new Set(cols || []);
    const off = new Set();
    let n = 0;
    for (const k of COLORS) if (ci.mono[k] && !set.has(k)) { off.add(k); n += ci.mono[k]; }
    for (const h of ci.hybrid) {
      if (set.has(h[0]) || set.has(h[1])) continue;
      if (off.has(h[0]) || off.has(h[1])) { n++; continue; }
      off.add(h[0]); n++;
    }
    return { colors: COLORS.filter(k => off.has(k)), pips: n };
  }
  /** True when the card can be cast with mana of the given colours only. */
  function fits(name, cols) { return offColor(name, cols).pips === 0; }

  const isBasic = (name) => BASICS.indexOf(norm(name)) >= 0;
  function isLand(name) { const d = data(name); return !!d && /\bLand\b/.test(d.type); }
  function isCreature(name) { const d = data(name); return !!d && /\bCreature\b/.test(d.type); }
  function manaValue(name) { const d = data(name); return d ? (d.mana_value || 0) : 0; }

  // ------------------------------------------------------------------ fixing
  /**
   * Hand-assigned mana fixing of Revenge of the Sith: colours a card helps produce.
   *   kind: 'land' (dual / any-colour land), 'rock' (artifact), 'creature', 'search' (basic-land search)
   *   any: produces / finds any colour.
   */
  const RAW_FIXERS = {
    // Common lands
    'Frontier Supply Post': { any: true, kind: 'land' },           // any colour with Force
    "Envoy's Landing": { any: true, kind: 'land' },                // fetches any basic tapped
    'Trade Route Junction': { any: true, kind: 'land' },           // any colour with {1}
    // Uncommon duals (GUR coalition)
    'Geonosis, Foundry Spires': { colors: ['U', 'R'], kind: 'land' },
    'Kashyyyk, Tidal Canopy': { colors: ['R', 'G'], kind: 'land' },
    'Naboo, Lake Country': { colors: ['U', 'G'], kind: 'land' },
    // Rare transforming land (filters with {1}; flips to Imperial Palace for W/B)
    'Jedi Temple, Coruscant': { colors: ['W', 'B'], any: true, kind: 'land' },
    // Artifact / Creature / Spell fixers
    'Astromech Scout': { any: true, kind: 'creature' },            // any colour with Force
    'Separatist Signal Array': { colors: ['U', 'R', 'G'], kind: 'rock' },
    'Chart the Outer Rim': { any: true, kind: 'search' },          // basic land ramp
    'Wroshyr Trailfinder': { any: true, kind: 'search' },          // basic land tutor
    'Wroshyr Seed Tender': { colors: ['G'], kind: 'creature' },    // green creature ramp
  };
  const FIXERS = {};
  for (const k in RAW_FIXERS) FIXERS[norm(k)] = RAW_FIXERS[k];
  const FIXING = FIXERS;

  const fixCache = {};
  /**
   * What colours a card helps produce: {colors:[letters], any:bool, kind, restricted?}
   * kind: 'land'|'basicLand'|'rock'|'creature'|'search'|'none'. Basic lands: their colour.
   */
  function fixing(name) {
    const key = norm(name);
    if (fixCache[key]) return fixCache[key];
    const d = data(name);
    let out = { colors: [], any: false, kind: 'none' };
    if (FIXERS[key]) out = Object.assign({ colors: [], any: false }, FIXERS[key], { colors: (FIXERS[key].colors || []).slice() });
    else if (d) {
      const text = String(d.rules || d.printed_rules || '');
      if (isBasic(name)) { out.colors = [BASIC_COLOR[norm(name)]]; out.kind = 'basicLand'; }
      else if (isLand(name)) {
        const set = new Set();
        const re = /Add \{([WUBRG])\}(?: or \{([WUBRG])\})?/g;
        let m;
        while ((m = re.exec(text))) { set.add(m[1]); if (m[2]) set.add(m[2]); }
        out.colors = COLORS.filter(k => set.has(k));
        if (out.colors.length) out.kind = 'land';
      }
    }
    fixCache[key] = out;
    return out;
  }
  /** True for cards whose main job in Limited is mana fixing (not basics). */
  function isFixer(name) {
    if (isBasic(name)) return false;
    const f = fixing(name);
    if (f.kind === 'none') return false;
    if (f.kind === 'land' && f.colors.length < 2 && !f.any) return false;
    return true;
  }
  /** Does `name` fix for colour c? */
  function fixesFor(name, c) {
    const f = fixing(name);
    if (f.colors.indexOf(c) >= 0) return true;
    return !!f.any;
  }

  /** The ten two-colour draft lanes of Revenge of the Sith. */
  const LANES = [
    { colors: 'WB', name: 'Compromise & Fall of the Republic', coalition: 'Fall of the Republic', text: 'Senate Garrison, Polis Massa Midwives, For The Better, Right? and 501st Legion: pay Compromise costs for efficient bodies and removal, trigger death payoffs like Padmé Amidala, and flip Jedi and clones to the Dark Side.' },
    { colors: 'WU', name: 'Jedi Tempo & Council Control', coalition: 'Republic', text: 'Obi-Wan Kenobi, Shaak Ti, The Senate Surprised and Unexpected Delegation: bounce and tap blockers, bank Force counters on Jedi, and close the game with flyers or Palpatine’s escalating upkeep drain.' },
    { colors: 'UB', name: 'Rule of Two & Graveyard Value', coalition: 'Sith', text: 'Count Dooku, Kamino’s Sealed Orders, Flight Log Scrubber and Dark-Side Intercession: filter cards into the graveyard, recur creatures and Afterimage spells, and spend banked Force on removal.' },
    { colors: 'BR', name: 'Sacrifice, Burn & Sith Aggro', coalition: 'Sith', text: 'Darth Maul, By the Rule of Two, Extraction Overseer and Sandburn: attack relentlessly, convert expendable bodies and artifacts into damage and cards, and finish with Caldera Riposte.' },
    { colors: 'RG', name: 'Kashyyyk & Outer Rim Beatdown', coalition: 'Separatist / Outer Rim', text: 'Wookiee Canopy Team, Kachirho Breaker, Beneath the Fallen Pillar and Wroshyr Seed Tender: ramp into sturdy creatures, turn on trample with droids and artifacts, and fight through blockers.' },
    { colors: 'GW', name: 'Living Force & Jedi Resilience', coalition: 'Republic', text: 'Qui-Gon Jinn, Yoda, Ahsoka Tano and Rebuild the Order: build deep Force reserves, grow creatures with +1/+1 counters and Battle Meditation, and outlast attrition by recurring low-cost Jedi.' },
    { colors: 'UR', name: 'Separatist Artifacts & Looting', coalition: 'Separatist / Outer Rim', text: 'Vulture Wing, Microjump Squadron, Slagworks Overseer and Geonosis Salvage Crew: fill the board with droids and starships, loot for action, and sacrifice spare artifacts for bursts of damage.' },
    { colors: 'BG', name: 'Salvage & Graveyard Grind', coalition: 'Outer Rim', text: 'Reclaim the Wreck, Skakoan Reclaimer, Chewbacca and Abandon the Witness: trade artifacts and creatures early, recur the best ones from the graveyard, and take over the late game.' },
    { colors: 'RW', name: 'Clone Battalion & Equipment', coalition: 'Republic', text: 'Torrent Squadron Wingman, Jedi Battalion-General, Clone Reinforcements and Jedi Lightsaber: flood the board with Clone Soldier tokens, trigger Attunement in combat, and suit up first strikers.' },
    { colors: 'UG', name: 'Force Ramp & Outer Rim Fixing', coalition: 'Separatist / Outer Rim', text: 'Felucian Grovekeeper, Wroshyr Trailfinder, Roots of the Living Force and Revelation of the Living Force: stockpile Force counters, ramp into top-end threats, and splash red for the GUR Separatist payoffs.' },
  ];
  const ARCHETYPES = LANES;

  /** Signature themes / coalitions of Revenge of the Sith. */
  const COALITIONS = [
    { colors: 'WB', name: 'The Compromise / Fall of the Republic', text: 'Compromise costs, sacrifice, off-colour activations, clones and Jedi turning to the Dark Side.' },
    { colors: 'GUR', name: 'Separatist / Outer Rim Coalition', text: 'Droids, artifacts, Force ramp and three-colour payoffs led by The Invisible Hand and General Grievous.' },
  ];

  /** Names of set cards without a hand-assigned rating (should be empty). */
  function missing() {
    return (OF.CARD_DATA || []).filter(c => typeof TABLE[norm(c.name)] !== 'number').map(c => c.name);
  }

  OF.Ratings = {
    rating, colorsOf, pips, hybridPips, symbolCounts, isHybrid, isGold, offColor, fits,
    fixing, isFixer, fixesFor, isBasic, isLand, isCreature, manaValue, data, missing, norm, isDFC, backFace, faceNames,
    COLORS, BASICS, BASIC_COLOR, COLOR_BASIC, ARCHETYPES, LANES, COALITIONS, TABLE, FIXING, FIXERS,
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
