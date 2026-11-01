'use strict';
/*
 * Checks that a Terraria .wld buffer is a whole, finished save. The server rewrites
 * the file on every autosave, so a read can catch it half-written; the public map
 * must keep serving the last good copy instead of a broken one.
 *
 * Layout used (little-endian): int32 version, 7 bytes "relogic", 1 byte file type,
 * 12 bytes metadata, int16 section count, then that many int32 section offsets.
 * The last offset is the footer: 1 byte (true), the world name, int32 world id.
 */
const HEADER_SIZE = 26;
const MAGIC = Buffer.from('relogic');

function isCompleteWorld(buf, worldName) {
  if (buf.length < HEADER_SIZE) return false;
  if (!buf.subarray(4, 11).equals(MAGIC)) return false;
  const sections = buf.readInt16LE(24);
  const offsetsEnd = HEADER_SIZE + sections * 4;
  if (sections < 1 || offsetsEnd > buf.length) return false;

  const footer = buf.readInt32LE(offsetsEnd - 4);
  const name = Buffer.from(worldName, 'utf8');
  const nameStart = footer + 2;              // 1 byte true + 1 byte string length
  if (footer < offsetsEnd || nameStart + name.length + 4 !== buf.length) return false;
  return buf[footer] === 1
    && buf[footer + 1] === name.length
    && buf.subarray(nameStart, nameStart + name.length).equals(name);
}

module.exports = { isCompleteWorld };
