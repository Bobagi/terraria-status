'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeModBosses, pickLive, iconKey, MODBOSS_MAX } = require('../world-extras');

const MUTANT = 'FargowiltasSouls/Content/Bosses/MutantBoss/MutantBoss_Head_Boss';

test('keeps a well-formed mod boss and maps its texture to a known icon', () => {
  const icons = new Set([iconKey(MUTANT)]);
  const [b] = sanitizeModBosses([{ mod: 'FargowiltasSouls', name: 'Mutant', kind: 'boss', downed: true, head: MUTANT }], icons);
  assert.deepStrictEqual(b, { mod: 'FargowiltasSouls', name: 'Mutant', kind: 'boss', downed: true,
    icon: 'FargowiltasSouls_Content_Bosses_MutantBoss_MutantBoss_Head_Boss' });
});

test('drops an icon that is not on disk instead of passing the raw path', () => {
  const [b] = sanitizeModBosses([{ name: 'x', head: '../../etc/passwd' }], new Set());
  assert.strictEqual(b.icon, null);
});

test('an icon key can never hold path or URL characters', () => {
  assert.match(iconKey('../a/b?c=d#e<script>'), /^[A-Za-z0-9_]+$/);
});

test('downed is true only for a literal true', () => {
  const out = sanitizeModBosses([{ downed: 'true' }, { downed: 1 }, { downed: true }], new Set());
  assert.deepStrictEqual(out.map((b) => b.downed), [false, false, true]);
});

test('unknown kinds fall back to boss, names and mod ids are bounded', () => {
  const [b] = sanitizeModBosses([{ kind: 'admin', name: 'n'.repeat(500), mod: 'Evil Mod<>/' + 'm'.repeat(100) }], new Set());
  assert.strictEqual(b.kind, 'boss');
  assert.strictEqual(b.name.length, 60);
  assert.match(b.mod, /^[A-Za-z0-9_]{0,40}$/);
});

test('caps the list and ignores junk entries', () => {
  assert.deepStrictEqual(sanitizeModBosses('nope', new Set()), []);
  assert.strictEqual(sanitizeModBosses([null, 3, 'x', {}], new Set()).length, 1);
  assert.strictEqual(sanitizeModBosses(Array.from({ length: 500 }, () => ({})), new Set()).length, MODBOSS_MAX);
});

test('pickLive keeps only the fields the page shows', () => {
  const live = pickLive({ dayTime: true, timeText: '12:30<b>', moonPhase: 3, tps: 59.8, bloodMoon: 'yes',
    progression: 'Hardmode', modBosses: [{ name: 'leak' }], secret: 'x' });
  assert.deepStrictEqual(Object.keys(live).sort(),
    ['bloodMoon', 'dayTime', 'eclipse', 'hardMode', 'moonPhase', 'progression', 'pumpkinMoon', 'snowMoon', 'timeText', 'tps']);
  assert.strictEqual(live.timeText, '12:30');
  assert.strictEqual(live.bloodMoon, false);
  assert.strictEqual(live.tps, 59.8);
});

test('pickLive rejects a nonsense tick rate and a missing object', () => {
  assert.strictEqual(pickLive({ tps: -1 }).tps, null);
  assert.strictEqual(pickLive({ tps: '60' }).tps, null);
  assert.strictEqual(pickLive(null), null);
});
