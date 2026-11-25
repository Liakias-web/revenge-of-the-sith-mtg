/* Revenge of the Sith card scripts, part 2: collector numbers 035–051 (Black 035–051).
 * Uses helpers from cards.js (OF.cardHelpers). Keywords, Afterimage, Equip, and simple mana lines are
 * derived automatically by engine.js; everything else is scripted here. */
(function (OF) {
  'use strict';
  const S = OF.CardScripts;
  const H = OF.cardHelpers;
  const {
    T, etb, dies, etbForce, useForce, attuned, opponents, allCreatures,
    ownGyCreature, returnToHand, tokens, isJedi,
  } = H;

  // ---------------------------------------------------------------------------
  // Local helpers (part 2)
  // ---------------------------------------------------------------------------
  const yourEndStep = (g, src, evt) => evt.player === g.controllerOf(src);
  const forceOf = (g, p) => (typeof g.forceOf === 'function' ? g.forceOf(p) : (g.players[p] ? g.players[p].force : 0));
  const spendForce = (g, p, n) => (typeof g.spendForce === 'function' ? g.spendForce(p, n) : g.payForce(p, n));
  const hasDarkFace = (c) => (c.backDef && c.backDef.side === 'dark') || (c.frontDef && c.frontDef.side === 'dark');

  // ===========================================================================
  // BLACK 035–051
  // ===========================================================================

  // 035 Senate Blackmailer
  S['Senate Blackmailer'] = {
    triggers: [etb('Target opponent loses 1 life.', function* (g, ctx) {
      const o = ctx.t(0);
      if (o) g.loseLife(o.index, 1);
    }, { targets: [T.opponent()] })],
    activated: [{
      cost: { mana: '{W}', sacSelf: true },
      text: '{W}, Sacrifice Senate Blackmailer: Target creature you control gains lifelink until end of turn.',
      targets: [T.ownCreature()],
      ai: { kind: 'pump', target: 'ownCreature', when: 'combat', sacrifice: true },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.grantEOT(c, 'lifelink');
      },
    }],
  };

  // 036 Underlevel Stalker (can't block auto-derived)
  S['Underlevel Stalker'] = {
    triggers: [{
      event: 'combatDamagePlayer',
      text: 'Whenever Underlevel Stalker deals combat damage to a player, you get 1 Force counter.',
      match: (g, src, evt) => evt.source && evt.source.id === src.id,
      resolve: function* (g, ctx) { g.gainForce(ctx.controller, 1); },
    }],
  };

  // 037 Extraction Overseer
  S['Extraction Overseer'] = {
    activated: [{
      cost: { sacrifice: { other: true, filter: (g, x) => g.isCreature(x), label: 'another creature', prompt: 'Sacrifice another creature.' } },
      oncePerTurn: true,
      text: 'Sacrifice another creature: Extraction Overseer gets +1/+1 until end of turn. Activate only once each turn.',
      ai: { kind: 'pump', target: 'self', when: 'combat', sacrifice: true },
      resolve: function* (g, ctx) {
        if (g.isOnBattlefield(ctx.source, ctx.sourceZcc)) g.pump(ctx.source, 1, 1);
      },
    }],
  };

  // 038 Separatist Demolition Droid
  S['Separatist Demolition Droid'] = {
    triggers: [etb('Compromise 2.', function* (g, ctx) {
      yield* g.compromise(ctx.controller, 2, { sourceId: ctx.source.id });
    })],
  };

  // 039 Skakoan Reclaimer
  S['Skakoan Reclaimer'] = {
    triggers: [etb('You may return target artifact card from your graveyard to your hand.', function* (g, ctx) {
      const c = ctx.t(0);
      if (c && c.zone === 'graveyard') returnToHand(g, c);
    }, { targets: [T.gyCard('you', 'Choose up to one target artifact card in your graveyard.', (g, c) => g.isArtifact(c), { min: 0 })] })],
  };

  // 040 Utapau Cave Scavenger (Flying auto-derived)
  S['Utapau Cave Scavenger'] = {
    triggers: [dies('Target opponent loses 2 life and you gain 2 life.', function* (g, ctx) {
      const o = ctx.t(0);
      if (!o) return;
      g.loseLife(o.index, 2);
      g.gainLife(ctx.controller, 2);
    }, { targets: [T.opponent()] })],
  };

  // 041 Abandon the Witness
  S['Abandon the Witness'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'removal', target: 'oppCreature', when: 'response', shrink: 3 },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (!c) return;
        const n = attuned(g, ctx.controller) ? -4 : -3;
        g.pump(c, n, n);
      },
    },
  };

  // 042 Dark-Side Intercession (Afterimage {2}{B} auto-derived)
  S['Dark-Side Intercession'] = {
    spell: {
      targets: [ownGyCreature()],
      ai: { kind: 'recursion', target: 'self', when: 'main' },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c && c.zone === 'graveyard') returnToHand(g, c);
      },
    },
  };

  // 043 Silence a Delegate
  S['Silence a Delegate'] = {
    spell: {
      targets: [T.creature()],
      ai: { kind: 'removal', target: 'oppCreature', when: 'response' },
      resolve: function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.destroy(c);
        yield* g.compromise(ctx.controller, 1, { sourceId: ctx.source.id });
      },
    },
  };

  // 044 Underworld Peacekeeper
  S['Underworld Peacekeeper'] = {
    triggers: [dies('You may pay {W}. If you do, another target creature you control gets +1/+1 and gains indestructible until end of turn.', function* (g, ctx) {
      const c = ctx.t(0);
      if (!c) return;
      const paid = yield* g.payOptional(ctx.controller, '{W}', `Pay {W} to give ${c.name} +1/+1 and indestructible until end of turn?`, ctx.source.id, 'pump');
      if (!paid) return;
      if (g.isOnBattlefield(c)) {
        g.pump(c, 1, 1);
        g.grantEOT(c, 'indestructible');
      }
    }, { targets: [T.ownCreature('Choose another target creature you control.', null, { notSelf: true })] })],
  };

  // 045 Savage Opress, Sith Enforcer
  S['Savage Opress, Sith Enforcer'] = {
    triggers: [etbForce(2)],
    activated: [useForce(3, 'Use the Force 3: Target creature gets -1/-1 until end of turn. Activate only once each turn.',
      function* (g, ctx) {
        const c = ctx.t(0);
        if (c) g.pump(c, -1, -1);
      },
      {
        oncePerTurn: true,
        targets: [T.creature()],
        ai: { kind: 'removal', target: 'oppCreature', when: 'response', shrink: 1 },
      })],
  };

  // 046 Fragments of a Sith Testament
  S['Fragments of a Sith Testament'] = {
    spell: {
      ai: { kind: 'draw', when: 'main' },
      resolve: function* (g, ctx) {
        g.draw(ctx.controller, 2);
        yield* g.compromise(ctx.controller, 3, { sourceId: ctx.source.id });
      },
    },
  };

  // 047 By the Rule of Two
  S['By the Rule of Two'] = {
    triggers: [{
      event: 'endStep',
      text: 'At the beginning of your end step, if you attacked with exactly two creatures this turn, you may sacrifice one of those creatures. If you do, draw a card and put a +1/+1 counter on the other.',
      match: yourEndStep,
      condition: (g, src) => g.attackedThisTurn(g.controllerOf(src)).length === 2,
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        const ids = g.attackedThisTurn(p);
        if (ids.length !== 2) return;
        const cands = ids.map(id => g.card(id)).filter(c => c && c.zone === 'battlefield' && g.controllerOf(c) === p);
        if (!cands.length) return;
        const pick = yield* g.chooseCards(p, cands, 0, 1, 'You may sacrifice one of those creatures to draw a card and put a +1/+1 counter on the other.', { reason: 'optionalSacrifice', sourceId: ctx.source.id, benefit: 'draw', alwaysAsk: true });
        if (!pick.length || pick[0].zone !== 'battlefield') return;
        const sacId = pick[0].id;
        if (!g.sacrifice(pick[0])) return;
        g.draw(p, 1);
        const otherId = ids.find(id => id !== sacId);
        const other = otherId !== undefined ? g.card(otherId) : null;
        if (other && g.isOnBattlefield(other)) g.addCounters(other, 1);
      },
    }],
  };

  // 048 Senate Shadow Detail
  S['Senate Shadow Detail'] = {
    spell: {
      ai: { kind: 'token', when: 'main' },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        yield* tokens(g, p, 'Human Rogue', 2);
        for (const c of allCreatures(g)) {
          if (g.controllerOf(c) !== p) g.pump(c, -1, -1);
        }
      },
    },
  };

  // 049 Execute Order 66!
  S['Execute Order 66!'] = {
    spell: {
      ai: { kind: 'wrath', when: 'main' },
      resolve: function* (g, ctx) {
        // 1. Each non-Jedi transforming permanent with a Dark Side face turns to the Dark Side.
        for (const id of g.battlefield.slice()) {
          const c = g.card(id);
          if (c && g.isOnBattlefield(c) && g.isDFC(c) && !isJedi(c) && hasDarkFace(c) && g.sideOf(c) !== 'dark') {
            g.transform(c, 'dark');
          }
        }
        // 2. Then destroy all Jedi.
        const jedis = g.battlefield.map(id => g.card(id)).filter(c => isJedi(c));
        const lostJedi = new Set();
        g._beginBatch();
        for (const c of jedis) {
          const ctrl = g.controllerOf(c);
          if (g.destroy(c)) lostJedi.add(ctrl);
        }
        g._endBatch();
        // 3. Each opponent who didn't control a Jedi destroyed this way sacrifices a creature.
        for (const o of opponents(g, ctx.controller)) {
          if (!lostJedi.has(o)) {
            yield* g.sacrificeChoose(o, c => g.isCreature(c), 1, 'Sacrifice a creature (Execute Order 66!).');
          }
        }
      },
    },
  };

  // 050 Unlimited Power!
  S['Unlimited Power!'] = {
    spell: {
      targets: [T.creature('Choose up to three target creatures.', null, { min: 0, max: 3 })],
      ai: { kind: 'removal', target: 'oppCreature', when: 'main' },
      resolve: function* (g, ctx) {
        const p = ctx.controller;
        const targets = ctx.ts(0);
        const powMap = new Map();
        for (const c of targets) powMap.set(c.id, Math.max(0, g.power(c) || 0));
        let totalPower = 0;
        g._beginBatch();
        for (const c of targets) {
          if (g.destroy(c)) totalPower += powMap.get(c.id);
        }
        g._endBatch();
        if (totalPower <= 0) return;
        let paid = false;
        if (forceOf(g, p) >= 8) {
          const yes = yield* g.yesNo(p, `Pay 8 Force counters so each opponent loses ${totalPower} life and you gain ${totalPower} life (instead of you losing ${totalPower} life)?`, { reason: 'payForce', amount: 8, sourceId: ctx.source.id });
          if (yes && spendForce(g, p, 8)) paid = true;
        }
        if (paid) {
          for (const o of opponents(g, p)) g.loseLife(o, totalPower);
          g.gainLife(p, totalPower);
        } else {
          g.loseLife(p, totalPower);
        }
      },
    },
  };

  // 051 Darth Sidious, Sith Master (Menace auto-derived)
  S['Darth Sidious, Sith Master'] = {
    triggers: [etbForce(3)],
    activated: [useForce(3, 'Use the Force 3: Target creature gets -3/-3 until end of turn. When that creature dies this turn, its controller loses 3 life. Activate only as a sorcery and only once each turn.',
      function* (g, ctx) {
        const c = ctx.t(0);
        if (!c) return;
        const tid = c.id;
        const tzcc = c.zcc;
        g.pump(c, -3, -3);
        g.delayedTriggers.push({
          event: 'dies',
          once: true,
          thisTurn: true,
          text: 'When that creature dies this turn, its controller loses 3 life.',
          controller: ctx.controller,
          source: ctx.source,
          sourceZcc: ctx.sourceZcc,
          match: (g2, evt) => evt.card && evt.card.id === tid && evt.lki && evt.lki.zcc === tzcc,
          resolve: function* (g2, ctx2) {
            const victimCtrl = ctx2.evt && ctx2.evt.lki ? ctx2.evt.lki.controller : null;
            if (victimCtrl !== null && victimCtrl !== undefined) g2.loseLife(victimCtrl, 3);
          },
        });
      },
      {
        sorcery: true,
        oncePerTurn: true,
        targets: [T.creature()],
        ai: { kind: 'removal', target: 'oppCreature', when: 'main', shrink: 3 },
      })],
  };
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
