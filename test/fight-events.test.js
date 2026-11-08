'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEventLine, parseEvents, aggregate, recentKills } = require('../fight-events');

const kill = (over = {}) => JSON.stringify(Object.assign({
  v: 1, id: 'a1', t: '2026-11-08T12:00:00Z', type: 'boss_kill', boss: 'Eye of Cthulhu', bossKey: 'EyeofCthulhu',
  durationSec: 90, participants: [{ name: 'Gustavo', damage: 5000, deaths: 1 }, { name: 'Wesley', damage: 9000, deaths: 0 }],
}, over));

test('parses a boss kill and sorts players by damage', () => {
  const ev = parseEventLine(kill());
  assert.strictEqual(ev.type, 'boss_kill');
  assert.strictEqual(ev.participants[0].name, 'Wesley');
  assert.strictEqual(ev.durationSec, 90);
});

test('rejects garbage, wrong version, unknown type and bad time', () => {
  assert.strictEqual(parseEventLine('not json'), null);
  assert.strictEqual(parseEventLine(kill({ v: 2 })), null);
  assert.strictEqual(parseEventLine(kill({ type: 'format_c' })), null);
  assert.strictEqual(parseEventLine(kill({ t: 'yesterday' })), null);
  assert.strictEqual(parseEventLine(kill({ boss: '', bossKey: '' })), null);
});

test('strips backticks and control characters from player names', () => {
  const ev = parseEventLine(kill({ participants: [{ name: '``` @everyone\u0007', damage: 1, deaths: 0 }] }));
  assert.ok(!ev.participants[0].name.includes('`'));
  assert.ok(!/[\u0000-\u001f]/.test(ev.participants[0].name));
});

test('clamps absurd numbers instead of trusting them', () => {
  const ev = parseEventLine(kill({ durationSec: -5, participants: [{ name: 'x', damage: 'NaN', deaths: 99999 }] }));
  assert.strictEqual(ev.durationSec, 0);
  assert.strictEqual(ev.participants[0].damage, 0);
  assert.strictEqual(ev.participants[0].deaths, 999);
});

test('caps the player list at 16', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: 'p' + i, damage: i, deaths: 0 }));
  assert.strictEqual(parseEventLine(kill({ participants: many })).participants.length, 16);
});

test('parseEvents skips bad lines and keeps the good ones', () => {
  const text = [kill(), 'oops', '', JSON.stringify({ v: 1, id: 'd', t: '2026-11-08T12:01:00Z', type: 'death', name: 'Gelado' })].join('\n');
  assert.strictEqual(parseEvents(text).length, 2);
});

test('aggregate counts only the requested window', () => {
  const day = (d) => `2026-11-${String(d).padStart(2, '0')}T12:00:00Z`;
  const events = parseEvents([
    kill({ id: '1', t: day(1) }),                                   // before the window
    kill({ id: '2', t: day(3) }),
    kill({ id: '3', t: day(4), boss: 'King Slime', bossKey: 'KingSlime', durationSec: 10, participants: [{ name: 'Gustavo', damage: 8000, deaths: 0 }] }),
    JSON.stringify({ v: 1, id: 'w', t: day(4), type: 'boss_wipe', boss: 'Plantera', bossKey: 'Plantera', durationSec: 60, participants: [] }),
    JSON.stringify({ v: 1, id: 'd1', t: day(5), type: 'death', name: 'Gelado' }),
    JSON.stringify({ v: 1, id: 'd2', t: day(5), type: 'death', name: 'Gelado' }),
    JSON.stringify({ v: 1, id: 'd3', t: day(5), type: 'death', name: 'Wesley' }),
  ].join('\n'));
  const agg = aggregate(events, Date.parse(day(2)), Date.parse(day(7)));
  assert.strictEqual(agg.fights, 2);
  assert.strictEqual(agg.wipes, 1);
  assert.strictEqual(agg.deaths[0].name, 'Gelado');
  assert.strictEqual(agg.deaths[0].value, 2);
  assert.strictEqual(agg.damage[0].name, 'Gustavo');          // 5000 + 8000 beats Wesley's 9000
  assert.strictEqual(agg.damage[0].value, 13000);
  assert.strictEqual(agg.bestDps.name, 'Gustavo');             // 8000 in 10 s = 800/s
  assert.strictEqual(Math.round(agg.bestDps.dps), 800);
});

test('recentKills is newest first and exposes per-player DPS', () => {
  const events = parseEvents([kill({ id: '1', t: '2026-11-08T10:00:00Z' }), kill({ id: '2', t: '2026-11-08T11:00:00Z', boss: 'Skeletron', bossKey: 'Skeletron' })].join('\n'));
  const r = recentKills(events, 5);
  assert.strictEqual(r[0].boss, 'Skeletron');
  assert.strictEqual(r[1].participants[0].dps, 100);           // 9000 / 90 s
});
