(function () {
  'use strict';

  const S = window.SlitherShared;
  const canvas = document.getElementById('view');
  const renderer = window.SlitherRender.createRenderer(canvas);
  const $ = (id) => document.getElementById(id);

  const state = {
    mode: 'menu',
    nick: '',
    color: S.SNAKE_COLORS[0],
    worldRadius: S.WORLD.RADIUS,
    beaconRange: S.WORLD.BEACON_RANGE,
    graceMs: S.WORLD.GRACE_MS,
    foodPalette: S.FOOD_COLORS.slice(),
    foods: new Map(),
    foodGone: new Map(),
    snapshots: [],
    selfId: null,
    you: null,
    beacon: { x: 700, y: 0, version: 1, ownerId: null, ownerName: null },
    live: [],
    records: [],
    conflictsTotal: 0,
    conflictCount: 0,
    online: 0,
    log: [],
    logVersion: 0,
    logDrawn: -1,
    feed: [],
    seenIds: new Set(),
    seenList: [],
    cam: { x: 0, y: 0, zoom: 1 },
    lastCam: null,
    aim: 0,
    aimMode: 'mouse',
    keys: new Set(),
    boosts: { mouse: false, space: false, button: false },
    particles: [],
    boardTab: 'live',
    boardKey: '',
    menuKey: ''
  };

  let audioCtx = null;
  let lastSentAt = 0;
  let lastSentAim = null;
  let lastSentBoost = null;

  const net = window.SlitherNet.create({
    onHello: (msg) => onHello(msg),
    onState: (msg) => onState(msg),
    onStatus: (hud) => updateNet(hud),
    onResumeFail: (msg) => {
      toast(msg.text || 'Сессия истекла');
      $('menu-error').textContent = msg.text || '';
      setMode('menu');
    },
    onError: (msg) => {
      toast(msg.text || 'Ошибка');
      $('menu-error').textContent = msg.text || '';
      if (state.mode !== 'menu' && !net.hud().spawned) setMode('menu');
    },
    onKicked: (msg) => {
      toast(msg.text || 'Сессия открыта в другом окне');
      setMode('menu');
    }
  });

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function toast(text) {
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').appendChild(el);
    window.setTimeout(() => el.remove(), 3600);
  }

  function ensureAudio() {
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* без звука игра жива */ }
  }

  function beep(freq, dur, type, gain) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const amp = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      amp.gain.value = gain || 0.03;
      osc.connect(amp);
      amp.connect(audioCtx.destination);
      osc.start();
      amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.stop(audioCtx.currentTime + dur);
    } catch { /* ignore */ }
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    if (mode !== 'play') {
      state.boosts.mouse = false;
      state.boosts.space = false;
      state.boosts.button = false;
    }
  }

  function decodeFood(row) {
    if (!Array.isArray(row)) return null;
    return {
      id: row[0],
      x: row[1],
      y: row[2],
      value: row[3],
      color: row[4] || 0,
      kind: S.FOOD_KIND_NAME[row[5]] || 'normal',
      version: row[6] || 1
    };
  }

  function applyFoods(msg, now) {
    const delay = 110;
    if (Array.isArray(msg.foods)) {
      const seen = new Set();
      for (const row of msg.foods) {
        const food = decodeFood(row);
        if (!food) continue;
        seen.add(food.id);
        state.foods.set(food.id, food);
        state.foodGone.delete(food.id);
      }
      for (const id of state.foods.keys()) {
        if (!seen.has(id)) state.foodGone.set(id, now + delay);
      }
      return;
    }
    for (const id of msg.foodRemove || []) state.foodGone.set(id, now + delay);
    for (const row of msg.foodAdd || []) {
      const food = decodeFood(row);
      if (!food) continue;
      state.foods.set(food.id, food);
      state.foodGone.delete(food.id);
    }
  }

  function purgeFoods(now) {
    for (const [id, at] of state.foodGone) {
      if (now < at) continue;
      const food = state.foods.get(id);
      if (food) burst(food);
      state.foods.delete(id);
      state.foodGone.delete(id);
    }
  }

  function burst(food) {
    const palette = state.foodPalette;
    const color = palette[food.color % palette.length] || '#ffd60a';
    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 28 + Math.random() * 90;
      state.particles.push({
        x: food.x,
        y: food.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.36,
        max: 0.36,
        color,
        r: 1.6 + Math.random() * 2
      });
    }
    if (state.particles.length > 200) state.particles.splice(0, state.particles.length - 200);
  }

  function parseSnake(raw) {
    return {
      id: raw.id,
      num: raw.num,
      name: raw.name,
      color: raw.color,
      x: raw.x,
      y: raw.y,
      angle: raw.angle || 0,
      mass: raw.mass || 0,
      length: raw.length || 0,
      boost: !!raw.boost,
      connected: raw.connected !== false,
      points: Array.isArray(raw.points) ? raw.points : []
    };
  }

  function pushSnapshot(snakes) {
    const map = new Map();
    for (const snake of snakes) map.set(snake.id, snake);
    state.snapshots.push({ t: performance.now(), snakes: map });
    if (state.snapshots.length > 24) state.snapshots.shift();
  }

  function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  function sampleSnakes(now) {
    const snaps = state.snapshots;
    if (!snaps.length) return [];
    const renderAt = now - 100;
    let older = null;
    let newer = null;
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].t <= renderAt) older = snaps[i];
      else {
        newer = snaps[i];
        break;
      }
    }
    const frame = newer && older ? null : (newer || older);
    if (frame && !(newer && older)) return [...frame.snakes.values()];
    if (!older || !newer) return [];
    const span = newer.t - older.t;
    const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (renderAt - older.t) / span));
    const out = [];
    for (const [id, next] of newer.snakes) {
      const prev = older.snakes.get(id);
      if (!prev || Math.hypot(next.x - prev.x, next.y - prev.y) > 240) {
        out.push(next);
        continue;
      }
      const x = prev.x + (next.x - prev.x) * t;
      const y = prev.y + (next.y - prev.y) * t;
      const dx = x - next.x;
      const dy = y - next.y;
      out.push(Object.assign({}, next, {
        x,
        y,
        angle: lerpAngle(prev.angle, next.angle, t),
        points: next.points.map((point) => [point[0] + dx, point[1] + dy])
      }));
    }
    return out;
  }

  function remember(id) {
    if (id == null || state.seenIds.has(id)) return false;
    state.seenIds.add(id);
    state.seenList.push(id);
    if (state.seenList.length > 400) state.seenIds.delete(state.seenList.shift());
    return true;
  }

  function ingestEvents(events) {
    let feedDirty = false;
    for (const event of events) {
      if (!remember(event.id)) continue;
      const kind = event.kind || 'notice';
      state.log.unshift({ id: event.id, kind, text: event.text || '', t: event.t || Date.now() });
      if (state.log.length > 30) state.log.length = 30;
      state.logVersion += 1;
      if (kind === 'conflict') {
        state.conflictCount += 1;
        const mine = (event.claimants || []).some((item) => item.id === state.selfId);
        const badge = $('conflict-count');
        badge.classList.remove('flash');
        void badge.offsetWidth;
        badge.classList.add('flash');
        if (mine) {
          beep(520, 0.08, 'square', 0.03);
          toast(event.winnerId === state.selfId ? 'Конфликт решён в вашу пользу' : 'Конфликт решён в пользу другого игрока');
        }
      } else if (kind === 'death') {
        state.feed.unshift(event.text || 'Столкновение');
        if (state.feed.length > 4) state.feed.length = 4;
        feedDirty = true;
      } else if (kind === 'notice' && /восстановлена|слишком далеко/i.test(event.text || '')) {
        toast(event.text);
      }
    }
    if (feedDirty) renderFeed();
  }

  function onHello(msg) {
    const constants = msg.constants || {};
    if (constants.worldRadius) state.worldRadius = constants.worldRadius;
    if (constants.beaconRange) state.beaconRange = constants.beaconRange;
    if (constants.graceMs) state.graceMs = constants.graceMs;
    if (constants.foodPalette) state.foodPalette = constants.foodPalette;
    if (Array.isArray(msg.records)) state.records = msg.records;
    if (Number.isFinite(msg.conflictsTotal)) state.conflictsTotal = msg.conflictsTotal;
    state.menuKey = '';
    state.boardKey = '';
    renderMenuRecords();
    renderBoard();
    renderLog();
  }

  function onState(msg) {
    applyFoods(msg, performance.now());
    if (msg.beacon) state.beacon = msg.beacon;
    if (Array.isArray(msg.live)) state.live = msg.live;
    if (Array.isArray(msg.records)) {
      state.records = msg.records;
      state.menuKey = '';
    }
    if (Number.isFinite(msg.conflictsTotal)) state.conflictsTotal = msg.conflictsTotal;
    state.online = msg.online || 0;
    if (msg.you) {
      const prevFood = state.you && state.you.id === msg.you.id ? state.you.foodEaten : null;
      state.you = msg.you;
      state.selfId = msg.you.id;
      if (prevFood != null && msg.you.foodEaten > prevFood) beep(680, 0.06, 'sine', 0.035);
      if (!msg.you.alive && (state.mode === 'play' || state.mode === 'dead')) {
        if (state.mode === 'play') beep(96, 0.22, 'triangle', 0.04);
        setMode('dead');
        showDeath(msg.you);
      } else if (msg.you.alive && state.mode === 'dead') {
        setMode('play');
      }
    }
    pushSnapshot((msg.snakes || []).map(parseSnake));
    ingestEvents(msg.events || []);
    renderBoard();
    renderLog();
    renderMenuRecords();
  }

  function showDeath(you) {
    const death = you.death || {};
    $('death-title').textContent = 'Змейка уничтожена';
    $('death-reason').textContent = death.text || 'Столкновение';
    const seconds = Math.round((death.survivalMs || 0) / 1000);
    $('death-stats').textContent = `Длина ${death.length != null ? death.length : you.length}, масса ${Math.round(death.mass != null ? death.mass : you.mass)}, еда ${death.foodEaten != null ? death.foodEaten : you.foodEaten}, время ${seconds} с`;
  }

  function renderMenuRecords() {
    const key = JSON.stringify(state.records);
    if (key === state.menuKey) return;
    state.menuKey = key;
    const rows = state.records.slice(0, 8);
    $('menu-records').innerHTML = rows.length
      ? rows.map((row, index) => `<li><b>${index + 1}. ${esc(row.nickname)}</b><em>длина ${row.maxLength} · еда ${row.foodEaten} · ${fmtTime(row.bestSurvivalMs)} · побед ${row.wins} · смертей ${row.deaths}</em></li>`).join('')
      : '<li class="empty">Рекордов пока нет. Они записываются на сервер и остаются после перезапуска.</li>';
  }

  function renderBoard() {
    const rows = state.boardTab === 'records' ? state.records : state.live;
    const key = `${state.boardTab}:${state.selfId}:${JSON.stringify(rows)}`;
    if (key === state.boardKey) return;
    state.boardKey = key;
    if (!rows.length) {
      $('board-list').innerHTML = '<li class="empty">Пока пусто</li>';
      return;
    }
    if (state.boardTab === 'records') {
      $('board-list').innerHTML = rows.map((row, index) => `<li><b>${index + 1}</b><span></span><span>${esc(row.nickname)}</span><em>длина ${row.maxLength} · еда ${row.foodEaten} · ${fmtTime(row.bestSurvivalMs)} · побед ${row.wins}</em></li>`).join('');
      return;
    }
    $('board-list').innerHTML = rows.map((row, index) => `<li class="${row.id === state.selfId ? 'me' : ''}"><i style="background:${esc(row.color)}"></i><b>${index + 1}</b><span>${esc(row.name)}</span><em>${row.mass}</em></li>`).join('');
  }

  function renderLog() {
    if (state.logDrawn === state.logVersion && $('conflict-server').textContent === String(state.conflictsTotal || 0)) return;
    state.logDrawn = state.logVersion;
    $('conflict-count').textContent = String(state.conflictCount);
    $('conflict-server').textContent = String(state.conflictsTotal || 0);
    $('log-list').innerHTML = state.log.length
      ? state.log.slice(0, 8).map((item) => {
        const time = new Date(item.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `<li class="${esc(item.kind)}"><time>${time}</time>${esc(item.text)}</li>`;
      }).join('')
      : '<li class="empty">Здесь появятся споры за еду и маяк: кто победил и по какому правилу.</li>';
  }

  function renderFeed() {
    $('feed').innerHTML = state.feed.map((text) => `<p>${esc(text)}</p>`).join('');
  }

  function updateNet(hud) {
    document.body.dataset.net = hud.state;
    const names = {
      online: 'на связи',
      connecting: 'подключение',
      reconnecting: 'переподключение',
      offline: 'нет сети'
    };
    const label = names[hud.state] || hud.state;
    $('net-label').textContent = state.mode === 'menu' ? label : `${label} · ${state.online || 0}`;
    $('net-rtt').textContent = hud.rtt == null ? '' : `${hud.rtt} мс`;
    $('menu-net').textContent = hud.state === 'online'
      ? `Сервер на связи${hud.rtt == null ? '' : ` · ${hud.rtt} мс`}`
      : hud.state === 'offline'
        ? 'Нет сети. Ник, цвет и очередь команд сохранены в браузере.'
        : 'Сервер бесплатного хостинга просыпается. Подождите около минуты и не закрывайте вкладку.';
    const wait = hud.nextTryAt ? Math.max(0, (hud.nextTryAt - Date.now()) / 1000) : 0;
    const self = hud.lastSelf;
    $('reconnect-title').textContent = hud.state === 'offline'
      ? 'Браузер офлайн'
      : 'Сервер просыпается';
    $('reconnect-detail').textContent = [
      `Попытка ${Math.max(1, hud.attempt)}. Следующая через ${wait.toFixed(1)} с.`,
      `Ник «${hud.nick || '—'}» и цвет сохранены локально.`,
      `Неотправленных команд: ${hud.buffered}.`,
      self ? `Последние данные: масса ${Math.round(self.mass)}, длина ${self.length}, еда ${self.food}.` : 'Локальная копия сессии ждёт сервер.',
      `Сервер держит змейку ${Math.round((state.graceMs || 25000) / 1000)} с, затем сбрасывает её.`
    ].join('\n');
  }

  function updateStats() {
    const you = state.you;
    const playing = state.mode !== 'menu' && you;
    $('stat-length').textContent = playing ? String(you.length || 0) : '0';
    $('stat-mass').textContent = playing ? String(Math.round(you.mass || 0)) : '0';
    $('stat-food').textContent = playing ? String(you.foodEaten || 0) : '0';
    $('stat-wins').textContent = playing ? String(you.wins || 0) : '0';
    $('stat-rank').textContent = playing && you.rank ? `${you.rank}/${you.total}` : '—';
  }

  function updateHint(snakes) {
    const hint = $('hint');
    if (state.mode !== 'play' || !state.you || !state.you.alive) {
      hint.textContent = '';
      return;
    }
    const me = snakes.find((snake) => snake.id === state.selfId);
    const beacon = state.beacon;
    if (!me || !beacon) {
      hint.textContent = '';
      return;
    }
    const dist = Math.hypot(me.x - beacon.x, me.y - beacon.y);
    const owner = beacon.ownerName ? `владелец ${beacon.ownerName}` : 'свободен';
    hint.textContent = dist <= state.beaconRange
      ? `Маяк v${beacon.version} · ${owner} · нажмите B`
      : `Маяк v${beacon.version} · ${owner} · ${Math.round(dist)} px`;
  }

  function updateCamera(snakes, dt, now) {
    const me = snakes.find((snake) => snake.id === state.selfId);
    let tx = state.cam.x;
    let ty = state.cam.y;
    let targetZoom = 0.92;
    if (me && (state.mode === 'play' || state.mode === 'dead')) {
      tx = me.x;
      ty = me.y;
      state.lastCam = { x: me.x, y: me.y };
      targetZoom = Math.max(0.58, 1.04 - Math.max(0, (me.length || 14) - 14) * 0.0038);
    } else if ((state.mode === 'dead' || state.mode === 'play') && state.lastCam) {
      tx = state.lastCam.x;
      ty = state.lastCam.y;
    } else {
      const t = now / 1000;
      tx = Math.cos(t * 0.13) * 480;
      ty = Math.sin(t * 0.11) * 360;
    }
    const follow = 1 - Math.exp(-dt * 6);
    state.cam.x += (tx - state.cam.x) * follow;
    state.cam.y += (ty - state.cam.y) * follow;
    state.cam.zoom += (targetZoom - state.cam.zoom) * (1 - Math.exp(-dt * 3));
  }

  function updateParticles(dt) {
    const next = [];
    for (const particle of state.particles) {
      particle.life -= dt;
      if (particle.life <= 0) continue;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      next.push(particle);
    }
    state.particles = next;
  }

  function aimFromClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    if (x * x + y * y < 36) return;
    state.aim = Math.atan2(y, x);
  }

  function claimBeacon(stale) {
    if (state.mode !== 'play' || !state.you || !state.you.alive) return;
    const version = stale ? (state.beacon.version || 1) - 1 : (state.beacon.version || 1);
    net.command({ type: 'beacon', version });
  }

  function maybeSendInput(now) {
    if (state.mode !== 'play' || !state.you || !state.you.alive) return;
    const boost = !!(state.boosts.mouse || state.boosts.space || state.boosts.button);
    if (now - lastSentAt < 50 && lastSentBoost === boost && lastSentAim != null && Math.abs(state.aim - lastSentAim) < 0.012) return;
    lastSentAt = now;
    lastSentAim = state.aim;
    lastSentBoost = boost;
    net.command({ type: 'input', angle: Math.round(state.aim * 1000) / 1000, boost });
  }

  function play() {
    const nick = $('nick').value.trim();
    if (nick.length < 2 || nick.length > 16) {
      $('menu-error').textContent = 'Ник должен быть от 2 до 16 символов.';
      return;
    }
    $('menu-error').textContent = '';
    state.nick = nick;
    ensureAudio();
    net.play(nick, state.color);
    setMode('play');
  }

  function buildColors() {
    const box = $('colors');
    S.SNAKE_COLORS.forEach((color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = color;
      button.setAttribute('aria-label', color);
      if (color.toLowerCase() === String(state.color).toLowerCase()) button.classList.add('on');
      button.addEventListener('click', () => {
        state.color = color;
        [...box.children].forEach((el) => el.classList.remove('on'));
        button.classList.add('on');
      });
      box.appendChild(button);
    });
  }

  function syncTabs() {
    $('tab-live').classList.toggle('on', state.boardTab === 'live');
    $('tab-records').classList.toggle('on', state.boardTab === 'records');
  }

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    play();
  });
  $('respawn-btn').addEventListener('click', () => {
    ensureAudio();
    net.respawn();
  });
  $('reconnect-now').addEventListener('click', () => net.reconnectNow());
  $('stale-btn').addEventListener('click', () => claimBeacon(true));
  $('tab-live').addEventListener('click', () => {
    state.boardTab = 'live';
    state.boardKey = '';
    syncTabs();
    renderBoard();
  });
  $('tab-records').addEventListener('click', () => {
    state.boardTab = 'records';
    state.boardKey = '';
    syncTabs();
    renderBoard();
  });

  const boostBtn = $('boost');
  boostBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    state.boosts.button = true;
    if (boostBtn.setPointerCapture) boostBtn.setPointerCapture(event.pointerId);
  });
  boostBtn.addEventListener('pointerup', () => { state.boosts.button = false; });
  boostBtn.addEventListener('pointercancel', () => { state.boosts.button = false; });

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'play') return;
    aimFromClient(event.clientX, event.clientY);
    state.aimMode = 'mouse';
    if (event.pointerType === 'mouse' && event.button === 0) state.boosts.mouse = true;
    ensureAudio();
  });
  window.addEventListener('pointermove', (event) => {
    if (state.mode !== 'play') return;
    const target = event.target;
    if (target && target.closest && target.closest('.panel, #death .card, #reconnect .card, #boost')) return;
    aimFromClient(event.clientX, event.clientY);
    state.aimMode = 'mouse';
  });
  window.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') state.boosts.mouse = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
    if (typing) return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.code === 'KeyA' || event.code === 'KeyD') {
      state.aimMode = 'keys';
      state.keys.add(event.code);
      event.preventDefault();
    }
    if (event.code === 'Space' && state.mode === 'play') {
      state.boosts.space = true;
      event.preventDefault();
    }
    if (event.code === 'KeyB') claimBeacon(false);
  });
  window.addEventListener('keyup', (event) => {
    state.keys.delete(event.code);
    if (event.code === 'Space') state.boosts.space = false;
  });
  window.addEventListener('blur', () => {
    state.keys.clear();
    state.boosts.mouse = false;
    state.boosts.space = false;
    state.boosts.button = false;
  });

  const hud0 = net.hud();
  state.nick = hud0.nick || '';
  state.color = S.SNAKE_COLORS.includes(hud0.color) ? hud0.color : S.SNAKE_COLORS[0];
  $('nick').value = state.nick;
  if (hud0.playing) setMode('play');
  else setMode('menu');
  buildColors();
  renderMenuRecords();
  renderLog();
  updateNet(hud0);

  fetch('/api/leaderboard')
    .then((res) => res.json())
    .then((data) => {
      if (!data || !Array.isArray(data.records)) return;
      state.records = data.records;
      if (Number.isFinite(data.conflictsTotal)) state.conflictsTotal = data.conflictsTotal;
      state.menuKey = '';
      state.boardKey = '';
      renderMenuRecords();
      renderBoard();
      renderLog();
    })
    .catch(() => {});

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;
    if (state.aimMode === 'keys') {
      let dir = 0;
      if (state.keys.has('ArrowLeft') || state.keys.has('KeyA')) dir -= 1;
      if (state.keys.has('ArrowRight') || state.keys.has('KeyD')) dir += 1;
      if (dir) state.aim += dir * 3.4 * dt;
    }
    net.pump();
    maybeSendInput(now);
    purgeFoods(now);
    updateParticles(dt);
    const snakes = sampleSnakes(now);
    updateCamera(snakes, dt, now);
    updateStats();
    updateHint(snakes);
    updateNet(net.hud());
    const view = renderer.resize();
    renderer.draw({
      cam: state.cam,
      snakes,
      foods: [...state.foods.values()],
      beacon: state.beacon,
      selfId: state.selfId,
      worldRadius: state.worldRadius,
      beaconRange: state.beaconRange,
      foodPalette: state.foodPalette,
      particles: state.particles,
      time: now
    }, view);
  }
  requestAnimationFrame(frame);
})();
