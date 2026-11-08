'use strict';
/*
 * Discord feed: turns the server-side mod's event log (serverevents.jsonl) into
 * themed webhook messages: boss kills with damage/DPS per player, invasions and
 * moons, a weekly ranking, and server up/down notices.
 *
 * Why it lives here and not in the mod: the mod stays offline (it only writes a
 * file), the webhook URL (a secret) lives only on the host, and a Discord outage
 * can never touch the game server. Zero npm dependencies, like the rest of the app.
 *
 * Disabled (a no-op) unless a webhook URL is configured:
 *   DISCORD_WEBHOOK_URL   the URL itself, or
 *   DISCORD_WEBHOOK_FILE  a file holding the URL (default ./discord-webhook.url)
 */

const fs = require('fs');
const path = require('path');
const { parseEventLine, parseEvents, aggregate, dps } = require('./fight-events');

const FOOTER = 'ENCALHADOS · Terraria';
const BOT_NAME = 'Guia';
const POLL_MS = 5000;
const SEND_GAP_MS = 1100;          // webhooks allow ~5 requests per 2 s
const MAX_READ_BYTES = 1024 * 1024;
const WEEKLY_HOUR_UTC = 23;        // Sunday 20:00 in Brasília

// Keys are NPCID names (NPCID.Search.GetName) or the mod's group keys. Anything
// unknown (modded bosses) falls back to the name the game reported.
const BOSSES = {
  KingSlime:       { pt: 'Rei Slime',            emoji: '👑', color: 0x5b8def },
  EyeofCthulhu:    { pt: 'Olho de Cthulhu',      emoji: '👁️', color: 0xc0392b },
  EaterofWorlds:   { pt: 'Devorador de Mundos',  emoji: '🪱', color: 0x8e44ad },
  BrainofCthulhu:  { pt: 'Cérebro de Cthulhu',   emoji: '🧠', color: 0xd9534f },
  QueenBee:        { pt: 'Abelha Rainha',        emoji: '🐝', color: 0xf1c40f },
  Skeletron:       { pt: 'Esqueletron',          emoji: '💀', color: 0xbdc3c7 },
  Deerclops:       { pt: 'Deerclops',            emoji: '🦌', color: 0x95a5a6 },
  WallofFlesh:     { pt: 'Parede de Carne',      emoji: '🔥', color: 0xe74c3c },
  QueenSlimeBoss:  { pt: 'Rainha Slime',         emoji: '🌸', color: 0xe08df0 },
  TheDestroyer:    { pt: 'O Destruidor',         emoji: '🛠️', color: 0x4fb2e0 },
  TheTwins:        { pt: 'Os Gêmeos',            emoji: '👀', color: 0x1abc9c },
  SkeletronPrime:  { pt: 'Esqueletron Prime',    emoji: '🤖', color: 0x7f8c8d },
  Plantera:        { pt: 'Plantera',             emoji: '🌺', color: 0xe84393 },
  Golem:           { pt: 'Golem',                emoji: '🗿', color: 0xd68910 },
  HallowBoss:      { pt: 'Imperatriz da Luz',    emoji: '✨', color: 0xf7dc6f },
  DukeFishron:     { pt: 'Duque Fishron',        emoji: '🐟', color: 0x16a085 },
  CultistBoss:     { pt: 'Cultista Lunático',    emoji: '🔮', color: 0x2e86c1 },
  MoonLord:        { pt: 'Lorde da Lua',         emoji: '🌙', color: 0x48c9b0 },
  DD2Betsy:        { pt: 'Betsy',                emoji: '🐉', color: 0xe67e22 },
};

// Extra line under a kill that changes the world.
const MILESTONES = {
  Skeletron:      '🏰 A Masmorra está liberada.',
  WallofFlesh:    '🔥 **O Hardmode começou!** Minérios novos no fundo do mundo e o mal vai se espalhar.',
  TheDestroyer:   '⚙️ Um mecânico a menos. Faltam os outros dois.',
  TheTwins:       '⚙️ Um mecânico a menos. Faltam os outros dois.',
  SkeletronPrime: '⚙️ Um mecânico a menos. Faltam os outros dois.',
  Plantera:       '🌿 O Templo da Selva está liberado.',
  Golem:          '🗿 O Cultista Lunático agora aparece na Masmorra.',
  CultistBoss:    '🌙 Os quatro Pilares Celestiais surgiram.',
  MoonLord:       '🏆 **ZEROU O JOGO!** Parabéns, ENCALHADOS.',
};

const EVENTS = {
  bloodMoon:   { pt: 'Lua de Sangue',      emoji: '🩸', color: 0xb03a2e, start: 'A lua ficou vermelha. Zumbis vão tentar arrombar as portas.', end: 'O sol nasceu, a Lua de Sangue acabou.' },
  eclipse:     { pt: 'Eclipse Solar',      emoji: '🌑', color: 0x566573, start: 'O sol sumiu. Monstros horríveis andam à luz do dia.', end: 'O eclipse passou.' },
  pumpkinMoon: { pt: 'Lua de Abóbora',     emoji: '🎃', color: 0xe67e22, start: 'A Lua de Abóbora nasceu. Prepare uma arena.', end: 'A Lua de Abóbora acabou.' },
  frostMoon:   { pt: 'Lua de Gelo',        emoji: '❄️', color: 0x5dade2, start: 'A Lua de Gelo chegou. Ho ho ho... corra.', end: 'A Lua de Gelo derreteu.' },
  goblins:     { pt: 'Invasão Goblin',     emoji: '🗡️', color: 0x58d68d, start: 'Um exército goblin está chegando.', end: 'Os goblins foram derrotados.' },
  frostLegion: { pt: 'Legião de Gelo',     emoji: '⛄', color: 0x85c1e9, start: 'A Legião de Gelo marcha para a base.', end: 'A Legião de Gelo foi derrotada.' },
  pirates:     { pt: 'Invasão Pirata',     emoji: '🏴‍☠️', color: 0xa04000, start: 'Piratas à vista! Protejam o ouro.', end: 'Os piratas foram embora.' },
  martians:    { pt: 'Loucura Marciana',   emoji: '👽', color: 0x7d3c98, start: 'Marcianos pousaram. Estão fazendo uma bagunça.', end: 'A loucura marciana acabou.' },
  oldOnesArmy: { pt: 'Exército do Ancião', emoji: '🔮', color: 0xaf7ac5, start: 'O Cristal de Eternia está sob ataque.', end: 'O Exército do Ancião foi repelido.' },
};

// ---- text helpers ------------------------------------------------------------
function fmtNum(n) {
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(1).replace('.', ',') + 'k';
  return (v / 1e6).toFixed(2).replace('.', ',') + 'M';
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function bar(fraction, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Markdown outside code blocks: neutralize the characters Discord formats.
function md(text) {
  return String(text).replace(/([\\*_~|>])/g, '\\$1');
}

function bossInfo(ev) {
  const known = BOSSES[ev.bossKey];
  return {
    name: known ? known.pt : (ev.boss || ev.bossKey),
    emoji: known ? known.emoji : '⚔️',
    color: known ? known.color : 0x9b59b6,
  };
}

// Damage table inside a code block (monospace keeps the columns aligned).
function damageTable(participants, durationSec) {
  const total = participants.reduce((a, p) => a + p.damage, 0) || 1;
  return participants.slice(0, 10).map((p, i) => {
    const name = p.name.slice(0, 14).padEnd(14);
    const share = p.damage / total;
    return `${String(i + 1).padStart(2)}. ${name} ${fmtNum(p.damage).padStart(7)} ${(fmtNum(dps(p.damage, durationSec)) + '/s').padStart(8)} ${bar(share)} ${String(Math.round(share * 100)).padStart(3)}%`;
  }).join('\n');
}

function embedBase(ev, extra) {
  return Object.assign({ footer: { text: FOOTER }, timestamp: ev.t }, extra);
}

// ---- embeds ------------------------------------------------------------------
function bossKillEmbed(ev) {
  const info = bossInfo(ev);
  const total = ev.participants.reduce((a, p) => a + p.damage, 0);
  const fields = [];
  let description = `⏱️ **${fmtDuration(ev.durationSec)}** · 💥 **${fmtNum(total)}** de dano`;
  if (ev.participants.length) {
    description += ` · 👥 **${ev.participants.length}** ${ev.participants.length === 1 ? 'jogador' : 'jogadores'}`;
    fields.push({ name: 'Dano por jogador', value: '```\n' + damageTable(ev.participants, ev.durationSec) + '\n```' });
    const top = ev.participants[0];
    if (ev.participants.length > 1 && total > 0) {
      fields.push({
        name: '🏅 Destaque',
        value: `**${md(top.name)}** causou **${Math.round((top.damage / total) * 100)}%** do dano (${fmtNum(dps(top.damage, ev.durationSec))}/s).`,
      });
    }
  } else {
    description += '\nNinguém foi creditado com dano nesta luta.';
  }
  const dead = ev.participants.filter((p) => p.deaths > 0);
  if (dead.length) {
    fields.push({ name: '💀 Mortes na luta', value: dead.map((p) => `${md(p.name)} ×${p.deaths}`).join(' · ') });
  }
  if (MILESTONES[ev.bossKey]) fields.push({ name: 'O que muda', value: MILESTONES[ev.bossKey] });
  return embedBase(ev, { title: `${info.emoji} ${info.name} foi derrotado!`, description, color: info.color, fields });
}

function bossWipeEmbed(ev) {
  const info = bossInfo(ev);
  const fields = [];
  if (ev.participants.length) {
    fields.push({ name: 'Dano até cair', value: '```\n' + damageTable(ev.participants, ev.durationSec) + '\n```' });
  }
  let description = `A luta durou **${fmtDuration(ev.durationSec)}** e o boss ficou de pé.`;
  if (ev.lifePct != null) {
    description += ev.lifePct <= 15 ? `\nFaltaram só **${ev.lifePct}%** da vida. Foi por pouco!` : `\nEle ainda tinha **${ev.lifePct}%** da vida.`;
  }
  return embedBase(ev, { title: `☠️ ${info.name} venceu esta rodada`, description, color: 0x7b241c, fields });
}

function eventEmbed(ev) {
  const info = EVENTS[ev.event];
  const name = info ? info.pt : ev.event;
  const emoji = info ? info.emoji : '📣';
  if (ev.type === 'event_start') {
    return embedBase(ev, { title: `${emoji} ${name} começou!`, description: info ? info.start : 'Um evento começou no mundo.', color: info ? info.color : 0x95a5a6 });
  }
  const lasted = ev.durationSec ? `\nDurou **${fmtDuration(ev.durationSec)}**.` : '';
  return embedBase(ev, { title: `${emoji} ${name} terminou`, description: (info ? info.end : 'O evento acabou.') + lasted, color: 0x566573 });
}

function serverEmbed(kind, at, extra) {
  const base = { footer: { text: FOOTER }, timestamp: new Date(at).toISOString() };
  if (kind === 'down') return Object.assign(base, { title: '🔴 O servidor caiu', description: 'Estamos de olho. Volta em instantes.', color: 0xc0392b });
  if (kind === 'up') return Object.assign(base, { title: '🟢 Servidor no ar!', description: extra || 'Pode entrar.', color: 0x27ae60 });
  return Object.assign(base, { title: '🔄 Servidor reiniciou', description: extra || 'Reconectem quando ele voltar.', color: 0xf39c12 });
}

function medal(i) { return ['🥇', '🥈', '🥉'][i] || `${i + 1}.`; }

function weeklyEmbed(agg, toMs) {
  const fields = [];
  if (agg.kills.length) {
    fields.push({
      name: '⚔️ Bosses derrotados',
      value: agg.kills.slice(0, 12).map((k) => {
        const known = BOSSES[k.bossKey];
        return `${known ? known.emoji : '⚔️'} ${md(known ? known.pt : k.boss)}${k.count > 1 ? ` ×${k.count}` : ''}`;
      }).join('\n'),
    });
  }
  if (agg.damage.length) {
    fields.push({ name: '💥 Mais dano em bosses', value: agg.damage.slice(0, 3).map((r, i) => `${medal(i)} **${md(r.name)}** · ${fmtNum(r.value)}`).join('\n'), inline: true });
  }
  if (agg.bestDps) {
    const b = agg.bestDps;
    const known = BOSSES[b.bossKey];
    fields.push({ name: '🔥 Maior DPS numa luta', value: `**${md(b.name)}** · ${fmtNum(b.dps)}/s\ncontra ${md(known ? known.pt : b.boss)}`, inline: true });
  }
  if (agg.deaths.length) {
    fields.push({ name: '💀 Mais mortes', value: agg.deaths.slice(0, 3).map((r, i) => `${medal(i)} **${md(r.name)}** · ${r.value}`).join('\n'), inline: true });
  }
  const description = `${agg.fights} ${agg.fights === 1 ? 'luta vencida' : 'lutas vencidas'} · ${agg.wipes} ${agg.wipes === 1 ? 'derrota' : 'derrotas'}`;
  return { title: '📊 Resumo da semana no Terraria', description, color: 0x2ecc71, fields, footer: { text: FOOTER }, timestamp: new Date(toMs).toISOString() };
}

function embedFor(ev) {
  switch (ev.type) {
    case 'boss_kill': return bossKillEmbed(ev);
    case 'boss_wipe': return bossWipeEmbed(ev);
    case 'event_start':
    case 'event_end': return eventEmbed(ev);
    default: return null;      // deaths only feed the weekly ranking
  }
}

// Most recent Sunday at WEEKLY_HOUR_UTC that is <= now (ms). Identifies "this week's post".
function lastWeeklySlot(nowMs) {
  const d = new Date(nowMs);
  const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WEEKLY_HOUR_UTC);
  let t = slot - d.getUTCDay() * 86400000;
  if (t > nowMs) t -= 7 * 86400000;
  return t;
}

// ---- I/O ---------------------------------------------------------------------
function readWebhookUrl(dir) {
  let url = process.env.DISCORD_WEBHOOK_URL || '';
  if (!url) {
    const file = process.env.DISCORD_WEBHOOK_FILE || path.join(dir, 'discord-webhook.url');
    try { url = fs.readFileSync(file, 'utf8'); } catch (_) { /* not configured */ }
  }
  url = url.trim();
  return /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(url) ? url : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postWebhook(url, embed) {
  const body = JSON.stringify({ username: BOT_NAME, embeds: [embed], allowed_mentions: { parse: [] } });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
      if (res.ok) return true;
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await sleep(Math.min(30000, Math.max(1000, (Number(j.retry_after) || 2) * 1000)));
        continue;
      }
      if (res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      console.warn(`discord-feed: webhook answered ${res.status}, message dropped`);
      return true;                 // a 4xx will not get better by retrying: do not block the queue
    } catch (_) {
      await sleep(2000 * (attempt + 1));
    }
  }
  return false;                    // still failing: keep the event for the next poll
}

function createFeed(opts) {
  const dir = opts.dir;
  const eventsFile = opts.eventsFile;
  const stateFile = opts.stateFile || path.join(dir, 'state', 'discord-feed.json');
  const url = readWebhookUrl(dir);
  if (!url) return { enabled: false, start() {}, tick() {}, onSnapshot() {} };
  const pollMs = opts.pollMs || POLL_MS;
  const sendGapMs = opts.sendGapMs == null ? SEND_GAP_MS : opts.sendGapMs;

  let state = { offset: null, ids: [], lastWeekly: null };
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch (_) { /* first run */ }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, stateFile);
    } catch (e) { console.warn('discord-feed: could not save state:', e.message); }
  }

  let busy = false;
  let lastSend = 0;
  async function send(embed) {
    const wait = lastSend + sendGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    const ok = await postWebhook(url, embed);
    lastSend = Date.now();
    return ok;
  }

  async function pollFile() {
    let st;
    try { st = fs.statSync(eventsFile); } catch (_) { return; }
    if (state.offset == null) {
      // First run: do not replay history into the channel, start from the end.
      state.offset = process.env.DISCORD_BACKFILL === '1' ? 0 : st.size;
      save();
    }
    if (st.size < state.offset) state.offset = 0;           // rotated or truncated
    if (st.size === state.offset) return;
    const len = Math.min(st.size - state.offset, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(eventsFile, 'r');
    try { fs.readSync(fd, buf, 0, len, state.offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;                                  // no complete line yet
    let consumed = 0;
    for (const line of text.slice(0, lastNl).split('\n')) {
      const lineBytes = Buffer.byteLength(line) + 1;
      const ev = line.trim() ? parseEventLine(line) : null;
      const embed = ev && !state.ids.includes(ev.id) ? embedFor(ev) : null;
      if (embed) {
        if (!(await send(embed))) break;                    // Discord down: retry this line next poll
        state.ids = [...state.ids, ev.id].slice(-50);
      }
      consumed += lineBytes;
      state.offset += lineBytes;
      save();
    }
    return consumed;
  }

  async function weekly() {
    const now = Date.now();
    const slot = lastWeeklySlot(now);
    if (state.lastWeekly == null) { state.lastWeekly = slot; save(); return; }   // first run: wait for the next Sunday
    if (state.lastWeekly >= slot) return;
    let text = '';
    try { text = fs.readFileSync(eventsFile, 'utf8'); } catch (_) { /* no log yet */ }
    const agg = aggregate(parseEvents(text), slot - 7 * 86400000, slot);
    if (agg.fights || agg.wipes || agg.deaths.length) {
      if (!(await send(weeklyEmbed(agg, slot)))) return;
    }
    state.lastWeekly = slot;
    save();
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try { await pollFile(); await weekly(); }
    catch (e) { console.warn('discord-feed:', e.message); }
    finally { busy = false; }
  }

  // Server up/down notices, fed with the status snapshot the app already builds.
  let known = null;        // { online, startedAt }
  let offlinePolls = 0;
  let announcedDown = false;
  function onSnapshot(snap) {
    const online = !!snap.online;
    const startedAt = snap.container && snap.container.startedAt;
    if (!known) { known = { online, startedAt }; return; }          // baseline, no message on boot of this app
    if (!online) {
      offlinePolls += 1;
      if (offlinePolls === 2 && known.online && !announcedDown) { announcedDown = true; send(serverEmbed('down', Date.now())); }
      known.online = false;
      return;
    }
    offlinePolls = 0;
    if (announcedDown) {
      announcedDown = false;
      send(serverEmbed('up', Date.now(), snap.server && snap.server.tmodloaderVersion ? `tModLoader ${snap.server.tmodloaderVersion}. Pode entrar.` : null));
    } else if (known.startedAt && startedAt && startedAt !== known.startedAt) {
      send(serverEmbed('restart', Date.now()));
    }
    known = { online: true, startedAt };
  }

  return {
    enabled: true,
    tick,
    onSnapshot,
    start() {
      console.log('discord-feed: enabled');
      setInterval(tick, pollMs).unref();
      setTimeout(tick, 2000);
    },
  };
}

module.exports = {
  createFeed, embedFor, bossKillEmbed, bossWipeEmbed, eventEmbed, weeklyEmbed, serverEmbed,
  fmtNum, fmtDuration, bar, md, lastWeeklySlot, readWebhookUrl, BOSSES, EVENTS,
};
