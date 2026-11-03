#!/usr/bin/env python3
"""Extract boss map-head icons from installed tModLoader mods into public/sprites/modboss/.

The status page lists the bosses other mods register with Boss Checklist (Fargo's Souls
and friends). The server-side export names each boss's head texture, e.g.
"FargowiltasSouls/Content/Bosses/MutantBoss/MutantBoss_Head_Boss"; this script pulls every
"*_Head_Boss" image out of the mods' .tmod files and writes it as
public/sprites/modboss/<icon key>.png, the same key server.js derives from that path.

usage: python3 -I tools/build-modboss-icons.py [workshop content dir]
       (default: /opt/terraria-tmodloader/data/steamMods/steamapps/workshop/content/1281930)

Output is git-ignored, like the other sprites: the art belongs to each mod's authors.
"""
import os
import re
import struct
import sys
import zlib

WORKSHOP = sys.argv[1] if len(sys.argv) > 1 else '/opt/terraria-tmodloader/data/steamMods/steamapps/workshop/content/1281930'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sprites', 'modboss')
MAX_SIDE = 512  # a head icon is ~30-60 px; anything bigger is not what we want


def icon_key(texture_path):
    """Same rule as server.js iconKey(): letters, digits and underscores only."""
    return re.sub(r'[^A-Za-z0-9_]', '_', texture_path)[:160]


def read_tmod(path):
    data = open(path, 'rb').read()
    pos = 0

    def rstr():
        nonlocal pos
        n = shift = 0
        while True:
            b = data[pos]; pos += 1
            n |= (b & 0x7F) << shift; shift += 7
            if b < 0x80:
                break
        s = data[pos:pos + n].decode('utf-8'); pos += n
        return s

    if data[:4] != b'TMOD':
        raise ValueError('not a .tmod file')
    pos = 4
    rstr()                 # tModLoader version
    pos += 20 + 256 + 4    # hash, signature, data length
    name = rstr(); rstr()  # mod name, mod version
    count = struct.unpack_from('<i', data, pos)[0]; pos += 4
    entries = []
    for _ in range(count):
        p = rstr()
        length, clen = struct.unpack_from('<ii', data, pos); pos += 8
        entries.append((p, length, clen))
    for p, length, clen in entries:
        blob = data[pos:pos + clen]; pos += clen
        yield name, p, (zlib.decompress(blob, -15) if clen != length else blob)


def rawimg_to_png(blob):
    """tModLoader .rawimg: int32 version, int32 width, int32 height, RGBA bytes."""
    _, w, h = struct.unpack_from('<iii', blob, 0)
    if not (0 < w <= MAX_SIDE and 0 < h <= MAX_SIDE) or len(blob) < 12 + w * h * 4:
        raise ValueError('unexpected image size')
    rgba = blob[12:12 + w * h * 4]
    raw = b''.join(b'\x00' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xFFFFFFFF)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def newest_tmods(root):
    """Each Workshop item keeps one folder per tModLoader version: take the newest."""
    for item in sorted(os.listdir(root)):
        folder = os.path.join(root, item)
        if not os.path.isdir(folder):
            continue
        versions = sorted((v for v in os.listdir(folder) if os.path.isdir(os.path.join(folder, v))),
                          key=lambda v: [int(x) for x in re.findall(r'\d+', v)])
        for v in reversed(versions):
            tmods = [f for f in os.listdir(os.path.join(folder, v)) if f.endswith('.tmod')]
            if tmods:
                yield os.path.join(folder, v, tmods[0])
                break


def main():
    os.makedirs(OUT, exist_ok=True)
    written = 0
    for tmod in newest_tmods(WORKSHOP):
        try:
            for mod, path, blob in read_tmod(tmod):
                if not path.endswith('_Head_Boss.rawimg'):
                    continue
                key = icon_key(mod + '/' + path[:-len('.rawimg')])
                try:
                    png = rawimg_to_png(blob)
                except ValueError as e:
                    print(f'skip {mod}/{path}: {e}')
                    continue
                with open(os.path.join(OUT, key + '.png'), 'wb') as f:
                    f.write(png)
                written += 1
        except (ValueError, OSError, struct.error, zlib.error) as e:
            print(f'skip {tmod}: {e}')
    print(f'{written} boss icons -> {os.path.normpath(OUT)}')


if __name__ == '__main__':
    main()
