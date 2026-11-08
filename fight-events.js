'use strict';
/*
 * Reads the event log written by the server-side mod (character-stats-mod/BossFights.cs):
 * one JSON object per line in `serverevents.jsonl`. Everything here is pure (no I/O,
 * no clock) so it can be tested; discord-feed.js and the /api/fights endpoint use it.
 *
 * The file is written by a mod, but player names inside it come from the game and
 * boss names can come from any installed mod, so every field is validated and
 * clamped here before it reaches Discord or the page.
 *
 * Line shapes (v = 1, t = ISO time, id = unique string):
 *   boss_kill   { boss, bossKey, durationSec, participants:[{name, damage, deaths}] }
 *   boss_wipe   { boss, bossKey, durationSec, lifePct, participants:[...] }
 *   event_start { event }                 event_end { event, durationSec }
 *   death       { name, inBoss }
 */

const MAX_PLAYERS = 16;
const TYPES = new Set(['boss_kill', 'boss_wipe', 'event_start', 'event_end', 'death']);

// Player/boss text: drop control characters and backticks (they would close a code
// block in Discord), then cap the length.
function cleanText(value, max = 40) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f`]/g, '').trim();
  return s.slice(0, max);
}

function num(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanParticipants(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, MAX_PLAYERS)) {
    if (!p || typeof p !== 'object') continue;
    const name = cleanText(p.name, 20);
    if (!name) continue;
    out.push({
      name,
      damage: Math.round(num(p.damage, 0, 1e12)),
      deaths: Math.round(num(p.deaths, 0, 999)),
    });
  }
  out.sort((a, b) => b.damage - a.damage);
  return out;
}

// One line of the log -> a normalized event, or null when it is not a valid one.
function parseEventLine(line) {
  let raw;
  try { raw = JSON.parse(line); } catch (_) { return null; }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !TYPES.has(raw.type)) return null;
  const at = Date.parse(raw.t);
  if (!Number.isFinite(at)) return null;
  const ev = { type: raw.type, id: cleanText(raw.id, 64), t: new Date(at).toISOString(), at };
  switch (raw.type) {
    case 'boss_kill':
    case 'boss_wipe':
      ev.boss = cleanText(raw.boss, 60);
      ev.bossKey = cleanText(raw.bossKey, 80);
      if (!ev.boss && !ev.bossKey) return null;
      ev.durationSec = Math.round(num(raw.durationSec, 0, 86400));
      ev.participants = cleanParticipants(raw.participants);
      if (raw.type === 'boss_wipe') ev.lifePct = raw.lifePct == null ? null : Math.round(num(raw.lifePct, 0, 100));
      break;
    case 'event_start':
    case 'event_end':
      ev.event = cleanText(raw.event, 40);
      if (!ev.event) return null;
      ev.durationSec = Math.round(num(raw.durationSec, 0, 7 * 86400));
      break;
    case 'death':
      ev.name = cleanText(raw.name, 20);
      if (!ev.name) return null;
      ev.inBoss = raw.inBoss === true;
      break;
  }
  return ev;
}

function parseEvents(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const ev = parseEventLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

function dps(damage, durationSec) {
  return durationSec >= 3 ? damage / durationSec : damage;
}

// Totals over [fromMs, toMs) for the weekly ranking.
function aggregate(events, fromMs, toMs) {
  const kills = new Map();          // bossKey -> { boss, bossKey, count }
  const damage = new Map();         // player -> total boss damage
  const deaths = new Map();         // player -> deaths (any cause)
  let wipes = 0;
  let bestDps = null;               // best single-fight DPS
  let fights = 0;
  for (const ev of events) {
    if (ev.at < fromMs || ev.at >= toMs) continue;
    if (ev.type === 'death') {
      deaths.set(ev.name, (deaths.get(ev.name) || 0) + 1);
    } else if (ev.type === 'boss_wipe') {
      wipes += 1;
    } else if (ev.type === 'boss_kill') {
      fights += 1;
      const key = ev.bossKey || ev.boss;
      const k = kills.get(key) || { boss: ev.boss, bossKey: ev.bossKey, count: 0 };
      k.count += 1;
      kills.set(key, k);
      for (const p of ev.participants) {
        damage.set(p.name, (damage.get(p.name) || 0) + p.damage);
        const d = dps(p.damage, ev.durationSec);
        if (!bestDps || d > bestDps.dps) bestDps = { name: p.name, boss: ev.boss, bossKey: ev.bossKey, dps: d, damage: p.damage };
      }
    }
  }
  const ranked = (m) => [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  return {
    fights,
    wipes,
    kills: [...kills.values()].sort((a, b) => b.count - a.count),
    damage: ranked(damage),
    deaths: ranked(deaths),
    bestDps,
  };
}

// Newest boss kills first, trimmed for the site (no ids, no player-only events).
function recentKills(events, limit = 20) {
  return events
    .filter((e) => e.type === 'boss_kill')
    .slice(-limit)
    .reverse()
    .map((e) => ({
      t: e.t,
      boss: e.boss,
      bossKey: e.bossKey,
      durationSec: e.durationSec,
      participants: e.participants.map((p) => ({ name: p.name, damage: p.damage, deaths: p.deaths, dps: Math.round(dps(p.damage, e.durationSec)) })),
    }));
}

module.exports = { parseEventLine, parseEvents, aggregate, recentKills, cleanText, dps, MAX_PLAYERS };
