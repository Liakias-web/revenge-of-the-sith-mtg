/* Revenge of the Sith card scripts, part 3: Red (052–068) and Green (069–085).
 * Uses helpers from cards.js (OF.cardHelpers).
 * Keywords (Flying, First strike, Double strike, Deathtouch, Lifelink, Trample, Haste, Vigilance, Reach, Defender,
 * Fear, Shroud, Flash, Menace, Indestructible), Afterimage {cost}, Equip {cost}, and simple "{T}: Add ..." mana lines
 * are derived from the rules text by engine.js; scripts add everything else. */
(function (OF) {
  'use strict';
  const S = OF.CardScripts;
  const H = OF.cardHelpers;
  const { T, creaturesOf, opponents, etb, dies, verse, attacksTrig, etbForce, useForce, attuned, equipped, anyTarget,
    returnToHand, artifactsOf } = H;

  // ---------------------------------------------------------------------------
  // Local helpers
  // ---------------------------------------------------------------------------
  const live = (g, ctx) => g.isOnBattlefield(ctx.source, ctx.sourceZcc) ? ctx.source : null;
  const forceCount = (g, p) => g.forceOf ? g.forceOf(p) : ((g.players[p] && g.players[p].force) || 0);
  const otherCreature = (prompt, extra) => T.creature(prompt || 'Choose another target creature.', null, Object.assign({ notSelf: true }, extra || {}));
  const otherOwnCreature = (prompt, extra) => T.ownCreature(prompt || 'Choose another target creature you control.', null, Object.assign({ notSelf: true }, extra || {}));
  const attackingOther = (prompt, extra) => T.creature(prompt || 'Choose another target attacking creature.', (g, c) => g.attacking(c), Object.assign({ notSelf: true }, extra || {}));
  const artOrEnch = (prompt, extra) => Object.assign({ type: ['artifact', 'enchantment'], prompt: prompt || 'Choose target artifact or enchantment.' }, extra || {});

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
  // RED 052–068
  // ===========================================================================

  // ROTS-052
  S['Junkyard Witness'] = {
    triggers: [dies('You may discard a card. If you do, draw a card.', function* (g, ctx) {
      const d = yield* optionalDiscard(g, ctx.controller, null, 'You may discard a card. If you do, draw a card.', ctx.source.id);
      if (d) g.draw(ctx.controller, 1);
    })],
  };

  // ROTS-053
  S['Geonosian Arena Runner'] = {
    triggers: [etb('Each opponent gets 2 Force counters.', function* (g, ctx) {
      for (const o of opponents(g, ctx.controller)) g.gainForce(o, 2);
    })],
  };

  // ROTS-054
  S['Hangar Sweep Droid'] = {
    triggers: [etbForce(1)],
    activated: [useForce(2, 'Use the Force 2: Hangar Sweep Droid gets +2/+0 until end of turn. Activate only once each turn.', function* (g, ctx) {
      const me = live(g, ctx);
      if (me) g.pump(me, 2, 0);
    }, { oncePerTurn: true, ai: { kind: 'pump', target: 'self', when: 'combat' } })],
  };

  // ROTS-055
  S['Sparks Before the Charge'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'pump', target: 'ownCreature', when: 'combat', force: 1 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) { g.pump(c, 2, 0); g.grantEOT(c, 'firstStrike'); }
        g.gainForce(ctx.controller, 1);
      },
    },
  };

  // ROTS-056 (Afterimage {4}{R} auto-derived)
  S['Sandburn'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'burn', target: 'oppCreature', when: 'response', amount: 2 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.damage(ctx.source, c, 2);
      },
    },
  };

  // ROTS-057
  S['Scuttle the Turret'] = {
    spell: {
      ai: { kind: 'artifactRemoval', target: 'oppCreature', when: 'main' },
      modes: [
        {
          label: 'Destroy target artifact. Draw a card.',
          targets: [{ type: 'artifact', prompt: 'Choose target artifact to destroy.' }],
          ai: { kind: 'artifactRemoval', target: 'oppCreature', when: 'main' },
          resolve: function* (g, ctx) {
            const a = ctx.t(0);
            if (a) g.destroy(a);
            g.draw(ctx.controller, 1);
          },
        },
        {
          label: "Target creature can't block this turn. Draw a card.",
          targets: [T.creature("Choose target creature that can't block this turn.")],
          ai: { kind: 'evasion', target: 'oppCreature', when: 'main' },
          resolve: function* (g, ctx) {
            const c = ctx.t(0);
            if (c) g.grantEOT(c, 'cantBlock');
            g.draw(ctx.controller, 1);
          },
        },
      ],
    },
  };

  // ROTS-058 (Flying, haste auto-derived)
  S['Canopy Strike Flyer'] = {};

  // ROTS-059
  S['Outer Rim Blademaster'] = {
    statics: [{ keywords: (g, src, c) => (c === src && equipped(g, src)) ? ['firstStrike'] : null }],
  };

  // ROTS-060
  S['Kachirho Breaker'] = {
    triggers: [etb("Up to one target creature can't block this turn.", function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.grantEOT(c, 'cantBlock');
    }, {
      targets: [T.creature("Choose up to one target creature that can't block this turn.", null, { min: 0, max: 1 })],
      ai: { kind: 'evasion', target: 'oppCreature' },
    })],
  };

  // ROTS-061
  S['Slagworks Overseer'] = {
    triggers: [{
      event: 'dies',
      text: 'Slagworks Overseer deals 1 damage to each opponent.',
      match: (g, src, evt) => evt.card.id !== src.id && evt.lki && evt.lki.types.includes('Artifact') && evt.lki.controller === g.controllerOf(src),
      resolve: function* (g, ctx) {
        g._beginBatch();
        for (const o of opponents(g, ctx.controller)) g.damage(ctx.source, g.players[o], 1);
        g._endBatch();
      },
    }],
  };

  // ROTS-062
  S['Caldera Riposte'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'burn', target: 'oppCreature', when: 'response', amount: 3 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (!c) return;
        const ctlIdx = g.controllerOf(c);
        g.damage(ctx.source, c, 3);
        const paid = yield* g.payForceOptional(ctx.controller, 2, "Pay 2 Force counters to deal 2 damage to that creature's controller?", ctx.source.id);
        if (paid) g.damage(ctx.source, g.players[ctlIdx], 2);
      },
    },
  };

  // ROTS-063
  S['Geonosis Salvage Crew'] = {
    activated: [{
      cost: { sacrifice: { other: true, filter: (g, x) => g.isArtifact(x), label: 'another artifact', prompt: 'Choose another artifact to sacrifice.' } },
      oncePerTurn: true,
      text: 'Sacrifice another artifact: Geonosis Salvage Crew gets +2/+0 and gains trample until end of turn. Activate only once each turn.',
      ai: { kind: 'pump', target: 'self', when: 'combat', sacrifice: true },
      resolve: function* (g, ctx) {
        const me = live(g, ctx);
        if (me) { g.pump(me, 2, 0); g.grantEOT(me, 'trample'); }
      },
    }],
  };

  // ROTS-064 (Afterimage {3}{R}{R} auto-derived)
  S['Cut the Pod Cable'] = {
    spell: {
      targets: [T.creature('Choose target creature with power 3 or less.', (g, c) => g.power(c) <= 3)],
      ai: { kind: 'steal', target: 'oppCreature', when: 'main' },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (!c) return;
        g.gainControlEOT(c, ctx.controller);
        g.untap(c);
        g.grantEOT(c, 'haste');
      },
    },
  };

  // ROTS-065
  S['Ryloth Fireteam'] = {
    triggers: [attacksTrig('Attunement — Ryloth Fireteam deals 1 damage to up to one target creature defending player controls.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.damage(ctx.source, c, 1);
    }, {
      condition: (g, src) => attuned(g, g.controllerOf(src)),
      targets: [T.creature('Choose up to one target creature defending player controls (1 damage).',
        (g, c, p) => g.combat ? g.controllerOf(c) === g.combat.defender : g.controllerOf(c) !== p, { min: 0, max: 1 })],
      ai: { kind: 'burn', target: 'oppCreature', amount: 1 },
    })],
  };

  // ROTS-066 (Haste auto-derived)
  S['Sebulba, Grandstand Menace'] = {
    triggers: [attacksTrig('You may sacrifice an artifact. When you do, Sebulba deals 3 damage to target creature defending player controls.', function* (g, ctx) {
      const s = yield* optionalSacrifice(g, ctx.controller, artifactsOf(g, ctx.controller), 'You may sacrifice an artifact (Sebulba deals 3 damage to target creature defending player controls).', ctx.source.id, 'burn3');
      if (!s) return;
      g.pendingTriggers.push({
        source: ctx.source, sourceZcc: ctx.sourceZcc, controller: ctx.controller, evt: ctx.evt,
        trig: {
          text: 'Sebulba deals 3 damage to target creature defending player controls.',
          targets: [T.creature('Choose target creature defending player controls (3 damage).',
            (g2, c, p2) => g2.combat ? g2.controllerOf(c) === g2.combat.defender : g2.controllerOf(c) !== p2)],
          ai: { kind: 'burn', target: 'oppCreature', amount: 3 },
          resolve: function* (g2, ctx2) {
            const c = ctx2.t(0);
            if (c) g2.damage(ctx2.source, c, 3);
          },
        },
      });
    })],
  };

  // ROTS-067
  S['Purge Transmission'] = {
    triggers: [
      etb('Purge Transmission deals 2 damage to any target.', function* (g, ctx) {
        const t = ctx.t(0);
        if (t) g.damage(ctx.source, t, 2);
      }, { targets: [anyTarget()], ai: { kind: 'burn', target: 'oppCreature', amount: 2 } }),
      verse('Purge Transmission deals 1 damage to up to one target creature and 1 damage to each opponent.', function* (g, ctx) {
        const c = ctx.t(0);
        g._beginBatch();
        if (c) g.damage(ctx.source, c, 1);
        for (const o of opponents(g, ctx.controller)) g.damage(ctx.source, g.players[o], 1);
        g._endBatch();
      }, {
        text: 'Purge Transmission deals 1 damage to up to one target creature and 1 damage to each opponent.',
        targets: [T.creature('Choose up to one target creature (1 damage).', null, { min: 0, max: 1 })],
        ai: { kind: 'burn', target: 'oppCreature', amount: 1 },
      }),
    ],
  };

  // ROTS-068 (Flying, haste auto-derived)
  S['Jango Fett, Contract Hunter'] = {
    triggers: [attacksTrig('Choose one — Jango Fett deals 2 damage to up to one target creature; or destroy up to one target artifact defending player controls.', function* (g, ctx) {
      const p = ctx.controller;
      const defP = g.combat ? g.combat.defender : g.opponent(p);
      const choice = yield* g.chooseOption(p, [
        { id: 'burn', label: 'Jango Fett deals 2 damage to up to one target creature.' },
        { id: 'artifact', label: 'Destroy up to one target artifact defending player controls.' },
      ], 'Jango Fett, Contract Hunter — choose one:', { reason: 'triggerMode', sourceId: ctx.source.id });
      if (choice === 'burn') {
        const spec = T.creature('Choose up to one target creature (2 damage).', null, { min: 0, max: 1 });
        const legal = g._targetCandidates(spec, p, ctx.item);
        if (!legal.length) return;
        const a = yield* g.ask(p, {
          type: 'chooseTargets', legal, min: 0, max: 1, prompt: spec.prompt, cancellable: false,
          sourceId: ctx.source.id, spec: { type: spec.type }, index: 0,
        });
        const ref = a.targets && a.targets[0];
        const c = ref ? g._refObject(ref) : null;
        if (c && g.isOnBattlefield(c)) g.damage(ctx.source, c, 2);
      } else if (choice === 'artifact') {
        const spec = { type: 'artifact', prompt: 'Choose up to one target artifact defending player controls to destroy.', filter: (g2, c) => g2.controllerOf(c) === defP, min: 0, max: 1 };
        const legal = g._targetCandidates(spec, p, ctx.item);
        if (!legal.length) return;
        const a = yield* g.ask(p, {
          type: 'chooseTargets', legal, min: 0, max: 1, prompt: spec.prompt, cancellable: false,
          sourceId: ctx.source.id, spec: { type: spec.type }, index: 0,
        });
        const ref = a.targets && a.targets[0];
        const art = ref ? g._refObject(ref) : null;
        if (art && g.isOnBattlefield(art)) g.destroy(art);
      }
    }, { ai: { kind: 'burn', target: 'oppCreature', amount: 2 } })],
  };

  // ===========================================================================
  // GREEN 069–085
  // ===========================================================================

  // ROTS-069
  S['Wroshyr Seed Tender'] = {
    noAutoMana: true,
    activated: [{
      mana: { produce: 'G', spendOnly: (g, sf) => !!sf && sf.kind === 'spell' && g.isCreature(sf.card) },
      cost: { tap: true },
      text: '{T}: Add {G}. Spend this mana only to cast a creature spell.',
    }],
  };

  // ROTS-070
  S['Gungan Sacred Groveguard'] = {
    triggers: [etbForce(1)],
  };

  // ROTS-071
  S['Wroshyr Trailfinder'] = {
    triggers: [etb('You may search your library for a basic land card, reveal it, put it into your hand, then shuffle.', function* (g, ctx) {
      const p = ctx.controller;
      const found = yield* g.searchLibrary(p, c => g.isBasicLand(c), 1, 'You may search your library for a basic land card.');
      if (found.length) { g.reveal(p, found, ctx.source.name); g.toHand(found[0]); }
      g.shuffle(p);
    })],
  };

  // ROTS-072
  S['Grip of the Living Force'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'pump', target: 'ownCreature', when: 'combat', force: 1 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.pump(c, 2, 2);
        g.gainForce(ctx.controller, 1);
      },
    },
  };

  // ROTS-073
  S['Leave No Metal'] = {
    spell: {
      targets: [artOrEnch()],
      ai: { kind: 'artifactRemoval', target: 'oppCreature', when: 'response' },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.destroy(c);
      },
    },
  };

  // ROTS-074 (Reach auto-derived)
  S['Kashyyyk Crossbow Post'] = {
    statics: [{ pt: (g, src, c) => (c === src && attuned(g, g.controllerOf(src))) ? [1, 1] : null }],
  };

  // ROTS-075
  S['Marshstep Initiate'] = {
    activated: [useForce(2, 'Use the Force 2: Marshstep Initiate gets +2/+2 until end of turn. Activate only once each turn.', function* (g, ctx) {
      const me = live(g, ctx);
      if (me) g.pump(me, 2, 2);
    }, { oncePerTurn: true, ai: { kind: 'pump', target: 'self', when: 'combat' } })],
  };

  // ROTS-076
  S['Skewering Reed'] = {
    spell: {
      targets: [T.creature('Choose target creature with flying.', (g, c) => g.has(c, 'flying'))],
      ai: { kind: 'removal', target: 'oppCreature', when: 'response', force: 1 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.destroy(c);
        g.gainForce(ctx.controller, 1);
      },
    },
  };

  // ROTS-077 (Trample auto-derived)
  S['Opee Sea Killer'] = {};

  // ROTS-078
  S['Chewbacca, Forest Defender'] = {
    triggers: [etb('You may return target artifact card from your graveyard to your hand.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && c.zone === 'graveyard') returnToHand(g, c);
    }, {
      targets: [T.gyCard('you', 'You may choose target artifact card in your graveyard.', (g, c) => g.isArtifact(c), { min: 0, max: 1 })],
      ai: { kind: 'recursion', target: 'self' },
    })],
  };

  // ROTS-079
  S['Roots of the Living Force'] = {
    triggers: [
      etbForce(2),
      {
        event: 'endStep',
        text: 'If you control a creature with power 4 or greater, you get 1 Force counter.',
        match: (g, src, evt) => evt.player === g.controllerOf(src),
        condition: (g, src) => creaturesOf(g, g.controllerOf(src)).some(c => g.power(c) >= 4),
        resolve: function* (g, ctx) { g.gainForce(ctx.controller, 1); },
      },
    ],
  };

  // ROTS-080 (Afterimage {4}{G} auto-derived)
  S['Battle Meditation, Canopy Chorus'] = {
    spell: {
      targets: [T.creature('Choose up to two target creatures.', null, { min: 0, max: 2 })],
      ai: { kind: 'pump', target: 'ownCreature', when: 'main', counter: true },
      resolve: function* (g, ctx) {
        for (const c of ctx.ts(0)) g.addCounters(c, 1);
      },
    },
  };

  // ROTS-081
  S['Beneath the Fallen Pillar'] = {
    spell: {
      targets: [
        T.ownCreature('Choose target creature you control (+2/+2, then it may fight).'),
        T.creature("Choose up to one target creature you don't control to fight.", (g, c, p) => g.controllerOf(c) !== p, { min: 0, max: 1 }),
      ],
      ai: { kind: 'removal', target: 'oppCreature', when: 'main', fight: true, pump: 2 },
      resolve: function* (g, ctx) {
        const a = ctx.t(0), b = ctx.t(1);
        if (a) g.pump(a, 2, 2);
        if (a && b) {
          if (g.fight) g.fight(a, b);
          else if (g.isOnBattlefield(a) && g.isOnBattlefield(b) && g.isCreature(a) && g.isCreature(b)) {
            const pa = g.power(a), pb = g.power(b);
            g._beginBatch();
            g.damage(a, b, pa);
            g.damage(b, a, pb);
            g._endBatch();
          }
        }
      },
    },
  };

  // ROTS-082
  S['Sacred Place Guardian'] = {
    triggers: [etb('Each opponent gets 1 Force counter.', function* (g, ctx) {
      for (const o of opponents(g, ctx.controller)) g.gainForce(o, 1);
    })],
    statics: [
      { pt: (g, src, c) => (c === src && opponents(g, g.controllerOf(src)).some(o => forceCount(g, o) >= 4)) ? [2, 2] : null },
      { keywords: (g, src, c) => (c === src && opponents(g, g.controllerOf(src)).some(o => forceCount(g, o) >= 4)) ? ['reach'] : null },
    ],
  };

  // ROTS-083
  S['Ahsoka Tano, Unbound Protector'] = {
    triggers: [attacksTrig('Another target attacking creature gets +2/+2 until end of turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c) g.pump(c, 2, 2);
    }, { targets: [attackingOther()], ai: { kind: 'pump', target: 'ownCreature' } })],
    activated: [useForce(3, 'Use the Force 3: Regenerate another target creature. Activate only once each turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && g.isOnBattlefield(c)) g.regenShield(c);
    }, {
      oncePerTurn: true,
      targets: [otherCreature('Choose another target creature to regenerate.')],
      ai: { kind: 'protect', target: 'ownCreature', when: 'response', regen: true },
    })],
  };

  // ROTS-084
  S['Revelation of the Living Force'] = {
    spell: {
      ai: { kind: 'tutor', target: 'self', when: 'main', force: 3 },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        g.gainForce(p, 3);
        const top = g.topCards(p, 7);
        if (!top.length) return;
        const maxMv = forceCount(g, p);
        const cands = top.filter(c => g.isCreatureCard(c) && g.manaValue(c) <= maxMv);
        const pick = yield* g.chooseCards(p, cands, 0, 1, `You may put a creature card with mana value ${maxMv} or less onto the battlefield.`, {
          reason: 'toBattlefield', sourceId: ctx.source.id, alwaysAsk: true, shown: top.map(c => c.id),
        });
        if (pick.length) {
          yield* g.putOntoBattlefield(pick[0], p);
          g.log(`${g.players[p].name} puts [[${pick[0].name}]] onto the battlefield.`);
        }
        const rest = top.filter(c => !pick.includes(c));
        const order = yield* g.orderCards(p, rest, 'Put these on the bottom of your library (first = closest to the top).');
        for (const c of order.slice().reverse()) g._placeInZone(c, 'library', p, 'bottom');
      },
    },
  };

  // ROTS-085 (Vigilance auto-derived)
  S['Yoda, Keeper of the Living Force'] = {
    triggers: [
      etbForce(3),
      {
        event: 'beginCombat',
        text: 'Up to one other target creature you control gets +2/+2 until end of turn.',
        match: (g, src, evt) => evt.player === g.controllerOf(src),
        targets: [otherOwnCreature('Choose up to one other target creature you control (+2/+2).', { min: 0, max: 1 })],
        ai: { kind: 'pump', target: 'ownCreature' },
        resolve: function* (g, ctx) {
          const c = ctx.t(0);
          if (c) g.pump(c, 2, 2);
        },
      },
    ],
    activated: [useForce(10, 'Use the Force 10: Put two +1/+1 counters on each creature you control. Those creatures gain trample until end of turn. Activate only as a sorcery.', function* (g, ctx) {
      for (const c of creaturesOf(g, ctx.controller)) {
        g.addCounters(c, 2);
        g.grantEOT(c, 'trample');
      }
    }, { sorcery: true, ai: { kind: 'anthem', target: 'self', when: 'main' } })],
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
