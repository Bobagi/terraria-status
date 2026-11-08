# Status Export - server-side character-stats mod

> 🟢 **This mod is LIVE on the demo server** ([terraria.bobagi.space](https://terraria.bobagi.space)).
> A prebuilt `.tmod` is included in [`prebuilt/`](prebuilt/) - you can deploy it without
> building anything.

This small **tModLoader mod feeds the character-stats modal** on the status page:
alive/dead + respawn timer, **lifetime death count**, current biome, wealth (coins),
the item in hand, life / mana / defense, full inventory, equipped gear + vanity +
utility slots, ammo, and active buffs. It also emits a small **world summary**
(day/night + in-game clock, progression stage, blood-moon / eclipse flags, downed
bosses) that powers the site's world panel.

Without it, the site still shows **who** is online and for how long - it just
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
stats - there's nobody to show); when players are online it refreshes every ~3 s.

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
> server log shows the mod being skipped - the server still boots fine either way.

## How it works

`PostUpdateEverything()` (server only) throttles to every ~3 s and writes a JSON
snapshot to `playerstats.json` in the tModLoader save directory (`Main.SavePath`,
e.g. `/data/tModLoader` in the Docker image). The status app reads that file if
it's present and fresh (< 60 s old) and merges it into `/api/status`.

Each item carries a vanilla `id` (or `-1` for modded items), a coarse `kind` (weapon /
tool / armor / accessory / potion / block / ammo / coin / material) and a `rarity` int, 
the site uses those to draw a rarity-framed category glyph, upgrading to a real pixel
sprite when `public/sprites/item/<id>.png` is present.

```json
{ "updatedAt": "…",
  "world": { "dayTime": false, "timeText": "21:14", "hardMode": true,
             "bloodMoon": true, "progression": "Pós-Plantera",
             "downed": { "plantera": true },
             "width": 8400, "height": 1200, "tps": 59.9,
             "modBosses": [{ "key": "FargowiltasSouls Mutant", "mod": "FargowiltasSouls",
               "name": "Mutant", "kind": "boss", "progression": 23, "downed": false,
               "head": "FargowiltasSouls/Content/Bosses/MutantBoss/MutantBoss_Head_Boss" }] },
  "players": [
    { "name": "Gustavo", "life": 280, "lifeMax": 400, "mana": 60, "manaMax": 200,
      "defense": 34, "difficulty": "Softcore", "dead": false, "respawnSec": 0,
      "deaths": 7, "pingMs": 55, "biome": "Selva", "inventoryCount": 41,
      "wealth": { "plat": 1, "gold": 24, "silver": 7, "copper": 88 },
      "held": { "id": 65, "name": "Enchanted Sword", "prefix": "Legendary",
                "kind": "melee", "rarity": 3, "stack": 1 },
      "equips": [{ "id": 551, "name": "Molten Helmet", "kind": "armor", "rarity": 1 }],
      "buffs": [{ "id": 11, "name": "Ironskin" }],
      "inventory": [{ "id": 28, "name": "Lesser Healing Potion", "kind": "potion",
                      "rarity": 1, "stack": 20 }] } ] }
```

## Console admin commands

`AdminCommands.cs` adds commands that only exist on the **server console** (`CommandType.Console`),
never in the in-game chat. Run them from the host with `tools/tmod-admin.sh "<command>"`, which
injects the command and prints the reply. Players still need nothing: items, NPCs and events are
created by the server and synced with vanilla packets.

| Command | What it does |
| --- | --- |
| `who` | Online players: life, mana, position |
| `find <item\|npc\|buff> <text>` | Looks up ids by name |
| `give <player> <item> [amount] [prefix]` | Item by id or name (`Terra_Blade`), any amount up to 50 piles. Goes straight into the inventory (Void Bag when full), see below |
| `coins <player> <platinum> [gold] [silver] [copper]` | Coins |
| `heal <player\|all>` | Fills life and mana (drops hearts and stars, the client owns these values) |
| `bag <player>` | Lists the player's Void Bag, read only: the client owns that storage |
| `buff <player> <buff> [seconds]` | Applies a buff |
| `tp <player> <player\|spawn\|dungeon\|x y>` | Teleports, `x y` in tiles |
| `spawn <npc\|boss> <player> [amount]` | Spawns near the player, up to 20 |
| `coffin <player\|reset>` | Moves the Fargo's Souls Cursed Coffin arena onto the player and spawns the boss; `reset` removes it after the fight |
| `oregen <cobalt\|palladium\|mythril\|orichalcum\|adamantite\|titanium> [veins]` | Adds new ore veins underground, 60 by default, up to 300 |
| `clearhostile` | Removes enemies and bosses without drops, keeps critters and target dummies |
| `clearitems` | Deletes every item lying on the ground in the world |
| `townnpcs` | Spawns every missing resident at once, at the world spawn (then they look for a free house): the ones the game would let spawn now plus every town NPC that already lived in this world (bestiary chat record), vanilla and modded. Skips Old Man and the traveling/skeleton merchants |
| `cleargraves <player> [radius]` | Deletes tombstones (and their epitaphs) around the player, 150 tiles by default, up to 1000, without dropping the stone |
| `event <bloodmoon\|eclipse\|goblins\|frost\|pirates\|martians\|pumpkinmoon\|frostmoon\|rain\|stop>` | World events, `stop` ends them all |
| `moon <full\|new\|0-7> [night]` | Sets the moon phase right away (0 = full, 4 = new); vanilla only advances it at a natural dawn. `night` also starts the night if it is day |
| `spawnrate [1-10]` | Shows or changes the natural enemy spawn multiplier (`SpawnRate.cs`: spawn interval divided and enemy cap multiplied by it). Default 3x, back to the default on restart |
| `pings` | Round-trip latency of each online player (end-to-end echo, see `/ping` below) |

## Boss fights and world events (`BossFights.cs`)

Appends one JSON line per event to `serverevents.jsonl` in the save directory (rotated at 20 MB). The
status app turns them into Discord messages and `/api/fights`; see "Discord feed" in the main README.

| `type` | Fields |
| --- | --- |
| `boss_kill` | `boss`, `bossKey` (NPCID name, or the mod's `Mod/Class`), `durationSec`, `participants[{name, damage, deaths}]` |
| `boss_wipe` | same, plus `lifePct`: the boss despawned or the party died |
| `event_start` / `event_end` | `event` (`bloodMoon`, `eclipse`, `pumpkinMoon`, `frostMoon`, `goblins`, `frostLegion`, `pirates`, `martians`, `oldOnesArmy`), `durationSec` on end |
| `death` | `name`, `inBoss` |

Every line also has `v` (1), `id` and `t` (UTC). Damage is measured from the strike packet (28) as the boss's life
lost, not read from `OnHitBy*`, which run on the client; see the main README. Whatever is already running when
the server boots is not announced as an event, and `clearhostile` clears fights without reporting them.


## Build

**Easiest:** just use the prebuilt [`prebuilt/StatusExport.tmod`](prebuilt/) and skip to Deploy.

**In-game:** install tModLoader, copy this folder to your `ModSources/StatusExport/`,
then **Workshop → Develop Mods → Build**.

**Headless** (how this repo's copy was built - no game GUI, works on a server):

```bash
# in a container/host that has tModLoader's files (tModLoader.dll + tMLMod.targets):
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /tmp/sdk
cp -r character-stats-mod /path/to/tModLoader/ModSources/StatusExport
cd /path/to/tModLoader/ModSources/StatusExport
PATH=/tmp/sdk:$PATH HOME=/tmp dotnet build -c Release
# → StatusExport.tmod lands in ~/.local/share/Terraria/tModLoader/Mods/
```

## Items go straight into the inventory

The inventory belongs to the client: vanilla ignores slot packets for your own character, so the server can't write it. An item the server spawns is also reserved for the server (owner 255), and nobody can grab it until the owner check hands it over, which is why `give` used to leave piles on the ground behind a moving player. `Drop` now spawns each pile at the player's center already reserved for them and sends `ItemOwner`, so their client grabs it on the next frame (into the Void Bag when the inventory is full).

## Ore drops

`OreDrops` makes every ore block drop 5 times (`Multiplier` in `AdminCommands.cs`), including blocks a player placed.

## Full life on respawn

Players normally respawn at half life. Life is owned by the client, which ignores the heal packet (a monitor over 12 respawns saw every one stay at half). So `RespawnHeal`, like the `heal` command, drops hearts on the player 0.5 s and 2 s after the revive whenever the life the client reports is below max, and the client heals itself picking them up. The revive is read from the client's spawn packet and from the server's `dead` flag, with nothing installed on the client.

## Reconnecting after a dropped connection

A dead connection normally holds its name for about two minutes ("X is already on this
server"). `GhostSessions.cs` ends the old session as soon as the same name connects again,
if the newcomer has the same IP or the old session has been silent for 5 seconds. A player
who is really online can't be pushed out from another IP.

## Deploy (Docker server from the guide)

The [`jacobsmile/tmodloader1.4`](https://github.com/JACOBSMILE/tmodloader1.4) image
rebuilds `enabled.json` from `TMOD_ENABLEDMODS` (Steam Workshop IDs) on every boot,
which would wipe a plain local mod. The clean, **persistent** trick - and exactly how
it's deployed on the live server - is to give the local `.tmod` its own "workshop"
folder so the existing machinery enables it:

1. Drop the `.tmod` into a self-assigned Workshop-id folder **in the data volume**
   (pick a high id that won't collide, e.g. `9000000001`):
   ```
   data/steamMods/steamapps/workshop/content/1281930/9000000001/2026.05/StatusExport.tmod
   data/steamMods/steamapps/workshop/content/1281930/9000000001/workshop.json
   ```
   (`workshop.json`: `{"ContentType":"Mod","SteamEntryId":9000000001,"Publicity":0}`)
2. Add that id to **`TMOD_ENABLEDMODS`** in `docker-compose.yml` - but **NOT** to
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

### World extras

- `tps`: world updates per second (`TickRate.cs`); 60 is full speed, lower means the server itself lags.
  `null` while nobody plays, because the server sleeps then.
- `modBosses`: every boss, miniboss and event other mods register with **Boss Checklist**, read through its
  `GetBossInfoDictionary` call (`ModBosses.cs`). Vanilla entries stay in `downed`. `head` names the map-head
  texture; the site only uses it to find an icon that `tools/build-modboss-icons.py` extracted.
- `downed.eaterOfWorlds` / `downed.brainOfCthulhu`: vanilla keeps one flag for both (`NPC.downedBoss2`,
  still exported as `evilBoss`), and so does Boss Checklist. `EvilBosses.cs` records each kill in the
  world save; kills from before it existed come from the world's bestiary kill counts.
- `downed.bloodMoon`, `eclipse`, `pumpkinMoon`, `frostMoon`, `flyingDutchman`, `martianSaucer`: vanilla
  never records these, so they come from Boss Checklist's own flags (only since it was installed).
  The four pillars and `oldOnesArmy` are vanilla flags.
- `pingMs` per player: end-to-end round trip (`PingEcho`), the same number `/ping` shows.

### `/ping` in game

`/ping` in the chat answers only the player who typed it: their round trip to the server and
its variation. Every 3 s the server sends the vanilla `ReleaseItemOwnership` message (39) for
a free (inactive) item slot and times the client's automatic `ItemOwner` reply (22), which it
then swallows (idea from the TShock [PingPlugin](https://github.com/simon311/PingPlugin)).
Nothing to install on the client, and it works behind a tunnel: the old Linux `TCP_INFO`
reading measured the tunnel agent (playit.gg on the same box), so everyone showed ~1 ms. That
reading is kept only as a fallback for direct, public connections. The value includes up to
one server tick (~17 ms), the latency the player feels in game. Above about 150 ms Terraria
starts to feel laggy.

Behind a tunnel every player also shares one private source address, so `GhostSessions`
ignores equal addresses that are loopback/private and decides by the 5 s silence rule alone.

