# tools — offline sprite builder

`build-sprites.mjs` decodes Terraria `Content/Images` **`.xnb`** textures into the PNG
sprites the status page serves — so item/buff icons show the **real pixel art** instead
of category glyphs.

It handles the LZX-compressed XNB directly, so you **don't need TConvert** — just point
it at a folder of raw `Item_<id>.xnb` / `Buff_<id>.xnb`.

```bash
cd tools
npm install                       # installs the `xnb` decoder (build-time only)
node build-sprites.mjs <src-dir>  # e.g. a copy of .../tModLoader/Content/Images
pm2 restart terraria-status       # so the server re-detects the sprite set
```

Output → `../public/sprites/item/<id>.png` and `../public/sprites/buff/<id>.png`
(git-ignored). The page auto-detects the folders at startup and upgrades each glyph to
its sprite, keeping the glyph for any ID it can't find (incl. all modded items).

### Coverage note

The **dedicated server's** `Content/Images` only ships ~332 (mostly banner) item
sprites. For full coverage, use the **tModLoader client** install's
`Content/Images` (all ~5000 `Item_*.xnb`) as the source.

> These are Re-Logic assets — `public/sprites/` is git-ignored on purpose. Never commit them.
