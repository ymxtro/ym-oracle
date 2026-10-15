'use strict';
// Telegram alert routing: who gets what, and the dev-mode / off switches. Pure logic (no network, no database) so it can be tested alone.
//
// Two chats: GROUP (the public group: trade signals and updates) and DM (your private chat: zones, daily summary, warnings).
// Every alert belongs to one CATEGORY, and each category has a DESTINATION: group | dm | both | off.
// A master MODE sits on top:
//   live  - each category goes where its destination says (the normal setting)
//   dev   - nothing reaches the group: whatever was meant for the group goes to your DM instead (tagged), so you can still watch it work
//   off   - Telegram is silent. Warnings (category "ops") can still reach your DM (keepOps) so a lost trade is never invisible
// A non-live mode can carry an expiry ("for 4 hours") so the group is never left muted by accident; it falls back to live by itself.
// Alerts sent while muted are NOT saved for later (dev messages should not flood the group when you switch back).

const CATS = {
  signals: { label: 'Trade signals', hint: 'Trade opened and trade closed (entry and result)', def: 'group' },
  updates: { label: 'Trade updates', hint: 'Stop moves, trailing, take-profit changes, other bot messages', def: 'group' },
  zones:   { label: 'Zone alerts', hint: 'Future entry zones the bots are watching (private by design)', def: 'dm' },
  daily:   { label: 'Daily summary', hint: 'End-of-day wins, losses and result', def: 'dm' },
  ops:     { label: 'Warnings', hint: 'Bot offline, lost order alarm, Bybit or key problems', def: 'dm' },
  tests:   { label: 'Test alerts', hint: 'The Send test alert buttons', def: 'dm' },
};
const CAT_IDS = Object.keys(CATS);
const DESTS = ['group', 'dm', 'both', 'off'];
const MODES = ['live', 'dev', 'off'];
const MAX_HOURS = 24 * 14;

function defaults() {
  const routes = {}; for (const c of CAT_IDS) routes[c] = CATS[c].def;
  return { mode: 'live', until: 0, keepOps: true, routes, groupChat: '', dmChat: '' };
}

// Cleans anything stored or submitted into a full, valid config. Unknown or bad values fall back to the defaults, never throw.
function normalize(raw) {
  const d = defaults();
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = { ...d };
  if (MODES.includes(r.mode)) out.mode = r.mode;
  out.until = Number.isFinite(Number(r.until)) && Number(r.until) > 0 ? Math.floor(Number(r.until)) : 0;
  out.keepOps = r.keepOps === undefined ? true : r.keepOps === true;
  out.routes = { ...d.routes };
  if (r.routes && typeof r.routes === 'object') for (const c of CAT_IDS) if (DESTS.includes(r.routes[c])) out.routes[c] = r.routes[c];
  const chat = v => { const s = String(v === undefined || v === null ? '' : v).trim(); return /^-?\d{3,20}$/.test(s) || /^@[A-Za-z0-9_]{4,64}$/.test(s) ? s : ''; };
  out.groupChat = chat(r.groupChat); out.dmChat = chat(r.dmChat);
  if (out.mode === 'live') out.until = 0;
  return out;
}

// What the admin asked for (hours = how long a non-live mode lasts; 0/absent = until changed) -> a config to store.
function fromRequest(body, nowMs, current) {
  const b = (body && typeof body === 'object') ? body : {};
  const merged = { ...(current || defaults()), ...b, routes: { ...((current || defaults()).routes), ...((b.routes && typeof b.routes === 'object') ? b.routes : {}) } };
  const cfg = normalize(merged);
  const hrs = Number(b.hours);
  cfg.until = (cfg.mode !== 'live' && Number.isFinite(hrs) && hrs > 0) ? nowMs + Math.min(hrs, MAX_HOURS) * 3600000 : 0;   // no hours = until you change it back
  if (b.hours === undefined && b.mode === undefined && cfg.mode !== 'live') cfg.until = Number((current || {}).until) || 0;   // changing a route or a chat id must not touch the running timer
  return cfg;
}

// The mode that is really in force right now (an expired dev/off setting counts as live).
function effectiveMode(cfg, nowMs) {
  if (cfg.mode !== 'live' && cfg.until && nowMs >= cfg.until) return 'live';
  return cfg.mode;
}

// Decides where one alert goes. env = { groupChat, dmChat } from the environment (the stored chat ids, when set, win).
// Returns { targets: [{ kind: 'group'|'dm', chat }], muted, reason, prefix }
//   muted=true with no targets means "deliberately not sent" (counts as handled, not as a failure).
function resolve(cfg, category, nowMs, env) {
  const cat = CAT_IDS.includes(category) ? category : 'updates';
  const mode = effectiveMode(cfg, nowMs);
  const group = cfg.groupChat || (env && env.groupChat) || '';
  const dm = cfg.dmChat || (env && env.dmChat) || '';
  let dest = cfg.routes[cat] || CATS[cat].def;
  let prefix = '', why = '';
  if (mode === 'dev') {
    if (dest === 'group' || dest === 'both') { dest = 'dm'; prefix = '🧪 DEV · not sent to the group\n'; why = 'dev mode: kept out of the group'; }
  } else if (mode === 'off') {
    if (cfg.keepOps && cat === 'ops') { dest = 'dm'; why = 'telegram off: warnings still reach your DM'; }
    else { dest = 'off'; why = 'telegram is off'; }
  }
  const strict = mode !== 'live';                   // in dev/off the DM must really be a DM: never fall back to the group
  const t = [];
  const add = (kind, chat) => { if (chat && !t.some(x => x.chat === chat)) t.push({ kind, chat }); };
  if (dest === 'group' || dest === 'both') add('group', group);
  if (dest === 'dm' || dest === 'both') {
    if (dm) add('dm', dm);
    else if (!strict) add('group', group);          // live mode with no DM set up: same as before this feature existed, the main chat
  }
  if (!t.length) return { targets: [], muted: true, reason: why || (dest === 'off' ? 'this category is switched off' : 'no chat is set up for it'), prefix: '' };
  return { targets: t, muted: false, reason: why, prefix };
}

function describe(cfg, nowMs) {
  const mode = effectiveMode(cfg, nowMs);
  return { mode, until: mode === 'live' ? 0 : cfg.until || 0, keepOps: cfg.keepOps, routes: cfg.routes, groupChat: cfg.groupChat, dmChat: cfg.dmChat };
}

module.exports = { CATS, CAT_IDS, DESTS, MODES, defaults, normalize, fromRequest, effectiveMode, resolve, describe };
