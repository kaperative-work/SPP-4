'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SlitherShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WORLD = Object.freeze({
    RADIUS: 2300,
    TICK_RATE: 20,
    FOOD_TARGET: 150,
    MAX_FOOD: 460,
    BASE_SPEED: 176,
    BOOST_SPEED: 292,
    TURN_RATE: 3.3,
    START_MASS: 10,
    MIN_BOOST_MASS: 18,
    BOOST_DRAIN: 3.8,
    SEGMENT_SPACING: 7,
    BASE_SEGMENTS: 6,
    MASS_TO_SEGMENTS: 0.82,
    MAX_SEGMENTS: 240,
    HIT_DISTANCE: 12,
    EAT_RADIUS: 32,
    NECK_SKIP: 8,
    GRACE_MS: 25000,
    BEACON_RANGE: 170,
    BEACON_ORBIT: 700,
    BEACON_SPEED: 0.16,
    MAX_PLAYERS: 20,
    VIEW_POINT_CAP: 64
  });

  const SNAKE_COLORS = Object.freeze([
    '#3ee0b0',
    '#4cc9f0',
    '#f72585',
    '#ffd60a',
    '#c77dff',
    '#ff7b54',
    '#80ed99',
    '#4d96ff',
    '#ff5d8f',
    '#e7f2ef'
  ]);

  const FOOD_COLORS = Object.freeze([
    '#ff5d8f',
    '#ffd60a',
    '#4cc9f0',
    '#80ed99',
    '#c77dff',
    '#ff7b54',
    '#e7f2ef',
    '#3ee0b0'
  ]);

  const FOOD_KIND = Object.freeze({ normal: 0, gold: 1, drop: 2, boost: 3 });
  const FOOD_KIND_NAME = Object.freeze(['normal', 'gold', 'drop', 'boost']);

  const MSG = Object.freeze({
    HELLO: 'hello',
    JOIN: 'join',
    RESUME: 'resume',
    INPUT: 'input',
    BEACON: 'beacon',
    RESPAWN: 'respawn',
    PING: 'ping',
    PONG: 'pong',
    STATE: 'state',
    RESUME_FAIL: 'resume_fail',
    SESSION_END: 'session_end',
    ERROR: 'error',
    KICKED: 'kicked'
  });

  function segmentCount(mass) {
    const n = WORLD.BASE_SEGMENTS + Math.floor(Math.max(0, mass) * WORLD.MASS_TO_SEGMENTS);
    return Math.max(WORLD.BASE_SEGMENTS, Math.min(WORLD.MAX_SEGMENTS, n));
  }

  return { WORLD, SNAKE_COLORS, FOOD_COLORS, FOOD_KIND, FOOD_KIND_NAME, MSG, segmentCount };
});
