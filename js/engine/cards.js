/* The Old Republic card scripts — shared helpers (cards are in cards1.js .. cards4.js).
 * Keywords (Flying, First strike, Double strike, Deathtouch, Lifelink, Trample, Haste, Vigilance, Reach, Defender,
 * Fear, Flanking, Shroud, Flash), "attacks each combat if able", "can't block", "can't be blocked by more than one
 * creature", "enters the battlefield tapped", Equip {N}, Afterimage {cost} and simple "{T}: Add ..." mana lines are
 * derived from the rules text in engine.js; scripts add everything else. Modern wording: battlefield, exile, cast. */
(function (OF) {
  'use strict';
  const S = OF.CardScripts;
  for (const k in S) delete S[k];
  // Shared helpers
  // ---------------------------------------------------------------------------
  const T = {
    creature: (prompt, filter, extra) => Object.assign({ type: 'creature', prompt: prompt || 'Choose target creature.', filter }, extra || {}),
    ownCreature: (prompt, filter, extra) => Object.assign({ type: 'creature', yours: true, prompt: prompt || 'Choose target creature you control.', filter }, extra || {}),
    oppCreature: (prompt, extra) => Object.assign({ type: 'creature', prompt: prompt || 'Choose target creature an opponent controls.', filter: (g, c, p) => g.controllerOf(c) !== p }, extra || {}),
    any: (prompt) => ({ type: 'any', prompt: prompt || 'Choose target creature or player.' }),
    player: (prompt) => ({ type: 'player', prompt: prompt || 'Choose target player.' }),
    opponent: (prompt) => ({ type: 'opponent', prompt: prompt || 'Choose target opponent.' }),
    gyCard: (whose, prompt, filter, extra) => Object.assign({ type: 'card', zone: 'graveyard', whose, prompt, filter }, extra || {}),
    spell: (prompt, filter) => ({ type: 'spell', prompt: prompt || 'Choose target spell.', filter }),
  };
  const ownGyCreature = (prompt, filter, extra) => T.gyCard('you', prompt || 'Choose target creature card in your graveyard.', (g, c, p, it) => g.isCreatureCard(c) && (!filter || filter(g, c, p, it)), extra);
  const ctl = (g, src) => g.controllerOf(src);
  const controls = (g, src, c) => g.controllerOf(c) === g.controllerOf(src);
  const concordOf = (g, src) => g.concord(g.controllerOf(src));
  const creaturesOf = (g, p) => g.battlefield.map(id => g.card(id)).filter(c => g.isCreature(c) && g.controllerOf(c) === p);
  const allCreatures = (g) => g.battlefield.map(id => g.card(id)).filter(c => g.isCreature(c));
  const landsOf = (g, p) => g.battlefield.map(id => g.card(id)).filter(c => g.isLand(c) && g.controllerOf(c) === p);
  const opponents = (g, p) => g.players.filter(P => P.index !== p && !P.lost).map(P => P.index);
  const isSelfEvent = (g, src, evt) => evt.card && evt.card.id === src.id;
  const attached = (g, src, c) => src.attachedTo === c.id;
  const yourUpkeep = (g, src, evt) => evt.player === g.controllerOf(src);
  const nontokenDiesYours = (g, src, evt) => evt.lki.wasCreature && !evt.lki.token && evt.lki.controller === g.controllerOf(src);
  const freshInGraveyard = (g, evt) => evt.card && evt.card.zone === 'graveyard' && evt.card.zcc === evt.lki.zcc + 1;
  const isInstantOrSorcery = (g, c) => g.isType(c, 'Instant') || g.isType(c, 'Sorcery');

  const etb = (text, resolve, extra) => Object.assign({ event: 'etb', text, match: isSelfEvent, resolve }, extra || {});
  const dies = (text, resolve, extra) => Object.assign({ event: 'dies', text, match: isSelfEvent, resolve }, extra || {});
  const upkeep = (text, resolve, extra) => Object.assign({ event: 'upkeep', text, match: yourUpkeep, resolve }, extra || {});
  /** Verse — whenever you play your second spell each turn. */
  const verse = (text, resolve, extra) => Object.assign({
    event: 'cast', text: 'Verse — ' + text, isVerse: true,
    match: (g, src, evt) => evt.player === g.controllerOf(src) && evt.nth === 2, resolve,
  }, extra || {});
  /** Whenever you play a multicolored spell. */
  const onMulticolored = (text, resolve, extra) => Object.assign({
    event: 'cast', text, match: (g, src, evt) => evt.player === g.controllerOf(src) && evt.multicolored, resolve,
  }, extra || {});
  const attacksTrig = (text, resolve, extra) => Object.assign({ event: 'attacks', text, match: (g, src, evt) => evt.card.id === src.id, resolve }, extra || {});
  const attacksAloneYours = (text, resolve, extra) => Object.assign({
    event: 'attacks', text, match: (g, src, evt) => evt.alone && g.controllerOf(evt.card) === g.controllerOf(src), resolve,
  }, extra || {});

  const selfPump = (cost, dp, dt, extra) => Object.assign({
    cost: { mana: cost }, text: `${cost}: +${dp}/+${dt} until end of turn.`, ai: { kind: 'pump', target: 'self', when: 'combat' },
    resolve: function* (g, ctx) { if (g.isOnBattlefield(ctx.source)) g.pump(ctx.source, dp, dt); },
  }, extra || {});
  const selfRegen = (cost, extra) => Object.assign({
    cost: Object.assign({}, typeof cost === 'string' ? { mana: cost } : cost), text: `${typeof cost === 'string' ? cost : '{1}{B}, Sacrifice a creature'}: Regenerate this creature.`,
    ai: { kind: 'protect', target: 'self', when: 'response', regen: true },
    resolve: function* (g, ctx) { if (g.isOnBattlefield(ctx.source)) g.regenShield(ctx.source); },
  }, extra || {});
  const concordPT = (dp, dt) => ({ pt: (g, src, c) => (c === src && concordOf(g, src)) ? [dp, dt] : null });
  const concordKw = (kws) => ({ keywords: (g, src, c) => (c === src && concordOf(g, src)) ? kws : null });
  const manaAny = () => ({ mana: { produce: 'ANY' }, cost: { tap: true }, text: '{T}: Add one mana of any color.' });
  const manaOf = (cols, extraCost) => ({ mana: { produce: cols }, cost: Object.assign({ tap: true }, extraCost ? { mana: extraCost } : {}), text: `${extraCost ? extraCost + ', ' : ''}{T}: Add ${cols.split('').map(c => '{' + c + '}').join('')}.` });
  const censer = (cols) => ({ activated: [manaOf(cols, '{1}')] });
  const confluenceCounter = () => ({ onEnter: function* (g, card, info) { if (info && info.colorsSpent >= 3) card.counters.p1p1 = (card.counters.p1p1 || 0) + 1; } });

  function* tokens(g, p, name, n, opts) { return yield* g.createToken(p, name, n || 1, opts); }
  function* loot(g, p, sourceId, optional) {
    if (optional && !(yield* g.yesNo(p, 'Draw a card? If you do, discard a card.', { reason: 'loot', sourceId }))) return;
    g.draw(p, 1);
    yield* g.discardChoose(p, 1, 'Discard a card.');
  }
  function drain(g, p, n) { for (const o of opponents(g, p)) g.loseLife(o, n); g.gainLife(p, n); }
  /** Look at the top n; you may reveal a land and put it into your hand; the rest go on the bottom in any order. */
  function* landDig(g, p, n, sourceId) {
    const top = g.topCards(p, n);
    if (!top.length) return;
    const lands = top.filter(c => g.isLand(c));
    const pick = yield* g.chooseCards(p, lands, 0, 1, 'You may reveal a land card and put it into your hand.', { reason: 'toHand', sourceId, alwaysAsk: true, shown: top.map(c => c.id) });
    if (pick.length) { g.reveal(p, pick, ''); g.toHand(pick[0]); }
    const rest = top.filter(c => !pick.includes(c));
    const order = yield* g.orderCards(p, rest, 'Put these on the bottom of your library (first = closest to the top).');
    for (const c of order.slice().reverse()) g._placeInZone(c, 'library', p, 'bottom');
  }
  function* searchBasicToPlay(g, p, n, tapped) {
    const found = yield* g.searchLibrary(p, c => g.isBasicLand(c), n, n === 1 ? 'Search for a basic land card.' : `Search for up to ${n} basic land cards.`);
    for (const c of found) yield* g.putOntoBattlefield(c, p, { tapped });
    g.shuffle(p);
    return found;
  }
  function* landFromHand(g, p, tapped, sourceId) {
    const lands = g.players[p].hand.map(id => g.card(id)).filter(c => g.isLand(c));
    const pick = yield* g.chooseCards(p, lands, 0, 1, `You may put a land card from your hand into play${tapped ? ' tapped' : ''}.`, { reason: 'toBattlefield', sourceId });
    if (pick.length) { yield* g.putOntoBattlefield(pick[0], p, { tapped }); g.log(`${g.players[p].name} puts [[${pick[0].name}]] into play.`); }
  }
  function* revealAndChoose(g, ctx, P, filter, prompt) {
    const hand = P.hand.map(id => g.card(id));
    g.reveal(P.index, hand, ctx.source.name);
    const cands = hand.filter(filter);
    const pick = yield* g.chooseCards(ctx.controller, cands, 1, 1, prompt, { reason: 'opponentDiscard', sourceId: ctx.source.id, revealed: hand.map(c => c.id), alwaysAsk: true });
    return pick[0] || null;
  }
  function* counterUnless(g, ctx, s, costStr) {
    const paid = yield* g.payOptional(s.controller, costStr, `Pay ${costStr} or ${s.name} is countered.`, ctx.source.id);
    if (!paid) g.counterItem(s); else g.log(`${g.players[s.controller].name} pays ${costStr}.`);
  }
  const returnToHand = (g, c) => { g.toHand(c); g.log(`[[${c.name}]] is returned to its owner's hand.`); };
    // Extra helpers for Mehrava
  const legendaryCast = (g, src, evt) => evt.player === g.controllerOf(src) && evt.card.def.supertypes.includes('Legendary') && g.isCreature(evt.card);
  const multicolorEtbYours = (g, src, evt) => evt.controller === g.controllerOf(src) && g.isCreature(evt.card) && g.isMulticolored(evt.card);
  const multicolorDiesYours = (g, src, evt) => evt.lki.wasCreature && evt.lki.controller === g.controllerOf(src) && evt.lki.colors.length >= 2;
  const destroyOnDamage = () => ({ event: 'damageDealt', text: 'Destroy that creature.', match: (g, src, evt) => evt.source && evt.source.id === src.id && !evt.target.isPlayer && g.isCreature(evt.target),
    resolve: function* (g, ctx) { const t = ctx.evt.target; if (g.isOnBattlefield(t)) g.destroy(t); } });
  function* lookTopOrder(g, p, n) {
    const top = g.topCards(p, n);
    const order = yield* g.orderCards(p, top, 'Put these back on top of your library (first = top).');
    for (let i = order.length - 1; i >= 0; i--) g._placeInZone(order[i], 'library', p, 'top');
  }
  function* digToHandRestBottom(g, p, n, sourceId) {
    const top = g.topCards(p, n);
    if (!top.length) return;
    const pick = yield* g.chooseCards(p, top, 1, 1, 'Choose a card to put into your hand. The rest go on the bottom.', { reason: 'toHand', sourceId, alwaysAsk: true });
    g.toHand(pick[0]);
    const rest = top.filter(c => c !== pick[0]);
    const order = yield* g.orderCards(p, rest, 'Put these on the bottom of your library (first = closest to the top).');
    for (const c of order.slice().reverse()) g._placeInZone(c, 'library', p, 'bottom');
  }
  function* chooseTargetNow(g, p, cands, prompt, sourceId) {
    // Choose an object for a modal ability at resolution (used where the mode determines the target).
    const pick = yield* g.chooseCards(p, cands, 1, 1, prompt, { reason: 'modeTarget', sourceId });
    return pick[0] || null;
  }

  // ---------------------------------------------------------------------------
  // The Old Republic helpers
  // ---------------------------------------------------------------------------
  /** "You get N Force counters." */
  const force = (g, p, n) => g.gainForce(p, n);
  /** Attunement — you've spent a Force counter this turn. */
  const attuned = (g, p) => g.spentForceThisTurn(p);
  /** ETB: you get N Force counters. */
  const etbForce = (n, extra) => etb(`You get ${n} Force counter${n === 1 ? '' : 's'}.`, function* (g, ctx) { g.gainForce(ctx.controller, n); }, extra);
  /** Activated ability with a "Use the Force N" cost. cost: { force, mana, tap, sacrifice, ... }. */
  const useForce = (n, text, resolve, extra) => Object.assign({ cost: { force: n }, text, resolve }, extra || {});
  /** "Use the Force N[, extra costs]: X turns to the Dark/Light Side. Activate only as a sorcery [and only if ...]." */
  const turnAbility = (toSide, cost, condition, extra) => Object.assign({
    cost, sorcery: true, isTurn: true, condition: condition || null,
    text: `${costText(cost)}: turns to the ${toSide === 'dark' ? 'Dark' : 'Light'} Side.`,
    ai: { kind: 'transform', toSide, when: 'main' },
    resolve: function* (g, ctx) { if (g.isOnBattlefield(ctx.source, ctx.sourceZcc)) g.transform(ctx.source, toSide); },
  }, extra || {});
  /** "When X turns to the Dark/Light Side, ..." */
  const onTurn = (toSide, text, resolve, extra) => Object.assign({ event: 'transformed', text, match: (g, src, evt) => evt.card.id === src.id && evt.toSide === toSide, resolve }, extra || {});
  function costText(cost) {
    const parts = [];
    if (cost.mana) parts.push(cost.mana);
    if (cost.tap) parts.push('{T}');
    if (cost.life) parts.push(`Pay ${cost.life} life`);
    if (cost.force) parts.push(`Use the Force ${cost.force}`);
    if (cost.sacrifice) parts.push('Sacrifice ' + (cost.sacrifice.label || 'a permanent'));
    if (cost.sacSelf) parts.push('Sacrifice this');
    if (cost.discard) parts.push('Discard a card');
    return parts.join(', ');
  }
  /** Scry n: look at the top n, put any number on the bottom, the rest back in any order. */
  function* scry(g, p, n, sourceId) {
    const top = g.topCards(p, n);
    if (!top.length) return;
    const bottom = yield* g.chooseCards(p, top, 0, top.length, `Scry ${n}: choose cards to put on the bottom of your library.`, { reason: 'scry', sourceId, alwaysAsk: true });
    for (const c of bottom) g._placeInZone(c, 'library', p, 'bottom');
    const keep = top.filter(c => !bottom.includes(c));
    if (keep.length > 1) {
      const order = yield* g.orderCards(p, keep, 'Put these back on top of your library (first = top).');
      for (let i = order.length - 1; i >= 0; i--) g._placeInZone(order[i], 'library', p, 'top');
    }
    g.log(`${g.players[p].name} scries ${n}.`);
  }
  /** Exile target until `src` leaves the battlefield (O-ring). */
  function exileUntilLeaves(g, src, target) {
    if (!g.isOnBattlefield(target)) return;
    const owner = target.owner, wasToken = target.token;
    g.exile(target);
    if (wasToken) return;
    const zcc = src.zcc, tid = target.id, tzcc = target.zcc;
    const back = function* (g2) {
      const c = g2.card(tid);
      if (c.zone === 'exile' && c.zcc === tzcc) { yield* g2.putOntoBattlefield(c, owner); g2.log(`[[${c.name}]] returns to the battlefield.`); }
    };
    if (!g.isOnBattlefield(src, zcc)) { const gen = back(g); let r = gen.next(); while (!r.done) r = gen.next(); return; }
    g.delayedTriggers.push({ event: 'leaves', once: true, text: `Return the exiled card.`, controller: g.controllerOf(src), source: src, sourceZcc: zcc,
      match: (g2, evt) => evt.card.id === src.id && evt.lki.zcc === zcc, resolve: function* (g2) { yield* back(g2); } });
  }
  /** Mill n (put the top n cards of your library into your graveyard). */
  const mill = (g, p, n) => g.mill(p, n);
  const equipped = (g, c) => g.battlefield.some(id => { const e = g.card(id); return e.attachedTo === c.id && g.isEquipment(e); });
  const isSith = (c) => (c.isLKI ? c.subtypes : c.def.subtypes).includes('Sith');
  const isJedi = (c) => (c.isLKI ? c.subtypes : c.def.subtypes).includes('Jedi');
  const isClone = (c) => (c.isLKI ? c.subtypes : c.def.subtypes).includes('Clone');
  const artifactsOf = (g, p) => g.battlefield.map(id => g.card(id)).filter(c => g.isArtifact(c) && g.controllerOf(c) === p);
  const anyTarget = (prompt) => ({ type: 'any', prompt: prompt || 'Choose any target.' });

  // ---------------------------------------------------------------------------
  // Revenge of the Sith helpers
  // ---------------------------------------------------------------------------
  /** Compromise N: give an opponent N Force counters, or lose N life. Returns 'force' | 'life'. */
  function* compromise(g, p, n, opts) { return yield* g.compromise(p, n, opts); }
  /** Optional Compromise N ("you may compromise N"): returns true if player compromised. */
  function* mayCompromise(g, p, n, opts) { return yield* g.mayCompromise(p, n, opts); }
  /** Match predicate for "At the beginning of your end step". */
  const yourEndStep = (g, src, evt) => evt.player === g.controllerOf(src);
  /** Trigger builder for "At the beginning of your end step, ...". */
  const endStep = (text, resolve, extra) => Object.assign({ event: 'endStep', text, match: yourEndStep, resolve }, extra || {});
  /** Register a delayed trigger for when `target` dies this turn ("When that creature dies this turn, ..."). */
  function delayedDies(g, src, target, text, resolve, extra) {
    if (!target || !g.isOnBattlefield(target)) return;
    const tid = target.id, tzcc = target.zcc;
    const controller = extra && extra.controller !== undefined ? extra.controller : g.controllerOf(src);
    g.delayedTriggers.push(Object.assign({
      event: 'dies', once: true, thisTurn: true,
      text: text || `When ${target.name} dies this turn.`,
      controller, source: src, sourceZcc: src.zcc,
      match: (g2, evt) => evt.card && evt.card.id === tid && evt.lki && evt.lki.zcc === tzcc,
      resolve,
    }, extra || {}));
  }
  /** Two creatures on the battlefield fight (deal damage equal to power to each other). */
  const fight = (g, a, b) => g.fight(a, b);
  /** Optional Force payment during resolution ("you may pay N Force counters"). */
  function* payForceOptional(g, p, n, prompt, sourceId) { return yield* g.payForceOptional(p, n, prompt, sourceId); }

  OF.cardHelpers = {
    force, attuned, etbForce, useForce, turnAbility, onTurn, costText, scry, exileUntilLeaves, mill, equipped,
    isSith, isJedi, isClone, artifactsOf, anyTarget, isSelfEvent, yourUpkeep, yourEndStep, endStep,
    compromise, mayCompromise, delayedDies, fight, payForceOptional,
    isInstantOrSorcery, attacksAloneYours,
    manaAny, manaOf, counterUnless, landDig, lookTopOrder, T, ownGyCreature, creaturesOf, allCreatures,
    opponents, loot, landsOf, controls, concordOf, ctl, attached, nontokenDiesYours, freshInGraveyard, etb,
    dies, upkeep, verse, onMulticolored, attacksTrig, selfPump, selfRegen, concordPT, concordKw, censer,
    confluenceCounter, tokens, drain, searchBasicToPlay, landFromHand, revealAndChoose, returnToHand,
    legendaryCast, multicolorEtbYours, multicolorDiesYours, destroyOnDamage, digToHandRestBottom,
    chooseTargetNow
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
