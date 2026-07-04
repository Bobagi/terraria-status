'use strict';
/*
 * terraria-status — live status page for the tModLoader dedicated server.
 *
 * Zero external deps. Polls Docker on timers and serves a cached JSON snapshot
 * at /api/status plus the static page. Runs on the HOST (under PM2) so it can
 * call `docker` without mounting docker.sock into an internet-facing container.
 *
 * SECURITY: the server console log contains the world password. This process
 * only ever extracts the `playing` command's player list from the logs and
 * strips IPs — it must NEVER surface raw log lines or the password to clients.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---- deploy config (override via environment; defaults match bobagi.space) --
const PORT = parseInt(process.env.STATUS_PORT || '3063', 10);
const HOST = process.env.STATUS_BIND || '127.0.0.1'; // keep localhost; expose via reverse proxy
const CONTAINER = process.env.TMOD_CONTAINER || 'tmodloader';
const DATA_DIR = process.env.TMOD_DATA_DIR || '/opt/terraria-tmodloader/data/tModLoader';
const WORLD_NAME = process.env.TMOD_WORLD || 'Hyperborea';
const WORLD_FILE = path.join(DATA_DIR, 'Worlds', WORLD_NAME + '.wld');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Optional: written by the companion server-side mod (see optional-serverside-mod/).
// If present & fresh, per-player character stats appear in the site's player modal.
const STATS_FILE = process.env.TMOD_STATS_FILE || path.join(DATA_DIR, 'playerstats.json');

// ---- static, subject-known metadata --------------------------------------
const MODS = [
  { id: '2619954303', name: 'Recipe Browser',   rarity: 'blue',   desc: 'Search every recipe and see what an item is used to craft.' },
  { id: '2563309347', name: 'Magic Storage',    rarity: 'purple', desc: 'One networked storage hub — deposit, search and auto-craft from it.' },
  { id: '2669644269', name: 'Boss Checklist',   rarity: 'orange', desc: 'Progression checklist: bosses, order, drops and summon items.' },
  { id: '2687866031', name: 'Census',           rarity: 'green',  desc: 'Town NPC checklist — shows what each townsfolk needs to move in.' },
  { id: '2599842771', name: 'AlchemistNPC Lite', rarity: 'lime',  desc: 'Buy potions, buffs and travel — quality-of-life alchemist NPCs.' },
  { id: '2565639705', name: 'Ore Excavator',    rarity: 'yellow', desc: 'Vein-mine: break a whole ore vein or tree in one swing.' },
  { id: '2908170107', name: 'SerousCommonLib',  rarity: 'gray',   desc: 'Support library — Magic Storage needs it to work (auto-installs with it).' },
];

const WORLD = {
  name: WORLD_NAME,
  size: process.env.TMOD_WORLD_SIZE || 'Small',
  difficulty: process.env.TMOD_DIFFICULTY || 'Expert',
  maxPlayers: parseInt(process.env.TMOD_MAXPLAYERS || '8', 10),
};

const SERVER = {
  host: process.env.SERVER_HOST || 'bobagi.space', // domain players type — friendlier than the raw IP
  ip: process.env.SERVER_IP || '46.202.144.75',
  port: parseInt(process.env.SERVER_PORT || '7777', 10),
  passwordProtected: true,
  steamAppId: 1281930,         // tModLoader on Steam (steam://run/<id> opens it)
  tmodloaderVersion: null,     // running version, filled live by collectVersion()
  latestVersion: null,         // latest stable on GitHub, filled by collectLatestVersion()
  upToDate: null,              // true/false/null — running >= latest?
  terrariaVersion: '1.4.4.9',
  // Whether a decoded pixel-sprite set is present (else the page draws category
  // glyphs). Populated once at startup from the public/sprites/ dirs.
  sprites: { item: false, buff: false, npc: false },
};

// A sprite set is "present" only if the dir exists AND holds at least one file —
// an empty dir must not switch the page into 404-per-item mode.
function hasSprites(sub) {
  try {
    const dir = path.join(PUBLIC_DIR, 'sprites', sub);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(png|webp|jpe?g)$/i.test(f));
  } catch (_) { return false; }
}

// ---- live snapshot (served to clients) ------------------------------------
let snapshot = {
  updatedAt: null,
  online: false,
  container: { status: 'unknown', startedAt: null, uptimeSec: null, restarts: null },
  resources: {
    cpuPerc: null,
    memUsedBytes: null, memLimitBytes: null, memPerc: null,
    memUsedText: null, memLimitText: null,
    netRxText: null, netTxText: null,
    diskWorldBytes: null,
  },
  // list: [{ name, onlineForSec, stats|null }]. statsSource=true when the optional
  // companion mod is feeding playerstats.json (life/gear/inventory); false → names only.
  players: { count: 0, max: WORLD.maxPlayers, list: [], statsSource: false, sampledAt: null },
  world: Object.assign({ lastSaveAt: null, live: null }, WORLD),
  server: SERVER,
  mods: MODS,
};

// name -> firstSeen epoch ms, so we can show "online for ~X" without a mod.
const sessions = Object.create(null);

// ---- helpers ---------------------------------------------------------------
function run(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ err, out: (stdout || '').toString() });
    });
  });
}

// "1.27GiB", "4GiB", "512MiB", "1.5GB", "32.4MB" -> bytes
function toBytes(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }[unit];
  return mult ? Math.round(n * mult) : null;
}

// ---- collectors ------------------------------------------------------------
async function collectInspect() {
  const { err, out } = await run('docker', ['inspect', CONTAINER]);
  if (err) { snapshot.online = false; snapshot.container.status = 'down'; return; }
  try {
    const info = JSON.parse(out)[0];
    const running = !!(info.State && info.State.Running);
    snapshot.online = running;
    snapshot.container.status = info.State ? info.State.Status : 'unknown';
    snapshot.container.restarts = info.RestartCount;
    const started = info.State && info.State.StartedAt;
    if (started && started !== '0001-01-01T00:00:00Z') {
      snapshot.container.startedAt = started;
      snapshot.container.uptimeSec = Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 1000));
    }
  } catch (_) { /* keep last */ }
}

async function collectStats() {
  const { err, out } = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', CONTAINER]);
  if (err || !out.trim()) return;
  try {
    const s = JSON.parse(out.trim().split('\n')[0]);
    const r = snapshot.resources;
    r.cpuPerc = parseFloat(s.CPUPerc);
    r.memPerc = parseFloat(s.MemPerc);
    const [used, limit] = (s.MemUsage || '').split('/').map((x) => x.trim());
    r.memUsedText = used || null;
    r.memLimitText = limit || null;
    r.memUsedBytes = toBytes(used);
    r.memLimitBytes = toBytes(limit);
    const [rx, tx] = (s.NetIO || '').split('/').map((x) => x.trim());
    r.netRxText = rx || null;
    r.netTxText = tx || null;
  } catch (_) { /* keep last */ }
}

// Optional per-player character stats, written by the companion server-side mod.
// Ignored if missing or stale (>60 s old) so a crashed/removed mod can't show
// ghost data. Never throws.
function readModStats() {
  try {
    const st = fs.statSync(STATS_FILE);
    if (Date.now() - st.mtimeMs > 60000) return null;   // stale mod output
    if (st.size > 2 * 1024 * 1024) return null;         // bound parse cost (full inventories × 8 players)
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const byName = Object.create(null);
    const arr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
    for (const p of arr) if (p && typeof p.name === 'string') byName[p.name] = p;
    // Newer mod builds also emit a live world summary (day/night, progression,
    // downed bosses); older ones don't — tolerate both.
    const world = (data && typeof data.world === 'object') ? data.world : null;
    return { byName, world };
  } catch (_) { return null; }
}

async function collectPlayers() {
  // Only meaningful while the container is up.
  if (!snapshot.online) {
    snapshot.players.count = 0; snapshot.players.list = []; snapshot.players.statsSource = false;
    snapshot.world.live = null;
    for (const n of Object.keys(sessions)) delete sessions[n];
    return;
  }
  await run('docker', ['exec', CONTAINER, 'inject', 'playing']);
  await new Promise((r) => setTimeout(r, 900));
  // Read the console straight from the tmux pane — fast and clean, unlike
  // `docker logs --tail` which gets slow once the json log grows large.
  const { err, out } = await run('docker', ['exec', CONTAINER, 'tmux', 'capture-pane', '-p', '-S', '-60']);
  if (err) return;
  const lines = out.split('\n').map((l) => l.replace(/\r$/, ''));
  // Find the LAST echoed `playing` command, then read the server reply lines.
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'playing') { idx = i; break; }
  }
  if (idx === -1) return;
  const names = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.startsWith(': ')) break;          // reply lines are prefixed with ": "
    const body = raw.slice(2).trim();
    if (!body) continue;
    // "No players connected." ends the block; a "N players connected:" header is skipped.
    if (/connected/i.test(body)) { if (/^no players/i.test(body)) break; else continue; }
    // A player entry may look like "Name" or "Name (1.2.3.4:port)". Keep the name,
    // strip any parenthetical / IP so we never publish a player's address.
    let name = body.replace(/\s*\(.*$/, '').replace(/\s*\d{1,3}(\.\d{1,3}){3}.*$/, '').trim();
    if (name && !/^<server>/i.test(name)) names.push(name.slice(0, 24));
    if (names.length >= WORLD.maxPlayers) break;
  }
  // Track session start (approx: first poll that sees the name) and drop leavers.
  const now = Date.now();
  for (const n of names) if (!sessions[n]) sessions[n] = now;
  for (const n of Object.keys(sessions)) if (!names.includes(n)) delete sessions[n];

  const mod = readModStats();
  snapshot.players.statsSource = !!mod;
  snapshot.world.live = mod ? mod.world : null;   // live day/night, progression, downed bosses (or null)
  snapshot.players.list = names.map((n) => ({
    name: n,
    onlineForSec: Math.floor((now - sessions[n]) / 1000),
    stats: (mod && mod.byName[n]) || null,
  }));
  snapshot.players.count = names.length;
  snapshot.players.sampledAt = new Date().toISOString();
}

async function collectVersion() {
  // The running version is printed to Launch.log at boot ("tModLoader v2026.5.3.0").
  const { err, out } = await run('docker', ['exec', CONTAINER, 'sh', '-c',
    "grep -hoE 'tModLoader v[0-9.]+' /terraria-server/tModLoader-Logs/Launch.log 2>/dev/null | tail -1"]);
  if (!err) {
    const m = out.match(/tModLoader v([\d.]+)/);
    if (m) { snapshot.server.tmodloaderVersion = m[1]; return; }
  }
  // Fallback: the version label our Dockerfile stamps on the image.
  const lbl = await run('docker', ['inspect', '--format', '{{index .Config.Labels "tmod.version"}}', CONTAINER]);
  if (!lbl.err) {
    const v = lbl.out.trim().replace(/^v/, '');
    if (v) snapshot.server.tmodloaderVersion = v;
  }
}

// Compare dotted numeric versions ("2026.5.3.0" vs "2026.05.3.0"). Sign of a-b.
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function collectLatestVersion() {
  // GitHub latest stable tag (unauthenticated: 60 req/h — this runs every 5 min).
  try {
    const resp = await fetch('https://api.github.com/repos/tModLoader/tModLoader/releases/latest', {
      headers: { 'user-agent': 'terraria-status', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return;
    const j = await resp.json();
    const tag = String(j.tag_name || '').replace(/^v/, '');
    if (!/^\d/.test(tag)) return;
    snapshot.server.latestVersion = tag;
    const cur = snapshot.server.tmodloaderVersion;
    snapshot.server.upToDate = cur ? cmpVer(cur, tag) >= 0 : null;
  } catch (_) { /* keep last */ }
}

async function collectDisk() {
  const { err, out } = await run('du', ['-sb', path.join(DATA_DIR, 'Worlds')]);
  if (!err) {
    const n = parseInt(out.split(/\s+/)[0], 10);
    if (!isNaN(n)) snapshot.resources.diskWorldBytes = n;
  }
  fs.stat(WORLD_FILE, (e, st) => { if (!e) snapshot.world.lastSaveAt = st.mtime.toISOString(); });
}

// ---- poll loops ------------------------------------------------------------
async function fastLoop() {
  try { await collectInspect(); await collectStats(); snapshot.updatedAt = new Date().toISOString(); }
  catch (_) {}
  finally { setTimeout(fastLoop, 8000); }
}
async function playerLoop() {
  try { await collectPlayers(); } catch (_) {}
  finally { setTimeout(playerLoop, 25000); }
}
async function diskLoop() {
  try { await collectDisk(); await collectVersion(); await collectLatestVersion(); } catch (_) {}
  finally { setTimeout(diskLoop, 5 * 60 * 1000); }
}

// ---- http ------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('bad request'); } // malformed %-escape must not crash the process
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Prefix check WITH the separator — bare startsWith(PUBLIC_DIR) would also
  // match a sibling like public-evil/.
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  if (req.url === '/api/status' || req.url.startsWith('/api/status?')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(snapshot));
  }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  serveStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`terraria-status listening on http://${HOST}:${PORT}`);
  SERVER.sprites = { item: hasSprites('item'), buff: hasSprites('buff'), npc: hasSprites('npc') };
  fastLoop(); diskLoop();
  setTimeout(playerLoop, 3000); // let the first inspect land so `online` is known

});
