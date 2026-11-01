'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePlaying } = require('../console-players');

test('lists every player, not only the one on the prompt line', () => {
  const pane = 'playing\n: default (177.1.2.3:51000)\nBobagi (138.9.9.9:42000)\n2 players connected.\n';
  assert.deepEqual(parsePlaying(pane), ['default', 'Bobagi']);
});

test('reads a full server', () => {
  const entries = Array.from({ length: 8 }, (_, i) => `P${i} (10.0.0.${i}:7000)`);
  const pane = `playing\n: ${entries.join('\n')}\n8 players connected.\n`;
  assert.equal(parsePlaying(pane).length, 8);
});

test('reads one player and an empty server', () => {
  assert.deepEqual(parsePlaying('playing\n: Solo (1.2.3.4:5)\n1 player connected.\n'), ['Solo']);
  assert.deepEqual(parsePlaying('playing\n: No players connected.\n'), []);
});

test('uses the last reply on screen', () => {
  const pane = 'playing\n: Old (1.1.1.1:1)\n1 player connected.\nplaying\n: No players connected.\n';
  assert.deepEqual(parsePlaying(pane), []);
});

test('keeps spaces and parentheses inside a name', () => {
  const pane = 'playing\n: Sir (Tank) Bob (1.2.3.4:5)\n1 player connected.\n';
  assert.deepEqual(parsePlaying(pane), ['Sir (Tank) Bob']);
});

test('never publishes an address', () => {
  const out = JSON.stringify(parsePlaying('playing\n: A (1.2.3.4:5)\nB ([2001:db8::1]:7)\n2 players connected.\n'));
  assert.equal(out, '["A","B"]');
});

test('ignores console noise between the entries', () => {
  const pane = [
    'playing',
    ': A (1.2.3.4:5)',
    'C has joined.',
    '<C> a senha e hunter2',
    'Saving world data: 50%',
    'B (5.6.7.8:9)',
    '2 players connected.',
  ].join('\n');
  assert.deepEqual(parsePlaying(pane), ['A', 'B']);
});

test('a chat line cannot fake a player', () => {
  const pane = 'playing\n: A (1.2.3.4:5)\n<A> Fake (9.9.9.9:1)\n1 player connected.\n';
  assert.equal(parsePlaying(pane), null);
});

test('returns null for a cut off or mismatched reply, so the last list stays', () => {
  assert.equal(parsePlaying('playing\n: A (1.2.3.4:5)\n'), null);
  assert.equal(parsePlaying('playing\n: A (1.2.3.4:5)\n2 players connected.\n'), null);
  assert.equal(parsePlaying('nothing here'), null);
});
