// Decode Terraria `Content/Images` .xnb textures into the PNG sprites the status
// page serves. It reads a source folder of raw `Item_<id>.xnb` / `Buff_<id>.xnb`
// (straight from a tModLoader/Terraria install — no TConvert needed) and writes
// `public/sprites/item/<id>.png` + `public/sprites/buff/<id>.png`.
//
// Usage:  cd tools && npm install && node build-sprites.mjs <src-dir>
//         (src-dir defaults to /root/prints/terrariaConvert)
//
// The `xnb` dependency is used ONLY by this offline build tool — the runtime
// server (../server.js) stays zero-dependency. Output PNGs are git-ignored
// (Re-Logic assets — never commit them). The page auto-detects the folders at
// startup and upgrades each category glyph to its real sprite.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import * as xnb from 'xnb';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'sprites');
const SRC = process.argv[2] || '/root/prints/terrariaConvert';

mkdirSync(join(OUT, 'item'), { recursive: true });
mkdirSync(join(OUT, 'buff'), { recursive: true });

// Recursively collect every *.xnb under SRC.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.xnb$/i.test(name)) out.push(p);
  }
  return out;
}

// XNB (LZX/LZ4 Texture2D) -> PNG bytes. Node pools small Buffers, and xnb.js
// reads `file.buffer` (the underlying ArrayBuffer) directly — so we MUST hand it
// a fresh Uint8Array copy whose .buffer owns exactly these bytes, or it reads
// pool garbage and fails "Invalid file magic".
async function xnbToPng(path) {
  const u8 = new Uint8Array(readFileSync(path));
  const files = await xnb.unpackToFiles(u8, { fileName: basename(path) });
  for (const f of files) {
    if (f.extension !== 'png') continue;
    return f.data instanceof Uint8Array ? Buffer.from(f.data)
      : (f.data?.arrayBuffer ? Buffer.from(await f.data.arrayBuffer()) : Buffer.from(f.data));
  }
  return null;
}

const all = walk(SRC);
let item = 0, buff = 0, other = 0, failed = 0;
for (const path of all) {
  const name = basename(path);
  const mI = /^Item_(\d+)\.xnb$/i.exec(name);
  const mB = /^Buff_(\d+)\.xnb$/i.exec(name);
  if (!mI && !mB) { other++; continue; }
  try {
    const png = await xnbToPng(path);
    if (!png) { failed++; continue; }
    if (mI) { writeFileSync(join(OUT, 'item', mI[1] + '.png'), png); item++; }
    else    { writeFileSync(join(OUT, 'buff', mB[1] + '.png'), png); buff++; }
  } catch (e) {
    failed++;
    if (failed <= 5) console.warn('  skip', name, '-', e.message);
  }
}

console.log(`\nsource: ${SRC}`);
console.log(`items: ${item} png   buffs: ${buff} png   (skipped ${other} non-item/buff, ${failed} failed)`);
console.log(`out:   ${OUT}/{item,buff}`);
console.log('Restart the status server so it re-detects the sprite set:  pm2 restart terraria-status');
