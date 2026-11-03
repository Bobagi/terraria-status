'use strict';
// Pure helpers for what the server-side mod exports beyond the vanilla world flags.
// Everything in playerstats.json is treated as untrusted: strings come from other
// mods' localization, so they are typed and bounded here and the page renders text only.

const MODBOSS_MAX = 80;
const KINDS = new Set(['boss', 'miniboss', 'event']);

// Same rule as tools/build-modboss-icons.py icon_key().
function iconKey(texture) {
  return String(texture).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 160);
}

// Bosses other mods register with Boss Checklist. `icons` is the set of icon keys that
// exist on disk: a key outside it is dropped, so the page never builds a URL from the
// mod's raw string.
function sanitizeModBosses(list, icons) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MODBOSS_MAX).filter((b) => b && typeof b === 'object').map((b) => {
    const icon = typeof b.head === 'string' ? iconKey(b.head) : null;
    return {
      mod: String(b.mod || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40),
      name: String(b.name || b.key || '?').slice(0, 60),
      kind: KINDS.has(b.kind) ? b.kind : 'boss',
      downed: b.downed === true,
      icon: icon && icons && icons.has(icon) ? icon : null,
    };
  });
}

// Only the live world fields the page shows: no raw pass-through of the mod's file.
function pickLive(w) {
  if (!w || typeof w !== 'object') return null;
  const bool = (v) => v === true;
  return {
    dayTime: bool(w.dayTime),
    timeText: typeof w.timeText === 'string' ? w.timeText.slice(0, 5) : null,
    moonPhase: Number.isInteger(w.moonPhase) ? w.moonPhase : 0,
    hardMode: bool(w.hardMode),
    bloodMoon: bool(w.bloodMoon), eclipse: bool(w.eclipse),
    pumpkinMoon: bool(w.pumpkinMoon), snowMoon: bool(w.snowMoon),
    progression: typeof w.progression === 'string' ? w.progression.slice(0, 40) : null,
    tps: typeof w.tps === 'number' && w.tps >= 0 && w.tps < 1000 ? w.tps : null,
  };
}

module.exports = { sanitizeModBosses, pickLive, iconKey, MODBOSS_MAX };
