'use strict';
/*
 * terraria-status, live status page for the tModLoader dedicated server.
 *
 * Zero external deps. Polls Docker on timers and serves a cached JSON snapshot
 * at /api/status plus the static page. Runs on the HOST (under PM2) so it can
 * call `docker` without mounting docker.sock into an internet-facing container.
 *
 * SECURITY: the server console log contains the world password. This process
 * only ever extracts the `playing` command's player list from the logs and
 * strips IPs, it must NEVER surface raw log lines or the password to clients.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { isCompleteWorld } = require('./world-snapshot');
const { parsePlaying, NAME_MAX } = require('./console-players');
const { sanitizeModBosses, pickLive } = require('./world-extras');
const { parseEvents, recentKills } = require('./fight-events');
const { createFeed } = require('./discord-feed');
const askLib = require('./ask');

// ---- deploy config (override via environment; defaults match bobagi.space) --
const PORT = parseInt(process.env.STATUS_PORT || '3063', 10);
const HOST = process.env.STATUS_BIND || '127.0.0.1'; // keep localhost; expose via reverse proxy
// Public origin, used by robots.txt / sitemap.xml (SEO). Override when self-hosting.
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://terraria.bobagi.space').replace(/\/+$/, '');
const CONTAINER = process.env.TMOD_CONTAINER || 'tmodloader';
const DATA_DIR = process.env.TMOD_DATA_DIR || '/opt/terraria-tmodloader/data/tModLoader';
const WORLD_NAME = process.env.TMOD_WORLD || 'Hyperborea';
const WORLD_FILE = path.join(DATA_DIR, 'Worlds', WORLD_NAME + '.wld');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Optional: written by the companion server-side mod (see optional-serverside-mod/).
// If present & fresh, per-player character stats appear in the site's player modal.
const STATS_FILE = process.env.TMOD_STATS_FILE || path.join(DATA_DIR, 'playerstats.json');
// The world password (TMOD_PASS=... in the tmodloader .env) gates the day/night
// button: players already have it to join. Read server-side only, never sent out.
// No file or no TMOD_PASS = the button is off.
const PASS_FILE = process.env.TMOD_PASS_FILE || path.join(DATA_DIR, '..', '..', '.env');
// The mod rewrites the file every ~3 s while anyone is online. Newer than this, it
// is the live truth about who is connected.
const STATS_FRESH_MS = 15000;
// Boss fights, invasions and deaths, one JSON line each, written by the same mod
// (BossFights.cs). Feeds the Discord webhook and /api/fights.
const EVENTS_FILE = process.env.TMOD_EVENTS_FILE || path.join(DATA_DIR, 'serverevents.jsonl');

// ---- static, subject-known metadata --------------------------------------
const MODS = [
  { id: '2619954303', name: 'Recipe Browser',   rarity: 'blue',   desc: 'Busque qualquer receita e veja onde cada item é usado para criar.' },
  { id: '2563309347', name: 'Magic Storage',    rarity: 'purple', desc: 'Um baú central em rede: deposite, pesquise e crie direto do estoque.' },
  { id: '2669644269', name: 'Boss Checklist',   rarity: 'orange', desc: 'Checklist de progressão: bosses, ordem, drops e itens de invocação.' },
  { id: '2687866031', name: 'Census',           rarity: 'green',  desc: 'Checklist de NPCs: mostra o que cada morador precisa para aparecer.' },
  { id: '2599842771', name: 'AlchemistNPC Lite', rarity: 'lime',  desc: 'NPCs que vendem poções, buffs e viagem, puro quality-of-life.' },
  { id: '2565639705', name: 'Ore Excavator',    rarity: 'yellow', desc: 'Vein-mine: quebre um filão de minério ou uma árvore inteira num golpe.' },
  { id: '2908170107', name: 'SerousCommonLib',  rarity: 'gray',   desc: 'Biblioteca de suporte: o Magic Storage precisa dela (instala junto).' },
  { id: '3021379176', name: 'Steam Achievement Fix', rarity: 'cyan', desc: 'As conquistas que você desbloqueia aqui contam no seu perfil do Terraria na Steam, automático, o servidor já exige o mod.' },
  { id: '2570931073', name: "Fargo's Mutant Mod", rarity: 'red', desc: 'Construção instantânea (Instabridge, InstaHouse, Instavator) e o NPC Mutant, que vende invocações de bosses.' },
  { id: '2815540735', name: "Fargo's Souls Mod", rarity: 'purple', desc: 'Encantamentos, Souls e bosses novos. O Eternity Mode é opcional: só liga com o item Mutant\'s Gift.' },
  { id: '3222493606', name: 'Luminance', rarity: 'gray', desc: 'Biblioteca de suporte: o Fargo\'s Souls precisa dela (instala junto).' },
  { id: '2812377597', name: 'No Pylon Restrictions', rarity: 'cyan', desc: 'Permite mais de um Pylon de cada bioma, já que o mundo dobrou. O resto segue como no jogo normal: NPCs por perto, bioma certo e alcance.' },
  // Our own mod, published on the Workshop (Bobagi/InfernoAura).
  { id: '3834360329', name: 'Inferno Aura', rarity: 'orange',
    desc: 'Feito para este servidor: troca o anel gigante da Poção do Inferno por uma aura de fogo em volta do personagem. Só muda o visual, o dano é o mesmo.' },
];

const WORLD = {
  name: WORLD_NAME,
  size: process.env.TMOD_WORLD_SIZE || 'Small',
  difficulty: process.env.TMOD_DIFFICULTY || 'Expert',
  maxPlayers: parseInt(process.env.TMOD_MAXPLAYERS || '8', 10),
};

const SERVER = {
  host: process.env.SERVER_HOST || 'bobagi.space', // SEO/display only; players join by `ip` (domain is Cloudflare-proxied, HTTP only)
  ip: process.env.SERVER_IP || '150.230.85.106',
  port: parseInt(process.env.SERVER_PORT || '7777', 10),
  passwordProtected: true,
  steamAppId: 1281930,         // tModLoader on Steam (steam://run/<id> opens it)
  tmodloaderVersion: null,     // running version, filled live by collectVersion()
  latestVersion: null,         // latest stable on GitHub, filled by collectLatestVersion()
  upToDate: null,              // true/false/null, running >= latest?
  terrariaVersion: '1.4.4.9',
  // Whether a decoded pixel-sprite set is present (else the page draws category
  // glyphs). Populated once at startup from the public/sprites/ dirs.
  sprites: { item: false, buff: false, npc: false },
};

// A sprite set is "present" only if the dir exists AND holds at least one file -
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
  world: Object.assign({ lastSaveAt: null, live: null, progress: null, tiles: null }, WORLD),
  server: SERVER,
  mods: MODS,
  // "Pergunte ao Claude" box: on only when ASK_CLAUDE_BIN is set (see ask.js).
  ask: { enabled: false, maxQuestions: askLib.MAX_QUESTIONS, questionMax: askLib.QUESTION_MAX },
};

// Last complete copy of the world, for the /mapa/ viewer (the browser parses it).
let worldSnapshot = null; // { buf, etag, mtime }

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
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > 60000) return null;                     // stale mod output
    if (st.size > 2 * 1024 * 1024) return null;         // bound parse cost (full inventories × 8 players)
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const byName = Object.create(null);
    const arr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
    for (const p of arr) if (p && typeof p.name === 'string') byName[p.name] = p;
    // Newer mod builds also emit a live world summary (day/night, progression,
    // downed bosses); older ones don't, tolerate both.
    const world = (data && typeof data.world === 'object') ? data.world : null;
    return { byName, world, fresh: ageMs <= STATS_FRESH_MS };
  } catch (_) { return null; }
}

// The world's progress outlives the player stats: with nobody online the mod stops
// writing, but its last export is still true until someone plays again. So this one
// ignores the file's age. Only booleans leave here, whatever the file holds.
function readWorldProgress() {
  try {
    const st = fs.statSync(STATS_FILE);
    if (st.size > 2 * 1024 * 1024) return;
    const world = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).world;
    if (!world || typeof world.downed !== 'object' || !world.downed) return;
    const downed = {};
    for (const [key, value] of Object.entries(world.downed)) downed[key] = value === true;
    snapshot.world.progress = {
      crimson: world.crimson === true,
      downed,
      modBosses: sanitizeModBosses(world.modBosses, modBossIcons),
    };
    if (Number.isInteger(world.width) && Number.isInteger(world.height)
        && world.width > 0 && world.width <= 8401 && world.height > 0 && world.height <= 2401) {
      snapshot.world.tiles = { width: world.width, height: world.height };
    }
  } catch (_) { /* keep last */ }
}

// Icon files written by tools/build-modboss-icons.py. The export names a texture path;
// only a key that maps to one of these files ever reaches the page.
const MODBOSS_DIR = path.join(PUBLIC_DIR, 'sprites', 'modboss');
let modBossIcons = new Set();
function loadModBossIcons() {
  try { modBossIcons = new Set(fs.readdirSync(MODBOSS_DIR).filter((f) => /^[A-Za-z0-9_]+\.png$/.test(f)).map((f) => f.slice(0, -4))); }
  catch (_) { modBossIcons = new Set(); }
}

async function collectPlayers() {
  readWorldProgress();
  // Only meaningful while the container is up.
  if (!snapshot.online) {
    snapshot.players.count = 0; snapshot.players.list = []; snapshot.players.statsSource = false;
    snapshot.world.live = null;
    for (const n of Object.keys(sessions)) delete sessions[n];
    return;
  }
  await run('docker', ['exec', CONTAINER, 'inject', 'playing']);
  await new Promise((r) => setTimeout(r, 900));
  // Read the console straight from the tmux pane, fast and clean, unlike
  // `docker logs --tail` which gets slow once the json log grows large.
  const { err, out } = await run('docker', ['exec', CONTAINER, 'tmux', 'capture-pane', '-p', '-S', '-60']);
  if (err) return;
  // Player chat reaches this console and can hold line breaks, so a connected player
  // can print a fake `playing` reply. The mod reads Main.player directly: trust it
  // while it is live. The console only speaks for an empty server (the mod is idle
  // then, and a forgery needs a connected player) or a missing mod.
  const mod = readModStats();
  const names = mod && mod.fresh
    ? Object.keys(mod.byName).map((n) => n.slice(0, NAME_MAX)).slice(0, WORLD.maxPlayers)
    : parsePlaying(out);
  if (!names) return;                            // no complete reply on screen: keep the last list
  // Track session start (approx: first poll that sees the name) and drop leavers.
  const now = Date.now();
  for (const n of names) if (!sessions[n]) sessions[n] = now;
  for (const n of Object.keys(sessions)) if (!names.includes(n)) delete sessions[n];

  snapshot.players.statsSource = !!mod;
  snapshot.world.live = mod ? pickLive(mod.world) : null;   // live day/night, progression, events, tick rate (or null)
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
  // GitHub latest stable tag (unauthenticated: 60 req/h, this runs every 5 min).
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

async function collectWorldSnapshot() {
  const st = await fs.promises.stat(WORLD_FILE);
  if (worldSnapshot && worldSnapshot.mtime.getTime() === st.mtime.getTime()) return;
  const buf = await fs.promises.readFile(WORLD_FILE);
  if (!isCompleteWorld(buf, WORLD_NAME)) return;   // mid-save: keep the last good copy
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
  worldSnapshot = { buf, etag, mtime: st.mtime };
}

// Discord webhook (no-op until DISCORD_WEBHOOK_URL / discord-webhook.url exists).
const feed = createFeed({ dir: __dirname, eventsFile: EVENTS_FILE });

// Last boss kills for the site, parsed from the tail of the event log. Cached
// briefly: the page polls often and the file only grows.
let fightsCache = { at: 0, body: '[]' };
function fightsJson() {
  if (Date.now() - fightsCache.at < 10000) return fightsCache.body;
  let body = '[]';
  try {
    const st = fs.statSync(EVENTS_FILE);
    const from = Math.max(0, st.size - 512 * 1024);
    const fd = fs.openSync(EVENTS_FILE, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      let text = buf.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);   // drop the cut first line
      body = JSON.stringify(recentKills(parseEvents(text), 20));
    } finally { fs.closeSync(fd); }
  } catch (_) { /* no log yet */ }
  fightsCache = { at: Date.now(), body };
  return body;
}

// ---- poll loops ------------------------------------------------------------
async function fastLoop() {
  try { await collectInspect(); await collectStats(); snapshot.updatedAt = new Date().toISOString(); feed.onSnapshot(snapshot); }
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
async function worldLoop() {
  try { await collectWorldSnapshot(); } catch (_) {}
  finally { setTimeout(worldLoop, worldSnapshot ? 60 * 1000 : 5000); }
}

// ---- http ------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function serveWorld(req, res) {
  if (!worldSnapshot) { res.writeHead(503, { 'retry-after': '10' }); return res.end('world not ready'); }
  const { buf, etag, mtime } = worldSnapshot;
  const headers = {
    etag,
    'last-modified': mtime.toUTCString(),
    'cache-control': 'no-cache',
    'x-world-name': WORLD_NAME,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': buf.length });
  res.end(buf);
}

// fs.readFile throws synchronously on some bad paths instead of calling back;
// turn that into an ordinary error so no request can crash the server.
function readFileSafe(file, cb) {
  try { fs.readFile(file, cb); }
  catch (e) { cb(e); }
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('bad request'); } // malformed %-escape must not crash the process
  // A NUL byte (%00) makes fs throw synchronously, which used to kill the process:
  // one request was enough to take the site down.
  if (rel.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Prefix check WITH the separator, bare startsWith(PUBLIC_DIR) would also
  // match a sibling like public-evil/.
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  readFileSafe(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}

// ---- day/night button ------------------------------------------------------
// POST /api/time {"mode":"day"|"night","password":"..."}. The mode only picks one
// of two fixed console commands (dawn / dusk); nothing from the request reaches
// the console. Guards: JSON-only body (a cross-site HTML form can't send it), a
// 1 KB body cap, a timing-safe password check, a lockout per IP after failed
// passwords and a short global cooldown so the sky can't be strobed.
const TIME_COMMANDS = { day: 'dawn', night: 'dusk' };
const TIME_COOLDOWN_MS = 15000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const GLOBAL_FAIL_LIMIT = 30; // across all IPs: caps a brute force spread over many addresses
let globalFails = [];
const failsByIp = new Map(); // ip -> [timestamps]
let lastTimeChange = 0;

function worldPassword() {
  try {
    const m = /^\s*TMOD_PASS\s*=\s*(.*)$/m.exec(fs.readFileSync(PASS_FILE, 'utf8'));
    const v = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    return v || null;
  } catch (_) { return null; }
}

function sameSecret(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// The site only listens on 127.0.0.1 behind the Cloudflare tunnel, so this header
// can only come from cloudflared.
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').slice(0, 64);
}

function recentFails(ip, now) {
  const list = (failsByIp.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failsByIp.set(ip, list); else failsByIp.delete(ip);
  return list;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads a small JSON body and checks the world password, with the lockout shared by
// every password-gated endpoint. Calls next(data, ip) only for a correct password;
// every other case is answered here.
function withPassword(req, res, maxBody, next) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'json' });
  const ip = clientIp(req);
  let body = '', tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > maxBody) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) return;
    const now = Date.now();
    globalFails = globalFails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (globalFails.length >= GLOBAL_FAIL_LIMIT || recentFails(ip, now).length >= FAIL_LIMIT) return sendJson(res, 429, { error: 'bloqueado', retrySec: Math.ceil(FAIL_WINDOW_MS / 1000) });
    let data;
    try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'json' }); }
    if (!data || typeof data !== 'object') return sendJson(res, 400, { error: 'json' });
    const password = typeof data.password === 'string' ? data.password : '';
    const real = worldPassword();
    if (!real) return sendJson(res, 503, { error: 'desligado' });
    if (!password || !sameSecret(password, real)) {
      const list = recentFails(ip, now); list.push(now); failsByIp.set(ip, list);
      globalFails.push(now);
      return sendJson(res, 403, { error: 'senha', left: Math.max(0, FAIL_LIMIT - list.length) });
    }
    failsByIp.delete(ip);
    Promise.resolve(next(data, ip)).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: 'servidor' }); else res.end(); });
  });
}

function handleTime(req, res) {
  withPassword(req, res, 1024, async (data) => {
    const mode = typeof data.mode === 'string' ? data.mode : '';
    if (!Object.prototype.hasOwnProperty.call(TIME_COMMANDS, mode)) return sendJson(res, 400, { error: 'modo' });
    const now = Date.now();
    const wait = lastTimeChange + TIME_COOLDOWN_MS - now;
    if (wait > 0) return sendJson(res, 429, { error: 'espera', retrySec: Math.ceil(wait / 1000) });
    lastTimeChange = now;
    const { err } = await run('docker', ['exec', CONTAINER, 'inject', TIME_COMMANDS[mode]]);
    if (err) { lastTimeChange = 0; return sendJson(res, 502, { error: 'servidor' }); }
    await run('docker', ['exec', CONTAINER, 'inject', 'say [site] ' + (mode === 'day' ? 'Amanheceu' : 'Anoiteceu') + ' pelo botao do terraria.bobagi.space']);
    sendJson(res, 200, { ok: true, mode });
  });
}

// ---- "Pergunte ao Claude" ----------------------------------------------------
// POST /api/ask {"password","question","conversationId"?} or {"password","close":id}. Same password gate as the
// day/night button. The answer streams back as server-sent events:
//   event: status {kind}   the model is thinking / searching / reading a page
//   event: delta  {text}   a piece of the answer
//   event: done   {conversationId, used, max, closed, text}
//   event: error  {error}
// The session has web search only, nothing that can reach this host (see ask.js).
const ASK_HTTP = { curta: 400, longa: 400, ritmo: 429, ocupado: 429, fila: 429, orcamento: 429 };
let asker = null, askRun = null;
// Curated notes about this server's mods (ask-knowledge.md), appended to the system
// prompt. Edit the file and restart to teach the analyst something new.
function askKnowledge() {
  try { return fs.readFileSync(path.join(__dirname, 'ask-knowledge.md'), 'utf8'); } catch (_) { return ''; }
}

function startAsk() {
  const bin = process.env.ASK_CLAUDE_BIN;
  if (!bin) return;
  try { fs.accessSync(bin, fs.constants.X_OK); } catch (_) { console.log('ask: ASK_CLAUDE_BIN is not an executable, box disabled'); return; }
  askRun = askLib.createCliRunner({ bin, cwd: ASK_ROOM });
  const stale = askRun.forgetAll();   // conversations do not survive a restart: drop their transcripts
  if (stale) console.log('ask: ' + stale + ' transcricao(oes) antiga(s) apagada(s)');
  asker = askLib.createAsk({
    run: askRun,
    systemPrompt: askLib.buildSystemPrompt({ worldName: WORLD.name, worldSize: WORLD.size, difficulty: WORLD.difficulty, maxPlayers: WORLD.maxPlayers, mods: MODS, knowledge: askKnowledge() }),
    stateFile: path.join(__dirname, 'state', 'ask-usage.json'),
    sessionsFile: path.join(__dirname, 'state', 'ask-sessions.json'),
    log: (line) => console.log('ask: ' + line),
    limits: {
      dailyUsd: parseFloat(process.env.ASK_DAILY_USD || '') || undefined,
      monthlyUsd: parseFloat(process.env.ASK_MONTHLY_USD || '') || undefined,
    },
  });
  asker.start();
  // A restart or shutdown must not leave session processes behind.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { askRun.killAll(); process.exit(0); });
  snapshot.ask.enabled = true;
}

// The snapshot's player stats are up to 25 s old (playerLoop). For a question the mod's
// file is read again, so "what am I holding" matches what the player sees right now.
function freshSnapshot() {
  const mod = readModStats();
  if (!mod) return snapshot;
  const list = snapshot.players.list.map((p) => Object.assign({}, p, { stats: mod.byName[p.name] || p.stats }));
  return Object.assign({}, snapshot, { players: Object.assign({}, snapshot.players, { list }) });
}

// ---- the analyst's data room ------------------------------------------------
// Copies of game data written into the session's working directory before each
// question, so the analyst reads the same facts the owner would look up. Nothing secret
// goes in: no .env, no console log (it prints the password), no webhook, and every file
// is scrubbed of the world password and of IP addresses on top of that.
const ASK_ROOM = path.join(__dirname, 'state', 'ask-cwd');
const MODS_DIR = path.join(DATA_DIR, 'Mods');
const MODCONFIG_DIR = path.join(DATA_DIR, 'ModConfigs');
function readTail(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString('utf8');
      return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}
function readSmall(file, maxBytes) {
  try { return fs.statSync(file).size <= maxBytes ? fs.readFileSync(file, 'utf8') : ''; } catch (_) { return ''; }
}
function buildAskRoom() {
  const scrub = askLib.scrubber([worldPassword()]);
  const live = freshSnapshot();
  const pretty = (v) => JSON.stringify(v, null, 1);
  const files = {
    'jogadores.json': pretty({ geradoEm: new Date().toISOString(), online: live.players.list.map((p) => Object.assign({ onlineHaSeg: p.onlineForSec }, p.stats || { name: p.name })) }),
    'mundo.json': pretty({ servidorNoAr: live.online, mundo: live.world, tmodloader: live.server.tmodloaderVersion, terraria: live.server.terrariaVersion, noArHaSeg: live.container.uptimeSec }),
    'mods.json': pretty({ ligados: (() => { try { return JSON.parse(readSmall(path.join(MODS_DIR, 'enabled.json'), 65536)); } catch (_) { return []; } })(), descricao: MODS }),
    'lutas.jsonl': readTail(EVENTS_FILE, 400 * 1024),
    'mortes.json': readSmall(path.join(DATA_DIR, 'playerdeaths.json'), 256 * 1024),
    'notas.md': askKnowledge(),
    'site.md': ASK_SITE_NOTES,
  };
  try {
    for (const name of fs.readdirSync(MODCONFIG_DIR).filter((f) => /^[A-Za-z0-9_.-]+\.json$/.test(f)).slice(0, 30)) {
      const text = readSmall(path.join(MODCONFIG_DIR, name), 128 * 1024);
      if (text) files['config-' + name] = text;
    }
  } catch (_) { /* no mod configs */ }
  for (const k of Object.keys(files)) { if (!files[k]) delete files[k]; else files[k] = scrub(files[k]); }
  files['LEIA-ME.md'] = '# Dados do servidor (cópias somente leitura, refeitas a cada pergunta)\n\n'
    + Object.keys(files).sort().map((k) => '- ' + k + ': ' + (ASK_ROOM_INDEX[k] || (k.startsWith('config-') ? 'configuração de um mod (nome do mod no nome do arquivo)' : 'dados do servidor'))).join('\n') + '\n';
  askLib.writeDataRoom(ASK_ROOM, files);
}
const ASK_ROOM_INDEX = {
  'jogadores.json': 'quem está online agora e tudo o que cada personagem carrega',
  'mundo.json': 'progresso do mundo, bosses derrotados e que faltam, hora, eventos, versões',
  'mods.json': 'mods ligados no servidor e o que cada um faz',
  'lutas.jsonl': 'histórico de eventos, uma linha JSON cada: boss_kill e boss_wipe (dano por jogador, duração, mortes), death, invasões',
  'mortes.json': 'total de mortes por jogador',
  'notas.md': 'fatos já conferidos sobre os mods deste servidor',
  'site.md': 'o que o site e o servidor oferecem, comandos do chat',
};
const ASK_SITE_NOTES = [
  '# Site e servidor', '',
  '- Site: terraria.bobagi.space. Mostra quem está online (clicar no nome abre os detalhes do personagem), CPU e memória, bosses derrotados, mods, o mapa do mundo em /mapa/ e um botão de dia/noite com a senha do servidor.',
  '- Comandos do chat para jogadores: /ping, /playing, /roll, /p texto.',
  '- Dar item, curar, teleportar e outros comandos de administração só existem no console do servidor, que só o dono (Gustavo) usa.',
  '- O Discord do grupo recebe aviso de cada chefe derrotado com dano e DPS por jogador, e um ranking semanal.',
  '- O servidor atualiza o tModLoader sozinho uma vez por dia.',
].join('\n');

function handleAsk(req, res) {
  withPassword(req, res, 4096, async (data, ip) => {
    if (!asker) return sendJson(res, 503, { error: 'desligado' });
    // {"close": id}: the player started a new conversation, end the old session now.
    if (typeof data.close === 'string') return sendJson(res, 200, { ok: true, closed: !!asker.close(data.close.slice(0, 64)) });
    const abort = new AbortController();
    let open = false;
    const send = (event, obj) => { if (open && !res.writableEnded) res.write('event: ' + event + '\ndata: ' + JSON.stringify(obj) + '\n\n'); };
    res.on('close', () => abort.abort());
    // Headers go out on the first event, so a limit hit before the model runs is
    // still a plain JSON error with its own status code.
    const begin = () => {
      if (open) return;
      open = true;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    };
    const started = Date.now();
    try {
      try { buildAskRoom(); } catch (_) { /* the analyst still answers from the prompt state */ }
      const out = await asker.ask({
        ip,
        conversationId: typeof data.conversationId === 'string' ? data.conversationId.slice(0, 64) : null,
        question: data.question,
        serverState: askLib.buildServerState(freshSnapshot()),
        signal: abort.signal,
        onEvent: (ev) => { begin(); send(ev.type, ev.type === 'delta' ? { text: ev.text } : { kind: ev.kind }); },
      });
      begin();
      // Never the question or the answer: only sizes and cost reach the log.
      console.log(`ask: ok ${Math.round((Date.now() - started) / 1000)}s pergunta ${out.used}/${out.max} ~$${out.costUsd.toFixed(4)}`);
      send('done', { conversationId: out.conversationId, used: out.used, max: out.max, closed: out.closed, text: out.text });
      res.end();
    } catch (e) {
      const code = e instanceof askLib.AskError ? e.code : (abort.signal.aborted ? 'cancelado' : 'claude');
      if (code !== 'cancelado' && !ASK_HTTP[code]) console.log('ask: falhou (' + code + ')');
      if (!open) return sendJson(res, ASK_HTTP[code] || 502, Object.assign({ error: code }, e.extra));
      send('error', Object.assign({ error: code }, e.extra));
      res.end();
    }
  });
}

http.createServer((req, res) => {
  if (req.url === '/api/time') return handleTime(req, res);
  if (req.url === '/api/ask') return handleAsk(req, res);
  if (req.url === '/api/status' || req.url.startsWith('/api/status?')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(snapshot));
  }
  if (req.url === '/api/fights' || req.url.startsWith('/api/fights?')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(fightsJson());
  }
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.url.split('?')[0] === '/mapa/mundo.wld') return serveWorld(req, res);
  if (req.url === '/mapa') { res.writeHead(301, { location: '/mapa/' }); return res.end(); }
  // SEO: página única, então sitemap e robots são estáticos e curtos.
  // /api/ fora do índice (JSON, muda a cada poll, não é conteúdo de busca).
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  }
  if (req.url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    return res.end(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + `  <url>\n    <loc>${SITE_ORIGIN}/mapa/</loc>\n    <changefreq>daily</changefreq>\n  </url>\n`
      + `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n`
      + `    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n`
      + '    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>\n'
      + '</urlset>\n'
    );
  }
  serveStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`terraria-status listening on http://${HOST}:${PORT}`);
  SERVER.sprites = { item: hasSprites('item'), buff: hasSprites('buff'), npc: hasSprites('npc') };
  loadModBossIcons();
  fastLoop(); diskLoop(); worldLoop();
  feed.start();
  startAsk();
  setTimeout(playerLoop, 3000); // let the first inspect land so `online` is known

});
