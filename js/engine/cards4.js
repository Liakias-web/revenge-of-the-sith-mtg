/* Revenge of the Sith card scripts, part 4: Multicolor (086–105, incl. 097B, 098B, 104B),
 * Artifacts (106–113), and Lands (114–120B). Uses helpers from cards.js (OF.cardHelpers).
 * Keywords, Equip {cost}, Afterimage {cost}, "This land enters tapped.", and simple "{T}: Add ..." mana lines
 * are derived from the rules text by engine.js; scripts add everything else. */
(function (OF) {
  'use strict';
  const S = OF.CardScripts;
  const H = OF.cardHelpers;
  const { T, ownGyCreature, creaturesOf, opponents, loot, attached, nontokenDiesYours, isInstantOrSorcery,
    etb, dies, upkeep, attacksTrig, tokens, drain, searchBasicToPlay, revealAndChoose, returnToHand,
    etbForce, useForce, turnAbility, onTurn, scry, equipped, isJedi, artifactsOf, anyTarget } = H;

  // ---------------------------------------------------------------------------
  // Local helpers
  // ---------------------------------------------------------------------------
  const live = (g, ctx) => g.isOnBattlefield(ctx.source, ctx.sourceZcc) ? ctx.source : null;
  const attackingOther = (prompt, extra) => T.creature(prompt || 'Choose another target attacking creature.', (g, c) => g.attacking(c), Object.assign({ notSelf: true }, extra || {}));
  const equipStatics = (p, t, kws) => {
    const out = [];
    if (p || t) out.push({ pt: (g, src, c) => attached(g, src, c) ? [p, t] : null });
    if (kws && kws.length) out.push({ keywords: (g, src, c) => attached(g, src, c) ? kws : null });
    return out;
  };
  const equipAi = (p, t, kws) => ({ kind: 'equipment', target: 'ownCreature', when: 'main', p, t, keywords: kws || [] });
  const equippedHitsPlayer = (g, src, evt) => !!(evt.source && src.attachedTo && src.attachedTo === evt.source.id);

  function* optionalDiscard(g, p, filter, prompt, sourceId) {
    const cands = g.players[p].hand.map(id => g.card(id)).filter(c => !filter || filter(c));
    if (!cands.length) return null;
    const pick = yield* g.chooseCards(p, cands, 0, 1, prompt, { reason: 'optionalDiscard', sourceId, alwaysAsk: true });
    if (!pick.length) return null;
    g.discard(pick[0]);
    return pick[0];
  }

  function* optionalSacrifice(g, p, cands, prompt, sourceId, benefit) {
    if (!cands.length) return null;
    const pick = yield* g.chooseCards(p, cands, 0, 1, prompt, { reason: 'optionalSacrifice', sourceId, benefit, alwaysAsk: true });
    if (!pick.length || !g.isOnBattlefield(pick[0])) return null;
    g.sacrifice(pick[0]);
    return pick[0];
  }

  // ===========================================================================
  // MULTICOLOR 086–105 (incl. 097B, 098B, 104B)
  // ===========================================================================

  // ROTS-086
  S['Senate Garrison'] = {
    triggers: [
      etb('Each opponent loses 1 life and you gain 1 life.', function* (g, ctx) { drain(g, ctx.controller, 1); }),
      dies('You get 1 Force counter.', function* (g, ctx) { g.gainForce(ctx.controller, 1); }),
    ],
  };

  // ROTS-087 (Flying auto-derived)
  S['Vulture Wing'] = {
    triggers: [etb('You may discard a card. If you do, draw a card.', function* (g, ctx) {
      const d = yield* optionalDiscard(g, ctx.controller, null, 'You may discard a card. If you do, draw a card.', ctx.source.id);
      if (d) g.draw(ctx.controller, 1);
    })],
  };

  // ROTS-088
  S['Felucian Grovekeeper'] = {
    triggers: [etbForce(2)],
    activated: [useForce(2, 'Use the Force 2: Tap target creature with flying. Activate only once each turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.tap(c);
    }, {
      oncePerTurn: true,
      targets: [T.creature('Choose target creature with flying to tap.', (g, c) => g.has(c, 'flying'))],
      ai: { kind: 'tap', target: 'oppCreature', when: 'combat' },
    })],
  };

  // ROTS-089
  S['Wookiee Canopy Team'] = {
    statics: [{ keywords: (g, src, c) => (c === src && artifactsOf(g, g.controllerOf(src)).length > 0) ? ['trample'] : null }],
  };

  // ROTS-090
  S['Polis Massa Midwives'] = {
    triggers: [etb('Return up to one target creature card with mana value 2 or less from your graveyard to the battlefield. Compromise 2.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && c.zone === 'graveyard') {
        yield* g.putOntoBattlefield(c, ctx.controller);
        g.log(`[[${c.name}]] returns to the battlefield.`);
      }
      yield* g.compromise(ctx.controller, 2, { sourceId: ctx.source.id });
    }, {
      targets: [ownGyCreature('Choose up to one target creature card with mana value 2 or less in your graveyard.', (g, c) => g.manaValue(c) <= 2, { min: 0, max: 1 })],
      ai: { kind: 'reanimate', target: 'self' },
    })],
  };

  // ROTS-091
  S['For The Better, Right?'] = {
    spell: {
      ai: { kind: 'removal', target: 'oppCreature', when: 'main', exile: true },
      modes: [
        {
          label: 'Exile target tapped creature. Compromise 2.',
          targets: [T.creature('Choose target tapped creature to exile.', (g, c) => c.tapped)],
          ai: { kind: 'removal', target: 'oppCreature', when: 'main', exile: true },
          resolve: function* (g, ctx) {
            const c = ctx.t(0);
            if (c) { g.exile(c); g.log(`[[${c.name}]] is exiled.`); }
            yield* g.compromise(ctx.controller, 2, { sourceId: ctx.source.id });
          },
        },
        {
          label: 'Target opponent reveals their hand. You choose a nonland card from it. That player discards that card. Compromise 2.',
          targets: [T.opponent()],
          ai: { kind: 'discard', target: 'opponent', when: 'main' },
          resolve: function* (g, ctx) {
            const P = ctx.t(0);
            if (P) {
              const pick = yield* revealAndChoose(g, ctx, P, c => !g.isLand(c), 'Choose a nonland card for that player to discard.');
              if (pick) g.discard(pick);
            }
            yield* g.compromise(ctx.controller, 2, { sourceId: ctx.source.id });
          },
        },
      ],
    },
  };

  // ROTS-092 (First strike auto-derived)
  S['Torrent Squadron Wingman'] = {
    triggers: [etb('Create a 1/1 white Clone Soldier creature token.', function* (g, ctx) {
      yield* tokens(g, ctx.controller, 'Clone Soldier', 1);
    })],
  };

  // ROTS-093 (Reach auto-derived)
  S['Geonosian Signal Thief'] = {
    triggers: [etb('You may sacrifice an artifact. If you do, draw two cards, then discard a card.', function* (g, ctx) {
      const s = yield* optionalSacrifice(g, ctx.controller, artifactsOf(g, ctx.controller), 'You may sacrifice an artifact (draw two cards, then discard a card).', ctx.source.id, 'draw2discard1');
      if (!s) return;
      g.draw(ctx.controller, 2);
      yield* g.discardChoose(ctx.controller, 1, 'Discard a card.');
    })],
  };

  // ROTS-094
  S['Reclaim the Wreck'] = {
    spell: {
      targets: [
        { type: 'artifact', prompt: 'Choose up to one target artifact to destroy.', min: 0, max: 1 },
        ownGyCreature('Choose up to one target creature card in your graveyard to return to your hand.', null, { min: 0, max: 1 }),
      ],
      ai: { kind: 'artifactRemoval', target: 'oppCreature', when: 'response' },
      resolve: function* (g, ctx) {
        const a = ctx.t(0);
        if (a) g.destroy(a);
        const c = ctx.t(1);
        if (c && c.zone === 'graveyard') returnToHand(g, c);
      },
    },
  };

  // ROTS-095 ("{T}: Add {G}, {U}, or {R}." auto-derived)
  S['Separatist Signal Array'] = {
    triggers: [etbForce(3)],
  };

  // ROTS-096 (Afterimage {3}{G}{U}{R} auto-derived)
  S['Chart the Outer Rim'] = {
    spell: {
      ai: { kind: 'ramp', target: 'self', when: 'main' },
      resolve: function* (g, ctx) {
        yield* searchBasicToPlay(g, ctx.controller, 1, true);
        yield* loot(g, ctx.controller, ctx.source.id, false);
      },
    },
  };

  // ROTS-097
  S['501st Legion'] = {
    triggers: [
      etb('Create a 1/1 white Clone Soldier creature token.', function* (g, ctx) {
        yield* tokens(g, ctx.controller, 'Clone Soldier', 1);
      }),
      {
        event: 'endStep',
        text: 'If you attacked with three or more creatures this turn and a creature died this turn, 501st Legion turns to the Dark Side.',
        match: (g, src, evt) => evt.player === g.controllerOf(src),
        condition: (g, src) => {
          const p = g.controllerOf(src);
          const atk = g.attackedThisTurn(p);
          const count = Array.isArray(atk) ? atk.length : (atk && typeof atk.size === 'number' ? atk.size : Number(atk || 0));
          return count >= 3 && g.anyCreatureDiedThisTurn();
        },
        resolve: function* (g, ctx) {
          if (live(g, ctx)) g.transform(ctx.source, 'dark');
        },
      },
    ],
  };

  // ROTS-097B (Menace auto-derived)
  S['501st, Vader\u2019s Fist'] = {
    triggers: [onTurn('dark', 'Up to one target creature an opponent controls gets -3/-3 until end of turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.pump(c, -3, -3);
    }, {
      targets: [T.oppCreature('Choose up to one target creature an opponent controls (-3/-3).', { min: 0, max: 1 })],
      ai: { kind: 'removal', target: 'oppCreature', shrink: 3 },
    })],
  };

  // ROTS-098 (Lifelink auto-derived)
  S['Asajj Ventress, Lost Padawan'] = {
    triggers: [
      attacksTrig('Another target attacking creature gains lifelink until end of turn.', function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.grantEOT(c, 'lifelink');
      }, { targets: [attackingOther('Choose another target attacking creature (gains lifelink).')], ai: { kind: 'pump', target: 'ownCreature' } }),
      {
        event: 'endStep',
        text: 'If you lost 4 or more life this turn, Asajj Ventress turns to the Dark Side.',
        match: (g, src, evt) => evt.player === g.controllerOf(src),
        condition: (g, src) => g.lifeLostThisTurn(g.controllerOf(src)) >= 4,
        resolve: function* (g, ctx) {
          if (live(g, ctx)) g.transform(ctx.source, 'dark');
        },
      },
    ],
  };

  // ROTS-098B (Menace auto-derived)
  S['Asajj Ventress, Dooku\u2019s Assassin'] = {
    triggers: [onTurn('dark', 'Destroy up to one target creature with mana value 4 or less.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.destroy(c);
    }, {
      targets: [T.creature('Choose up to one target creature with mana value 4 or less to destroy.', (g, c) => g.manaValue(c) <= 4, { min: 0, max: 1 })],
      ai: { kind: 'removal', target: 'oppCreature' },
    })],
  };

  // ROTS-099
  S['Empire by Acclamation'] = {
    triggers: [upkeep("You may sacrifice a creature. If you do, each opponent loses life equal to that creature's power and you gain that much life.", function* (g, ctx) {
      const p = ctx.controller;
      const cands = creaturesOf(g, p);
      if (!cands.length) return;
      const pick = yield* g.chooseCards(p, cands, 0, 1, 'You may sacrifice a creature (each opponent loses life equal to its power and you gain that much life).', {
        reason: 'optionalSacrifice', sourceId: ctx.source.id, benefit: 'drain', alwaysAsk: true,
      });
      if (!pick.length || !g.isOnBattlefield(pick[0])) return;
      const pow = Math.max(0, g.power(pick[0]));
      g.sacrifice(pick[0]);
      if (pow > 0) drain(g, p, pow);
    })],
  };

  // ROTS-100 (Defender auto-derived)
  S['Palpatine, Supreme Chancellor'] = {
    enterUnderOpponent: true,
    triggers: [upkeep("If you don't own Palpatine, put an influence counter on it, then you lose 1 life for each influence counter on it and Palpatine's owner scries 1.", function* (g, ctx) {
      const me = live(g, ctx);
      const p = ctx.controller;
      if (!me || me.owner === p) return;
      g.addCounter(me, 'influence', 1);
      const n = me.counters.influence || 0;
      if (n > 0) g.loseLife(p, n);
      yield* scry(g, me.owner, 1, me.id);
    }, { condition: (g, src) => src.owner !== g.controllerOf(src) })],
  };

  // ROTS-101
  S['Qui-Gon Jinn, Living Force'] = {
    triggers: [
      etbForce(2),
      {
        event: 'dies',
        oncePerTurn: true,
        text: 'You may put a +1/+1 counter on target creature you control. This ability triggers only once each turn.',
        match: nontokenDiesYours,
        targets: [T.ownCreature('You may choose target creature you control (+1/+1 counter).', null, { min: 0, max: 1 })],
        ai: { kind: 'pump', target: 'ownCreature', counter: true },
        resolve: function* (g, ctx) {
          const c = ctx.t(0);
          if (c) g.addCounters(c, 1);
        },
      },
    ],
    activated: [useForce(3, 'Use the Force 3: Return target creature card with mana value 2 or less from your graveyard to your hand. Activate only as a sorcery.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && c.zone === 'graveyard') returnToHand(g, c);
    }, {
      sorcery: true,
      targets: [ownGyCreature('Choose target creature card with mana value 2 or less in your graveyard.', (g, c) => g.manaValue(c) <= 2)],
      ai: { kind: 'recursion', target: 'self', when: 'main' },
    })],
  };

  // ROTS-102 (First strike auto-derived)
  S['Darth Maul, Shadow Apprentice'] = {
    triggers: [{
      event: 'combatDamagePlayer',
      text: 'You get 2 Force counters.',
      match: (g, src, evt) => evt.source && evt.source.id === src.id,
      resolve: function* (g, ctx) { g.gainForce(ctx.controller, 2); },
    }],
    activated: [useForce(2, 'Use the Force 2: Darth Maul deals 1 damage to target creature. Activate only once each turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.damage(ctx.source, c, 1);
    }, {
      oncePerTurn: true,
      targets: [T.creature('Choose target creature (1 damage).')],
      ai: { kind: 'burn', target: 'oppCreature', when: 'main', amount: 1 },
    })],
  };

  // ROTS-103 (Flying auto-derived)
  S['The Invisible Hand'] = {
    triggers: [etb('Create two 1/1 colorless Droid artifact creature tokens.', function* (g, ctx) {
      yield* tokens(g, ctx.controller, 'Droid', 2);
    })],
    activated: [{
      cost: { tap: true, force: 5 },
      text: '{T}, Use the Force 5: The Invisible Hand deals 3 damage to any target.',
      targets: [anyTarget()],
      ai: { kind: 'burn', target: 'oppCreature', when: 'main', amount: 3 },
      resolve: function* (g, ctx) {
        const t = ctx.t(0);
        if (t) g.damage(ctx.source, t, 3);
      },
    }],
  };

  // ROTS-104 (First strike auto-derived)
  S['Count Dooku, Lost Idealist'] = {
    triggers: [etb('Look at the top three cards of your library. Put one into your hand and the rest into your graveyard.', function* (g, ctx) {
      const p = ctx.controller;
      const top = g.topCards(p, 3);
      if (!top.length) return;
      const pick = yield* g.chooseCards(p, top, 1, 1, 'Put one of these cards into your hand. The rest go into your graveyard.', {
        reason: 'toHand', sourceId: ctx.source.id, alwaysAsk: true, shown: top.map(c => c.id),
      });
      if (pick.length) g.toHand(pick[0]);
      for (const c of top) {
        if (!pick.includes(c)) {
          g.moveToZone(c, 'graveyard');
          g.log(`${g.players[p].name} puts [[${c.name}]] into their graveyard.`);
        }
      }
    })],
    activated: [turnAbility('dark', {
      mana: '{3}{U}{B}',
      sacrifice: { other: true, filter: (g, x) => g.isCreature(x), label: 'another creature', prompt: 'Choose another creature to sacrifice.' },
    }, null, {
      text: '{3}{U}{B}, Sacrifice another creature: Count Dooku turns to the Dark Side. Activate only as a sorcery.',
    })],
  };

  // ROTS-104B (First strike, deathtouch auto-derived)
  S['Darth Tyranus, Sith Count'] = {
    triggers: [onTurn('dark', 'Return up to one target instant or sorcery card from your graveyard to your hand. You get 3 Force counters.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && c.zone === 'graveyard') returnToHand(g, c);
      g.gainForce(ctx.controller, 3);
    }, {
      targets: [T.gyCard('you', 'Choose up to one target instant or sorcery card in your graveyard.', (g, c) => isInstantOrSorcery(g, c), { min: 0, max: 1 })],
      ai: { kind: 'recursion', target: 'self' },
    })],
    activated: [{
      cost: { mana: '{U}{B}', force: 3 },
      oncePerTurn: true,
      text: '{U}{B}, Use the Force 3: Target creature gets -3/-3 until end of turn. Activate only once each turn.',
      targets: [T.creature('Choose target creature (-3/-3).')],
      ai: { kind: 'removal', target: 'oppCreature', when: 'combat', shrink: 3 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.pump(c, -3, -3);
      },
    }],
  };

  // ROTS-105
  S['General Grievous, Blade Collector'] = {
    triggers: [
      etb('You may search your library for an Equipment card, reveal it, put it into your hand, then shuffle.', function* (g, ctx) {
        const p = ctx.controller;
        const found = yield* g.searchLibrary(p, c => g.isEquipment(c), 1, 'You may search your library for an Equipment card.');
        if (found.length) { g.reveal(p, found, ctx.source.name); g.toHand(found[0]); }
        g.shuffle(p);
      }),
      attacksTrig('You may attach an Equipment you control to General Grievous.', function* (g, ctx) {
        const me = live(g, ctx);
        if (!me) return;
        const p = ctx.controller;
        const eqs = g.battlefield.map(id => g.card(id)).filter(c => g.isEquipment(c) && g.controllerOf(c) === p && c.attachedTo !== me.id);
        if (!eqs.length) return;
        const pick = yield* g.chooseCards(p, eqs, 0, 1, `You may attach an Equipment you control to ${me.name}.`, {
          reason: 'attachEquipment', sourceId: me.id, alwaysAsk: true,
        });
        if (pick.length && g.isOnBattlefield(pick[0]) && g.isOnBattlefield(me)) {
          g.attach(pick[0], me);
          g.log(`[[${pick[0].name}]] is attached to [[${me.name}]].`);
        }
      }),
    ],
    statics: [{ keywords: (g, src, c) => (c === src && equipped(g, src)) ? ['doubleStrike', 'trample'] : null }],
  };

  // ===========================================================================
  // ARTIFACTS 106–113
  // ===========================================================================

  // ROTS-106
  S['B1 Droid Pair'] = {
    triggers: [etb('Create a 1/1 colorless Droid artifact creature token.', function* (g, ctx) {
      yield* tokens(g, ctx.controller, 'Droid', 1);
    })],
  };

  // ROTS-107
  S['Medical Capsule'] = {
    triggers: [etbForce(1)],
    activated: [{
      cost: { mana: '{1}', tap: true, sacSelf: true },
      text: '{1}, {T}, Sacrifice Medical Capsule: You gain 3 life. Draw a card.',
      ai: { kind: 'draw', target: 'self', when: 'endOfTurn', life: 3 },
      resolve: function* (g, ctx) {
        g.gainLife(ctx.controller, 3);
        g.draw(ctx.controller, 1);
      },
    }],
  };

  // ROTS-108
  S['Astromech Scout'] = {
    noAutoMana: true,
    activated: [
      { mana: { produce: 'C' }, cost: { tap: true }, text: '{T}: Add {C}.' },
      { mana: { produce: 'ANY' }, cost: { tap: true, force: 1 }, text: '{T}, Use the Force 1: Add one mana of any color.' },
    ],
  };

  // ROTS-109 (Flying auto-derived)
  S['Republic Gunship'] = {};

  // ROTS-110
  S['Temple Training Holocron'] = {
    triggers: [etbForce(2)],
    activated: [{
      cost: { mana: '{3}', tap: true, force: 3 },
      text: '{3}, {T}, Use the Force 3: Draw a card.',
      ai: { kind: 'draw', target: 'self', when: 'endOfTurn' },
      resolve: function* (g, ctx) { g.draw(ctx.controller, 1); },
    }],
  };

  // ROTS-111
  S['Comms Disruptor'] = {
    triggers: [etb('Tap up to one target artifact or creature.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.tap(c);
    }, {
      targets: [{ type: ['artifact', 'creature'], prompt: 'Choose up to one target artifact or creature to tap.', min: 0, max: 1 }],
      ai: { kind: 'tap', target: 'oppCreature' },
    })],
    activated: [{
      cost: { mana: '{2}', tap: true, sacSelf: true },
      text: '{2}, {T}, Sacrifice Comms Disruptor: Destroy target artifact.',
      targets: [{ type: 'artifact', prompt: 'Choose target artifact to destroy.' }],
      ai: { kind: 'artifactRemoval', target: 'oppCreature', when: 'response' },
      resolve: function* (g, ctx) {
        const a = ctx.t(0);
        if (a) g.destroy(a);
      },
    }],
  };

  // ROTS-112 (Equip {2} auto-derived)
  S['Jedi Lightsaber'] = {
    statics: [
      { pt: (g, src, c) => attached(g, src, c) ? [1, 1] : null },
      { keywords: (g, src, c) => attached(g, src, c) ? (isJedi(c) ? ['firstStrike', 'vigilance'] : ['firstStrike']) : null },
    ],
    ai: equipAi(1, 1, ['firstStrike']),
  };

  // ROTS-113 (Equip {3} auto-derived)
  S['Maul\u2019s Lightsaber'] = {
    statics: equipStatics(0, 0, ['doubleStrike']),
    triggers: [{
      event: 'combatDamagePlayer',
      oncePerTurn: true,
      text: 'You get 1 Force counter. This ability triggers only once each turn.',
      match: equippedHitsPlayer,
      resolve: function* (g, ctx) { g.gainForce(ctx.controller, 1); },
    }],
    ai: equipAi(0, 0, ['doubleStrike']),
  };

  // ===========================================================================
  // LANDS 114–120 (incl. 120B)
  // ===========================================================================

  // ROTS-114
  S['Frontier Supply Post'] = {
    entersTapped: true,
    noAutoMana: true,
    triggers: [etbForce(1)],
    activated: [
      { mana: { produce: 'C' }, cost: { tap: true }, text: '{T}: Add {C}.' },
      { mana: { produce: 'ANY' }, cost: { tap: true, force: 1 }, text: '{T}, Use the Force 1: Add one mana of any color.' },
    ],
  };

  // ROTS-115 ("{T}: Add {C}." auto-derived)
  S['Envoy\u2019s Landing'] = {
    activated: [{
      cost: { mana: '{1}', tap: true, sacSelf: true },
      text: "{1}, {T}, Sacrifice Envoy's Landing: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
      ai: { kind: 'ramp', target: 'self', when: 'endOfTurn' },
      resolve: function* (g, ctx) { yield* searchBasicToPlay(g, ctx.controller, 1, true); },
    }],
  };

  // ROTS-116 ("{T}: Add {C}." and "{1}, {T}: Add one mana of any color." auto-derived)
  S['Trade Route Junction'] = {};

  // ROTS-117 ("{T}: Add {U} or {R}." auto-derived)
  S['Geonosis, Foundry Spires'] = { entersTapped: true };

  // ROTS-118 ("{T}: Add {R} or {G}." auto-derived)
  S['Kashyyyk, Tidal Canopy'] = { entersTapped: true };

  // ROTS-119 ("{T}: Add {G} or {U}." auto-derived)
  S['Naboo, Lake Country'] = { entersTapped: true };

  // ROTS-120 ("{T}: Add {C}." and "{1}, {T}: Add one mana of any color." auto-derived)
  S['Jedi Temple, Coruscant'] = {
    triggers: [{
      event: 'endStep',
      text: 'If a Jedi you controlled died this turn and an opponent lost 3 or more life this turn, Jedi Temple turns to the Dark Side.',
      match: (g, src, evt) => evt.player === g.controllerOf(src),
      condition: (g, src) => {
        const p = g.controllerOf(src);
        return g.jediDiedThisTurn(p) > 0 && opponents(g, p).some(o => g.lifeLostThisTurn(o) >= 3);
      },
      resolve: function* (g, ctx) {
        if (live(g, ctx)) g.transform(ctx.source, 'dark');
      },
    }],
  };

  // ROTS-120B ("{T}: Add {W} or {B}." auto-derived)
  S['Imperial Palace'] = {
    triggers: [onTurn('dark', 'Create two 1/1 white and black Clone Soldier creature tokens.', function* (g, ctx) {
      yield* tokens(g, ctx.controller, 'Imperial Clone Soldier', 2);
    })],
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
