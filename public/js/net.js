(function (global) {
  'use strict';

  const SESSION_KEY = 'slitherlab.v1';
  const PROFILE_KEY = 'slitherlab.profile';

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function validId(id) {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  }

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function create(handlers) {
    const saved = readJson(global.sessionStorage, SESSION_KEY) || {};
    const profile = readJson(global.localStorage, PROFILE_KEY) || {};
    const keepId = validId(saved.sessionId);
    const net = {
      sessionId: keepId ? saved.sessionId : uuid(),
      nick: saved.nick || profile.nick || '',
      color: saved.color || profile.color || '#3ee0b0',
      pending: keepId && Array.isArray(saved.pending) ? saved.pending.slice(-32) : [],
      nextSeq: keepId && Number.isFinite(saved.nextSeq) ? saved.nextSeq : 1,
      ack: keepId && Number.isFinite(saved.ack) ? saved.ack : 0,
      playing: keepId && !!saved.playing,
      spawned: keepId && !!saved.spawned,
      wantRespawn: keepId && !!saved.wantRespawn,
      lastSelf: keepId ? saved.lastSelf || null : null,
      ws: null,
      attempt: 0,
      everOnline: false,
      timer: null,
      connectTimer: null,
      nextTryAt: 0,
      manualRestart: false,
      lastFlush: 0,
      lastSync: 0,
      lastRespawn: 0,
      lastPing: 0,
      lastMsgAt: 0,
      lastSave: 0,
      dirty: false,
      rtt: null,
      state: 'connecting'
    };
    if (net.nextSeq <= net.ack) net.nextSeq = net.ack + 1;

    function hud() {
      return {
        state: net.state,
        attempt: net.attempt,
        nextTryAt: net.nextTryAt,
        buffered: net.pending.length,
        rtt: net.rtt,
        offline: !global.navigator.onLine,
        sessionId: net.sessionId,
        spawned: net.spawned,
        playing: net.playing,
        lastSelf: net.lastSelf,
        nick: net.nick,
        color: net.color
      };
    }

    function emit() {
      if (handlers.onStatus) handlers.onStatus(hud());
    }

    function persist() {
      const blob = {
        sessionId: net.sessionId,
        nick: net.nick,
        color: net.color,
        pending: net.pending.slice(-32),
        nextSeq: net.nextSeq,
        ack: net.ack,
        playing: net.playing,
        spawned: net.spawned,
        wantRespawn: net.wantRespawn,
        lastSelf: net.lastSelf,
        savedAt: Date.now()
      };
      try { global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(blob)); } catch { /* private mode */ }
      try {
        global.localStorage.setItem(PROFILE_KEY, JSON.stringify({ nick: net.nick, color: net.color }));
        const all = readJson(global.localStorage, 'slitherlab.sessions') || {};
        all[net.sessionId] = blob;
        const ids = Object.keys(all);
        if (ids.length > 8) {
          ids.sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0));
          ids.slice(0, ids.length - 8).forEach((id) => { delete all[id]; });
        }
        global.localStorage.setItem('slitherlab.sessions', JSON.stringify(all));
      } catch { /* private mode */ }
      net.dirty = false;
      net.lastSave = Date.now();
    }

    function touch() {
      net.dirty = true;
    }

    function isOpen() {
      return !!(net.ws && net.ws.readyState === 1);
    }

    function raw(payload) {
      if (!isOpen()) return;
      try { net.ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }

    function flushPending() {
      if (!isOpen() || !net.spawned) return;
      net.lastFlush = Date.now();
      for (const item of net.pending) {
        if ((item.seq || 0) > net.ack) raw(item);
      }
    }

    function syncSession() {
      if (!isOpen() || !net.playing) return;
      net.lastSync = Date.now();
      if (net.spawned) {
        raw({
          type: 'resume',
          sessionId: net.sessionId,
          nick: net.nick,
          color: net.color,
          pending: net.pending.slice(-32)
        });
        if (net.wantRespawn) {
          raw({ type: 'respawn', sessionId: net.sessionId });
          net.lastRespawn = Date.now();
        }
      } else {
        raw({
          type: 'join',
          sessionId: net.sessionId,
          nick: net.nick,
          color: net.color
        });
      }
    }

    function schedule() {
      if (net.timer) return;
      const delay = Math.min(8000, 400 * 2 ** net.attempt) + Math.floor(Math.random() * 180);
      net.attempt = Math.min(net.attempt + 1, 6);
      net.nextTryAt = Date.now() + delay;
      net.state = global.navigator.onLine ? 'reconnecting' : 'offline';
      net.timer = global.setTimeout(() => {
        net.timer = null;
        connect();
      }, delay);
      emit();
    }

    function connect() {
      if (net.ws && (net.ws.readyState === 0 || net.ws.readyState === 1)) return;
      global.clearTimeout(net.connectTimer);
      const proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let sock;
      try {
        sock = new WebSocket(`${proto}//${global.location.host}/ws`);
      } catch {
        schedule();
        return;
      }
      net.ws = sock;
      net.state = net.everOnline ? 'reconnecting' : 'connecting';
      emit();
      net.connectTimer = global.setTimeout(() => {
        if (net.ws === sock && sock.readyState === 0) {
          try { sock.close(); } catch { /* ignore */ }
        }
      }, 90000);

      sock.onopen = () => {
        if (net.ws !== sock) return;
        global.clearTimeout(net.connectTimer);
        global.clearTimeout(net.timer);
        net.timer = null;
        net.everOnline = true;
        net.attempt = 0;
        net.state = 'online';
        net.lastMsgAt = Date.now();
        syncSession();
        flushPending();
        emit();
      };

      sock.onmessage = (ev) => {
        if (net.ws !== sock) return;
        net.lastMsgAt = Date.now();
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') {
          if (handlers.onHello) handlers.onHello(msg);
          return;
        }
        if (msg.type === 'state') {
          if (msg.you) {
            const first = !net.spawned;
            net.spawned = true;
            if (msg.you.alive) net.wantRespawn = false;
            ackTo(msg.you.ack);
            net.lastSelf = {
              mass: msg.you.mass,
              length: msg.you.length,
              alive: msg.you.alive,
              food: msg.you.foodEaten,
              wins: msg.you.wins,
              name: msg.you.name
            };
            touch();
            if (first) flushPending();
          }
          if (handlers.onState) handlers.onState(msg);
          return;
        }
        if (msg.type === 'resume_fail' || msg.type === 'session_end') {
          net.spawned = false;
          net.playing = false;
          net.wantRespawn = false;
          net.pending = [];
          persist();
          if (handlers.onResumeFail) handlers.onResumeFail(msg);
          return;
        }
        if (msg.type === 'error') {
          if (handlers.onError) handlers.onError(msg);
          return;
        }
        if (msg.type === 'kicked') {
          net.playing = false;
          net.spawned = false;
          net.wantRespawn = false;
          net.pending = [];
          net.sessionId = uuid();
          net.nextSeq = 1;
          net.ack = 0;
          persist();
          if (handlers.onKicked) handlers.onKicked(msg);
          return;
        }
        if (msg.type === 'pong' && typeof msg.t === 'number') {
          net.rtt = Math.max(0, Math.round(performance.now() - msg.t));
          emit();
        }
      };

      sock.onerror = () => {
        try { sock.close(); } catch { /* ignore */ }
      };

      sock.onclose = () => {
        if (net.ws !== sock) return;
        net.ws = null;
        global.clearTimeout(net.connectTimer);
        persist();
        if (net.manualRestart) {
          net.manualRestart = false;
          connect();
          return;
        }
        net.state = global.navigator.onLine ? 'reconnecting' : 'offline';
        emit();
        schedule();
      };
    }

    function ackTo(value) {
      if (!Number.isFinite(value) || value < net.ack) return;
      net.ack = value;
      net.pending = net.pending.filter((item) => (item.seq || 0) > net.ack);
      touch();
    }

    function command(partial) {
      const msg = Object.assign({}, partial, { seq: net.nextSeq++ });
      net.pending.push(msg);
      if (net.pending.length > 32) net.pending.splice(0, net.pending.length - 32);
      if (isOpen() && net.spawned) {
        touch();
        raw(msg);
      } else persist();
      return msg;
    }

    function play(nick, color) {
      net.nick = nick;
      net.color = color;
      net.playing = true;
      net.wantRespawn = false;
      persist();
      if (!isOpen()) reconnectNow();
      else syncSession();
    }

    function respawn() {
      net.wantRespawn = true;
      net.playing = true;
      persist();
      if (isOpen() && net.spawned) {
        raw({ type: 'respawn', sessionId: net.sessionId });
        net.lastRespawn = Date.now();
      } else if (!isOpen()) reconnectNow();
    }

    function reconnectNow() {
      global.clearTimeout(net.timer);
      net.timer = null;
      net.attempt = 0;
      const sock = net.ws;
      if (sock && (sock.readyState === 0 || sock.readyState === 1)) {
        net.manualRestart = true;
        try { sock.close(); } catch { /* ignore */ }
      } else connect();
    }

    function pump() {
      const now = Date.now();
      if (net.dirty && now - net.lastSave > 200) persist();
      if (isOpen() && net.everOnline && now - net.lastMsgAt > 4000) {
        try { net.ws.close(); } catch { /* ignore */ }
        return;
      }
      if (isOpen() && now - net.lastPing > 2000) {
        net.lastPing = now;
        raw({ type: 'ping', t: performance.now() });
      }
      if (net.playing && !net.spawned && isOpen() && now - net.lastSync > 1000) syncSession();
      if (net.wantRespawn && net.spawned && isOpen() && now - net.lastRespawn > 1000) {
        raw({ type: 'respawn', sessionId: net.sessionId });
        net.lastRespawn = now;
      }
      if (now - net.lastFlush > 500) flushPending();
    }

    global.addEventListener('offline', () => {
      net.state = 'offline';
      emit();
      const sock = net.ws;
      if (sock && sock.readyState <= 1) {
        try { sock.close(); } catch { /* ignore */ }
      } else if (!net.timer) schedule();
    });

    global.addEventListener('online', () => {
      net.attempt = 0;
      reconnectNow();
    });

    global.addEventListener('pagehide', () => persist());

    connect();
    return {
      play,
      respawn,
      command,
      reconnectNow,
      hud,
      pump
    };
  }

  global.SlitherNet = { create };
})(window);
