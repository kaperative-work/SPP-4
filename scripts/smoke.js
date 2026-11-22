'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { Game } = require('../server/game');
const { Store } = require('../server/persistence');
const { createApp } = require('../server/index');
const { WORLD } = require('../shared/protocol');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), 4000);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (fn()) return;
    await delay(20);
  }
  throw new Error(`timeout: ${label}`);
}

function fresh() {
  const file = path.join(os.tmpdir(), `slither-${crypto.randomUUID()}.json`);
  const store = new Store(file);
  const game = new Game(store);
  return { file, store, game };
}

function place(game, sessionId, x, y, angle) {
  const snake = game.sessions.get(sessionId).snake;
  snake.x = x;
  snake.y = y;
  snake.angle = angle;
  snake.targetAngle = angle;
  snake.alive = true;
  snake.frozen = false;
  snake.connected = true;
  snake.boost = false;
  snake.boosting = false;
  snake.points = [];
  for (let i = 0; i < 16; i++) {
    snake.points.push({
      x: x - Math.cos(angle) * WORLD.SEGMENT_SPACING * i,
      y: y - Math.sin(angle) * WORLD.SEGMENT_SPACING * i
    });
  }
  snake.maxLength = Math.max(snake.maxLength, snake.points.length);
  game.snakes.set(snake.id, snake);
  return snake;
}

function quiet(game) {
  game.foods.clear();
  game.foodTarget = 0;
  game.goldCooldown = 100000;
  game.deltaAdd = [];
  game.deltaRemove = [];
}

function logic() {
  const survival = fresh();
  const sid = crypto.randomUUID();
  assert(survival.game.join({ sessionId: sid, nick: 'Solo', color: '#3ee0b0' }).ok, 'join solo');
  for (let i = 0; i < 60; i++) survival.game.tick(1 / 20);
  const survived = survival.game.snakes.get(sid);
  assert(survived && survived.alive, `snake died during cruise: ${survival.game.sessions.get(sid).snake.deathInfo && survival.game.sessions.get(sid).snake.deathInfo.text}`);
  console.log('ok survival');

  const { file, store, game } = fresh();
  quiet(game);
  const anna = crypto.randomUUID();
  const oleg = crypto.randomUUID();
  assert(game.join({ sessionId: anna, nick: 'Anna', color: '#3ee0b0' }).ok, 'join anna');
  assert(game.join({ sessionId: oleg, nick: 'Oleg', color: '#4cc9f0' }).ok, 'join oleg');
  const a = place(game, anna, -18, 0, 0);
  const b = place(game, oleg, 0, 26, -Math.PI / 2);
  const startA = a.mass;
  const startB = b.mass;
  game.spawnFood(0, 0, 5, 0, 'normal');
  game.tick(1 / 20);
  assert(a.alive && b.alive, `food claimants died: ${a.deathInfo && a.deathInfo.text} | ${b.deathInfo && b.deathInfo.text}`);
  assert(game.foods.size === 0, `food left ${game.foods.size}`);
  assert(a.mass === startA + 5, `winner mass ${a.mass}`);
  assert(b.mass === startB, `loser mass ${b.mass}`);
  const foodConflict = game.events.find((event) => event.kind === 'conflict' && event.subject === 'food');
  assert(foodConflict, 'food conflict missing');
  assert(foodConflict.winnerId === anna, 'closer snake should win');
  assert(foodConflict.claimants.length === 2, 'two claimants');
  assert(foodConflict.versionBefore === 1 && foodConflict.versionAfter === 2, 'food version bump');
  console.log('ok food conflict');

  game.orbitRadius = 0;
  game.orbitSpeed = 0;
  place(game, anna, 0, 60, 0);
  place(game, oleg, 0, -60, 0);
  const version = game.beacon.version;
  game.queueBeacon(anna, { type: 'beacon', seq: 1, version });
  game.queueBeacon(oleg, { type: 'beacon', seq: 1, version });
  game.tick(1 / 20);
  assert(game.beacon.ownerId === anna, `beacon owner ${game.beacon.ownerName}`);
  assert(game.beacon.version === version + 1, 'beacon version');
  const race = game.events.find((event) => event.subject === 'beacon' && event.rule && event.rule.startsWith('same-version'));
  assert(race && race.winnerId === anna, 'beacon race');
  console.log('ok beacon race');

  game.queueBeacon(oleg, { type: 'beacon', seq: 2, version });
  game.tick(1 / 20);
  const stale = [...game.events].reverse().find((event) => event.rule && event.rule.startsWith('optimistic'));
  assert(stale, 'stale beacon conflict');
  assert(game.beacon.version === version + 1, 'stale write must not bump version');
  assert(game.beacon.ownerId === anna, 'owner stays');
  console.log('ok stale version');

  place(game, anna, WORLD.RADIUS + 80, 0, 0);
  game.tick(1 / 20);
  const dead = game.sessions.get(anna).snake;
  assert(!dead.alive && dead.deathInfo && dead.deathInfo.reason === 'wall', 'wall death');
  store.save();
  const reloaded = new Store(file);
  const row = reloaded.top(10).find((item) => item.nickname === 'Anna');
  assert(row && row.deaths >= 1, 'deaths persisted');
  assert(row.maxLength >= 6, 'length persisted');
  assert(row.foodEaten >= 1, `food persisted ${row.foodEaten}`);
  assert((reloaded.data.meta.totalConflicts || 0) >= 3, `conflicts persisted ${reloaded.data.meta.totalConflicts}`);
  console.log('ok persistence');

  const karl = crypto.randomUUID();
  assert(game.join({ sessionId: karl, nick: 'Karl', color: '#ffd60a' }).ok, 'join karl');
  const snake = game.sessions.get(karl).snake;
  snake.mass = 41;
  game.markDisconnected(karl);
  assert(snake.frozen === true && snake.connected === false, 'frozen while disconnected');
  const resumed = game.resume({
    sessionId: karl,
    nick: 'Karl',
    color: '#ffd60a',
    pending: [{ type: 'input', seq: 5, angle: 1.25, boost: true }]
  });
  assert(resumed.ok && resumed.applied === 1, `resume applied ${resumed.applied}`);
  assert(snake.frozen === false && snake.connected === true, 'unfrozen');
  assert(Math.abs(snake.targetAngle - 1.25) < 1e-6, 'replayed angle');
  assert(snake.boost === true, 'replayed boost');
  assert(snake.mass === 41, 'mass kept across resume');
  const again = game.join({ sessionId: karl, nick: 'Karl', color: '#ffd60a' });
  assert(again.ok && again.resumed, 'second join resumes');
  assert(game.sessions.get(karl).snake.mass === 41, 'join must not reset mass');
  const missing = game.resume({
    sessionId: crypto.randomUUID(),
    nick: 'Nope',
    color: '#ffffff',
    pending: []
  });
  assert(!missing.ok, 'unknown session');
  console.log('ok resume');
}

async function integration() {
  const file = path.join(os.tmpdir(), `slither-http-${crypto.randomUUID()}.json`);
  const app = createApp({ dataFile: file });
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert(health.ok, 'health');
    const board = await fetch(`http://127.0.0.1:${port}/api/leaderboard`);
    const boardJson = await board.json();
    assert(Array.isArray(boardJson.records), 'leaderboard');

    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    ws.on('message', (buf) => messages.push(JSON.parse(buf.toString())));
    await once(ws, 'open');
    await waitFor(() => messages.some((msg) => msg.type === 'hello'), 'hello');
    ws.send(JSON.stringify({ type: 'join', sessionId, nick: 'Http', color: '#3ee0b0' }));
    await waitFor(() => messages.some((msg) => msg.type === 'state' && msg.you && msg.you.alive), 'joined');
    ws.close();
    await once(ws, 'close');
    await delay(80);

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages2 = [];
    ws2.on('message', (buf) => messages2.push(JSON.parse(buf.toString())));
    await once(ws2, 'open');
    ws2.send(JSON.stringify({
      type: 'resume',
      sessionId,
      nick: 'Http',
      color: '#3ee0b0',
      pending: [{ type: 'input', seq: 1, angle: 0.4, boost: false }]
    }));
    await waitFor(() => messages2.some((msg) => msg.type === 'state' && msg.you && msg.you.alive && msg.you.id === sessionId), 'resumed');
    const events = messages2.flatMap((msg) => msg.events || []);
    assert(events.some((event) => /восстановлена/i.test(event.text || '')), 'resume notice');
    ws2.close();
    const saved = await fetch(`http://127.0.0.1:${port}/api/leaderboard`).then((res) => res.json());
    assert(saved.records.some((row) => row.nickname === 'Http'), 'http player stored');
    console.log('ok websocket');
  } finally {
    app.close();
  }
}

async function main() {
  const killer = setTimeout(() => {
    console.error('smoke timeout');
    process.exit(1);
  }, 12000);
  try {
    logic();
    await integration();
    clearTimeout(killer);
    console.log('smoke ok');
    process.exit(0);
  } catch (err) {
    clearTimeout(killer);
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
