/* Revenge of the Sith theme decks (OF.THEME_DECKS) — eight 60-card preconstructed decks in the
 * spirit of 2006–09 Magic theme decks: 23–24 lands, iconic rares and mythics, mostly commons and
 * uncommons, at most four copies of any card except basic lands.
 *
 *   {name, colours, colors:'WB', strategy, cards:[{count, name, land?, rarity}]}
 *
 * `rarity` is filled in from OF.CARD_DATA at load time (L for basic lands). */
(function (OF) {
  'use strict';
  const L = (count, name) => ({ count, name, land: true });
  const C = (count, name) => ({ count, name });

  OF.THEME_DECKS = [
    {
      name: 'Fall of the Republic', colours: 'White/Black', colors: 'WB',
      strategy: 'Compromise and the turn to the Dark Side. Pay Compromise costs for efficient threats like Separatist Demolition Droid and Polis Massa Midwives, leverage off-colour activations on Padmé Amidala and Underworld Peacekeeper, and flip Anakin, the 501st Legion, Asajj Ventress and Jedi Temple, Coruscant while Empire by Acclamation drains the table.',
      cards: [
        C(1, 'Anakin, Hero With No Fear'), C(1, '501st Legion'), C(1, 'Asajj Ventress, Lost Padawan'), C(1, 'Empire by Acclamation'),
        C(3, 'Temple Initiate'), C(2, 'Senate Blackmailer'), C(2, 'Padmé Amidala, Civic Liaison'), C(3, 'Underworld Peacekeeper'),
        C(3, 'Separatist Demolition Droid'), C(3, 'Senate Garrison'), C(2, 'Senate Observer'), C(2, 'Extraction Overseer'),
        C(2, 'Polis Massa Midwives'), C(1, 'Senate Shadow Detail'), C(2, 'Clone Reinforcements'),
        C(2, 'For The Better, Right?'), C(2, 'Abandon the Witness'),
        C(2, 'Halt the Advance'), C(1, 'Silence a Delegate'),
        L(1, 'Jedi Temple, Coruscant'), L(3, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(9, 'Plains'), L(9, 'Swamp'),
      ],
    },
    {
      name: 'Separatist Armada', colours: 'Green/Blue/Red', colors: 'GUR',
      strategy: 'The Separatist / Outer Rim coalition. Ramp and fix with Wroshyr Seed Tender, Astromech Scout, Separatist Signal Array and Chart the Outer Rim, flood the board with droids and starships like Vulture Wing and B1 Droid Pair, then deploy The Invisible Hand and General Grievous armed with a Jedi Lightsaber.',
      cards: [
        C(1, 'General Grievous, Blade Collector'), C(1, 'The Invisible Hand'), C(1, 'Jedi Lightsaber'),
        C(3, 'Wroshyr Seed Tender'), C(3, 'Astromech Scout'), C(3, 'Wroshyr Trailfinder'), C(3, 'Vulture Wing'),
        C(3, 'B1 Droid Pair'), C(2, 'Flight Log Scrubber'), C(2, 'Geonosian Signal Thief'), C(2, 'Microjump Squadron'),
        C(2, 'Hangar Sweep Droid'), C(2, 'Wookiee Canopy Team'), C(2, 'Separatist Signal Array'),
        C(3, 'Chart the Outer Rim'), C(2, 'Sandburn'), C(1, 'Beneath the Fallen Pillar'),
        L(3, 'Geonosis, Foundry Spires'), L(3, 'Kashyyyk, Tidal Canopy'), L(3, 'Naboo, Lake Country'),
        L(2, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(5, 'Forest'), L(3, 'Island'), L(3, 'Mountain'),
      ],
    },
    {
      name: 'Council of Coruscant', colours: 'White/Blue', colors: 'WU',
      strategy: 'Jedi tempo and Council control. Bank Force counters with Temple Initiate, Archive Night Shift and Shaak Ti, rally Clone Soldiers with Jedi Battalion-General and Clone Reinforcements, bounce and exile threats with Obi-Wan Kenobi and Mace Windu, and dominate the skies with Plo Koon, Fleet Protector.',
      cards: [
        C(1, 'Obi-Wan Kenobi'), C(1, 'Mace Windu, Vaapad Master'), C(1, 'Plo Koon, Fleet Protector'), C(1, 'Palpatine, Supreme Chancellor'),
        C(3, 'Temple Initiate'), C(2, 'Kamino Drill Squad'), C(3, 'Geonosis Relief Jedi'), C(3, 'Archive Night Shift'),
        C(2, 'Shaak Ti, Citadel Mentor'), C(2, 'Jedi Battalion-General'), C(3, 'Sky Lane Escort'),
        C(2, 'Cloudbank Courier'), C(2, 'Microjump Squadron'),
        C(2, 'Clone Reinforcements'), C(2, 'Battle Meditation at First Light'), C(2, 'The Senate Surprised'),
        C(2, 'Halt the Advance'), C(2, 'Temple Vigil'),
        L(2, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(1, 'Trade Route Junction'), L(10, 'Plains'), L(9, 'Island'),
      ],
    },
    {
      name: 'Rule of Two', colours: 'Blue/Black', colors: 'UB',
      strategy: 'Sith Force control and graveyard value. Loot and stockpile Force with Flight Log Scrubber, Archive Night Shift and Kamino\'s Sealed Orders, recur threats with Dark-Side Intercession and Skakoan Reclaimer, then dominate the late game with Count Dooku turning into Darth Tyranus alongside Darth Sidious.',
      cards: [
        C(1, 'Count Dooku, Lost Idealist'), C(1, 'Darth Sidious, Sith Master'), C(1, "Kamino's Sealed Orders"),
        C(3, 'Turbolift Interceptor'), C(3, 'Flight Log Scrubber'), C(3, 'Archive Night Shift'), C(2, 'Savage Opress, Sith Enforcer'),
        C(2, 'Skakoan Reclaimer'), C(2, 'Utapau Cave Scavenger'), C(2, 'Kamino Tidewall'), C(2, 'B1 Droid Pair'),
        C(3, 'Abandon the Witness'), C(2, 'Silence a Delegate'), C(2, 'Dark-Side Intercession'), C(2, 'Evasive Translation'),
        C(2, 'Interdict the Channel'), C(1, 'Fragments of a Sith Testament'), C(2, 'Temple Training Holocron'),
        L(2, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(1, 'Trade Route Junction'), L(10, 'Island'), L(9, 'Swamp'),
      ],
    },
    {
      name: 'Shadow of the Sith', colours: 'Black/Red', colors: 'BR',
      strategy: 'Sith sacrifice and relentless burn. Pressure early with Underlevel Stalker, Separatist Demolition Droid and Darth Maul, cash in spare bodies and artifacts with By the Rule of Two, Extraction Overseer and Sebulba, clear blockers with Sandburn and Caldera Riposte, and close out in the air with Jango Fett.',
      cards: [
        C(1, 'Darth Maul, Shadow Apprentice'), C(1, 'Sebulba, Grandstand Menace'), C(1, 'Jango Fett, Contract Hunter'),
        C(3, 'Underlevel Stalker'), C(3, 'Junkyard Witness'), C(2, 'Separatist Demolition Droid'), C(3, 'Hangar Sweep Droid'),
        C(2, 'Extraction Overseer'), C(2, 'Geonosis Salvage Crew'), C(2, 'B1 Droid Pair'), C(2, 'Canopy Strike Flyer'), C(2, 'Kachirho Breaker'),
        C(2, 'By the Rule of Two'), C(1, 'Senate Shadow Detail'), C(2, 'Sandburn'), C(2, 'Caldera Riposte'),
        C(2, 'Abandon the Witness'), C(2, 'Cut the Pod Cable'), C(1, 'Sparks Before the Charge'),
        L(2, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(10, 'Swamp'), L(10, 'Mountain'),
      ],
    },
    {
      name: 'Voices of the Living Force', colours: 'Green/White', colors: 'GW',
      strategy: 'Force counters, +1/+1 counters and Jedi recursion. Build deep Force pools with Temple Initiate, Gungan Sacred Groveguard and Roots of the Living Force, keep creatures fighting through attrition with Qui-Gon Jinn, Ahsoka Tano and Rebuild the Order, and overwhelm the board with Yoda, Keeper of the Living Force.',
      cards: [
        C(1, 'Yoda, Keeper of the Living Force'), C(1, 'Qui-Gon Jinn, Living Force'),
        C(1, 'Ahsoka Tano, Unbound Protector'), C(1, 'Rebuild the Order'),
        C(3, 'Temple Initiate'), C(3, 'Wroshyr Seed Tender'), C(3, 'Gungan Sacred Groveguard'), C(3, 'Marshstep Initiate'),
        C(3, 'Geonosis Relief Jedi'), C(2, 'Wroshyr Trailfinder'), C(2, 'Kashyyyk Crossbow Post'),
        C(2, 'Jedi Battalion-General'), C(1, 'Sacred Place Guardian'),
        C(2, 'Roots of the Living Force'), C(2, 'Battle Meditation, Canopy Chorus'), C(2, 'Beneath the Fallen Pillar'),
        C(2, 'Grip of the Living Force'), C(2, 'Halt the Advance'),
        L(3, 'Frontier Supply Post'), L(2, 'Envoy’s Landing'), L(10, 'Forest'), L(9, 'Plains'),
      ],
    },
    {
      name: 'Clone Battalion', colours: 'Red/White', colors: 'RW',
      strategy: 'Go-wide Clone tokens and lightsabers. Flood the battlefield with Torrent Squadron Wingman, Jedi Battalion-General and Clone Reinforcements, trigger Attunement in combat, and equip first strikers or Outer Rim Blademaster with Jedi Lightsaber and Maul’s Lightsaber for devastating swings.',
      cards: [
        C(2, 'Jedi Lightsaber'), C(1, 'Maul’s Lightsaber'),
        C(3, 'Temple Initiate'), C(4, 'Kamino Drill Squad'), C(3, 'Torrent Squadron Wingman'), C(3, 'Jedi Battalion-General'),
        C(3, 'Outer Rim Blademaster'), C(2, 'Hangar Sweep Droid'), C(2, 'Ryloth Fireteam'),
        C(2, 'Sky Lane Escort'), C(2, 'Kachirho Breaker'),
        C(3, 'Clone Reinforcements'), C(2, 'Sparks Before the Charge'), C(2, 'Sandburn'),
        C(2, 'Halt the Advance'), C(1, 'Battle Meditation at First Light'),
        L(2, 'Frontier Supply Post'), L(1, 'Envoy’s Landing'), L(10, 'Plains'), L(10, 'Mountain'),
      ],
    },
    {
      name: 'Mustafar Salvage', colours: 'Blue/Red', colors: 'UR',
      strategy: 'Artifacts, looting and scrapyard burn. Cycle through your deck with Vulture Wing, Flight Log Scrubber and Microjump Squadron, sacrifice spare droids and Medical Capsules to Geonosis Salvage Crew and Sebulba while Slagworks Overseer pings every turn, and chain double-spell triggers off Purge Transmission.',
      cards: [
        C(2, 'Purge Transmission'), C(1, 'Sebulba, Grandstand Menace'),
        C(2, 'Kamino Sample Keeper'), C(3, 'Turbolift Interceptor'), C(3, 'Flight Log Scrubber'), C(4, 'Vulture Wing'),
        C(3, 'Slagworks Overseer'), C(3, 'Geonosis Salvage Crew'), C(3, 'B1 Droid Pair'), C(2, 'Cloudbank Courier'),
        C(2, 'Microjump Squadron'), C(2, 'Medical Capsule'), C(1, 'Comms Disruptor'),
        C(2, 'Sandburn'), C(2, 'Scuttle the Turret'), C(2, 'Evasive Translation'),
        L(4, 'Geonosis, Foundry Spires'), L(1, 'Frontier Supply Post'), L(9, 'Island'), L(9, 'Mountain'),
      ],
    },
  ];

  // rarity from the card data (L = basic land)
  const byName = {};
  for (const c of OF.CARD_DATA || []) byName[c.name] = c;
  for (const t of OF.THEME_DECKS) {
    for (const e of t.cards) {
      const d = byName[e.name];
      e.rarity = d ? d.rarity : 'L';
      if (d && /\bLand\b/.test(d.type)) e.land = true;
    }
  }
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
