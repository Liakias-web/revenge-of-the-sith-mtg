/* Revenge of the Sith card scripts, part 1: collector numbers 001–034 (White 001–017B, Blue 018–034).
 * Uses helpers from cards.js (OF.cardHelpers). Keywords, Afterimage, Equip, and simple mana lines are
 * derived automatically by engine.js; everything else is scripted here. */
(function (OF) {
  'use strict';
  const S = OF.CardScripts;
  const H = OF.cardHelpers;
  const {
    T, etb, dies, upkeep, attacksTrig, etbForce, useForce, onTurn, scry, exileUntilLeaves,
    attuned, creaturesOf, opponents, loot, attached, returnToHand, tokens, artifactsOf,
    ownGyCreature, isJedi, nontokenDiesYours, isInstantOrSorcery,
  } = H;

  // ---------------------------------------------------------------------------
  // Local helpers (part 1)
  // ---------------------------------------------------------------------------
  const yourEndStep = (g, src, evt) => evt.player === g.controllerOf(src);
  const forceOf = (g, p) => (typeof g.forceOf === 'function' ? g.forceOf(p) : (g.players[p] ? g.players[p].force : 0));
  const spendForce = (g, p, n) => (typeof g.spendForce === 'function' ? g.spendForce(p, n) : g.payForce(p, n));
  const controlsJedi = (g, p) => g.battlefield.some(id => {
    const c = g.card(id);
    return g.controllerOf(c) === p && isJedi(c);
  });
  /** "Whenever you attack" / "Whenever one or more ... attack": fire once per combat on the first qualifying attacker. */
  const firstAttackerMatch = (filter) => (g, src, evt) => {
    if (!g.combat) return false;
    const me = g.controllerOf(src);
    const first = g.combat.attackers.map(a => g.card(a.id)).find(c => c && g.controllerOf(c) === me && filter(g, c, src));
    return !!first && first.id === evt.card.id;
  };

  // ===========================================================================
  // WHITE 001–017B
  // ===========================================================================

  // 001 Temple Initiate
  S['Temple Initiate'] = {
    triggers: [etbForce(1)],
  };

  // 002 Kamino Drill Squad
  S['Kamino Drill Squad'] = {};

  // 003 Naboo Palace Guard
  S['Naboo Palace Guard'] = {};

  // 004 Geonosis Relief Jedi
  S['Geonosis Relief Jedi'] = {};

  // 005 Sky Lane Escort
  S['Sky Lane Escort'] = {};

  // 006 Senate Observer
  S['Senate Observer'] = {
    triggers: [etb('You may compromise 1. When you do, tap target creature an opponent controls.', function* (g, ctx) {
      const p = ctx.controller;
      const oppCreatures = g.battlefield.map(id => g.card(id)).filter(c =>
        g.isCreature(c) && g.controllerOf(c) !== p
        && !g.has(c, 'shroud') && !g.has(c, 'untargetable') && !g.has(c, 'hexproofOpp')
        && !g.protectedFrom(c, ctx.source)
      );
      if (!oppCreatures.length) return;
      const did = yield* g.mayCompromise(p, 1, { sourceId: ctx.source.id, benefit: 'tap' });
      if (!did) return;
      const pick = yield* g.chooseCards(p, oppCreatures, 1, 1, 'Choose target creature an opponent controls to tap.', { reason: 'tap', sourceId: ctx.source.id });
      if (pick.length && g.isOnBattlefield(pick[0])) g.tap(pick[0]);
    })],
  };

  // 007 Halt the Advance
  S['Halt the Advance'] = {
    spell: {
      targets: [T.creature('Choose target attacking or blocking creature.', (g, c) => g.attacking(c) || g.blocking(c))],
      ai: { kind: 'removal', target: 'oppCreature', when: 'combat', damage: 3 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.damage(ctx.source, c, 3);
      },
    },
  };

  // 008 Seal the Archives
  S['Seal the Archives'] = {
    spell: {
      targets: [{ type: ['artifact', 'enchantment'], prompt: 'Choose target artifact or enchantment.' }],
      ai: { kind: 'artifactRemoval', target: 'opponent', exile: true },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.exile(c);
        g.gainForce(ctx.controller, 1);
      },
    },
  };

  // 009 Clone Reinforcements (Afterimage {5}{W} auto-derived)
  S['Clone Reinforcements'] = {
    spell: {
      ai: { kind: 'token' },
      resolve: function* (g, ctx) {
        yield* tokens(g, ctx.controller, 'Clone Soldier', 2);
      },
    },
  };

  // 010 Battle Meditation at First Light
  S['Battle Meditation at First Light'] = {
    spell: {
      targets: [T.ownCreature('Choose up to two target creatures you control.', null, { min: 0, max: 2 })],
      ai: { kind: 'pump', target: 'ownCreature', when: 'combat' },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        const cs = ctx.ts(0);
        for (const c of cs) {
          g.untap(c);
          g.pump(c, 1, 2);
        }
        if (cs.length && forceOf(g, p) >= 2) {
          const yes = yield* g.yesNo(p, 'Pay 2 Force counters to give those creatures first strike until end of turn?', { reason: 'payForce', amount: 2, sourceId: ctx.source.id });
          if (yes && spendForce(g, p, 2)) {
            for (const c of cs) g.grantEOT(c, 'firstStrike');
          }
        }
      },
    },
  };

  // 011 Padmé Amidala, Civic Liaison
  S['Padmé Amidala, Civic Liaison'] = {
    triggers: [{
      event: 'dies',
      text: 'Whenever another nontoken creature you control dies, you gain 1 life.',
      match: (g, src, evt) => evt.card.id !== src.id && nontokenDiesYours(g, src, evt),
      resolve: function* (g, ctx) { g.gainLife(ctx.controller, 1); },
    }],
    activated: [{
      cost: { mana: '{B}', life: 1 },
      text: '{B}, Pay 1 life: Padmé Amidala gains deathtouch until end of turn.',
      ai: { kind: 'pump', target: 'self', when: 'combat' },
      resolve: function* (g, ctx) {
        if (g.isOnBattlefield(ctx.source, ctx.sourceZcc)) g.grantEOT(ctx.source, 'deathtouch');
      },
    }],
  };

  // 012 Unexpected Delegation (Flash auto-derived)
  S['Unexpected Delegation'] = {
    triggers: [etb("Return up to one other target permanent you control to its owner's hand.", function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.bounce(c);
    }, { targets: [{ type: 'permanent', yours: true, min: 0, notSelf: true, prompt: 'Choose up to one other target permanent you control.' }] })],
  };

  // 013 Jedi Battalion-General
  S['Jedi Battalion-General'] = {
    triggers: [
      etb('Create a 1/1 white Clone Soldier creature token.', function* (g, ctx) {
        yield* tokens(g, ctx.controller, 'Clone Soldier', 1);
      }),
      {
        event: 'attacks',
        text: 'Attunement — Whenever you attack, if you spent a Force counter this turn, attacking creature tokens you control get +1/+0 until end of turn.',
        match: firstAttackerMatch(() => true),
        condition: (g, src) => attuned(g, g.controllerOf(src)),
        resolve: function* (g, ctx) {
          for (const c of creaturesOf(g, ctx.controller)) {
            if (c.token && g.attacking(c)) g.pump(c, 1, 0);
          }
        },
      },
    ],
  };

  // 014 Temple Vigil
  S['Temple Vigil'] = {
    triggers: [etbForce(2)],
    activated: [useForce(2, 'Use the Force 2: Target attacking or blocking creature you control gets +2/+2 until end of turn. Activate only once each turn.',
      function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.pump(c, 2, 2);
      },
      {
        oncePerTurn: true,
        targets: [T.ownCreature('Choose target attacking or blocking creature you control.', (g, c) => g.attacking(c) || g.blocking(c))],
        ai: { kind: 'pump', target: 'ownCreature', when: 'combat' },
      })],
  };

  // 015 Mace Windu, Vaapad Master (First strike auto-derived)
  S['Mace Windu, Vaapad Master'] = {
    triggers: [
      etb('Exile up to one target tapped creature an opponent controls until Mace Windu leaves the battlefield.', function* (g, ctx) {
        const t = ctx.t(0);
        if (t && g.isOnBattlefield(ctx.source, ctx.sourceZcc)) exileUntilLeaves(g, ctx.source, t);
      }, {
        targets: [T.creature('Choose up to one target tapped creature an opponent controls.', (g, c, p) => g.controllerOf(c) !== p && c.tapped, { min: 0 })],
      }),
      attacksTrig('You may pay {B} and 1 life. If you do, Mace Windu gains deathtouch until end of turn.', function* (g, ctx) {
        const p = ctx.controller;
        if (!g.isOnBattlefield(ctx.source, ctx.sourceZcc)) return;
        if (g.players[p].life < 1) return;
        const paid = yield* g.payOptional(p, '{B}', 'Pay {B} and 1 life to give Mace Windu deathtouch until end of turn?', ctx.source.id, 'vaapad');
        if (!paid) return;
        g.loseLife(p, 1);
        if (g.isOnBattlefield(ctx.source, ctx.sourceZcc)) g.grantEOT(ctx.source, 'deathtouch');
      }),
    ],
  };

  // 016 Rebuild the Order
  S['Rebuild the Order'] = {
    spell: {
      targets: [ownGyCreature('Choose up to two target creature cards with mana value 3 or less in your graveyard.', (g, c) => g.manaValue(c) <= 3, { min: 0, max: 2 })],
      ai: { kind: 'reanimate', target: 'self', when: 'main' },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        const cards = ctx.ts(0);
        let jediReturned = 0;
        for (const c of cards) {
          if (c.zone !== 'graveyard') continue;
          yield* g.putOntoBattlefield(c, p);
          g.log(`[[${c.name}]] returns to the battlefield.`);
          if (isJedi(c)) jediReturned++;
        }
        if (jediReturned > 0) g.gainForce(p, jediReturned);
      },
    },
  };

  // 017 Anakin, Hero With No Fear (Vigilance auto-derived)
  S['Anakin, Hero With No Fear'] = {
    triggers: [
      etbForce(2),
      {
        event: 'endStep',
        text: 'At the beginning of your end step, if you have 2 or fewer Force counters and another nontoken creature you controlled died this turn, Anakin turns to the Dark Side.',
        match: yourEndStep,
        condition: (g, src) => {
          const p = g.controllerOf(src);
          return forceOf(g, p) <= 2 && g.nontokenDiedThisTurn(p, src.id) > 0;
        },
        resolve: function* (g, ctx) {
          if (g.isOnBattlefield(ctx.source, ctx.sourceZcc)) g.transform(ctx.source, 'dark');
        },
      },
    ],
    activated: [useForce(2, 'Use the Force 2: Another target creature you control gains indestructible until end of turn.',
      function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.grantEOT(c, 'indestructible');
      },
      {
        targets: [T.ownCreature('Choose another target creature you control.', null, { notSelf: true })],
        ai: { kind: 'protect', target: 'ownCreature', when: 'response' },
      })],
  };

  // 017B Darth Vader, Iron Betrayal (Menace auto-derived)
  S['Darth Vader, Iron Betrayal'] = {
    triggers: [
      onTurn('dark', 'Each opponent sacrifices a creature.', function* (g, ctx) {
        for (const o of opponents(g, ctx.controller)) {
          yield* g.sacrificeChoose(o, c => g.isCreature(c), 1, 'Sacrifice a creature (Darth Vader).');
        }
      }),
      attacksTrig('You may sacrifice another creature. If you do, Darth Vader gets +2/+0 and gains indestructible until end of turn.', function* (g, ctx) {
        const p = ctx.controller;
        const me = ctx.source;
        const cands = creaturesOf(g, p).filter(c => c.id !== me.id);
        if (!cands.length) return;
        const pick = yield* g.chooseCards(p, cands, 0, 1, 'You may sacrifice another creature (Darth Vader gets +2/+0 and gains indestructible until end of turn).', { reason: 'optionalSacrifice', sourceId: me.id, benefit: 'pump', alwaysAsk: true });
        if (!pick.length || pick[0].zone !== 'battlefield') return;
        if (g.sacrifice(pick[0]) && g.isOnBattlefield(me, ctx.sourceZcc)) {
          g.pump(me, 2, 0);
          g.grantEOT(me, 'indestructible');
        }
      }),
    ],
  };

  // ===========================================================================
  // BLUE 018–034
  // ===========================================================================

  // 018 Kamino Sample Keeper
  S['Kamino Sample Keeper'] = {
    activated: [{
      cost: { tap: true },
      sorcery: true,
      condition: (g, c, p) => artifactsOf(g, p).length > 0,
      text: '{T}: Draw a card, then discard a card. Activate only if you control an artifact and only as a sorcery.',
      ai: { kind: 'loot', when: 'main' },
      resolve: function* (g, ctx) { yield* loot(g, ctx.controller, ctx.source.id); },
    }],
  };

  // 019 Turbolift Interceptor (Flying, canBlockOnlyFlying auto-derived)
  S['Turbolift Interceptor'] = {};

  // 020 Archive Night Shift
  S['Archive Night Shift'] = {
    triggers: [etbForce(2)],
    activated: [useForce(2, 'Use the Force 2: Scry 1. Activate only once each turn.',
      function* (g, ctx) { yield* scry(g, ctx.controller, 1, ctx.source.id); },
      { oncePerTurn: true, ai: { kind: 'scry', when: 'endOfTurn' } })],
  };

  // 021 Cloudbank Courier (Flying auto-derived)
  S['Cloudbank Courier'] = {
    triggers: [etb("You may return target artifact you control to its owner's hand.", function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.bounce(c);
    }, { targets: [{ type: 'artifact', yours: true, min: 0, prompt: 'Choose up to one target artifact you control.' }] })],
  };

  // 022 The Senate Surprised
  S['The Senate Surprised'] = {
    spell: {
      targets: [T.creature('Choose up to two target creatures.', null, { min: 0, max: 2 })],
      ai: { kind: 'tap', target: 'oppCreature', when: 'combat', lock: true },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        const cs = ctx.ts(0);
        for (const c of cs) g.tap(c);
        if (cs.length && controlsJedi(g, p)) {
          let chosen = cs[0];
          if (cs.length > 1) {
            const pick = yield* g.chooseCards(p, cs, 1, 1, "Choose one of those creatures that doesn't untap during its controller's next untap step.", { reason: 'freeze', sourceId: ctx.source.id });
            chosen = pick[0] || cs[0];
          }
          if (chosen && g.isOnBattlefield(chosen)) {
            chosen.skipNextUntap = true;
            g.log(`[[${chosen.name}]] doesn't untap during its controller's next untap step.`);
          }
        }
      },
    },
  };

  // 023 Evasive Translation (Afterimage {4}{U} auto-derived)
  S['Evasive Translation'] = {
    spell: {
      targets: [T.oppCreature()],
      ai: { kind: 'removal', target: 'oppCreature', bounce: true, when: 'combat' },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.bounce(c);
      },
    },
  };

  // 024 Flight Log Scrubber
  S['Flight Log Scrubber'] = {
    triggers: [etb('Draw a card, then discard a card. You get 1 Force counter.', function* (g, ctx) {
      yield* loot(g, ctx.controller, ctx.source.id);
      g.gainForce(ctx.controller, 1);
    })],
  };

  // 025 Kamino Tidewall
  S['Kamino Tidewall'] = {
    triggers: [etb('You may tap target creature with power 3 or greater.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.tap(c);
    }, { targets: [T.creature('Choose up to one target creature with power 3 or greater.', (g, c) => g.power(c) >= 3, { min: 0 })] })],
  };

  // 026 Interdict the Channel
  S['Interdict the Channel'] = {
    spell: {
      targets: [T.spell()],
      ai: { kind: 'counter', when: 'response', soft: 3 },
      resolve: function* (g, ctx) {
        const s = ctx.t(0);
        if (!s) return;
        const paid = yield* g.payOptional(s.controller, '{3}', `Pay {3} or ${s.name} is countered.`, ctx.source.id);
        if (!paid) {
          if (g.counterItem(s)) g.gainForce(ctx.controller, 1);
        } else {
          g.log(`${g.players[s.controller].name} pays {3}.`);
        }
      },
    },
  };

  // 027 Shaak Ti, Citadel Mentor
  S['Shaak Ti, Citadel Mentor'] = {
    triggers: [etbForce(2)],
    activated: [useForce(2, '{1}, Use the Force 2: Target creature you control gains flying until end of turn. Activate only as a sorcery.',
      function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.grantEOT(c, 'flying');
      },
      {
        cost: { mana: '{1}', force: 2 },
        sorcery: true,
        targets: [T.ownCreature()],
        ai: { kind: 'evasion', target: 'ownCreature', when: 'main' },
      })],
  };

  // 028 Meditation in Formation
  S['Meditation in Formation'] = {
    triggers: [
      etb('Scry 2.', function* (g, ctx) { yield* scry(g, ctx.controller, 2, ctx.source.id); }),
      {
        event: 'endStep',
        text: 'Attunement — At the beginning of your end step, if you spent a Force counter this turn, you may draw a card. If you do, discard a card.',
        match: yourEndStep,
        condition: (g, src) => attuned(g, g.controllerOf(src)),
        resolve: function* (g, ctx) { yield* loot(g, ctx.controller, ctx.source.id, true); },
      },
    ],
  };

  // 029 Signal from the Underlevels
  S['Signal from the Underlevels'] = {
    enchant: { type: 'creature' },
    ai: { kind: 'auraBuff', target: 'ownCreature', when: 'main' },
    statics: [
      { keywords: (g, src, c) => attached(g, src, c) ? ['unblockableAlone'] : null },
      { canBlock: (g, src, attacker) => !(attached(g, src, attacker) && g.combat && g.combat.alone && g.combat.attackers.length === 1) },
    ],
    triggers: [{
      event: 'combatDamagePlayer',
      text: 'Whenever enchanted creature deals combat damage to a player, you get 1 Force counter.',
      match: (g, src, evt) => !!src.attachedTo && evt.source && evt.source.id === src.attachedTo,
      resolve: function* (g, ctx) { g.gainForce(ctx.controller, 1); },
    }],
  };

  // 030 Utapau Traffic Lock
  S['Utapau Traffic Lock'] = {
    spell: {
      targets: [T.spell('Choose target creature spell.', (g, s) => s.kind === 'spell' && g.isCreature(s.card))],
      ai: { kind: 'counter', when: 'response' },
      resolve: function* (g, ctx) {
        const s = ctx.t(0);
        if (!s) return;
        g.counterItem(s);
        if (controlsJedi(g, ctx.controller)) yield* scry(g, ctx.controller, 2, ctx.source.id);
      },
    },
  };

  // 031 Microjump Squadron (Flying auto-derived)
  S['Microjump Squadron'] = {
    triggers: [etb('If you control another artifact, draw a card.', function* (g, ctx) {
      g.draw(ctx.controller, 1);
    }, { condition: (g, src) => artifactsOf(g, g.controllerOf(src)).some(a => a.id !== src.id) })],
  };

  // 032 Obi-Wan Kenobi (Flash auto-derived)
  S['Obi-Wan Kenobi'] = {
    triggers: [etb("You get 1 Force counter and return up to one other target creature to its owner's hand.", function* (g, ctx) {
      g.gainForce(ctx.controller, 1);
      const c = ctx.t(0);
      if (c) g.bounce(c);
    }, { targets: [T.creature('Choose up to one other target creature.', null, { min: 0, notSelf: true })] })],
  };

  // 033 Kamino's Sealed Orders (Afterimage {5}{U}{U} auto-derived)
  S["Kamino's Sealed Orders"] = {
    spell: {
      ai: { kind: 'draw' },
      resolve: function* (g, ctx) {
        g.draw(ctx.controller, 3);
        yield* g.discardChoose(ctx.controller, 1, 'Discard a card.');
        g.gainForce(ctx.controller, 3);
      },
    },
  };

  // 034 Plo Koon, Fleet Protector (Flying auto-derived)
  S['Plo Koon, Fleet Protector'] = {
    triggers: [
      etbForce(3),
      {
        event: 'cast',
        text: 'Whenever an opponent casts an instant or sorcery spell, if you have at least three more Force counters than that player, you may pay 3 Force counters. If you do, copy that spell. You may choose new targets for the copy.',
        match: (g, src, evt) => evt.player !== g.controllerOf(src) && isInstantOrSorcery(g, evt.card),
        condition: (g, src, evt) => {
          const me = g.controllerOf(src);
          return forceOf(g, me) >= forceOf(g, evt.player) + 3;
        },
        resolve: function* (g, ctx) {
          const me = ctx.controller;
          const spellItem = ctx.evt.item;
          if (!spellItem || forceOf(g, me) < 3) return;
          const yes = yield* g.yesNo(me, `Pay 3 Force counters to copy ${spellItem.name}?`, { reason: 'payForce', amount: 3, sourceId: ctx.source.id });
          if (!yes || !spendForce(g, me, 3)) return;
          if (typeof g.copySpellOnStack === 'function') {
            yield* g.copySpellOnStack(me, spellItem, { sourceId: ctx.source.id });
          } else {
            yield* g.copySpell(spellItem, me, { newTargets: true });
          }
        },
      },
    ],
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
