# Status Export — server-side character-stats mod

> 🟢 **This mod is LIVE on the demo server** ([terraria.bobagi.space](https://terraria.bobagi.space)).
> A prebuilt `.tmod` is included in [`prebuilt/`](prebuilt/) — you can deploy it without
> building anything.

This small **tModLoader mod feeds the character-stats modal** on the status page:
alive/dead + respawn timer, **lifetime death count**, current biome, wealth (coins),
the item in hand, life / mana / defense, full inventory, equipped gear + vanity +
utility slots, ammo, and active buffs. It also emits a small **world summary**
(day/night + in-game clock, progression stage, blood-moon / eclipse flags, downed
bosses) that powers the site's world panel.

Without it, the site still shows **who** is online and for how long — it just
can't show their character details, because a vanilla tModLoader dedicated server
exposes only player *names* over its console (`playing`). There is no built-in
API/console command for character data, and **tShock's REST API does not work
with tModLoader** (they're mutually exclusive). A small mod is the only way.

## Why this doesn't force your friends to install anything

`build.txt` sets **`side = Server`**. A server-side mod:

- runs **only on the dedicated server**,
- is **not** added to the required modlist, so **players don't need it** and
  nobody gets kicked for not having it,
- reads only data the server already receives for multiplayer sync.

So you can enable it on the server alone.

It uses `PostUpdateEverything()` (the reliable per-tick hook on a dedicated
server) and is defensive: the whole export is wrapped in try/catch and logs once
on success/failure, so a bad read can never destabilize the server. When the
server is empty it idles (the file simply stops updating and the site shows no
stats — there's nobody to show); when players are online it refreshes every ~3 s.

> ℹ️ **"Level" is intentionally absent:** Terraria has no character levels unless
> you also run an RPG/leveling mod. Instead the mod emits a **world progression stage**
> (pré-boss → hardmode → pós-Plantera …) derived from the downed-boss flags. To add a
> real level, extend `BuildPlayer()` to read an RPG mod's data.
>
> ℹ️ **Death count** is tracked by the mod itself (via the `Kill` hook) and persisted to
> `playerdeaths.json` next to the world, keyed by character name, so it survives restarts.
>
> ⚠️ **Rebuild after a major tModLoader update.** A `.tmod` is tied to the tML
> version it was built against. After a big version bump, rebuild (below) if the
> server log shows the mod being skipped — the server still boots fine either way.

## How it works

`PostUpdateEverything()` (server only) throttles to every ~3 s and writes a JSON
snapshot to `playerstats.json` in the tModLoader save directory (`Main.SavePath`,
e.g. `/data/tModLoader` in the Docker image). The status app reads that file if
it's present and fresh (< 60 s old) and merges it into `/api/status`.

Each item carries a vanilla `id` (or `-1` for modded items), a coarse `kind` (weapon /
tool / armor / accessory / potion / block / ammo / coin / material) and a `rarity` int —
the site uses those to draw a rarity-framed category glyph, upgrading to a real pixel
sprite when `public/sprites/item/<id>.png` is present.

```json
{ "updatedAt": "…",
  "world": { "dayTime": false, "timeText": "21:14", "hardMode": true,
             "bloodMoon": true, "progression": "Pós-Plantera",
             "downed": { "plantera": true } },
  "players": [
    { "name": "Gustavo", "life": 280, "lifeMax": 400, "mana": 60, "manaMax": 200,
      "defense": 34, "difficulty": "Softcore", "dead": false, "respawnSec": 0,
      "deaths": 7, "biome": "Selva", "inventoryCount": 41,
      "wealth": { "plat": 1, "gold": 24, "silver": 7, "copper": 88 },
      "held": { "id": 65, "name": "Enchanted Sword", "prefix": "Legendary",
                "kind": "melee", "rarity": 3, "stack": 1 },
      "equips": [{ "id": 551, "name": "Molten Helmet", "kind": "armor", "rarity": 1 }],
      "buffs": [{ "id": 11, "name": "Ironskin" }],
      "inventory": [{ "id": 28, "name": "Lesser Healing Potion", "kind": "potion",
                      "rarity": 1, "stack": 20 }] } ] }
```

## Build

**Easiest:** just use the prebuilt [`prebuilt/StatusExport.tmod`](prebuilt/) and skip to Deploy.

**In-game:** install tModLoader, copy this folder to your `ModSources/StatusExport/`,
then **Workshop → Develop Mods → Build**.

**Headless** (how this repo's copy was built — no game GUI, works on a server):

```bash
# in a container/host that has tModLoader's files (tModLoader.dll + tMLMod.targets):
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /tmp/sdk
cp -r character-stats-mod /path/to/tModLoader/ModSources/StatusExport
cd /path/to/tModLoader/ModSources/StatusExport
PATH=/tmp/sdk:$PATH HOME=/tmp dotnet build -c Release
# → StatusExport.tmod lands in ~/.local/share/Terraria/tModLoader/Mods/
```

## Deploy (Docker server from the guide)

The [`jacobsmile/tmodloader1.4`](https://github.com/JACOBSMILE/tmodloader1.4) image
rebuilds `enabled.json` from `TMOD_ENABLEDMODS` (Steam Workshop IDs) on every boot,
which would wipe a plain local mod. The clean, **persistent** trick — and exactly how
it's deployed on the live server — is to give the local `.tmod` its own "workshop"
folder so the existing machinery enables it:

1. Drop the `.tmod` into a self-assigned Workshop-id folder **in the data volume**
   (pick a high id that won't collide, e.g. `9000000001`):
   ```
   data/steamMods/steamapps/workshop/content/1281930/9000000001/2026.05/StatusExport.tmod
   data/steamMods/steamapps/workshop/content/1281930/9000000001/workshop.json
   ```
   (`workshop.json`: `{"ContentType":"Mod","SteamEntryId":9000000001,"Publicity":0}`)
2. Add that id to **`TMOD_ENABLEDMODS`** in `docker-compose.yml` — but **NOT** to
   `TMOD_AUTODOWNLOAD` (steamcmd must never try to fetch a non-Workshop id).
3. `docker compose up -d`. The entrypoint resolves the id → `StatusExport` → enables
   it; tModLoader loads it. Within a few seconds `playerstats.json` appears next to
   your world and the site's player modal fills in automatically.

Because both the `.tmod` (data volume) and the id (compose env) persist, the mod stays
enabled across restarts and the guide's daily auto-update.

## Security / privacy

- Writes to the save dir only; no network, no ports, reads no secrets.
- The status site strips player IPs regardless and never exposes the console log.
- If you'd rather not publish inventory, trim `BuildPlayer` to taste.
