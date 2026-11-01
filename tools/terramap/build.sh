#!/usr/bin/env bash
# Builds TerraMap Web (MIT, github.com/TerraMap/terramap.github.io) into
# public/mapa/, patched to open the server's live world (see serve-our-world.patch).
# public/mapa/ is git-ignored: run this after a fresh clone or to update TerraMap.
# To update: bump TERRAMAP_COMMIT and regenerate the patch if it stops applying.
set -euo pipefail

TERRAMAP_COMMIT=e4b03f4ab8878fa2e9d98668e991090272d6826f
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../public/mapa"
export PATH="/opt/node-v22/bin:$PATH"   # vite 8 needs Node >= 20; the host default is 18

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet https://github.com/TerraMap/terramap.github.io "$WORK/terramap"
cd "$WORK/terramap"
git checkout --quiet "$TERRAMAP_COMMIT"
git apply "$HERE/serve-our-world.patch"
npm ci --no-audit --no-fund
BASE_PATH=/mapa/ npx vite build

# Upstream's public/ also ships old Windows installers and its own ads.txt.
rm -rf dist/resources/*.zip dist/ads.txt dist/native.html dist/windows.html
cp LICENSE dist/LICENSE.txt

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r dist/. "$OUT/"
echo "TerraMap ${TERRAMAP_COMMIT:0:8} -> $OUT ($(du -sh "$OUT" | cut -f1))"
