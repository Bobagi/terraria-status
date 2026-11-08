'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const feedMod = require('../discord-feed');
const { parseEventLine } = require('../fight-events');

const ev = (over = {}) => parseEventLine(JSON.stringify(Object.assign({
  v: 1, id: 'k1', t: '2026-11-08T12:00:00Z', type: 'boss_kill', boss: 'Wall of Flesh', bossKey: 'WallofFlesh',
  durationSec: 125, participants: [{ name: 'Gustavo', damage: 12400, deaths: 0 }, { name: 'Wesley', damage: 7600, deaths: 2 }],
}, over)));

test('formatters', () => {
  assert.strictEqual(feedMod.fmtNum(999), '999');
  assert.strictEqual(feedMod.fmtNum(12400), '12,4k');
  assert.strictEqual(feedMod.fmtNum(2500000), '2,50M');
  assert.strictEqual(feedMod.fmtDuration(45), '45s');
  assert.strictEqual(feedMod.fmtDuration(125), '2m05s');
  assert.strictEqual(feedMod.fmtDuration(3725), '1h02m');
  assert.strictEqual(feedMod.bar(0.5, 10), '█████░░░░░');
  assert.strictEqual(feedMod.md('a_b*c'), 'a\\_b\\*c');
});

test('boss kill embed: title, table, deaths and the Hardmode milestone', () => {
  const e = feedMod.bossKillEmbed(ev());
  assert.match(e.title, /Parede de Carne foi derrotado/);
  assert.match(e.description, /2m05s/);
  const table = e.fields.find((f) => f.name === 'Dano por jogador').value;
  assert.match(table, /1\. Gustavo/);
  assert.match(table, /2\. Wesley/);
  assert.match(table, /62%/);                                   // 12400 of 20000
  assert.match(e.fields.find((f) => f.name.includes('Mortes')).value, /Wesley ×2/);
  assert.match(e.fields.find((f) => f.name === 'O que muda').value, /Hardmode/);
});

test('unknown (modded) boss falls back to the reported name', () => {
  const e = feedMod.bossKillEmbed(ev({ boss: 'Mutant', bossKey: 'FargowiltasSouls/MutantBoss' }));
  assert.match(e.title, /Mutant foi derrotado/);
});

test('embeds respect Discord limits even with 16 players', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({ name: 'Jogador' + i + 'x'.repeat(10), damage: 1e9 - i, deaths: 5 }));
  const e = feedMod.bossKillEmbed(ev({ participants: many }));
  assert.ok(e.title.length <= 256);
  assert.ok(e.description.length <= 4096);
  for (const f of e.fields) { assert.ok(f.name.length <= 256); assert.ok(f.value.length <= 1024, f.name + ' too long'); }
});

test('wipe, event and death embeds', () => {
  const wipe = feedMod.embedFor(ev({ type: 'boss_wipe', boss: 'Plantera', bossKey: 'Plantera', lifePct: 8 }));
  assert.match(wipe.description, /8%/);
  const start = feedMod.embedFor(ev({ type: 'event_start', event: 'bloodMoon' }));
  assert.match(start.title, /Lua de Sangue começou/);
  const end = feedMod.embedFor(ev({ type: 'event_end', event: 'bloodMoon', durationSec: 600 }));
  assert.match(end.description, /10m00s/);
  assert.strictEqual(feedMod.embedFor(ev({ type: 'death', name: 'Gelado' })), null);
});

test('weekly slot is a Sunday 23:00 UTC at or before now', () => {
  const wed = Date.parse('2026-11-11T10:00:00Z');
  assert.strictEqual(new Date(feedMod.lastWeeklySlot(wed)).toISOString(), '2026-11-08T23:00:00.000Z');
  const sundayNoon = Date.parse('2026-11-08T12:00:00Z');       // before this Sunday's slot: previous week
  assert.strictEqual(new Date(feedMod.lastWeeklySlot(sundayNoon)).toISOString(), '2026-11-01T23:00:00.000Z');
});

test('webhook URL is only accepted for discord.com webhooks', () => {
  const old = process.env.DISCORD_WEBHOOK_URL;
  try {
    process.env.DISCORD_WEBHOOK_URL = 'https://evil.example/api/webhooks/1/abc';
    assert.strictEqual(feedMod.readWebhookUrl(os.tmpdir()), '');
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc-DEF_1';
    assert.ok(feedMod.readWebhookUrl(os.tmpdir()));
  } finally { if (old === undefined) delete process.env.DISCORD_WEBHOOK_URL; else process.env.DISCORD_WEBHOOK_URL = old; }
});

test('feed tails the log: skips history, posts new lines once, survives a partial line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const file = path.join(dir, 'serverevents.jsonl');
  const line = (id, over) => JSON.stringify(Object.assign({ v: 1, id, t: '2026-11-08T12:00:00Z', type: 'boss_kill', boss: 'Skeletron', bossKey: 'Skeletron', durationSec: 30, participants: [{ name: 'Gustavo', damage: 900, deaths: 0 }] }, over));
  fs.writeFileSync(file, line('old') + '\n');                  // history: must NOT be posted

  const posts = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
  try {
    const feed = feedMod.createFeed({ dir, eventsFile: file, sendGapMs: 0 });
    assert.ok(feed.enabled);
    await feed.tick();
    assert.strictEqual(posts.length, 0);

    const half = line('half');
    fs.appendFileSync(file, line('new1') + '\n' + half.slice(0, 20));   // one full line + a cut line
    await feed.tick();
    assert.strictEqual(posts.length, 1);
    assert.match(posts[0].embeds[0].title, /Esqueletron/);
    assert.deepStrictEqual(posts[0].allowed_mentions, { parse: [] });

    fs.appendFileSync(file, half.slice(20) + '\n');
    await feed.tick();
    await feed.tick();                                          // nothing new: no duplicate
    assert.strictEqual(posts.length, 2);
  } finally {
    global.fetch = realFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('events file created after the app started: its first line is posted, not skipped as history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const file = path.join(dir, 'serverevents.jsonl');           // does not exist yet
  const posts = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
  try {
    const feed = feedMod.createFeed({ dir, eventsFile: file, sendGapMs: 0 });
    await feed.tick();                                          // no file: nothing to do
    fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'd1', t: '2026-11-08T11:41:17Z', type: 'boss_kill', boss: 'The Destroyer', bossKey: 'TheDestroyer', durationSec: 21, participants: [{ name: 'Bobagi', damage: 120000, deaths: 0 }] }) + '\n');
    await feed.tick();
    assert.strictEqual(posts.length, 1);
    assert.match(posts[0].embeds[0].title, /derrotado/);
  } finally {
    global.fetch = realFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 4xx from Discord drops the message instead of blocking the queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const file = path.join(dir, 'e.jsonl');
  fs.writeFileSync(file, '');
  let calls = 0;
  const realFetch = global.fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  global.fetch = async () => { calls += 1; return { ok: false, status: 404, json: async () => ({}) }; };
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
  try {
    const feed = feedMod.createFeed({ dir, eventsFile: file, sendGapMs: 0 });
    await feed.tick();
    fs.appendFileSync(file, JSON.stringify({ v: 1, id: 'z', t: '2026-11-08T12:00:00Z', type: 'boss_kill', boss: 'Golem', bossKey: 'Golem', durationSec: 5, participants: [] }) + '\n');
    await feed.tick();
    await feed.tick();
    assert.strictEqual(calls, 1);
  } finally {
    global.fetch = realFetch; console.warn = realWarn;
    delete process.env.DISCORD_WEBHOOK_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
