'use strict';

const fs = require('node:fs');
const path = require('node:path');

function emptyProfile(nickname) {
  return {
    nickname,
    maxLength: 0,
    maxMass: 0,
    foodEaten: 0,
    bestSurvivalMs: 0,
    totalPlayMs: 0,
    wins: 0,
    deaths: 0,
    games: 0,
    updatedAt: Date.now()
  };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      players: {},
      meta: {
        totalConflicts: 0,
        createdAt: new Date().toISOString()
      }
    };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      this.data.players = parsed.players && typeof parsed.players === 'object' ? parsed.players : {};
      this.data.meta = Object.assign(this.data.meta, parsed.meta || {});
      if (!Number.isFinite(this.data.meta.totalConflicts)) this.data.meta.totalConflicts = 0;
    } catch (err) {
      console.error('Не удалось прочитать сохранение, таблица начнётся заново:', err.message);
    }
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.save();
      } catch (err) {
        console.error('Ошибка автосохранения:', err.message);
      }
    }, 800);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  save() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      fs.copyFileSync(tmp, this.filePath);
      fs.rmSync(tmp, { force: true });
    }
  }

  keyOf(nickname) {
    return String(nickname).trim().toLocaleLowerCase('ru-RU');
  }

  ensure(nickname) {
    const key = this.keyOf(nickname);
    if (!this.data.players[key]) this.data.players[key] = emptyProfile(nickname);
    this.data.players[key].nickname = nickname;
    return this.data.players[key];
  }

  update(nickname, patch) {
    const profile = this.ensure(nickname);
    if (patch.length) profile.maxLength = Math.max(profile.maxLength, patch.length | 0);
    if (patch.mass) profile.maxMass = Math.max(profile.maxMass, Math.round(patch.mass * 10) / 10);
    if (patch.foodDelta) profile.foodEaten += patch.foodDelta;
    if (patch.playDelta) profile.totalPlayMs += Math.max(0, patch.playDelta | 0);
    if (patch.survivalSample) {
      profile.bestSurvivalMs = Math.max(profile.bestSurvivalMs, patch.survivalSample | 0);
    }
    if (patch.killDelta) profile.wins += patch.killDelta;
    if (patch.died) profile.deaths += 1;
    if (patch.newGame) profile.games += 1;
    profile.foodEaten = Math.round(profile.foodEaten * 10) / 10;
    profile.updatedAt = Date.now();
    this.schedule();
    return profile;
  }

  bumpConflict() {
    this.data.meta.totalConflicts = (this.data.meta.totalConflicts || 0) + 1;
    this.schedule();
    return this.data.meta.totalConflicts;
  }

  top(limit) {
    const n = limit || 10;
    return Object.values(this.data.players)
      .sort((a, b) =>
        (b.maxLength || 0) - (a.maxLength || 0) ||
        (b.foodEaten || 0) - (a.foodEaten || 0) ||
        (b.wins || 0) - (a.wins || 0) ||
        String(a.nickname).localeCompare(String(b.nickname), 'ru')
      )
      .slice(0, n)
      .map((p) => ({
        nickname: p.nickname,
        maxLength: p.maxLength || 0,
        maxMass: p.maxMass || 0,
        foodEaten: p.foodEaten || 0,
        bestSurvivalMs: p.bestSurvivalMs || 0,
        totalPlayMs: p.totalPlayMs || 0,
        wins: p.wins || 0,
        deaths: p.deaths || 0,
        games: p.games || 0
      }));
  }
}

module.exports = { Store };
