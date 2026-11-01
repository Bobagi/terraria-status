'use strict';
/*
 * Reads the player list out of the tModLoader console (`playing` command).
 *
 * The reply is one line per player and only the first carries the console's
 * ": " prompt, the block ends with a count line:
 *
 *   playing
 *   : default (1.2.3.4:5678)
 *   Bobagi (5.6.7.8:9012)
 *   2 players connected.
 *
 * SECURITY: the console also holds chat, join lines and the world password, so
 * only lines shaped exactly like a player entry are accepted, and the address is
 * dropped here. Returns null when no complete reply is on screen, so the caller
 * keeps the last good list instead of showing a partial one.
 *
 * Player chat lands on this console too, line breaks included, so the result can
 * be forged by a connected player. The caller prefers the mod's export when live.
 */

const ENTRY = /^(.+) \((?:[\da-f.:]+|\[[\da-f:]+\])(?::\d+)?\)$/i;
const COUNT = /^(\d+) players? connected\.?$/i;
const NONE = /^no players connected\.?$/i;
const NAME_MAX = 24;

function parsePlaying(pane) {
  const lines = String(pane).split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.lastIndexOf('playing');
  if (start === -1) return null;

  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const body = lines[i].replace(/^: /, '').trim();
    if (!body) continue;
    if (NONE.test(body)) return [];
    const count = COUNT.exec(body);
    if (count) return parseInt(count[1], 10) === names.length ? names : null;
    const entry = ENTRY.exec(body);
    if (entry) names.push(entry[1].trim().slice(0, NAME_MAX));
  }
  return null;
}

module.exports = { parsePlaying, NAME_MAX };
