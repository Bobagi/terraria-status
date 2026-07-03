# Status Export — optional server-side mod

This small **tModLoader mod feeds the character-stats modal** on the status page
(health, mana, defense, equipped gear, inventory highlights, active buffs).

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

> ⚠️ **Reference implementation.** It's written against the documented tModLoader
> API and is deliberately minimal, but build and test it on a staging server
> before relying on it — it has not been validated against a live client in CI.
> "Level" is intentionally absent: **Terraria has no character levels** unless you
> also run an RPG/leveling mod (then extend `BuildPlayer` to read that mod's data).

## How it works

`PostUpdatePlayers()` (server only) throttles to every ~3 s and writes a JSON
snapshot to `playerstats.json` in the tModLoader save directory (`Main.SavePath`,
e.g. `/data/tModLoader` in the Docker image). The status app reads that file if
it's present and fresh (< 60 s old) and merges it into `/api/status`.

```json
{ "updatedAt": "…", "players": [
  { "name": "Gustavo", "life": 380, "lifeMax": 400, "mana": 120, "manaMax": 200,
    "defense": 34, "difficulty": "Softcore", "inventoryCount": 47,
    "equips": [{"name":"Molten Helmet"}], "buffs": ["Ironskin"],
    "inventory": [{"name":"Life Potion","stack":12}] } ] }
```

## Build

1. Install tModLoader (the game), open it, **Workshop → Develop Mods**.
2. Copy this folder to your tModLoader `ModSources/StatusExport/` directory.
3. **Build + Reload** (or `Build Mod`). This produces `StatusExport.tmod`.

(Headless/CI build is possible via `dotnet build` against tModLoader's
`tMLMod.targets`, but the in-game build is the supported path.)

## Deploy (Docker server from the guide)

1. Put `StatusExport.tmod` where the server loads mods (the `Mods` folder of the
   data volume, e.g. `data/tModLoader/Mods/StatusExport.tmod`).
2. Enable it. Since it's `side = Server`, you do **not** add it to the Workshop
   auto-download list players use — only the server needs the `.tmod`. Add its
   internal name to the server's enabled mods (or `enabled.json`).
3. Restart the server. Within a few seconds `playerstats.json` appears next to
   your world, and the site's player modal fills in automatically.

## Security / privacy

- Writes to the save dir only; no network, no ports, reads no secrets.
- The status site strips player IPs regardless and never exposes the console log.
- If you'd rather not publish inventory, trim `BuildPlayer` to taste.
