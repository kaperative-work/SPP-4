'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const { Store } = require('./persistence');
const { WORLD, SNAKE_COLORS, FOOD_COLORS, MSG } = require('../shared/protocol');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SHARED_DIR = path.resolve(__dirname, '..', 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function resolveInside(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^[/\\]+/, '');
  const full = path.resolve(root, rel);
  const diff = path.relative(root, full);
  if (diff.startsWith('..') || path.isAbsolute(diff)) return null;
  return full;
}

function helloPayload(store) {
  return {
    type: MSG.HELLO,
    constants: {
      worldRadius: WORLD.RADIUS,
      tickRate: WORLD.TICK_RATE,
      beaconRange: WORLD.BEACON_RANGE,
      eatRadius: WORLD.EAT_RADIUS,
      graceMs: WORLD.GRACE_MS,
      palette: SNAKE_COLORS,
      foodPalette: FOOD_COLORS
    },
    records: store.top(10),
    conflictsTotal: store.data.meta.totalConflicts || 0,
    serverTime: Date.now()
  };
}

function handleHttp(req, res, store, game, connections) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method' });
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }
  if (url.pathname === '/api/leaderboard') {
    sendJson(res, 200, {
      records: store.top(20),
      conflictsTotal: store.data.meta.totalConflicts || 0,
      online: game.onlineCount(),
      viewers: connections.size
    });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const shared = url.pathname.startsWith('/shared/');
  const root = shared ? SHARED_DIR : PUBLIC_DIR;
  const requestPath = shared ? url.pathname.slice('/shared'.length) : url.pathname;
  const normalized = requestPath === '' || requestPath === '/' ? '/index.html' : requestPath;
  let filePath = resolveInside(root, normalized);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad path');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (!statErr && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }).end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    });
  });
}

function createApp(options) {
  const opts = options || {};
  const dataFile = opts.dataFile || path.join(__dirname, '..', 'data', 'leaderboard.json');
  const store = new Store(dataFile);
  const connections = new Set();

  function onSessionEnd(sessionId) {
    for (const conn of connections) {
      if (conn.sessionId !== sessionId) continue;
      conn.sessionId = null;
      send(conn, {
        type: MSG.SESSION_END,
        text: 'Сессия завершена: связь не восстановили вовремя. Рекорды сохранены.'
      });
    }
  }

  const game = new Game(store, { onSessionEnd });
  const server = http.createServer((req, res) => handleHttp(req, res, store, game, connections));
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 65536,
    perMessageDeflate: false
  });

  function send(conn, payload) {
    if (!conn.ws || conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(JSON.stringify(payload));
    } catch {
      /* сокет уже закрывается */
    }
  }

  function publish(conn) {
    const message = game.snapshot(conn);
    message.viewers = connections.size;
    send(conn, message);
  }

  function bindSession(conn, sessionId) {
    for (const other of connections) {
      if (other === conn || other.sessionId !== sessionId) continue;
      other.sessionId = null;
      other.replaced = true;
      send(other, { type: MSG.KICKED, text: 'Сессия открыта в другом подключении.' });
      try { other.ws.close(); } catch { /* ignore */ }
    }
    conn.sessionId = sessionId;
  }

  function allow(conn) {
    const now = Date.now();
    conn.hits = conn.hits.filter((stamp) => now - stamp < 1000);
    if (conn.hits.length > 90) return false;
    conn.hits.push(now);
    return true;
  }

  function onMessage(conn, buf) {
    if (!allow(conn)) return;
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(buf) ? buf.toString() : String(buf));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === MSG.PING) {
      send(conn, { type: MSG.PONG, t: msg.t, serverTime: Date.now() });
      return;
    }
    if (msg.type === MSG.JOIN) {
      const result = game.join(msg);
      if (!result.ok) {
        send(conn, { type: MSG.ERROR, text: result.error });
        return;
      }
      bindSession(conn, result.sessionId);
      conn.needFood = true;
      publish(conn);
      return;
    }
    if (msg.type === MSG.RESUME) {
      const result = game.resume(msg);
      if (!result.ok) {
        send(conn, { type: MSG.RESUME_FAIL, text: result.error });
        return;
      }
      bindSession(conn, result.sessionId);
      conn.needFood = true;
      publish(conn);
      return;
    }
    if (!conn.sessionId) return;
    if (msg.type === MSG.INPUT) game.input(conn.sessionId, msg);
    else if (msg.type === MSG.BEACON) game.queueBeacon(conn.sessionId, msg);
    else if (msg.type === MSG.RESPAWN) {
      const result = game.respawn(conn.sessionId);
      if (!result.ok) send(conn, { type: MSG.ERROR, text: result.error });
      else {
        conn.needFood = true;
        publish(conn);
      }
    }
  }

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      sessionId: null,
      lastEventId: game.eventSeq,
      needFood: true,
      isAlive: true,
      hits: [],
      replaced: false
    };
    connections.add(conn);
    ws.on('pong', () => { conn.isAlive = true; });
    ws.on('message', (buf) => onMessage(conn, buf));
    ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
    ws.on('close', () => {
      connections.delete(conn);
      if (conn.replaced) return;
      if (conn.sessionId) game.markDisconnected(conn.sessionId);
    });
    send(conn, helloPayload(store));
    publish(conn);
  });

  let acc = 0;
  let last = process.hrtime.bigint();
  const step = 1 / WORLD.TICK_RATE;
  const loop = setInterval(() => {
    const now = process.hrtime.bigint();
    acc += Number(now - last) / 1e9;
    last = now;
    if (acc > 0.25) acc = 0.25;
    let steps = 0;
    while (acc >= step && steps < 5) {
      try {
        game.tick(step);
      } catch (err) {
        console.error('Ошибка тика:', err);
      }
      acc -= step;
      steps += 1;
    }
    for (const conn of connections) {
      if (conn.ws.readyState !== 1) continue;
      if (conn.ws.bufferedAmount > 1000000) {
        try { conn.ws.close(1008, 'slow'); } catch { /* ignore */ }
        continue;
      }
      publish(conn);
    }
    game.clearDeltas();
  }, step * 1000);

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) {
        try { conn.ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      conn.isAlive = false;
      try { conn.ws.ping(); } catch { /* ignore */ }
    }
  }, 15000);

  function close() {
    clearInterval(loop);
    clearInterval(heartbeat);
    for (const conn of connections) {
      try { conn.ws.close(); } catch { /* ignore */ }
    }
    try { wss.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { store.save(); } catch (err) { console.error(err); }
  }

  return { server, wss, game, store, connections, close };
}

function listen(app) {
  const port = Number.parseInt(process.env.PORT, 10) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Порт ${port} уже занят.`);
    else console.error(err);
    process.exit(1);
  });
  app.server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`SLITHER LAB: http://${shown}:${port}`);
    console.log(`WebSocket: ws://${shown}:${port}/ws`);
    console.log(`Рекорды: ${app.store.filePath}`);
    console.log(`Записей в таблице: ${Object.keys(app.store.data.players).length}`);
  });

  let stopped = false;
  const shutdown = (signal) => {
    if (stopped) return;
    stopped = true;
    console.log(`\n${signal}: сохраняю таблицу и останавливаюсь`);
    try { app.close(); } catch (err) { console.error(err); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  listen(createApp());
}

module.exports = { createApp, listen };
