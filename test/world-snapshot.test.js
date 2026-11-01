'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isCompleteWorld } = require('../world-snapshot');

function fakeWorld(name = 'Hyperborea', body = 64) {
  const nameBytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(26 + 8);
  head.writeInt32LE(279, 0);
  head.write('relogic', 4, 'latin1');
  head[11] = 2;
  head.writeInt16LE(2, 24);
  head.writeInt32LE(head.length, 26);
  const footerAt = head.length + body;
  head.writeInt32LE(footerAt, 30);
  const footer = Buffer.concat([Buffer.from([1, nameBytes.length]), nameBytes, Buffer.alloc(4)]);
  return Buffer.concat([head, Buffer.alloc(body), footer]);
}

test('accepts a finished save', () => {
  assert.equal(isCompleteWorld(fakeWorld(), 'Hyperborea'), true);
});

test('rejects a save cut off at any point', () => {
  const whole = fakeWorld();
  for (let len = 0; len < whole.length; len++) {
    assert.equal(isCompleteWorld(whole.subarray(0, len), 'Hyperborea'), false, `length ${len}`);
  }
});

test('rejects extra bytes after the footer', () => {
  assert.equal(isCompleteWorld(Buffer.concat([fakeWorld(), Buffer.alloc(1)]), 'Hyperborea'), false);
});

test('rejects another world and a non-world file', () => {
  assert.equal(isCompleteWorld(fakeWorld('Other'), 'Hyperborea'), false);
  assert.equal(isCompleteWorld(Buffer.alloc(200), 'Hyperborea'), false);
});

test('rejects a footer offset that points outside the file', () => {
  const world = fakeWorld();
  world.writeInt32LE(-1, 30);
  assert.equal(isCompleteWorld(world, 'Hyperborea'), false);
  world.writeInt32LE(2 ** 30, 30);
  assert.equal(isCompleteWorld(world, 'Hyperborea'), false);
});
