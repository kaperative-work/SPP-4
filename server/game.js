'use strict';

const { WORLD, SNAKE_COLORS, FOOD_COLORS, FOOD_KIND, segmentCount } = require('../shared/protocol');

function wrap(angle) {
  const t = Math.PI * 2;
  let a = angle % t;
  if (a > Math.PI) a -= t;
  if (a < -Math.PI) a += t;
  return a;
}

function round(value, digits) {
  const m = 10 ** (digits === undefined ? 1 : digits);
  return Math.round(value * m) / m;
}

function clampWorld(x, y, pad) {
  const max = WORLD.RADIUS - (pad || 20);
  const dist = Math.hypot(x, y);
  if (dist <= max || dist < 1e-6) return { x, y };
  const k = max / dist;
  return { x: x * k, y: y * k };
}

function sanitizeNick(value) {
  if (typeof value !== 'string') return null;
  const nick = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
  if (nick.length < 2 || nick.length > 16) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(nick)) return null;
  return nick;
}

function sanitizeColor(value) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return SNAKE_COLORS[0];
}

function sanitizeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return null;
  return id;
}

function colorIndex(hex) {
  let hash = 0;
  const text = String(hex || '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % FOOD_COLORS.length;
}

class HashGrid {
  constructor(cell) {
    this.cell = cell;
    this.buckets = new Map();
  }

  add(x, y, value) {
    const ix = Math.floor(x / this.cell);
    const iy = Math.floor(y / this.cell);
    const key = `${ix},${iy}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, bucket = []);
    bucket.push(value);
  }

  query(x, y, radius) {
    const cell = this.cell;
    const x0 = Math.floor((x - radius) / cell);
    const x1 = Math.floor((x + radius) / cell);
    const y0 = Math.floor((y - radius) / cell);
    const y1 = Math.floor((y + radius) / cell);
    const out = [];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const bucket = this.buckets.get(`${ix},${iy}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}

class Game {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks || {};
    this.sessions = new Map();
    this.snakes = new Map();
    this.foods = new Map();
    this.events = [];
    this.eventSeq = 0;
    this.foodSeq = 1;
    this.tickN = 0;
    this.joinSeq = 0;
    this.serverSeq = 0;
    this.nextNum = 1;
    this.foodTarget = WORLD.FOOD_TARGET;
    this.orbitSpeed = WORLD.BEACON_SPEED;
    this.orbitRadius = WORLD.BEACON_ORBIT;
    this.goldCooldown = 10;
    this.beaconClaims = [];
    this.deltaAdd = [];
    this.deltaRemove = [];
    this.beacon = {
      x: WORLD.BEACON_ORBIT,
      y: 0,
      angle: 0,
      version: 1,
      ownerId: null,
      ownerName: null
    };
    this.fillFood();
  }

  fillFood() {
    let guard = 0;
    while (this.foods.size < this.foodTarget && guard < this.foodTarget + 8) {
      this.spawnNatural();
      guard++;
    }
  }

  randomPoint(scale) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * WORLD.RADIUS * (scale || 0.92);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  randomPointAway(minDist, scale) {
    for (let i = 0; i < 24; i++) {
      const point = this.randomPoint(scale || 0.86);
      let ok = true;
      for (const snake of this.snakes.values()) {
        if (Math.hypot(snake.x - point.x, snake.y - point.y) < minDist) {
          ok = false;
          break;
        }
      }
      if (ok) return point;
    }
    return this.randomPoint(scale || 0.86);
  }

  spawnFood(x, y, value, color, kind) {
    const spot = clampWorld(x, y, 18);
    const food = {
      id: this.foodSeq++,
      x: spot.x,
      y: spot.y,
      value,
      color,
      kind: kind || 'normal',
      version: 1,
      ignoreId: null,
      ignoreUntil: 0,
      bornTick: this.tickN,
      claimed: false
    };
    this.foods.set(food.id, food);
    this.deltaAdd.push(food);
    return food;
  }

  spawnNatural() {
    const point = this.randomPoint(0.94);
    const value = 1 + Math.floor(Math.random() * 3);
    this.spawnFood(point.x, point.y, value, Math.floor(Math.random() * FOOD_COLORS.length), 'normal');
  }

  removeFood(id) {
    if (!this.foods.has(id)) return;
    this.foods.delete(id);
    const fresh = this.deltaAdd.findIndex((food) => food.id === id);
    if (fresh >= 0) this.deltaAdd.splice(fresh, 1);
    else this.deltaRemove.push(id);
  }

  makeRoom(count) {
    let guard = 0;
    while (this.foods.size + count > WORLD.MAX_FOOD && guard < 600) {
      let oldest = null;
      for (const food of this.foods.values()) {
        if (food.kind !== 'normal') continue;
        if (!oldest || food.id < oldest.id) oldest = food;
      }
      if (!oldest) break;
      this.removeFood(oldest.id);
      guard++;
    }
  }

  pushEvent(partial) {
    const event = Object.assign({ id: ++this.eventSeq, t: Date.now() }, partial);
    this.events.push(event);
    if (this.events.length > 160) this.events.splice(0, this.events.length - 160);
    return event;
  }

  pushInbox(session, partial) {
    if (!session) return null;
    const event = Object.assign({ id: ++this.eventSeq, t: Date.now() }, partial);
    session.inbox.push(event);
    return event;
  }

  emitConflict(partial) {
    const total = this.store.bumpConflict();
    const event = this.pushEvent(Object.assign({ kind: 'conflict', conflictsTotal: total }, partial));
    console.log(`[conflict] ${event.text}`);
    return event;
  }

  clearDeltas() {
    this.deltaAdd = [];
    this.deltaRemove = [];
  }

  onlineCount() {
    let count = 0;
    for (const session of this.sessions.values()) if (session.connected) count++;
    return count;
  }

  join(input) {
    const sessionId = sanitizeId(input.sessionId);
    const nick = sanitizeNick(input.nick);
    const color = sanitizeColor(input.color);
    if (!sessionId) return { ok: false, error: 'Некорректный идентификатор сессии.' };
    if (!nick) return { ok: false, error: 'Ник: 2–16 символов, буквы, цифры, пробел, «_», «-» или точка.' };

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = 0;
      existing.nick = nick;
      existing.color = color;
      if (existing.snake && existing.snake.alive) {
        existing.snake.frozen = false;
        existing.snake.connected = true;
        existing.snake.name = nick;
        existing.snake.color = color;
        return { ok: true, resumed: true, sessionId };
      }
      this.spawnSnake(existing);
      console.log(`[join] ${nick} возвращается в арену`);
      return { ok: true, respawned: true, sessionId };
    }

    if (this.sessions.size >= WORLD.MAX_PLAYERS) {
      return { ok: false, error: 'Арена заполнена. Подождите, пока освободится место.' };
    }

    const session = {
      id: sessionId,
      num: this.nextNum++,
      nick,
      color,
      connected: true,
      disconnectedAt: 0,
      lastCmdSeq: 0,
      snake: null,
      inbox: []
    };
    this.sessions.set(sessionId, session);
    this.spawnSnake(session);
    console.log(`[join] ${nick} (#${session.num})`);
    return { ok: true, sessionId };
  }

  resume(input) {
    const sessionId = sanitizeId(input.sessionId);
    if (!sessionId) return { ok: false, error: 'Некорректный идентификатор сессии.' };
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        error: 'Сессия на сервере не найдена. Она могла истечь после обрыва связи. Войдите снова — рекорды сохранены.'
      };
    }
    const nick = sanitizeNick(input.nick) || session.nick;
    const color = sanitizeColor(input.color || session.color);
    session.connected = true;
    session.disconnectedAt = 0;
    session.nick = nick;
    session.color = color;
    if (session.snake) {
      session.snake.name = nick;
      session.snake.color = color;
      session.snake.connected = true;
      if (session.snake.alive) session.snake.frozen = false;
    }
    const applied = this.applyPending(session, input.pending);
    this.pushInbox(session, {
      kind: 'notice',
      text: `Сессия восстановлена. Повторно принято команд: ${applied}.`
    });
    console.log(`[resume] ${nick}, команд ${applied}`);
    return { ok: true, applied, sessionId };
  }

  respawn(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Сессия не найдена.' };
    if (session.snake && session.snake.alive) return { ok: true, already: true };
    session.connected = true;
    session.disconnectedAt = 0;
    this.spawnSnake(session);
    return { ok: true };
  }

  applyPending(session, pending) {
    if (!Array.isArray(pending)) return 0;
    const items = pending.slice(0, 40).filter((item) => item && typeof item === 'object');
    items.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    let applied = 0;
    for (const item of items) {
      const before = session.lastCmdSeq;
      if (item.type === 'beacon') this.queueBeacon(session.id, item);
      else this.input(session.id, item);
      if (session.lastCmdSeq !== before) applied++;
    }
    return applied;
  }

  acceptSeq(session, msg) {
    const seq = Number(msg && msg.seq);
    if (!Number.isFinite(seq)) return true;
    if (seq <= session.lastCmdSeq) return false;
    session.lastCmdSeq = seq;
    return true;
  }

  input(sessionId, msg) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!this.acceptSeq(session, msg)) return;
    const snake = session.snake;
    if (!snake || !snake.alive) return;
    if (Number.isFinite(msg.angle) && Math.abs(msg.angle) < 100) snake.targetAngle = wrap(msg.angle);
    if (msg.boost === true || msg.boost === false) snake.boost = msg.boost;
  }

  queueBeacon(sessionId, msg) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!this.acceptSeq(session, msg)) return;
    const snake = session.snake;
    if (!snake || !snake.alive || snake.frozen) return;
    const version = Number(msg.version);
    if (!Number.isInteger(version)) return;
    this.beaconClaims.push({
      sessionId,
      version,
      serverSeq: ++this.serverSeq,
      receivedAt: Date.now()
    });
  }

  markDisconnected(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.connected) return;
    session.connected = false;
    session.disconnectedAt = Date.now();
    if (session.snake && session.snake.alive) {
      session.snake.connected = false;
      session.snake.frozen = true;
      session.snake.boost = false;
      session.snake.boosting = false;
      this.flush(session.snake);
    }
    console.log(`[disconnect] ${session.nick}, пауза ${WORLD.GRACE_MS / 1000} с`);
  }

  spawnSnake(session) {
    const spot = this.randomSpawn();
    const snake = {
      id: session.id,
      num: session.num,
      name: session.nick,
      color: session.color,
      x: spot.x,
      y: spot.y,
      angle: spot.angle,
      targetAngle: spot.angle,
      boost: false,
      boosting: false,
      mass: WORLD.START_MASS,
      alive: true,
      frozen: false,
      connected: true,
      points: [],
      foodEaten: 0,
      kills: 0,
      maxLength: 0,
      spawnedAt: Date.now(),
      endedAt: 0,
      accountedFood: 0,
      accountedKills: 0,
      accountedPlay: 0,
      dropAcc: 0,
      finalFlushed: false,
      deathInfo: null,
      joinSeq: ++this.joinSeq
    };
    this.buildBody(snake);
    snake.maxLength = snake.points.length;
    session.snake = snake;
    session.connected = true;
    this.snakes.set(snake.id, snake);
    this.flush(snake, { newGame: true });
    return snake;
  }

  randomSpawn() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const point = this.randomPoint(0.48);
      const inward = Math.atan2(-point.y, -point.x);
      const angle = inward + (Math.random() - 0.5) * 1.1;
      let ok = true;
      for (const snake of this.snakes.values()) {
        if (!snake.alive) continue;
        if (Math.hypot(snake.x - point.x, snake.y - point.y) < 190) {
          ok = false;
          break;
        }
      }
      if (ok) return { x: point.x, y: point.y, angle };
    }
    return { x: 0, y: 0, angle: Math.random() * Math.PI * 2 };
  }

  buildBody(snake) {
    const count = segmentCount(snake.mass);
    snake.points = [];
    for (let i = 0; i < count; i++) {
      snake.points.push({
        x: snake.x - Math.cos(snake.angle) * WORLD.SEGMENT_SPACING * i,
        y: snake.y - Math.sin(snake.angle) * WORLD.SEGMENT_SPACING * i
      });
    }
  }

  flush(snake, extra) {
    if (!snake || snake.finalFlushed) return;
    const flags = extra || {};
    if (flags.died) snake.endedAt = Date.now();
    const end = snake.endedAt || Date.now();
    const play = Math.max(0, end - snake.spawnedAt);
    const foodDelta = snake.foodEaten - snake.accountedFood;
    const killDelta = snake.kills - snake.accountedKills;
    const playDelta = Math.max(0, play - snake.accountedPlay);
    try {
      this.store.update(snake.name, {
        length: snake.maxLength,
        mass: snake.mass,
        foodDelta,
        killDelta,
        playDelta,
        survivalSample: play,
        died: !!flags.died,
        newGame: !!flags.newGame
      });
    } catch (err) {
      console.error('Ошибка сохранения профиля:', err.message);
      return;
    }
    snake.accountedFood = snake.foodEaten;
    snake.accountedKills = snake.kills;
    snake.accountedPlay = play;
    if (flags.died) snake.finalFlushed = true;
  }

  tick(dt) {
    this.tickN++;
    const now = Date.now();
    this.expireSessions(now);
    this.updateBeacon(dt);
    for (const snake of this.snakes.values()) {
      if (!snake.alive || snake.frozen) continue;
      this.moveSnake(snake, dt);
    }
    this.handleFood();
    this.handleCollisions();
    this.resolveBeacon();
    this.maintainFood();
    this.maybeGold(dt);
    if (this.tickN % 100 === 0) {
      for (const snake of this.snakes.values()) this.flush(snake);
    }
  }

  expireSessions(now) {
    const stale = [];
    for (const session of this.sessions.values()) {
      if (!session.connected && session.disconnectedAt && now - session.disconnectedAt > WORLD.GRACE_MS) {
        stale.push(session);
      }
    }
    for (const session of stale) this.destroySession(session);
  }

  destroySession(session) {
    if (session.snake && session.snake.alive) {
      this.kill(session.snake, {
        reason: 'timeout',
        killerId: null,
        killerName: null,
        text: `«${session.nick}» не вернулся за ${WORLD.GRACE_MS / 1000} с — змейка сброшена.`
      });
    }
    this.sessions.delete(session.id);
    if (this.hooks.onSessionEnd) this.hooks.onSessionEnd(session.id);
    console.log(`[timeout] ${session.nick}`);
  }

  updateBeacon(dt) {
    this.beacon.angle += dt * this.orbitSpeed;
    this.beacon.x = Math.cos(this.beacon.angle) * this.orbitRadius;
    this.beacon.y = Math.sin(this.beacon.angle) * this.orbitRadius;
  }

  moveSnake(snake, dt) {
    let diff = wrap(snake.targetAngle - snake.angle);
    const maxTurn = WORLD.TURN_RATE * dt;
    if (diff > maxTurn) diff = maxTurn;
    else if (diff < -maxTurn) diff = -maxTurn;
    snake.angle = wrap(snake.angle + diff);

    const canBoost = !!(snake.boost && snake.mass > WORLD.MIN_BOOST_MASS);
    snake.boosting = canBoost;
    const speed = canBoost ? WORLD.BOOST_SPEED : WORLD.BASE_SPEED;
    snake.x += Math.cos(snake.angle) * speed * dt;
    snake.y += Math.sin(snake.angle) * speed * dt;

    if (!snake.points.length) this.buildBody(snake);
    snake.points[0].x = snake.x;
    snake.points[0].y = snake.y;
    const spacing = WORLD.SEGMENT_SPACING;
    for (let i = 1; i < snake.points.length; i++) {
      const prev = snake.points[i - 1];
      const cur = snake.points[i];
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-4) {
        const back = i >= 2
          ? Math.atan2(prev.y - snake.points[i - 2].y, prev.x - snake.points[i - 2].x)
          : snake.angle;
        cur.x = prev.x - Math.cos(back) * spacing;
        cur.y = prev.y - Math.sin(back) * spacing;
        continue;
      }
      cur.x = prev.x + (dx / dist) * spacing;
      cur.y = prev.y + (dy / dist) * spacing;
    }

    const target = segmentCount(snake.mass);
    if (snake.points.length < target) {
      const tail = snake.points[snake.points.length - 1];
      snake.points.push({ x: tail.x, y: tail.y });
    } else if (snake.points.length > target) {
      snake.points.pop();
    }
    snake.maxLength = Math.max(snake.maxLength, snake.points.length);

    if (canBoost) {
      const drain = WORLD.BOOST_DRAIN * dt;
      snake.mass = Math.max(WORLD.MIN_BOOST_MASS * 0.65, snake.mass - drain);
      snake.dropAcc += drain;
      const tail = snake.points[snake.points.length - 1];
      while (snake.dropAcc >= 1) {
        snake.dropAcc -= 1;
        const food = this.spawnFood(tail.x, tail.y, 1, colorIndex(snake.color), 'boost');
        food.ignoreId = snake.id;
        food.ignoreUntil = this.tickN + 25;
      }
    }
  }

  // Все претензии на еду собираются до изменения мира.
  // В одном тике сфера достаётся одной змейке: ближе к центру, затем меньший joinSeq, затем id.
  handleFood() {
    const grid = new HashGrid(80);
    for (const food of this.foods.values()) grid.add(food.x, food.y, food);
    const claims = new Map();
    const snakes = [];
    for (const snake of this.snakes.values()) {
      if (snake.alive && !snake.frozen) snakes.push(snake);
    }
    snakes.sort((a, b) => a.joinSeq - b.joinSeq);

    for (const snake of snakes) {
      const near = grid.query(snake.x, snake.y, WORLD.EAT_RADIUS + 24);
      const seen = new Set();
      for (const food of near) {
        if (seen.has(food.id) || food.claimed) continue;
        seen.add(food.id);
        if (food.ignoreId === snake.id && this.tickN < food.ignoreUntil) continue;
        const dist = Math.hypot(food.x - snake.x, food.y - snake.y);
        if (dist > WORLD.EAT_RADIUS) continue;
        let list = claims.get(food.id);
        if (!list) claims.set(food.id, list = []);
        list.push({ snake, dist });
      }
    }

    const ids = [...claims.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const food = this.foods.get(id);
      if (!food || food.claimed) continue;
      const list = claims.get(id);
      list.sort((a, b) =>
        a.dist - b.dist ||
        a.snake.joinSeq - b.snake.joinSeq ||
        (a.snake.id < b.snake.id ? -1 : a.snake.id > b.snake.id ? 1 : 0)
      );
      const winner = list[0].snake;
      const versionBefore = food.version;
      food.claimed = true;
      food.version += 1;
      winner.mass += food.value;
      winner.foodEaten += 1;
      if (list.length > 1) {
        const losers = list.slice(1).map((item) => `${item.snake.name} (${item.dist.toFixed(1)} px)`).join(', ');
        const label = food.kind === 'gold' ? 'золотая сфера' : 'сфера';
        this.emitConflict({
          subject: 'food',
          resourceId: food.id,
          versionBefore,
          versionAfter: food.version,
          winnerId: winner.id,
          winnerName: winner.name,
          claimants: list.map((item) => ({
            id: item.snake.id,
            name: item.snake.name,
            dist: round(item.dist),
            joinSeq: item.snake.joinSeq
          })),
          rule: 'min-distance, then joinSeq, then playerId',
          text: `${label} #${food.id} v${versionBefore}→v${food.version}: одновременно ${list.length} игрока. Победитель — ${winner.name} (дистанция ${list[0].dist.toFixed(1)} px). Правило: минимальная дистанция, затем порядок входа, затем id. Остальные: ${losers}.`
        });
      }
      this.removeFood(id);
    }
  }

  handleCollisions() {
    const grid = new HashGrid(70);
    const alive = [];
    for (const snake of this.snakes.values()) {
      if (!snake.alive || snake.frozen) continue;
      alive.push(snake);
      for (let i = 0; i < snake.points.length; i++) {
        if (i < WORLD.NECK_SKIP) continue;
        const point = snake.points[i];
        grid.add(point.x, point.y, { snakeId: snake.id, index: i, x: point.x, y: point.y });
      }
      for (let i = 0; i < Math.min(WORLD.NECK_SKIP, snake.points.length); i++) {
        const point = snake.points[i];
        grid.add(point.x, point.y, { snakeId: snake.id, index: i, x: point.x, y: point.y, neck: true });
      }
    }

    const doomed = new Map();
    for (const snake of alive) {
      const dist = Math.hypot(snake.x, snake.y);
      if (dist > WORLD.RADIUS - 10) {
        doomed.set(snake.id, {
          reason: 'wall',
          killerId: null,
          killerName: null,
          text: `«${snake.name}» погибает: граница арены.`
        });
        continue;
      }
      const near = grid.query(snake.x, snake.y, WORLD.HIT_DISTANCE + 8);
      let best = null;
      const seen = new Set();
      for (const point of near) {
        const key = `${point.snakeId}:${point.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (point.snakeId === snake.id && point.index < WORLD.NECK_SKIP) continue;
        const d = Math.hypot(point.x - snake.x, point.y - snake.y);
        if (d > WORLD.HIT_DISTANCE) continue;
        if (!best || d < best.dist || (d === best.dist && point.snakeId < best.snakeId)) {
          best = { dist: d, snakeId: point.snakeId, index: point.index };
        }
      }
      if (!best) continue;
      if (best.snakeId === snake.id) {
        doomed.set(snake.id, {
          reason: 'self',
          killerId: null,
          killerName: null,
          text: `«${snake.name}» столкнулась с собственным телом.`
        });
      } else {
        const other = this.snakes.get(best.snakeId);
        doomed.set(snake.id, {
          reason: 'snake',
          killerId: best.snakeId,
          killerName: other ? other.name : 'змейка',
          text: `«${snake.name}» врезается в «${other ? other.name : 'змейку'}».`
        });
      }
    }

    for (const [id, info] of doomed) {
      if (info.killerId && doomed.has(info.killerId)) {
        info.killerId = null;
        info.killerName = null;
      }
      const snake = this.snakes.get(id);
      if (snake) this.kill(snake, info);
    }
  }

  kill(snake, info) {
    if (!snake || !snake.alive) return;
    snake.alive = false;
    snake.frozen = true;
    snake.boost = false;
    snake.boosting = false;
    const survivalMs = Date.now() - snake.spawnedAt;
    snake.deathInfo = {
      reason: info.reason,
      killerId: info.killerId || null,
      killerName: info.killerName || null,
      length: snake.points.length,
      mass: round(snake.mass),
      foodEaten: round(snake.foodEaten),
      survivalMs,
      text: info.text
    };
    this.dropBody(snake);
    if (info.killerId && info.killerId !== snake.id) {
      const killer = this.snakes.get(info.killerId);
      if (killer && killer.alive) {
        killer.kills += 1;
        this.flush(killer);
      }
    }
    this.flush(snake, { died: true });
    this.snakes.delete(snake.id);
    this.pushEvent({
      kind: 'death',
      victimId: snake.id,
      victimName: snake.name,
      killerId: info.killerId || null,
      killerName: info.killerName || null,
      reason: info.reason,
      text: info.text
    });
    console.log(`[death] ${info.text}`);
  }

  dropBody(snake) {
    const points = snake.points;
    if (!points.length) return;
    const drops = Math.min(28, Math.max(6, Math.floor(points.length / 3)));
    this.makeRoom(drops);
    const budget = Math.max(drops, snake.mass * 0.72);
    const each = Math.max(1, Math.round((budget / drops) * 10) / 10);
    const tint = colorIndex(snake.color);
    for (let i = 0; i < drops; i++) {
      const idx = Math.min(points.length - 1, Math.round((i / Math.max(1, drops - 1)) * (points.length - 1)));
      const point = points[idx];
      this.spawnFood(
        point.x + (Math.random() - 0.5) * 18,
        point.y + (Math.random() - 0.5) * 18,
        each,
        tint,
        'drop'
      );
    }
  }

  // Заявки на маяк, пришедшие за тик, разбираются вместе.
  // Актуальная версия: меньший serverSeq, затем время приёма, затем id.
  // Чужая версия отклоняется и не меняет ресурс (оптимистическая блокировка).
  resolveBeacon() {
    if (!this.beaconClaims.length) return;
    const raw = this.beaconClaims;
    this.beaconClaims = [];
    const byPlayer = new Map();
    for (const claim of raw) {
      if (!byPlayer.has(claim.sessionId)) byPlayer.set(claim.sessionId, claim);
    }

    const versionAtStart = this.beacon.version;
    const current = [];
    const stale = [];
    for (const claim of byPlayer.values()) {
      const session = this.sessions.get(claim.sessionId);
      const snake = session && session.snake;
      if (!session || !snake || !snake.alive || snake.frozen) continue;
      const dist = Math.hypot(snake.x - this.beacon.x, snake.y - this.beacon.y);
      const enriched = {
        sessionId: claim.sessionId,
        version: claim.version,
        serverSeq: claim.serverSeq,
        receivedAt: claim.receivedAt,
        dist,
        name: snake.name,
        session
      };
      if (claim.version !== versionAtStart) {
        stale.push(enriched);
        continue;
      }
      if (dist > WORLD.BEACON_RANGE) {
        this.pushInbox(session, {
          kind: 'notice',
          text: `Маяк слишком далеко (${dist.toFixed(0)} px, нужно ≤ ${WORLD.BEACON_RANGE}).`
        });
        continue;
      }
      current.push(enriched);
    }

    current.sort((a, b) =>
      a.serverSeq - b.serverSeq ||
      a.receivedAt - b.receivedAt ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    );

    if (current.length === 1) {
      this.applyBeaconOwner(current[0]);
      this.pushEvent({
        kind: 'notice',
        text: `Маяк захвачен: ${current[0].name} (v${this.beacon.version}).`
      });
    } else if (current.length > 1) {
      const winner = current[0];
      this.applyBeaconOwner(winner);
      const losers = current.slice(1).map((item) => `${item.name} (serverSeq ${item.serverSeq})`).join(', ');
      this.emitConflict({
        subject: 'beacon',
        resourceId: 'beacon',
        versionBefore: versionAtStart,
        versionAfter: this.beacon.version,
        winnerId: winner.sessionId,
        winnerName: winner.name,
        claimants: current.map((item) => ({
          id: item.sessionId,
          name: item.name,
          serverSeq: item.serverSeq,
          receivedAt: item.receivedAt,
          dist: Math.round(item.dist)
        })),
        rule: 'same-version: lowest serverSeq, then server timestamp, then playerId',
        text: `Маяк v${versionAtStart}→v${this.beacon.version}: одновременные заявки (${current.length}) с одной версией. Победитель — ${winner.name} (serverSeq ${winner.serverSeq}). Правило: меньший serverSeq, затем более раннее серверное время, затем id. Отклонены: ${losers}.`
      });
    }

    for (const claim of stale) {
      this.emitConflict({
        subject: 'beacon',
        resourceId: 'beacon',
        versionBefore: versionAtStart,
        versionAfter: this.beacon.version,
        winnerId: this.beacon.ownerId,
        winnerName: this.beacon.ownerName,
        claimants: [{
          id: claim.sessionId,
          name: claim.name,
          version: claim.version,
          serverSeq: claim.serverSeq
        }],
        rule: 'optimistic lock: client version must equal resource version',
        text: `Маяк v${versionAtStart}: конфликт версий. «${claim.name}» прислал версию ${claim.version}. Правило: запись применяется только если версия клиента равна серверной. Эта заявка отклонена.`
      });
    }
  }

  applyBeaconOwner(claim) {
    this.beacon.ownerId = claim.sessionId;
    this.beacon.ownerName = claim.name;
    this.beacon.version += 1;
  }

  maintainFood() {
    let guard = 0;
    while (this.foods.size < this.foodTarget && guard < 3) {
      this.spawnNatural();
      guard++;
    }
  }

  maybeGold(dt) {
    this.goldCooldown -= dt;
    if (this.goldCooldown > 0) return;
    this.goldCooldown = 22;
    for (const food of this.foods.values()) {
      if (food.kind === 'gold') return;
    }
    const point = this.randomPointAway(260, 0.8);
    const food = this.spawnFood(point.x, point.y, 9, 1, 'gold');
    this.pushEvent({
      kind: 'notice',
      text: `Золотая сфера #${food.id} появилась. В одном тике её заберёт только ближайшая змейка.`
    });
  }

  packPoints(points) {
    const cap = WORLD.VIEW_POINT_CAP;
    const count = points.length;
    if (!count) return [];
    if (count <= cap) {
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = [round(points[i].x), round(points[i].y)];
      return out;
    }
    const out = new Array(cap);
    const last = count - 1;
    for (let i = 0; i < cap; i++) {
      const idx = Math.round((i * last) / (cap - 1));
      out[i] = [round(points[idx].x), round(points[idx].y)];
    }
    return out;
  }

  packFood(food) {
    return [
      food.id,
      round(food.x),
      round(food.y),
      round(food.value),
      food.color,
      FOOD_KIND[food.kind] || 0,
      food.version
    ];
  }

  takeEvents(conn, session) {
    if (this.events.length && conn.lastEventId < this.events[0].id - 1) {
      conn.lastEventId = this.events[0].id - 1;
    }
    const out = [];
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].id > conn.lastEventId) out.push(this.events[i]);
    }
    if (session && session.inbox.length) {
      for (const event of session.inbox) out.push(event);
      session.inbox.length = 0;
    }
    if (!out.length) return out;
    out.sort((a, b) => a.id - b.id);
    if (out.length > 30) out.splice(0, out.length - 30);
    conn.lastEventId = out[out.length - 1].id;
    return out;
  }

  snapshot(conn) {
    const session = conn.sessionId ? this.sessions.get(conn.sessionId) : null;
    const snakes = [];
    for (const snake of this.snakes.values()) {
      const x = round(snake.x);
      const y = round(snake.y);
      const points = this.packPoints(snake.points);
      if (points.length) {
        points[0][0] = x;
        points[0][1] = y;
      }
      snakes.push({
        id: snake.id,
        num: snake.num,
        name: snake.name,
        color: snake.color,
        x,
        y,
        angle: round(snake.angle, 3),
        mass: round(snake.mass),
        length: snake.points.length,
        boost: snake.boosting,
        connected: snake.connected,
        points
      });
    }

    const live = snakes
      .slice()
      .sort((a, b) => b.mass - a.mass || b.length - a.length || a.num - b.num);
    let you = null;
    if (session && session.snake) {
      const snake = session.snake;
      const rankIndex = live.findIndex((item) => item.id === snake.id);
      you = {
        id: snake.id,
        num: snake.num,
        name: snake.name,
        color: snake.color,
        alive: snake.alive && this.snakes.has(snake.id),
        mass: round(snake.mass),
        length: snake.alive ? snake.points.length : (snake.deathInfo ? snake.deathInfo.length : snake.points.length),
        foodEaten: round(snake.foodEaten),
        wins: snake.kills,
        boost: snake.boosting,
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        total: live.length,
        death: snake.alive ? null : snake.deathInfo,
        ack: session.lastCmdSeq
      };
    }

    const sendFull = !!(conn.needFood || this.tickN % 8 === 0);
    if (sendFull) conn.needFood = false;
    const message = {
      type: 'state',
      tick: this.tickN,
      serverTime: Date.now(),
      you,
      snakes,
      beacon: {
        x: round(this.beacon.x),
        y: round(this.beacon.y),
        version: this.beacon.version,
        ownerId: this.beacon.ownerId,
        ownerName: this.beacon.ownerName
      },
      live: live.slice(0, 8).map((item) => ({
        id: item.id,
        num: item.num,
        name: item.name,
        color: item.color,
        mass: Math.round(item.mass),
        length: item.length,
        connected: item.connected
      })),
      records: this.store.top(8),
      conflictsTotal: this.store.data.meta.totalConflicts || 0,
      events: this.takeEvents(conn, session),
      online: this.onlineCount()
    };
    if (sendFull) {
      const foods = [];
      for (const food of this.foods.values()) foods.push(this.packFood(food));
      message.foods = foods;
    } else {
      message.foodAdd = this.deltaAdd.map((food) => this.packFood(food));
      message.foodRemove = this.deltaRemove.slice();
    }
    return message;
  }
}

module.exports = { Game, sanitizeNick, sanitizeColor, sanitizeId, SNAKE_COLORS };
