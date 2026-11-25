/* Revenge of the Sith multiplayer lobby and session controller.
 *
 *   OF.MP.open(containerElement, { onExit })   -> controller {close()}
 *
 * Screens: connect (name, host LAN / online, join by address / invite code) -> lobby
 * (players, chat, deck choice, host settings, Start) -> activities: lockstep duel match
 * (js/mp/sync.js) or draft / sealed event (js/mp/event-mp.js). A floating chat window and a
 * connection banner stay visible on every screen.
 *
 * The host's client runs HostCtl (authoritative lobby state, MatchHost, EventHost) next to its
 * own player client; messages to itself go through the session's local delivery, so host and
 * guests run exactly the same client code.
 */
(function (OF) {
  'use strict';
  if (typeof document === 'undefined') return;
  const MP = OF.MP = OF.MP || {};
  const U = () => OF.AppUtil;
  const P = () => MP.Proto;

  const NAME_KEY = 'rots.mp.name';
  const DECK_KEY = 'rots.mp.deck';
  const ADDR_KEY = 'rots.mp.addr';
  const CID_KEY = 'rots.mp.cid';
  const MODES = { duel: 'Duel (theme or constructed deck)', draft: 'Booster Draft (8 seats, AI fill)', sealed: 'Sealed Deck (6 boosters each)' };

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function clientId() {
    try { let c = sessionStorage.getItem(CID_KEY); if (!c) { c = OF.Net.randomId('c', 10); sessionStorage.setItem(CID_KEY, c); } return c; } catch (e) { return OF.Net.randomId('c', 10); }
  }
  function defaultName() {
    const saved = store(NAME_KEY);
    if (saved) return saved;
    try { const n = U().getSettings().playerName; if (n && n !== 'You') return n; } catch (e) { /* ignore */ }
    return 'Player ' + Math.floor(100 + Math.random() * 900);
  }

  /** Theme decks + saved constructed decks (app storage), as [{id, label, cards}]. */
  function deckChoices() {
    const out = [];
    (OF.THEME_DECKS || []).forEach((t, i) => {
      const cards = OF.DeckTools ? OF.DeckTools.themeDeckList(t) : t.cards.flatMap(c => Array(c.count).fill(c.name));
      out.push({ id: 'theme:' + i, label: 'Theme: ' + t.name + (t.colours ? ' (' + t.colours + ')' : ''), cards, kind: 'theme' });
    });
    const keys = [];
    try { const pre = (U().SETTINGS_KEY || 'rots.settings').split('.')[0]; keys.push(pre + '.decks'); } catch (e) { /* ignore */ }
    for (const k of ['rots.decks']) if (keys.indexOf(k) < 0) keys.push(k);
    const seen = new Set();
    for (const k of keys) {
      const saved = U().storeGet(k, null);
      if (!saved || typeof saved !== 'object') continue;
      for (const name of Object.keys(saved).sort()) {
        const d = saved[name];
        const cards = d && Array.isArray(d.main) ? d.main : Array.isArray(d) ? d : null;
        if (!cards || cards.length < 40 || seen.has(name)) continue;
        seen.add(name);
        out.push({ id: 'saved:' + name, label: 'Saved: ' + name + ' (' + cards.length + ')', cards: cards.slice(), kind: 'saved' });
      }
    }
    return out;
  }

  function copyText(text, el) {
    const fallback = () => { try { if (el) { el.focus(); el.select(); } document.execCommand('copy'); return true; } catch (e) { return false; } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { return navigator.clipboard.writeText(text).then(() => true, fallback); }
    } catch (e) { /* fall back */ }
    return Promise.resolve(fallback());
  }

  // ====================================================================== host controller
  class HostCtl {
    constructor(app) {
      this.app = app;
      this.s = app.session;
      this.players = [];          // [{id, name, cid, isHost, deck:{label, count}|null}]
      this.decks = {};            // peer -> [names]
      this.cfg = { mode: 'duel', bestOf: 1, aiLevel: 'normal', pickTimer: 0, sealedAI: 6, duelOpp: null };
      try { const st = U().getSettings(); this.cfg.bestOf = st.bestOf === 3 ? 3 : 1; this.cfg.aiLevel = st.aiLevel || 'normal'; this.cfg.pickTimer = st.pickTimer || 0; } catch (e) { /* defaults */ }
      this.phase = 'lobby';
      this.activity = '';
      this.match = null;          // duel MatchHost
      this.event = null;          // EventHost
      this.addPlayer(this.s.id, app.name, app.cid, true);
    }
    toAll(msg) { this.s.send('*', msg); this.s.send(this.s.id, msg); }
    state() {
      return { hostId: this.s.id, transport: this.s.transport, info: this.app.hostInfo || null, players: this.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, deck: p.deck })), cfg: Object.assign({}, this.cfg), phase: this.phase, activity: this.activity };
    }
    broadcast() { this.toAll({ t: 'lobby', state: this.state() }); }
    sys(text) { this.toAll({ t: 'chatb', sys: true, text, ts: Date.now() }); }
    uniqueName(name, id) {
      let n = P().cleanName(name, 'Player'), k = 2;
      const base = n;
      while (this.players.some(p => p.id !== id && p.name.toLowerCase() === n.toLowerCase())) n = base + ' ' + (k++);
      return n;
    }
    addPlayer(id, name, cid, isHost) {
      let p = this.players.find(x => x.id === id);
      if (!p) { p = { id, name: '', cid: cid || '', isHost: !!isHost, deck: null }; this.players.push(p); }
      p.name = this.uniqueName(name, id);
      p.cid = cid || p.cid;
      return p;
    }
    handle(from, msg) {
      switch (msg.t) {
        case 'hello': {
          if (msg.ver !== P().VERSION) { this.s.send(from, { t: 'refused', why: 'Your Revenge of the Sith version does not match the host\'s. Please use the same version.' }); return true; }
          if (!this.players.find(p => p.id === from) && this.players.length >= 8) { this.s.send(from, { t: 'refused', why: 'This game is full (8 players).' }); return true; }
          const p = this.addPlayer(from, msg.name, msg.cid, false);
          this.sys(p.name + ' joined.');
          if (this.event) this.event.rejoin(msg.cid, from);
          this.broadcast();
          if (this.event) this.s.send(from, { t: 'estate', view: this.event.view(), late: true });
          return true;
        }
        case 'rename': { const p = this.players.find(x => x.id === from); if (p) { const old = p.name; p.name = this.uniqueName(msg.name, from); if (old !== p.name) this.sys(old + ' is now ' + p.name + '.'); this.broadcast(); } return true; }
        case 'chat': {
          const p = this.players.find(x => x.id === from);
          const text = String(msg.text || '').slice(0, 400).trim();
          if (p && text) this.toAll({ t: 'chatb', name: p.name, from, text, ts: Date.now() });
          return true;
        }
        case 'deck': {
          const p = this.players.find(x => x.id === from);
          if (!p) return true;
          const cards = Array.isArray(msg.deck && msg.deck.cards) ? msg.deck.cards.filter(x => typeof x === 'string').slice(0, 250) : [];
          const bad = P().unknownCards(cards);
          if (bad.length || cards.length < 40) {
            this.s.send(from, { t: 'deckerr', why: bad.length ? 'Unknown cards: ' + bad.slice(0, 5).join(', ') : 'A deck needs at least 40 cards.' });
            p.deck = null; delete this.decks[from];
          } else {
            this.decks[from] = cards;
            p.deck = { label: String(msg.deck.label || 'Deck').slice(0, 60), count: cards.length };
          }
          this.broadcast();
          return true;
        }
      }
      if (this.match && this.match.handle(from, msg)) return true;
      if (this.event && this.event.handle(from, msg)) return true;
      return false;
    }
    peerLeft(id) {
      const p = this.players.find(x => x.id === id);
      this.players = this.players.filter(x => x.id !== id);
      delete this.decks[id];
      if (this.cfg.duelOpp === id) this.cfg.duelOpp = null;
      if (p) this.sys(p.name + ' left.');
      if (this.match) this.match.peerLeft(id);
      if (this.event) this.event.peerLeft(id);
      this.broadcast();
    }
    setCfg(patch) {
      Object.assign(this.cfg, patch);
      this.broadcast();
    }
    kick(id) {
      const p = this.players.find(x => x.id === id);
      if (!p || p.isHost) return;
      this.s.send(id, { t: 'refused', why: 'The host removed you from the game.' });
      setTimeout(() => { if (this.s.kick) this.s.kick(id, 'removed'); this.peerLeft(id); }, 300);
    }
    /** Returns an error string or '' when the game can start. */
    canStart() {
      if (this.phase !== 'lobby') return 'A game is already running.';
      const guests = this.players.filter(p => !p.isHost);
      if (this.cfg.mode === 'duel') {
        if (!guests.length) return 'Waiting for an opponent to join.';
        const opp = this.duelOpponent();
        if (!opp) return 'Choose your opponent.';
        if (!this.decks[this.s.id]) return 'Choose your deck.';
        if (!this.decks[opp.id]) return opp.name + ' has not chosen a deck yet.';
        return '';
      }
      if (this.players.length < 2) return 'At least two players are needed.';
      if (this.players.length > 8) return 'At most eight players.';
      return '';
    }
    duelOpponent() {
      const guests = this.players.filter(p => !p.isHost);
      if (this.cfg.duelOpp) return guests.find(p => p.id === this.cfg.duelOpp) || null;
      return guests.length === 1 ? guests[0] : null;
    }
    start() {
      const err = this.canStart();
      if (err) { U().toast(err, 2500); return false; }
      if (this.cfg.mode === 'duel') {
        const me = this.players.find(p => p.isHost), opp = this.duelOpponent();
        const mid = 'd' + OF.Net.randomId('', 6);
        this.phase = 'duel';
        this.activity = 'Duel: ' + me.name + ' vs ' + opp.name;
        this.match = new MP.MatchHost({
          mid, peers: [me.id, opp.id], bestOf: this.cfg.bestOf, title: 'Duel',
          players: [{ name: me.name, deck: this.decks[me.id] }, { name: opp.name, deck: this.decks[opp.id] }],
          send: (to, m) => this.s.send(to, m),
          onDone: (m) => {
            const w = m.winner === 0 ? me.name : m.winner === 1 ? opp.name : null;
            this.sys(w ? w + ' won the duel ' + Math.max(m.winsA, m.winsB) + '–' + Math.min(m.winsA, m.winsB) + '.' : 'The duel ended in a draw.');
            this.match = null; this.phase = 'lobby'; this.activity = ''; this.broadcast();
          },
        });
        this.broadcast();
        this.match.start();
        return true;
      }
      const type = this.cfg.mode;
      this.phase = 'event';
      this.activity = (type === 'draft' ? 'Booster Draft' : 'Sealed') + ' event in progress';
      const humans = this.players.map(p => ({ peer: p.id, name: p.name, cid: p.cid }));
      this.event = new MP.EventHost({
        type, humans, aiCount: this.cfg.sealedAI, bestOf: this.cfg.bestOf, aiLevel: this.cfg.aiLevel, pickTimer: type === 'draft' ? this.cfg.pickTimer : 0,
        seed: P().randomSeed(),
        send: (to, m) => this.s.send(to, m),
        onChange: (view) => this.toAll({ t: 'estate', view }),
        onComplete: (ev) => {
          const st = OF.Events.standings(ev);
          this.sys('Event complete. Winner: ' + (st[0] ? st[0].name : '?') + '.');
          this.phase = 'lobby'; this.activity = ''; this.broadcast();
          this.event.completed = true;
        },
      });
      this.broadcast();
      this.toAll({ t: 'evstart', type, members: humans.map(h => h.peer) });
      this.event.start();
      return true;
    }
    abortActivity() {
      if (this.match) { this.match.finished = true; this.match = null; }
      if (this.event) { this.event.destroy(); this.event = null; }
      this.phase = 'lobby'; this.activity = '';
      this.toAll({ t: 'abort', why: 'The host ended the current game.' });
      this.broadcast();
    }
    nextRound() { if (this.event) this.event.nextRound(); }
  }

  // ====================================================================== client / screens
  class MPApp {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.name = defaultName();
      this.cid = clientId();
      this.session = null;
      this.hostCtl = null;
      this.lobby = null;         // last lobby state from host
      this.liveMatch = null;
      this.eventClient = null;
      this.current = null;
      this.screenName = '';
      this.chatLog = [];
      this.unread = 0;
      const { h } = U();
      this.main = h('div', { class: 'mp-main' });
      this.banner = h('div', { class: 'mp-banner hidden' });
      this.chatEl = this.buildChat();
      this.root = h('div', { class: 'mp-root' }, this.main, this.banner, this.chatEl);
      U().clear(container).appendChild(this.root);
      MP.app = this; // test / debugging hook
      this.showConnect();
    }
    get myId() { return this.session ? this.session.id : null; }
    get isHost() { return !!this.hostCtl; }

    // -------------------------------------------------------------- infrastructure
    show(name, builder) {
      if (this.current && typeof this.current.destroy === 'function') { try { this.current.destroy(); } catch (e) { console.error(e); } }
      this.current = null;
      this.screenName = name;
      U().clear(this.main);
      this.root.dataset.screen = name;
      try { this.current = builder(this.main) || null; } catch (e) { console.error('[MP] screen error', e); this.main.appendChild(U().h('div', { class: 'mp-error' }, 'Screen error: ' + (e && e.message || e))); }
      this.chatEl.classList.toggle('hidden', !this.session);
      if (name === 'lobby') this.setChatOpen(true);
      else if (name === 'live' || name === 'activity') this.setChatOpen(false);
    }
    header(title, extra) {
      const { h } = U();
      return h('div', { class: 'screen-header mp-header' },
        h('span', { class: 'dv-title' }, title),
        extra || null,
        h('span', { class: 'flex1' }),
        this.session ? h('span', { class: 'mp-conn dim' }, (this.isHost ? 'Hosting' : 'Connected') + ' · ' + (this.session.transport === 'webrtc' ? 'online' : 'LAN/relay')) : null,
        this.session ? h('button', { 'data-mp': 'leave', onclick: () => this.confirmLeave() }, this.isHost ? 'Close game' : 'Leave') : h('button', { class: 'back-btn', 'data-mp': 'exit', onclick: () => this.exit() }, '◀ Menu'));
    }
    toast(t, ms) { U().toast(t, ms || 2600); }
    setBanner(text, kind) {
      this.banner.textContent = text || '';
      this.banner.className = 'mp-banner' + (text ? '' : ' hidden') + (kind ? ' ' + kind : '');
    }
    sendHost(msg) { if (this.session) this.session.send(this.session.hostId, msg); }

    exit() {
      this.close();
      if (this.opts.onExit) this.opts.onExit();
    }
    close() {
      if (this.current && this.current.destroy) { try { this.current.destroy(); } catch (e) { /* ignore */ } }
      this.current = null;
      this.endSession('closed');
    }
    endSession(reason) {
      const s = this.session;
      this.session = null;
      this.hostCtl = null;
      this.lobby = null;
      if (this.liveMatch) { try { this.liveMatch.destroy(); } catch (e) { /* ignore */ } this.liveMatch = null; }
      if (this.eventClient) { this.eventClient.destroy(); this.eventClient = null; }
      if (s && !s.closed) s.close(reason);
      this.chatLog = []; this.renderChat();
      this.setBanner('');
    }
    confirmLeave() {
      const { h } = U();
      const inGame = this.screenName === 'live' || this.screenName === 'activity';
      U().modal(this.isHost ? 'Close the game?' : 'Leave the game?', h('p', {}, this.isHost ? 'Everyone will be disconnected.' : inGame ? 'Your current match is forfeited (in an event, your seat continues as an AI player).' : 'You can join again later.'), [
        { label: this.isHost ? 'Close game' : 'Leave', primary: true, onClick: () => { this.endSession('left'); this.showConnect(); } }, { label: 'Stay' }]);
    }

    // -------------------------------------------------------------- session wiring
    attach(session, isHost) {
      this.session = session;
      session.on('message', (from, msg) => this.onMessage(from, msg));
      session.on('peer-join', (id) => { if (this.hostCtl) { /* waits for hello */ } void id; });
      session.on('peer-leave', (id) => { if (this.hostCtl) this.hostCtl.peerLeft(id); });
      session.on('status', (st) => { if (/reconnect/i.test(st)) this.setBanner('Connection interrupted — reconnecting…', 'warn'); else this.setBanner(''); });
      session.on('close', (reason) => {
        if (this.session !== session) return;
        this.endSession(reason);
        const { h } = U();
        this.showConnect();
        U().modal('Disconnected', h('p', {}, reason || 'The connection ended.'), [{ label: 'OK' }]);
      });
      if (isHost) this.hostCtl = new HostCtl(this);
    }
    onOpen() {
      if (this.hostCtl) { this.hostCtl.broadcast(); }
      else this.sendHost({ t: 'hello', name: this.name, cid: this.cid, ver: P().VERSION });
      this.showLobby();
    }

    onMessage(from, msg) {
      if (!msg || typeof msg !== 'object') return;
      // host authority first (only messages addressed to the host reach here on the host)
      if (this.hostCtl && from !== undefined) {
        try { if (this.hostCtl.handle(from, msg)) return; } catch (e) { console.error('[MP host] error handling', msg.t, e); }
      }
      try { this.clientHandle(from, msg); } catch (e) { console.error('[MP] error handling', msg.t, e); }
    }

    clientHandle(from, msg) {
      // only accept authority messages from the host
      const fromHost = from === (this.session && this.session.hostId);
      switch (msg.t) {
        case 'lobby': if (!fromHost) return; this.lobby = msg.state; if (this.screenName === 'lobby') this.renderLobby(); return;
        case 'chatb': if (!fromHost) return; this.addChat(msg); return;
        case 'refused': if (!fromHost) return; { const why = msg.why; this.endSession('refused'); this.showConnect(); U().modal('Could not join', U().h('p', {}, why), [{ label: 'OK' }]); } return;
        case 'deckerr': if (!fromHost) return; U().modal('Deck not accepted', U().h('p', {}, msg.why), [{ label: 'OK' }]); return;
        case 'abort':
          if (!fromHost) return;
          if (this.liveMatch) { this.liveMatch.destroy(); this.liveMatch = null; }
          if (this.eventClient) { this.eventClient.destroy(); this.eventClient = null; }
          this.showLobby();
          this.toast(msg.why || 'The game was ended.');
          return;
        case 'mstart':
          if (!fromHost) return;
          if (this.liveMatch) { try { this.liveMatch.destroy(); } catch (e) { /* ignore */ } }
          if (this.eventClient) { this.eventClient.screen = 'live'; this.eventClient.stopTimer(); }
          this.show('live', (root) => {
            const lm = this.liveMatch = MP.mountLiveMatch(root, {
              ctx: { myId: this.myId, send: (to, m) => this.session && this.session.send(to, m), sendHost: (m) => this.sendHost(m) },
              start: msg,
              onDone: () => { if (this.liveMatch === lm) this.liveMatch = null; if (this.eventClient) this.eventClient.showHub(); else this.showLobby(); },
            });
            return { destroy: () => { lm.destroy(); if (this.liveMatch === lm) this.liveMatch = null; } };
          });
          return;
        case 'evstart':
          if (!fromHost) return;
          if ((msg.members || []).indexOf(this.myId) < 0) return; // spectators stay in the lobby
          if (this.eventClient) this.eventClient.destroy();
          this.eventClient = new MP.EventClient(this.eventApi());
          this.show('activity', (root) => {
            root.appendChild(U().h('div', { class: 'screen mp-screen' }, this.header(msg.type === 'sealed' ? 'Sealed event' : 'Booster Draft'), U().h('div', { class: 'match-center' }, U().h('div', { class: 'panel mp-box' }, U().h('div', { class: 'titlebar' }, 'Starting…'), U().h('p', {}, msg.type === 'sealed' ? 'Opening sealed pools…' : 'Opening the first boosters…')))));
            return null;
          });
          return;
      }
      if (this.liveMatch && this.liveMatch.handle(from, msg)) return;
      if (this.eventClient && (fromHost || msg.t === 'estate') && this.eventClient.handle(from, msg)) return;
      if (msg.t === 'estate' && !this.eventClient && this.screenName === 'lobby') { this.lastEventView = msg.view; this.renderLobby(); }
    }

    eventApi() {
      const self = this;
      return {
        get myId() { return self.myId; },
        get isHost() { return self.isHost; },
        show: (builder) => this.show('activity', builder),
        sendHost: (m) => this.sendHost(m),
        header: (t) => this.header(t),
        toast: (t, ms) => this.toast(t, ms),
        hostNextRound: () => { if (this.hostCtl) this.hostCtl.nextRound(); },
        leaveToLobby: () => { if (this.eventClient) { this.eventClient.destroy(); this.eventClient = null; } this.showLobby(); },
      };
    }

    // -------------------------------------------------------------- chat
    buildChat() {
      const { h } = U();
      const log = h('div', { class: 'mp-chat-log' });
      const input = h('input', { type: 'text', class: 'mp-chat-input', placeholder: 'Say something… (Enter)', maxlength: '400' });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep game hotkeys away while typing
        if (e.key === 'Enter' && input.value.trim()) { this.sendHost({ t: 'chat', text: input.value.trim() }); input.value = ''; }
      });
      const badge = h('span', { class: 'mp-chat-badge hidden' });
      const head = h('div', { class: 'mp-chat-head', onclick: () => this.setChatOpen(!this.chatOpen) }, h('span', {}, 'Chat'), badge, h('span', { class: 'flex1' }), h('span', { class: 'mp-chat-toggle' }, '▾'));
      const el = h('div', { class: 'mp-chat hidden' }, head, h('div', { class: 'mp-chat-body' }, log, input));
      this.chatParts = { log, input, badge, head };
      this.chatOpen = true;
      return el;
    }
    setChatOpen(open) {
      this.chatOpen = !!open;
      this.chatEl.classList.toggle('collapsed', !this.chatOpen);
      this.chatParts.head.querySelector('.mp-chat-toggle').textContent = this.chatOpen ? '▾' : '▴';
      if (this.chatOpen) { this.unread = 0; this.renderBadge(); this.chatParts.log.scrollTop = 1e9; }
    }
    renderBadge() { const b = this.chatParts.badge; b.textContent = String(this.unread); b.classList.toggle('hidden', !this.unread); }
    addChat(m) {
      this.chatLog.push(m);
      if (this.chatLog.length > 300) this.chatLog.shift();
      this.appendChatLine(m);
      if (!this.chatOpen && !m.sys) { this.unread++; this.renderBadge(); }
    }
    appendChatLine(m) {
      const { h } = U();
      const log = this.chatParts.log;
      const time = new Date(m.ts || Date.now());
      const ts = ('0' + time.getHours()).slice(-2) + ':' + ('0' + time.getMinutes()).slice(-2);
      log.appendChild(m.sys ? h('div', { class: 'mp-chat-line sys' }, h('span', { class: 'dim' }, ts + ' '), m.text)
        : h('div', { class: 'mp-chat-line' + (m.from === this.myId ? ' mine' : '') }, h('span', { class: 'dim' }, ts + ' '), h('b', {}, m.name + ': '), m.text));
      while (log.children.length > 300) log.removeChild(log.firstChild);
      log.scrollTop = 1e9;
    }
    renderChat() { U().clear(this.chatParts.log); for (const m of this.chatLog) this.appendChatLine(m); }

    // -------------------------------------------------------------- connect screen
    showConnect() {
      const { h } = U();
      this.show('connect', (root) => {
        const nameIn = h('input', { type: 'text', class: 'mp-name', 'data-mp': 'name', value: this.name, maxlength: '24' });
        nameIn.addEventListener('change', () => { this.name = P().cleanName(nameIn.value, this.name); nameIn.value = this.name; store(NAME_KEY, this.name); });
        const readName = () => { this.name = P().cleanName(nameIn.value, this.name); store(NAME_KEY, this.name); };
        const servedByOther = /^https?:$/.test(location.protocol) && !/^(127\.0\.0\.1|localhost)$/.test(location.hostname);
        const underExe = location.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
        const lanStatus = h('div', { class: 'mp-small dim', 'data-mp': 'lan-status' }, 'Checking…');
        const lanBtn = h('button', { class: 'primary', 'data-mp': 'host-lan', disabled: true, onclick: () => { readName(); this.hostRelay(underExe); } }, 'Host on LAN');
        const rtcBtn = h('button', { class: 'primary', 'data-mp': 'host-online', disabled: !(OF.Net.webrtc && OF.Net.webrtc.supported()), onclick: () => { readName(); this.hostWebRTC(); } }, 'Host online');
        const addrIn = h('input', { type: 'text', class: 'mp-addr', 'data-mp': 'addr', placeholder: '192.168.1.5:47920', value: servedByOther ? location.host : (store(ADDR_KEY) || '') });
        const joinBtn = h('button', { class: 'primary', 'data-mp': 'join-addr', onclick: () => { readName(); store(ADDR_KEY, addrIn.value.trim()); this.joinRelay(addrIn.value.trim()); } }, 'Join');
        addrIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
        const codeIn = h('textarea', { class: 'mp-code', 'data-mp': 'invite-in', rows: '3', placeholder: 'Paste the invite code from the host (starts with ROTS)' });
        const codeBtn = h('button', { class: 'primary', 'data-mp': 'join-code', onclick: () => { readName(); this.joinWebRTC(codeIn.value); } }, 'Join with code');
        if (OF.Net.relay) {
          if (/^https?:$/.test(location.protocol)) {
            OF.Net.relay.probe(location.origin).then(() => {
              lanBtn.disabled = false;
              lanStatus.textContent = underExe ? 'Opens this PC to your local network. Guests open the address shown in the lobby in any browser.' : 'Host through the relay of the computer serving this page (' + location.host + ').';
            }, () => { lanStatus.textContent = 'LAN hosting needs RevengeOfTheSith.exe (this page is not served by it).'; });
          } else lanStatus.textContent = 'LAN hosting needs RevengeOfTheSith.exe — this page was opened from a file. You can still join a LAN game by address, or use online invite codes.';
        } else lanStatus.textContent = 'Relay transport not loaded.';
        root.appendChild(h('div', { class: 'screen mp-screen mp-connect' }, this.header('Multiplayer'),
          h('div', { class: 'mp-connect-body' },
            h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Your name'), h('div', { class: 'mp-pad' }, nameIn,
              h('div', { class: 'mp-small dim' }, 'Play Revenge of the Sith with friends: theme-deck or constructed duels, and booster draft or sealed events (2–8 players, AI fills the empty seats).'))),
            servedByOther ? h('div', { class: 'panel mp-card mp-hl' }, h('div', { class: 'titlebar' }, 'Game on ' + location.host), h('div', { class: 'mp-pad' }, h('p', {}, 'You opened a Revenge of the Sith host in your browser. Enter your name and press Join.'))) : null,
            h('div', { class: 'mp-cols' },
              h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Host a game'),
                h('div', { class: 'mp-pad' },
                  h('div', { class: 'mp-opt' }, h('div', { class: 'mp-opt-title' }, 'LAN / relay via this PC'), lanStatus, lanBtn),
                  h('div', { class: 'mp-opt' }, h('div', { class: 'mp-opt-title' }, 'Online (invite codes)'),
                    h('div', { class: 'mp-small dim' }, 'Direct connection over the internet, no port forwarding: you send each friend an invite code and paste back their reply code (any messenger works). Very strict NATs (some mobile or company networks) can fail — then use LAN, port forwarding to the relay, or a VPN like Tailscale/ZeroTier.'),
                    rtcBtn))),
              h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Join a game'),
                h('div', { class: 'mp-pad' },
                  h('div', { class: 'mp-opt' }, h('div', { class: 'mp-opt-title' }, 'Host address (LAN / relay)'), h('div', { class: 'mp-row' }, addrIn, joinBtn),
                    h('div', { class: 'mp-small dim' }, 'As shown in the host\'s lobby, e.g. 192.168.1.5:47920. Friends without the client can simply open http://<address>/ in a browser.')),
                  h('div', { class: 'mp-opt' }, h('div', { class: 'mp-opt-title' }, 'Invite code (online)'), codeIn, codeBtn)))))));
        return null;
      });
    }

    busy(text) {
      const { h } = U();
      this.show('busy', (root) => {
        root.appendChild(h('div', { class: 'screen mp-screen' }, this.header('Multiplayer'), h('div', { class: 'match-center' }, h('div', { class: 'panel mp-box' }, h('div', { class: 'titlebar' }, 'Please wait'), h('p', { 'data-mp': 'busy' }, text),
          h('div', { class: 'mbx-buttons' }, h('button', { onclick: () => { this.endSession('cancelled'); this.showConnect(); } }, 'Cancel'))))));
        return null;
      });
    }
    failConnect(e) {
      const msg = (e && e.message) || String(e);
      this.endSession('failed');
      this.showConnect();
      U().modal('Connection failed', U().h('p', {}, msg), [{ label: 'OK' }]);
    }

    async hostRelay(underExe) {
      this.busy('Starting the host…');
      try {
        if (underExe) this.hostInfo = Object.assign({ kind: 'lan' }, await OF.Net.relay.startLanHost());
        else this.hostInfo = { kind: 'relay', urls: [location.origin + '/'], addrs: [location.host] };
        const s = OF.Net.createHost({ transport: 'relay', base: location.origin, name: this.name });
        this.attach(s, true);
        s.on('error', (e) => console.warn('[MP] relay error', e));
        await s.ready;
        this.onOpen();
      } catch (e) { this.failConnect(e); }
    }
    async hostWebRTC() {
      try {
        this.hostInfo = { kind: 'webrtc' };
        const s = OF.Net.createHost({ transport: 'webrtc', name: this.name });
        this.attach(s, true);
        await s.ready;
        this.onOpen();
      } catch (e) { this.failConnect(e); }
    }
    async joinRelay(addr) {
      let base;
      try { base = OF.Net.relay.normalizeBase(addr); } catch (e) { this.failConnect(e); return; }
      this.busy('Connecting to ' + base + '…');
      const s = OF.Net.join({ transport: 'relay', base, name: this.name });
      this.attach(s, false);
      try { await s.ready; this.onOpen(); } catch (e) { if (this.session === s || !this.session) this.failConnect(new Error(s.closeReason || e.message)); }
    }
    async joinWebRTC(code) {
      if (!String(code || '').trim()) { this.toast('Paste the invite code first.'); return; }
      const { h } = U();
      const s = OF.Net.join({ transport: 'webrtc', code, name: this.name });
      this.attach(s, false);
      this.show('joining', (root) => {
        const out = h('textarea', { class: 'mp-code', 'data-mp': 'answer-out', rows: '5', readonly: true, placeholder: 'Preparing your reply code…' });
        const copyBtn = h('button', { class: 'primary', 'data-mp': 'copy-answer', disabled: true, onclick: () => copyText(out.value, out).then(() => this.toast('Reply code copied.')) }, 'Copy reply code');
        const status = h('p', { class: 'dim', 'data-mp': 'join-status' }, 'Preparing the connection (gathering network addresses)…');
        root.appendChild(h('div', { class: 'screen mp-screen' }, this.header('Join online game'), h('div', { class: 'match-center' }, h('div', { class: 'panel mp-box wide' }, h('div', { class: 'titlebar' }, 'Send this reply code back to the host'),
          h('div', { class: 'mp-pad' }, out, h('div', { class: 'mbx-buttons' }, copyBtn, h('button', { onclick: () => { this.endSession('cancelled'); this.showConnect(); } }, 'Cancel')), status)))));
        s.answerCode.then((code2) => { out.value = code2; copyBtn.disabled = false; status.textContent = 'Give this code to ' + ((s.info && s.info.hostName) || 'the host') + '. You are connected as soon as they paste it.'; }, () => {});
        s.on('status', (t) => { status.textContent = t; });
        return null;
      });
      try { await s.ready; this.onOpen(); } catch (e) { if (this.session === s || !this.session) this.failConnect(new Error(s.closeReason || e.message)); }
    }

    // -------------------------------------------------------------- lobby screen
    showLobby() {
      const { h } = U();
      if (!this.session) { this.showConnect(); return; }
      this.show('lobby', (root) => {
        this.lobbyEls = { body: h('div', { class: 'mp-lobby-body' }) };
        root.appendChild(h('div', { class: 'screen mp-screen mp-lobby' }, this.header('Multiplayer lobby'), this.lobbyEls.body));
        this.renderLobby();
        return { destroy: () => { this.lobbyEls = null; } };
      });
    }
    myDeckChoice() {
      const list = deckChoices();
      const saved = store(DECK_KEY);
      return list.find(d => d.id === saved) || list[0] || null;
    }
    sendMyDeck(choice) {
      if (!choice) return;
      store(DECK_KEY, choice.id);
      this.sendHost({ t: 'deck', deck: { label: choice.label.replace(/^(Theme|Saved): /, ''), cards: choice.cards } });
    }
    renderLobby() {
      if (!this.lobbyEls) return;
      const { h, clear } = U();
      const L = this.lobby;
      const body = this.lobbyEls.body;
      clear(body);
      if (!L) { body.appendChild(h('div', { class: 'match-center' }, h('div', { class: 'panel mp-box' }, h('div', { class: 'titlebar' }, 'Joining…'), h('p', {}, 'Waiting for the host…')))); return; }
      const host = this.isHost;
      const cfg = L.cfg;
      const me = L.players.find(p => p.id === this.myId);
      // ---- players
      const plist = h('div', { class: 'mp-players', 'data-mp': 'players' });
      for (const p of L.players) {
        plist.appendChild(h('div', { class: 'mp-player' + (p.id === this.myId ? ' me' : ''), 'data-peer': p.id },
          h('span', { class: 'mp-dot on' }), h('span', { class: 'mp-pname' }, p.name), p.isHost ? h('span', { class: 'mp-badge' }, 'host') : null,
          cfg.mode === 'duel' ? h('span', { class: 'mp-pdeck dim' }, p.deck ? p.deck.label : 'no deck chosen') : null,
          h('span', { class: 'flex1' }),
          host && !p.isHost ? h('button', { class: 'mini', title: 'Remove this player', onclick: () => this.hostCtl.kick(p.id) }, '✕') : null));
      }
      const left = h('div', { class: 'mp-lobby-col' },
        h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Players (' + L.players.length + '/8)'), plist),
        this.renderHostInfo(L));
      // ---- settings
      const dis = !host || L.phase !== 'lobby';
      const sel = (key, options, val, onchange) => {
        const s = h('select', { 'data-mp': 'cfg-' + key, disabled: dis }, options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(val) }, label)));
        s.addEventListener('change', () => onchange(s.value));
        return s;
      };
      const row = (label, ctl, hint) => h('div', { class: 'mp-set-row' }, h('label', {}, label), ctl, hint ? h('div', { class: 'mp-small dim' }, hint) : null);
      const set = (patch) => this.hostCtl && this.hostCtl.setCfg(patch);
      const settings = h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Game settings' + (host ? '' : ' (chosen by the host)')));
      const sb = h('div', { class: 'mp-pad mp-settings' });
      settings.appendChild(sb);
      sb.appendChild(row('Mode', sel('mode', Object.keys(MODES).map(k => [k, MODES[k]]), cfg.mode, (v) => set({ mode: v }))));
      sb.appendChild(row('Match format', sel('bestOf', [[1, 'Best of 1'], [3, 'Best of 3']], cfg.bestOf, (v) => set({ bestOf: Number(v) }))));
      if (cfg.mode === 'duel') {
        const guests = L.players.filter(p => !p.isHost);
        if (guests.length > 1) sb.appendChild(row('Host plays against', sel('duelOpp', [['', '— choose —']].concat(guests.map(g => [g.id, g.name])), cfg.duelOpp || '', (v) => set({ duelOpp: v || null })), 'Other players watch the chat until the duel is over.'));
      } else {
        sb.appendChild(row('AI difficulty', sel('aiLevel', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], cfg.aiLevel, (v) => set({ aiLevel: v })), 'For AI seats and your matches against them.'));
        if (cfg.mode === 'draft') sb.appendChild(row('Pick timer', sel('pickTimer', [[0, 'Off'], [45, '45 s per pack'], [60, '60 s per pack'], [90, '90 s per pack']], cfg.pickTimer, (v) => set({ pickTimer: Number(v) })), 'The timer shrinks as the pack gets smaller; time-outs are auto-picked.'));
        if (cfg.mode === 'sealed') sb.appendChild(row('AI opponents', sel('sealedAI', [0, 1, 2, 3, 4, 5, 6].map(n => [n, n === 0 ? 'None (humans only)' : String(n)]), cfg.sealedAI, (v) => set({ sealedAI: Number(v) })), 'Odd player counts get one more AI. Up to 8 players in total.'));
        const humans = L.players.length;
        const seats = cfg.mode === 'draft' ? 8 : Math.max(2, Math.min(8, humans + Number(cfg.sealedAI) + ((humans + Number(cfg.sealedAI)) % 2)));
        sb.appendChild(h('div', { class: 'mp-small dim mp-seatinfo' }, humans + ' human' + (humans === 1 ? '' : 's') + ' + ' + Math.max(0, seats - humans) + ' AI = ' + seats + ' seats · ' + (cfg.mode === 'draft' ? '3 boosters each, then' : '6 boosters each, then') + ' Swiss rounds.'));
      }
      // ---- my deck (duel)
      let deckPanel = null;
      if (cfg.mode === 'duel') {
        const choices = deckChoices();
        const mine = this.myDeckChoice();
        const dsel = h('select', { 'data-mp': 'deck', disabled: L.phase !== 'lobby' }, choices.map(c => h('option', { value: c.id, selected: mine && c.id === mine.id }, c.label)));
        dsel.addEventListener('change', () => this.sendMyDeck(choices.find(c => c.id === dsel.value)));
        deckPanel = h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Your deck'), h('div', { class: 'mp-pad' }, dsel,
          h('div', { class: 'mp-small dim' }, 'Theme decks or decks saved in the Deck Editor (40+ cards). Your opponent\'s client receives your list.')));
        if (me && !me.deck && mine && L.phase === 'lobby' && !this._deckSent) { this._deckSent = true; setTimeout(() => this.sendMyDeck(mine), 0); }
      }
      // ---- start / activity
      const startBox = h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, L.phase === 'lobby' ? 'Start' : 'In progress'));
      const sbody = h('div', { class: 'mp-pad' });
      startBox.appendChild(sbody);
      if (L.phase !== 'lobby') {
        sbody.appendChild(h('p', { 'data-mp': 'activity' }, L.activity || 'A game is running.'));
        if (host) sbody.appendChild(h('button', { 'data-mp': 'abort', onclick: () => U().modal('End the current game?', h('p', {}, 'All players return to the lobby.'), [{ label: 'End game', primary: true, onClick: () => this.hostCtl.abortActivity() }, { label: 'Cancel' }]) }, 'End game for everyone'));
        if (this.eventClient) sbody.appendChild(h('button', { class: 'primary', onclick: () => this.eventClient.showHub() }, 'Return to the event'));
      } else if (host) {
        const err = this.hostCtl.canStart();
        sbody.appendChild(h('button', { class: 'primary mp-start', 'data-mp': 'start', disabled: !!err, onclick: () => this.hostCtl.start() }, 'Start ' + (cfg.mode === 'duel' ? 'duel' : cfg.mode === 'draft' ? 'draft' : 'sealed event') + ' ▶'));
        sbody.appendChild(h('div', { class: 'mp-small dim', 'data-mp': 'start-hint' }, err || 'Everyone is ready.'));
      } else sbody.appendChild(h('p', { class: 'dim', 'data-mp': 'start-hint' }, 'Waiting for the host to start.'));
      const mid = h('div', { class: 'mp-lobby-col' }, settings, deckPanel, startBox);
      body.append(left, mid, h('div', { class: 'mp-lobby-col mp-chatcol' }));
    }

    renderHostInfo(L) {
      const { h } = U();
      const info = L.info || {};
      if (L.transport === 'webrtc') {
        if (!this.isHost) return h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'Connection'), h('div', { class: 'mp-pad mp-small dim' }, 'Connected directly to the host over the internet (WebRTC).'));
        return this.renderInvites();
      }
      const urls = info.urls || [];
      return h('div', { class: 'panel mp-card' }, h('div', { class: 'titlebar' }, 'How friends join'),
        h('div', { class: 'mp-pad' },
          urls.length ? h('div', {}, h('div', { class: 'mp-small' }, 'On the same network, friends open in any browser:'), h('div', { class: 'mp-urls', 'data-mp': 'lan-urls' }, urls.map(u => h('div', { class: 'mp-url' }, u))),
            h('div', { class: 'mp-small dim' }, 'Or, in their own copy of the client: Multiplayer → Join → host address ' + (info.addrs && info.addrs[0] ? info.addrs[0] + ':' + (info.port || '') : '') + '. Windows may ask to allow Revenge of the Sith through the firewall — allow it on private networks. Over the internet: forward TCP port ' + (info.port || 47920) + ' or use Tailscale/ZeroTier and share that address.'))
            : h('div', { class: 'mp-small dim' }, 'No network address found.')));
    }

    renderInvites() {
      const { h } = U();
      const s = this.session;
      const box = h('div', { class: 'panel mp-card mp-invites' }, h('div', { class: 'titlebar' }, 'Invite players (online)'));
      const body = h('div', { class: 'mp-pad' });
      box.appendChild(body);
      const inv = this.invite;
      if (!inv) {
        body.appendChild(h('div', { class: 'mp-small dim' }, '1. Create an invite code and send it to one friend. 2. Paste the reply code they send back. Repeat for each friend.'));
        body.appendChild(h('button', { class: 'primary', 'data-mp': 'create-invite', onclick: () => {
          this.invite = { pending: true };
          this.renderLobby();
          s.webrtc.createInvite().then((r) => { this.invite = r; this.renderLobby(); }, (e) => { this.invite = null; this.renderLobby(); U().modal('Could not create an invite', h('p', {}, e.message), [{ label: 'OK' }]); });
        } }, 'Create invite code'));
        return box;
      }
      if (inv.pending) { body.appendChild(h('p', { class: 'dim' }, 'Preparing an invite code (gathering network addresses)…')); return box; }
      const out = h('textarea', { class: 'mp-code', rows: '4', readonly: true, 'data-mp': 'invite-out' });
      out.value = inv.code;
      const ans = h('textarea', { class: 'mp-code', rows: '3', 'data-mp': 'answer-in', placeholder: 'Paste the reply code here' });
      if (inv.answerDraft) ans.value = inv.answerDraft;
      ans.addEventListener('input', () => { inv.answerDraft = ans.value; });
      const status = h('div', { class: 'mp-small dim', 'data-mp': 'invite-status' }, inv.status || '');
      const connect = h('button', { class: 'primary', 'data-mp': 'accept-answer', onclick: () => {
        connect.disabled = true; status.textContent = 'Connecting…'; inv.status = 'Connecting…';
        s.webrtc.acceptAnswer(ans.value).then((r) => { this.invite = null; this.toast((r.name || 'A player') + ' connected.'); this.renderLobby(); },
          (e) => { connect.disabled = false; inv.status = e.message; status.textContent = e.message; });
      } }, 'Connect');
      body.append(h('div', { class: 'mp-small' }, 'Invite #' + inv.slot + ' — send this code to a friend:'), out,
        h('div', { class: 'mbx-buttons' }, h('button', { 'data-mp': 'copy-invite', onclick: () => copyText(out.value, out).then(() => this.toast('Invite code copied.')) }, 'Copy invite code'),
          h('button', { onclick: () => { s.webrtc.cancelInvite(inv.slot); this.invite = null; this.renderLobby(); } }, 'Cancel')),
        h('div', { class: 'mp-small' }, 'Then paste their reply code:'), ans, h('div', { class: 'mbx-buttons' }, connect), status);
      return box;
    }
  }

  MP.open = function (container, opts) {
    if (!container) throw new Error('OF.MP.open: container element required');
    if (MP.app && MP.app.root && MP.app.root.isConnected) { try { MP.app.close(); } catch (e) { /* ignore */ } }
    const app = new MPApp(container, opts || {});
    return { close: () => app.close(), app };
  };
  MP.deckChoices = deckChoices;
  MP.HostCtl = HostCtl;
})(typeof window !== 'undefined' ? (window.OF = window.OF || {}) : (globalThis.OF = globalThis.OF || {}));
