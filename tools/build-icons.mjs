// Builds public/icons/icons.svg: an SVG sprite with only the Lucide icons the
// page uses (https://lucide.dev, ISC license, copied to public/icons/LICENSE.txt).
//
//   cd tools && npm install && node build-icons.mjs
//
// The sprite is committed, so the runtime server stays zero-dependency and the
// page never loads an icon CDN. To add an icon: append its Lucide name to ICONS,
// rerun, then use <svg class="ic"><use href="/icons/icons.svg#NAME"/></svg>
// in the HTML or icon('NAME') in public/js/app.js.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = [
  // buttons / UI
  'play', 'copy', 'check', 'x', 'chevron-right', 'external-link', 'map',
  'triangle-alert', 'mouse-pointer-click',
  // section titles
  'log-in', 'earth', 'users', 'server', 'skull', 'puzzle', 'megaphone', 'message-square',
  // pills / live world
  'swords', 'mountain', 'lock', 'heart-pulse', 'map-pin', 'sun', 'moon',
  'droplet', 'eclipse', 'ghost', 'snowflake',
  // item category glyphs (fallback when no pixel sprite) + buff fallback
  'sword', 'bow-arrow', 'wand-sparkles', 'paw-print', 'pickaxe', 'shield',
  'circle-dot', 'move-up-right', 'flask-round', 'box', 'coins', 'gem', 'sparkle',
];

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'node_modules', 'lucide-static');
const out = join(here, '..', 'public', 'icons');
const { version } = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));

const symbols = ICONS.map((name) => {
  const svg = readFileSync(join(src, 'icons', `${name}.svg`), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
    .replace(/\s*\n\s*/g, '').trim();
  return `<symbol id="${name}" viewBox="0 0 24 24">${inner}</symbol>`;
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icons.svg'),
  `<!-- Lucide v${version} (ISC), built by tools/build-icons.mjs -->\n`
  + `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n</svg>\n`);
writeFileSync(join(out, 'LICENSE.txt'), readFileSync(join(src, 'LICENSE'), 'utf8'));
console.log(`icons.svg: ${ICONS.length} icons from lucide-static v${version}`);
