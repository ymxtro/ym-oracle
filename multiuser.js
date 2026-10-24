'use strict';
/*
 * Multi-user layer for the Bybit relay.
 *
 * Needs two env vars, otherwise it stays OFF and the relay behaves exactly as before:
 *   DATABASE_URL           Postgres connection string (Neon free tier works)
 *   KEY_ENCRYPTION_SECRET  64 hex chars (32 bytes)
 *
 * Optional:
 *   DASHBOARD_PASSWORD         REQUIRED for any /admin access (admin routes refuse to work without it)
 *   ADMIN_TOTP_SECRET          base32 secret; if set, admin login also needs the 6-digit authenticator code
 *   ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID   admin alerts, user Telegram alerts, daily CSV backup
 *   TELEGRAM_BOT_USERNAME      only needed if the bot's username can't be fetched automatically
 *   MAX_USER_LEVERAGE          cap leverage applied to users' accounts (0 / unset = no cap)
 *   PUBLIC_OUTBOUND_IPS        shown on the signup page so users can whitelist your server on their key
 *   MULTIUSER_MAX_RATIO        cap on (user equity / admin equity) when scaling size, default 10
 *   DATABASE_SSL=false         only for a local Postgres
 */
const crypto = require('crypto');
const path = require('path');
const { RestClientV5 } = require('bybit-api');
const sec = require('./security');

const SESSION_DAYS = 30;
const ADMIN_SESSION_HOURS = 12;
const AUTH_RET_CODES = new Set([10003, 10004, 10005, 10010, 33004]); // bad/expired key, bad IP, no permission
const BAL_RET_CODES = new Set([110004, 110007, 110012, 110045]);      // insufficient balance / margin
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const QUIET_CODES = new Set(['DUP', 'HELD', 'NOPOS', 'PAPER', 'FILT', 'MAXT', 'DRY']);       // never worth pinging a user about
const CODE_TEXT = {
  BAL: 'not enough free money for this trade', MINQ: "this trade is smaller than the smallest order Bybit allows for this coin", PAIR: 'pair not tradable',
  LEV: 'Bybit rejected the leverage', NET: "couldn't reach Bybit", BYBIT: 'Bybit refused the order', HALT: 'trading is halted for you right now',
  SIDE: 'your position is on the other side', AUTH: 'your API key stopped working',
  FILT: 'skipped by your coin or direction settings', MAXT: 'you already have your maximum number of open trades',
};

// Only these fields are ever forwarded to users' accounts -- a request can never smuggle extra parameters into someone else's order.
const ORDER_FIELDS = ['category', 'symbol', 'isLeverage', 'side', 'orderType', 'qty', 'marketUnit', 'price', 'triggerDirection', 'orderFilter', 'triggerPrice', 'triggerBy',
  'timeInForce', 'positionIdx', 'takeProfit', 'stopLoss', 'tpTriggerBy', 'slTriggerBy', 'reduceOnly', 'closeOnTrigger', 'smpType', 'tpslMode', 'tpLimitPrice', 'slLimitPrice', 'tpOrderType', 'slOrderType'];
const STOP_FIELDS = ['symbol', 'positionIdx', 'takeProfit', 'stopLoss', 'trailingStop', 'activePrice', 'tpTriggerBy', 'slTriggerBy', 'tpslMode', 'tpSize', 'slSize', 'tpLimitPrice', 'slLimitPrice', 'tpOrderType', 'slOrderType'];
const NUMERIC_FIELDS = ['qty', 'price', 'triggerPrice', 'takeProfit', 'stopLoss', 'tpLimitPrice', 'slLimitPrice', 'tpSize', 'slSize', 'trailingStop', 'activePrice'];
const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;

// ---------- pure helpers (unit-testable) ----------
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function encrypt(plain, keyBuf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob, keyBuf) {
  const [iv, tag, enc] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function scryptAsync(pw, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt);
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}
async function verifyPassword(pw, stored) {
  try {
    const [, saltB64, keyB64] = String(stored).split('$');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scryptAsync(pw, Buffer.from(saltB64, 'base64'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

// Same % of equity as the admin account: userQty = adminQty * (userEquity / adminEquity) * multiplier.
// ---- per-user Bybit environment helpers (pure, tested directly) ----
const normEnv = e => (e === 'demo' ? 'demo' : 'live');
// Which environment the relay itself (the master account) was running in. Used once, to label users that existed before v1.7.
function defaultEnvFor(base) {
  base = base || {};
  return (base.demoTrading || /api-demo\./i.test(String(base.baseUrl || ''))) ? 'demo' : 'live';
}
// Client options for a user's own environment. The master's baseUrl / demoTrading never leak into a user's client.
function envOptsFor(base, env) {
  const o = { ...(base || {}) };
  delete o.baseUrl; delete o.demoTrading;
  if (normEnv(env) === 'demo') { delete o.testnet; o.demoTrading = true; }
  return o;
}

// BURST BRAKE (v2.9.4). Several bots often fire the same direction within minutes of each other (Oct 21 2026: three shorts at 01:15, then more later). For the COPY
// USERS that is one big bet in disguise. Each new same-side open on a DIFFERENT coin inside `windowMin` minutes counts as one earlier burst trade, and the n-th later copy
// is sized by factors[n] (default 1, 0.6, 0.4). The master account is never touched. Pure function so it can be tested directly.
const BURST_DEFAULT = { mode: 'shadow', windowMin: 15, factors: [1, 0.6, 0.4],
  // v2.9.12 EXPOSURE: how many OTHER coins the master already holds on the same side, fast and swing together (a swing short from yesterday and three fast shorts today are one big bet). Index = that count.
  expo: { on: true, factors: [1, 1, 1, 0.7, 0.5, 0.35] } };   // mode: 'off' | 'shadow' (log what it would do) | 'live'
function burstNorm(c) {
  const b = { ...BURST_DEFAULT, ...(c && typeof c === 'object' ? c : {}) };
  if (!['off', 'shadow', 'live'].includes(b.mode)) b.mode = 'shadow';
  b.windowMin = Math.min(120, Math.max(1, Number(b.windowMin) || BURST_DEFAULT.windowMin));
  let f = Array.isArray(b.factors) ? b.factors.map(Number).filter(x => Number.isFinite(x) && x > 0 && x <= 1).slice(0, 6) : [];
  if (!f.length) f = BURST_DEFAULT.factors.slice();
  b.factors = f;
  const ex = b.expo && typeof b.expo === 'object' ? b.expo : {};
  let ef = Array.isArray(ex.factors) ? ex.factors.map(Number).filter(x => Number.isFinite(x) && x > 0 && x <= 1).slice(0, 10) : [];
  if (!ef.length) ef = BURST_DEFAULT.expo.factors.slice();
  b.expo = { on: ex.on === undefined ? true : ex.on === true, factors: ef };
  return b;
}
function burstFactor(recent, symbol, side, now, cfg) {
  const c = burstNorm(cfg);
  const seen = new Set();
  for (const r of recent || []) if (r.side === side && r.symbol !== symbol && now - r.at <= c.windowMin * 60000) seen.add(r.symbol);
  const n = seen.size;
  return { n, factor: c.factors[Math.min(n, c.factors.length - 1)], mode: c.mode };
}
function scaleQty({ adminQty, adminEquity, userEquity, mult, qtyStep, minQty, maxRatio }) {
  adminQty = Number(adminQty); adminEquity = Number(adminEquity); userEquity = Number(userEquity);
  if (!(adminQty > 0) || !(adminEquity > 0) || !(userEquity > 0)) return { qty: null, code: 'BAL' };
  let ratio = userEquity / adminEquity;
  const capped = ratio > (maxRatio || 10);
  if (capped) ratio = maxRatio || 10;
  const raw = adminQty * ratio * (Number(mult) > 0 ? Number(mult) : 1);
  const step = qtyStep > 0 ? qtyStep : 0.000001;
  const qty = Number((Math.floor(raw / step + 1e-9) * step).toFixed(decimalsOf(step)));
  if (!(qty > 0) || qty < (minQty || 0)) return { qty: null, code: 'MINQ' };
  return { qty, code: 'OK', capped };
}

const SIZE_MODES = ['fixed', 'percent'];   // 'match' (copy the master's share) was retired in Standard v1; old rows are converted on startup
// Standard v1 numbers (one place, so the docs, the screens and the code agree)
const STD = { pct: 20, userPctMax: 30, userPctConfirmAbove: 20, maxTradeUsd: 500, maxOpen: 3, adminMaxOpen: 5, dailyLossPct: 10, drawdownPct: 30, floorMult: 1.5, floorBalanceShare: 0.35, legacyMatchPct: 10, minLiveBalance: 50 };
const DIRECTIONS = ['both', 'long', 'short'];

// ---------- Master Plan (universal settings the admin sets for every autopilot account) ----------
// Standard v1: every account sizes trades from ITS OWN balance. The plan supplies the starting percent for new sign-ups plus the safety rails
// and signal rules that apply to everyone. Leverage is not a setting: it is exactly what the signal says (maxLeverage is kept only so old stored plans still load).
const PLAN_DEFAULT = { sizeMode: 'percent', sizeMult: 1, sizeUsd: null, sizePct: STD.pct, maxOpenTrades: STD.maxOpen, symbols: null, direction: 'both',
  maxLeverage: null, dailyLossLimitUsd: null, dailyLossPct: STD.dailyLossPct, dailyProfitTargetUsd: null, drawdownStopPct: STD.drawdownPct, maxTradeUsd: STD.maxTradeUsd, allowManual: true };
const CONTROL_KEYS = ['sizeMode', 'sizeMult', 'sizeUsd', 'sizePct', 'maxOpenTrades', 'symbols', 'direction', 'maxLeverage', 'dailyLossLimitUsd', 'dailyLossPct', 'dailyProfitTargetUsd', 'drawdownStopPct', 'maxTradeUsd'];
const MANUAL_KEYS = ['sizeMode', 'sizeUsd', 'sizePct', 'dailyLossLimitUsd']; // what a user may change on their own account (their own size and loss limit)

// The plan as it was before Standard v1 (used only to read old stored plans and by the one-time migration)
const LEGACY_PLAN = { sizeMode: 'match', sizeMult: 1, sizeUsd: null, sizePct: null, maxOpenTrades: null, symbols: null, direction: 'both',
  maxLeverage: null, dailyLossLimitUsd: null, dailyProfitTargetUsd: null, drawdownStopPct: null, allowManual: true };
// an old stored plan that still says sizeMode:'match' is read as the Standard sizing, so it always validates
function normalizeStoredPlan(stored) {
  const o = { ...(stored || {}) };
  if (o.sizeMode === 'match') { o.sizeMode = PLAN_DEFAULT.sizeMode; o.sizePct = PLAN_DEFAULT.sizePct; o.sizeUsd = null; }
  return o;
}

const posOrNull = (v, max) => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n > 0 && n <= max ? n : NaN; };

// Validates a controls body (admin master plan or a manual user). o = { current, allowed, ceilUsd, levCeil, sizeMultMax }
// Returns { error } or { values } (only the keys that were sent).
function parseControls(b, o) {
  const bad = m => ({ error: m });
  const cur = o.current || {}, allowed = o.allowed || CONTROL_KEYS;
  b = b || {};
  for (const k of CONTROL_KEYS.concat(['allowManual'])) if (b[k] !== undefined && !allowed.includes(k)) return bad('That setting is managed by the admin plan.');
  const v = {};
  if (b.dailyLossLimitUsd !== undefined) {
    const n = b.dailyLossLimitUsd === null || b.dailyLossLimitUsd === '' ? null : Number(b.dailyLossLimitUsd);
    if (n !== null && !(n >= 0 && Number.isFinite(n))) return bad('Daily loss limit must be a positive number or empty.');
    v.dailyLossLimitUsd = n;
  }
  if (b.dailyProfitTargetUsd !== undefined) { const n = posOrNull(b.dailyProfitTargetUsd, 1e9); if (Number.isNaN(n)) return bad('Daily profit target must be a positive number or empty.'); v.dailyProfitTargetUsd = n; }
  if (b.drawdownStopPct !== undefined) { const n = posOrNull(b.drawdownStopPct, 90); if (Number.isNaN(n) || (n !== null && n < 1)) return bad('Drawdown stop must be between 1 and 90 percent, or empty.'); v.drawdownStopPct = n; }
  if (b.sizeMult !== undefined) {
    const n = Number(b.sizeMult), max = o.sizeMultMax || 20;
    if (!(n > 0) || n > max) return bad('Size multiplier must be above 0 and at most ' + max + '.');
    v.sizeMult = n;
  }
  if (b.dailyLossPct !== undefined) { const n = posOrNull(b.dailyLossPct, 50); if (Number.isNaN(n) || (n !== null && n < 1)) return bad('Daily loss limit must be between 1 and 50 percent of the balance, or empty.'); v.dailyLossPct = n; }
  if (b.maxTradeUsd !== undefined) { const n = posOrNull(b.maxTradeUsd, 1e7); if (Number.isNaN(n)) return bad('The most any trade can use must be a positive number, or empty for no cap.'); v.maxTradeUsd = n; }
  if (b.sizeMode !== undefined) {
    if (b.sizeMode === 'match') return bad('Copying the master account\'s share is retired. Choose a percent of balance or a fixed amount.');
    if (!SIZE_MODES.includes(b.sizeMode)) return bad('Unknown trade size mode.');
    v.sizeMode = b.sizeMode;
  }
  if (b.sizeUsd !== undefined) {
    const n = posOrNull(b.sizeUsd, 1e7); if (Number.isNaN(n)) return bad('Trade amount must be a positive number.');
    if (n !== null && o.ceilUsd && n > o.ceilUsd) return bad('Your trade amount can be at most $' + o.ceilUsd + ' (the limit set for your account).');
    v.sizeUsd = n;
  }
  if (b.sizePct !== undefined) { const n = posOrNull(b.sizePct, o.pctMax || 100); if (Number.isNaN(n)) return bad('Percent of balance must be above 0 and at most ' + (o.pctMax || 100) + '.'); v.sizePct = n; }
  if (b.maxOpenTrades !== undefined) {
    const n = b.maxOpenTrades === null || b.maxOpenTrades === '' ? null : Number(b.maxOpenTrades);
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= (o.openMax || 50))) return bad('Max open trades must be a whole number from 1 to ' + (o.openMax || 50) + ', or empty.');
    v.maxOpenTrades = n;
  }
  if (b.direction !== undefined) { if (!DIRECTIONS.includes(b.direction)) return bad('Direction must be both, long or short.'); v.direction = b.direction; }
  if (b.symbols !== undefined) {
    if (b.symbols === null) v.symbols = null;
    else {
      if (!Array.isArray(b.symbols) || b.symbols.length > 60) return bad('Coin list is not valid.');
      const list = Array.from(new Set(b.symbols.map(x => String(x).toUpperCase().trim()).filter(Boolean).map(x => (x.endsWith('USDT') ? x : x + 'USDT'))));
      if (list.some(x => !SYMBOL_RE.test(x))) return bad('One of the coins is not valid.');
      v.symbols = list.length ? list : null;
    }
  }
  if (b.maxLeverage !== undefined) {
    const n = posOrNull(b.maxLeverage, 125); if (Number.isNaN(n)) return bad('Max leverage must be between 1 and 125, or empty.');
    if (n !== null && o.levCeil && n > o.levCeil) return bad('Your leverage can be at most ' + o.levCeil + 'x (the limit set for your account).');
    v.maxLeverage = n;
  }
  if (b.allowManual !== undefined) { if (typeof b.allowManual !== 'boolean') return bad('allowManual must be true or false.'); v.allowManual = b.allowManual; }
  const merged = { ...cur, ...v };
  if (merged.sizeMode === 'fixed' && !(merged.sizeUsd > 0)) return bad('Enter the USD amount to use for each trade.');
  if (merged.sizeMode === 'percent' && !(merged.sizePct > 0)) return bad('Enter the percent of the balance to use for each trade.');
  return { values: v };
}

// How closely a manual user's settings track the master plan: 100 = identical. (join.html has a copy of this formula for its live gauge.)
function planMatch(plan, e) {
  const amt = x => (x.sizeMode === 'fixed' ? Number(x.sizeUsd) : x.sizeMode === 'percent' ? Number(x.sizePct) : Number(x.sizeMult));
  const sim = (a, b) => (!Number.isFinite(a) || !Number.isFinite(b) ? 0 : a === b ? 1 : 1 - Math.min(1, Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))));
  const sizing = plan.sizeMode === e.sizeMode ? sim(amt(plan), amt(e)) : 0.3;
  const pl = plan.dailyLossLimitUsd, el = e.dailyLossLimitUsd;
  const loss = (pl == null && el == null) ? 1 : (pl == null || el == null) ? 0.4 : sim(Number(pl), Number(el));
  return Math.max(0, Math.min(100, Math.round(70 * sizing + 30 * loss)));
}

// smallest positive number among the arguments, 0 if none is positive (0 = "no cap")
function minPositive(...vals) {
  const p = vals.map(Number).filter(v => Number.isFinite(v) && v > 0);
  return p.length ? Math.min(...p) : 0;
}

// Works out the quantity for one user's new position (Standard v1).
//  percent -> margin is `sizePct` % of THEIR OWN balance;  fixed -> margin is `sizeUsd`
//  margin is capped by the plan's per-trade ceiling (`maxTradeUsd`) and must fit in their free balance
//  position = margin x leverage / price, rounded DOWN to Bybit's step. Leverage is whatever the signal set; it is never changed here.
//  Floor rule: if rounding leaves less than Bybit's minimum order but the minimum is close to what they chose
//  (<= 1.5x their margin) and still a modest part of their balance (<= 35%), the minimum order is used instead of skipping.
// `mode:'match'` (retired) is still understood so a row that was missed by the migration keeps trading at 10% x its multiplier.
function sizeForUser(p) {
  const step = p.qtyStep > 0 ? p.qtyStep : 0.000001;
  const price = Number(p.price), lev = Number(p.leverage);
  const haveMath = price > 0 && lev > 0;
  const ceil = Number(p.maxTradeUsd) > 0 ? Number(p.maxTradeUsd) : 0;
  let mode = p.mode, pct = Number(p.sizePct);
  if (mode === 'match') { mode = 'percent'; pct = Math.min(STD.userPctMax, Math.max(1, STD.legacyMatchPct * (Number(p.mult) > 0 ? Number(p.mult) : 1))); }
  if (!haveMath) return { qty: null, code: 'NET', detail: "Couldn't read the price or leverage needed to size your trade" };
  const equity = Number(p.userEquity);
  if (!(equity > 0)) return { qty: null, code: 'BAL', detail: 'No usable balance' };
  let margin = mode === 'fixed' ? Number(p.sizeUsd) : equity * pct / 100;
  if (!(margin > 0)) return { qty: null, code: 'BAL', detail: 'No usable trade amount' };
  let capped = false;
  if (ceil && margin > ceil) { margin = ceil; capped = true; }
  const avail = Number(p.available);
  const hasAvail = Number.isFinite(avail);
  if (hasAvail && margin > avail) {
    return { qty: null, code: 'BAL', detail: 'This trade needs about $' + margin.toFixed(2) + ' of free money but only $' + avail.toFixed(2) + ' is free (other trades are using the rest)' };
  }
  const toQty = m => Number((Math.floor(m * lev / price / step + 1e-9) * step).toFixed(decimalsOf(step)));
  let qty = toQty(margin), floored = false;
  const minQty = p.minQty || 0;
  if (!(qty > 0) || qty < minQty) {
    const need = minQty * price / lev; // margin the smallest allowed order needs at this leverage
    const ok = minQty > 0 && need <= margin * STD.floorMult + 1e-9 && need <= equity * STD.floorBalanceShare + 1e-9 && (!hasAvail || need <= avail) && (!ceil || need <= ceil * STD.floorMult);
    if (!ok) {
      return { qty: null, code: 'MINQ', detail: 'Your ' + (mode === 'fixed' ? '$' + margin.toFixed(2) : pct + '% (about $' + margin.toFixed(2) + ')') + ' is below the smallest order Bybit allows for this coin. The smallest order needs about $' + need.toFixed(2) + ' at ' + lev + 'x, ' + (need > equity * STD.floorBalanceShare ? 'which is more than ' + Math.round(STD.floorBalanceShare * 100) + '% of your balance, so it was skipped to protect you.' : 'which is too far above your amount, so it was skipped. Raise your amount to trade this coin.') };
    }
    qty = Number(minQty.toFixed(decimalsOf(step))); floored = true;
  }
  return { qty, code: 'OK', capped, floored, marginUsd: qty * price / lev };
}

function classifyRet(retCode) {
  if (AUTH_RET_CODES.has(retCode)) return 'AUTH';
  if (BAL_RET_CODES.has(retCode)) return 'BAL';
  return 'BYBIT';
}

function permissionProblem(info) {
  const perms = (info && info.permissions) || {};
  const all = [].concat(...Object.values(perms).map(v => (Array.isArray(v) ? v : [])));
  if (all.some(p => /withdraw/i.test(p))) return 'This API key has withdrawal permission. Create a new key with trade-only permissions (no withdrawals).';
  if (Number(info && info.readOnly) === 1) return 'This API key is read-only. It needs Contract/Derivatives trade permission.';
  const trade = (perms.ContractTrade || []).length + (perms.Derivatives || []).length;
  if (!trade) return 'This API key has no Contract/Derivatives trading permission.';
  return null;
}

function pick(body, fields) {
  const out = {};
  for (const k of fields) if (body[k] !== undefined && body[k] !== null && body[k] !== '') out[k] = body[k];
  return out;
}
function numbersOk(o) {
  for (const k of NUMERIC_FIELDS) if (o[k] !== undefined && !(Number.isFinite(Number(o[k])) && Number(o[k]) >= 0)) return false;
  return true;
}
function sanitizeOrder(body) {
  if (!body || typeof body !== 'object') return null;
  const o = pick(body, ORDER_FIELDS);
  o.category = 'linear';
  if (!SYMBOL_RE.test(String(o.symbol || ''))) return null;
  if (o.side !== 'Buy' && o.side !== 'Sell') return null;
  o.orderType = o.orderType || 'Market';
  if (o.orderType !== 'Market' && o.orderType !== 'Limit') return null;
  if (!numbersOk(o) || !(Number(o.qty) > 0)) return null;
  if (o.reduceOnly !== undefined) o.reduceOnly = o.reduceOnly === true || o.reduceOnly === 'true';
  return o;
}
function sanitizeStop(body) {
  if (!body || typeof body !== 'object') return null;
  const o = pick(body, STOP_FIELDS);
  if (!SYMBOL_RE.test(String(o.symbol || ''))) return null;
  if (!numbersOk(o)) return null;
  if (o.takeProfit === undefined && o.stopLoss === undefined && o.trailingStop === undefined) return null;
  return o;
}
function sanitizeLeverage(body, cap) {
  if (!body || typeof body !== 'object' || !SYMBOL_RE.test(String(body.symbol || ''))) return null;
  let b = Number(body.buyLeverage), s = Number(body.sellLeverage);
  if (!(b > 0 && b <= 125) || !(s > 0 && s <= 125)) return null;
  if (cap > 0) { b = Math.min(b, cap); s = Math.min(s, cap); }
  return { category: 'linear', symbol: body.symbol, buyLeverage: String(b), sellLeverage: String(s) };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // neutralise spreadsheet formula injection in text cells, but leave real numbers (including negatives) untouched
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- module ----------
function init(deps) {
  const noop = async () => {};
  const off = { enabled: false, canPersist: false, loadControl: async () => ({}), saveControl: async () => false, loadMasterCreds: async () => null, saveMasterCreds: async () => ({ ok: false, reason: 'no database' }), clearMasterCreds: async () => ({ ok: false, reason: 'no database' }), fanOutOrder: noop, fanOutTradingStop: noop, guardClamp: b => b, guardFitClose: async b => b, fanOutLeverage: noop, recordExec: noop, recordBotEvent: async () => ({ status: 200 }), verifyAdminToken: async () => false, sizeMasterOrder: async () => null,
    _test: { burstFactor, burstNorm, envOptsFor, defaultEnvFor, encrypt, decrypt, scaleQty, sizeForUser, minPositive, parseControls, planMatch, PLAN_DEFAULT, hashPassword, verifyPassword, classifyRet, permissionProblem, sanitizeOrder, sanitizeStop, sanitizeLeverage, csvCell } };

  const DATABASE_URL = process.env.DATABASE_URL || '';
  const SECRET_HEX = process.env.KEY_ENCRYPTION_SECRET || '';
  let Pool;
  try { ({ Pool } = require('pg')); } catch { Pool = null; }
  if (!DATABASE_URL || !/^[0-9a-fA-F]{64}$/.test(SECRET_HEX) || !Pool) {
    console.log('[multiuser] OFF (needs DATABASE_URL, a 64-hex KEY_ENCRYPTION_SECRET, and the pg package). Single-account mode unchanged.');
    return off;
  }

  const { app, restClient, getMode, breakerIsTripped, sendAlert, baseOpts, execTrade } = deps;
  const PG = require('./profitguard.js');
  const RB = require('./reentrybrain.js');
  const PL = require('./policylab.js');
  const SN = require('./sentinel.js');
  const SC = require('./scalpmodel.js');       // v2.9.15: scalp lane model (confirmed entry, small target, quick exit; shadow test)
  const PM = require('./pacemodel.js');        // v2.9.13: fast / slow pace of a call (signal-time class, proof after entry, labels)
  const SW = require('./swingmgr.js');        // v2.9.12: swing-specific management (grace, 4h-close breakeven, thesis exit, time rule)
  const LQ = require('./livequality.js');
  let snCfg = SN.defaults();            // Trade Sentinel settings (off until switched on from the admin console)
  let pgCfg = PG.defaults();            // Profit Guard settings (off until switched on from the admin console)
  const pgWatch = new Map();            // re-entry watches (recording; with live re-entry on, the same watch can place one order); filled and used further down
  const pgPlanned = new Map();          // v2.9.8: symbol|side -> { sl, eng, bot, at } for a re-entry the relay has just placed, so the guard measures R against ITS stop, not the old trade's
  const botReads = new Map();
  // v2.9.4: trades the relay has seen close on the exchange (stop, target, Profit Guard, anything). A bot that is still tracking the trade asks via its
  // 'read' event and gets the real exit back, so it books the REAL result instead of a later phantom stop. Memory only; key SYMBOL|Buy/Sell.
  const masterClosed = new Map();
  const closedDbMiss = new Map();   // v2.9.11: 'SYMBOL|Side|ot' -> when the database last said "not closed", so a bot asking every minute costs at most one query a minute
  async function closedFromDb(rkey, otMs) {
    const ck = rkey + '|' + otMs, seen = closedDbMiss.get(ck);
    if (seen && Date.now() - seen < 60000) return null;
    try {
      const [sym, sd] = rkey.split('|');
      const r = await q(`SELECT exit_price, exit_r FROM pg_trades WHERE symbol=$1 AND side=$2 AND exit_price > 0 AND at > to_timestamp($3) AND at > now() - interval '48 hours' ORDER BY at ASC LIMIT 1`, [sym, sd, otMs / 1000]);
      const x = r.rows[0];
      if (x) return { x: Number(x.exit_price), r: x.exit_r === null ? null : Number(x.exit_r) };
    } catch (e) { console.error('[multiuser] closed lookup:', e.message); }
    closedDbMiss.set(ck, Date.now());
    if (closedDbMiss.size > 200) for (const [kk, vv] of closedDbMiss) if (Date.now() - vv > 300000) closedDbMiss.delete(kk);
    return null;
  }
  let pcCfg = PM.normalize(null);        // PACE MODEL settings (meta 'pace_model'); default = shadow: record and show only
  const scNorm = c => ({ mode: c && c.mode === 'off' ? 'off' : 'shadow', ...SC.normalize(c) });   // the scalp lane has no live mode yet: off or shadow only
  let scCfg = scNorm(null);              // SCALP LANE settings (meta 'scalp_lane'); default = shadow: records virtual trades only, no orders
  let swCfg = SW.normalize(null);        // SWING MANAGER settings (meta 'swing_mgr'); default = shadow: log only
  let burstCfg = burstNorm(null);        // BURST BRAKE settings (meta 'burst_brake'); default = shadow: log only
  const burstRecent = [];                // recent non-reduce orders {symbol, side, at, key}
  const burstLog = [];                   // what the brake did / would have done: newest last, max 60           // the bots' own reversal readings, by 'SYMBOL|Side' (memory only: a reading is only useful for a few minutes)
  let guardsMaster = true;              // MASTER SWITCH: off = Profit Guard, Sentinel, the stop floor and the early slice all do nothing and trades run on their own stops
  const snState = new Map();            // Trade Sentinel: 'SYMBOL|Side' -> what it knows about that open trade
  const pgState = new Map();            // 'SYMBOL|Buy' -> { entry, initialSl, peak, floor, shadowSl, profile, ... } for every trade being watched
  // deliverAlert (optional dep) = async text => { ok, configured, telegram, email }: waits for the real result. Falls back to fire-and-forget sendAlert.
  const deliverAlert = deps.deliverAlert || (async (t, _o) => { if (!sendAlert) return { ok: false, configured: false }; sendAlert(t); return { ok: true, configured: true, telegram: 'sent' }; });
  const getSecurityInfo = deps.getSecurityInfo || (() => ({}));
  const alertRouter = deps.alertRouter || null;   // { state, route, envChats, tokenSet }: where Telegram alerts go (see alertroute.js)
  const getMasterSync = deps.getMasterSync || (() => ({}));
  const getExecReports = deps.getExecReports || (() => []);
  const getFleet = deps.getFleet || (() => ({ last: {}, info: {}, offlineMs: 0 }));
  const KEY = Buffer.from(SECRET_HEX, 'hex');
  const MAX_RATIO = Number(process.env.MULTIUSER_MAX_RATIO) || 10;
  const MAX_USER_LEVERAGE = Number(process.env.MAX_USER_LEVERAGE) || 0;
  const MIN_LIVE_BALANCE = process.env.MIN_LIVE_BALANCE !== undefined && process.env.MIN_LIVE_BALANCE !== '' ? Math.max(0, Number(process.env.MIN_LIVE_BALANCE) || 0) : STD.minLiveBalance; // live sign-ups only; demo has no minimum
  const demoLike = !!(baseOpts && (baseOpts.demoTrading || baseOpts.baseUrl || baseOpts.testnet));
  // ---- per-user environment (v1.7): each user's key is either a LIVE key or a Bybit DEMO-trading key ----
  // The relay's own BYBIT_DEMO / BYBIT_TESTNET / BYBIT_BASE_URL settings describe the MASTER account only. A user's client is
  // built from that user's own choice, so a base URL pointing at api-demo.bybit.com can never drag a live user onto demo.
  const DEMO_KEYS_ALLOWED = process.env.DISABLE_DEMO_KEYS !== 'true';
  const DEFAULT_ENV = defaultEnvFor(baseOpts); // what users that existed before v1.7 are treated as
  const envOpts = env => envOptsFor(baseOpts, env);
  const TG_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
  const TG_ADMIN_CHAT = process.env.ALERT_TELEGRAM_CHAT_ID || '';
  const tgOn = !!TG_TOKEN;
  let tgBotUsername = process.env.TELEGRAM_BOT_USERNAME || '';

  app.set('trust proxy', 1);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', e => console.error('[multiuser] db pool error:', e.message));
  const q = (text, params) => pool.query(text, params);

  const ready = q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      key_enc TEXT,
      key_hash TEXT UNIQUE,
      key_status TEXT NOT NULL DEFAULT 'ok',
      key_error TEXT,
      ips_unrestricted BOOLEAN DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      size_mult NUMERIC NOT NULL DEFAULT 1,
      daily_loss_limit_usd NUMERIC,
      last_equity NUMERIC,
      last_pnl_sync_ms BIGINT,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      used_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pnl_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id TEXT NOT NULL,
      symbol TEXT, side TEXT, qty NUMERIC,
      entry_price NUMERIC, exit_price NUMERIC,
      closed_pnl NUMERIC NOT NULL,
      open_fee NUMERIC, close_fee NUMERIC, leverage NUMERIC,
      closed_at TIMESTAMPTZ NOT NULL,
      UNIQUE (user_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS equity_snap (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      equity NUMERIC NOT NULL,
      PRIMARY KEY (user_id, day)
    );
    CREATE TABLE IF NOT EXISTS order_log (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      order_link_id TEXT,
      symbol TEXT, side TEXT, qty NUMERIC,
      code TEXT, ok BOOLEAN, detail TEXT, bybit_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS order_log_link_uq ON order_log(user_id, order_link_id) WHERE order_link_id IS NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'core';
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'core';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS share_show_balance BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_counter BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_chat_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_link_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_link_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_notify BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS size_mult_max NUMERIC NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_funding_sync_ms BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS size_mode TEXT NOT NULL DEFAULT 'match';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS size_usd NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS size_pct NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS max_open_trades INT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS symbols_allow TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'both';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS user_max_lev NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_profit_target_usd NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS drawdown_stop_pct NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS equity_peak NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS max_trade_usd NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS max_lev_ceiling NUMERIC;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS control_mode TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_ack_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS key_env TEXT NOT NULL DEFAULT 'live';
    ALTER TABLE users ALTER COLUMN size_mode SET DEFAULT 'percent';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notice TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notice_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_ack_at TIMESTAMPTZ;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS plan_version INT;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS signal_key TEXT;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS risk_usd NUMERIC;
    CREATE INDEX IF NOT EXISTS order_log_signal_idx ON order_log(signal_key) WHERE signal_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS signals (
      k TEXT PRIMARY KEY,
      bot TEXT NOT NULL DEFAULT '', symbol TEXT, side TEXT, eng TEXT, bot_t BIGINT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entry NUMERIC, sl NUMERIC, tp NUMERIC, lev NUMERIC, margin NUMERIC,
      relay_flag TEXT, rid TEXT,
      relay_ok BOOLEAN, relay_code TEXT, relay_secs NUMERIC, relay_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ, won BOOLEAN, exit_price NUMERIC, pct NUMERIC, relayed BOOLEAN, close_why TEXT,
      order_seen_at TIMESTAMPTZ, alarm_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS alert_open_at TIMESTAMPTZ;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS alert_close_at TIMESTAMPTZ;
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS alert_tries INT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS signals_opened_idx ON signals(opened_at DESC);
    CREATE INDEX IF NOT EXISTS signals_rid_idx ON signals(rid) WHERE rid IS NOT NULL AND rid <> '';
    CREATE TABLE IF NOT EXISTS bot_msgs (
      k TEXT PRIMARY KEY, bot TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'other', sym TEXT, priv BOOLEAN NOT NULL DEFAULT FALSE,
      text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, tries INT NOT NULL DEFAULT 0, last_result TEXT
    );
    CREATE INDEX IF NOT EXISTS bot_msgs_recent_idx ON bot_msgs(created_at DESC);
    CREATE TABLE IF NOT EXISTS bot_status (
      bot TEXT PRIMARY KEY, payload TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS plan_versions (
      id SERIAL PRIMARY KEY,
      plan TEXT NOT NULL,
      changed_by TEXT,
      summary TEXT,
      restored_from INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    UPDATE users SET size_mult_max = size_mult WHERE size_mult > size_mult_max;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS ref_price NUMERIC;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS fill_price NUMERIC;
    ALTER TABLE order_log ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC;
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT, action TEXT NOT NULL, target TEXT, ip TEXT, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS funding_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tx_key TEXT NOT NULL,
      symbol TEXT, amount NUMERIC NOT NULL, at TIMESTAMPTZ NOT NULL,
      UNIQUE (user_id, tx_key)
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS profit_guard_log (
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
      symbol TEXT, side TEXT, mode TEXT, profile TEXT, event TEXT,
      entry NUMERIC, mark NUMERIC, old_sl NUMERIC, new_sl NUMERIC, peak_r NUMERIC, lock_pct NUMERIC, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS profit_guard_log_at_idx ON profit_guard_log(at DESC);
    ALTER TABLE profit_guard_log ADD COLUMN IF NOT EXISTS result_r NUMERIC;
    ALTER TABLE profit_guard_log ADD COLUMN IF NOT EXISTS score NUMERIC;
    ALTER TABLE profit_guard_log ADD COLUMN IF NOT EXISTS feat TEXT;
    CREATE TABLE IF NOT EXISTS pg_trades (
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), symbol TEXT, side TEXT, profile TEXT, mode TEXT,
      entry NUMERIC, initial_sl NUMERIC, peak_price NUMERIC, exit_price NUMERIC, peak_pct NUMERIC, exit_pct NUMERIC, giveback_pct NUMERIC,
      peak_r NUMERIC, exit_r NUMERIC, guard_floor NUMERIC, scaled INT, pnl NUMERIC
    );
    ALTER TABLE pg_trades ADD COLUMN IF NOT EXISTS closed_by TEXT;
    CREATE INDEX IF NOT EXISTS pg_trades_sym_at_idx ON pg_trades(symbol, at DESC);
    ALTER TABLE pg_trades ADD COLUMN IF NOT EXISTS reentry BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE pg_trades ADD COLUMN IF NOT EXISTS reentry_score NUMERIC;
    ALTER TABLE pg_trades ADD COLUMN IF NOT EXISTS reentry_src TEXT;
    CREATE TABLE IF NOT EXISTS trade_path (
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), symbol TEXT, side TEXT, mark NUMERIC, now_r NUMERIC, peak_r NUMERIC, atr NUMERIC, score NUMERIC, state TEXT
    );
    CREATE INDEX IF NOT EXISTS trade_path_at_idx ON trade_path(at);
    CREATE TABLE IF NOT EXISTS scalp_trades (
      k TEXT PRIMARY KEY, symbol TEXT, side TEXT, bot TEXT, eng TEXT, klass TEXT, score NUMERIC, signal_px NUMERIC, signal_at TIMESTAMPTZ,
      target NUMERIC, entered BOOLEAN, reason TEXT, exit TEXT, gross_pct NUMERIC, net_pct NUMERIC, usd NUMERIC, mfe NUMERIC, mae NUMERIC, held_min NUMERIC,
      inst_exit TEXT, inst_net NUMERIC, path JSONB, cfg JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS lev NUMERIC;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS base_net NUMERIC;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS base_exit TEXT;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS base_usd NUMERIC;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS feat JSONB;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS gate TEXT;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS tgt_src TEXT;
    ALTER TABLE scalp_trades ADD COLUMN IF NOT EXISTS entry_min NUMERIC;
    CREATE INDEX IF NOT EXISTS scalp_trades_at_idx ON scalp_trades(signal_at DESC);
    CREATE INDEX IF NOT EXISTS scalp_trades_sym_idx ON scalp_trades(symbol, signal_at DESC);
    CREATE TABLE IF NOT EXISTS pace_trades (
      k TEXT PRIMARY KEY, symbol TEXT, side TEXT, bot TEXT, eng TEXT, entry_at TIMESTAMPTZ, entry NUMERIC, sl NUMERIC, tp NUMERIC,
      features JSONB, score NUMERIC, klass TEXT, hours NUMERIC, why TEXT, late BOOLEAN DEFAULT false,
      cp JSONB, peak_r NUMERIC, t05_min NUMERIC, t10_min NUMERIC, proof TEXT, label TEXT, closed_at TIMESTAMPTZ, exit_r NUMERIC, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pace_trades_at_idx ON pace_trades(entry_at DESC);
    CREATE TABLE IF NOT EXISTS sentinel_log (
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), symbol TEXT, side TEXT, mode TEXT, profile TEXT, event TEXT, state TEXT, score NUMERIC,
      entry NUMERIC, mark NUMERIC, old_sl NUMERIC, new_sl NUMERIC, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS sentinel_log_at_idx ON sentinel_log(at DESC);
    CREATE TABLE IF NOT EXISTS sentinel_trades (
      id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), symbol TEXT, side TEXT, profile TEXT, mode TEXT, label TEXT, entry NUMERIC, initial_sl NUMERIC,
      peak_r NUMERIC, max_score NUMERIC, first_alert_at TIMESTAMPTZ, first_danger_at TIMESTAMPTZ, moves INT, shadow_exit_r NUMERIC, exit_price NUMERIC, exit_r NUMERIC, pnl NUMERIC
    );
    -- v2.9.5: the Sentinel scorecard wrote the same closed trade again after a restart (a stale saved state): keep the first row of each trade, once
    DELETE FROM sentinel_trades a USING sentinel_trades b WHERE a.id > b.id AND a.symbol = b.symbol AND a.side = b.side AND a.entry = b.entry AND a.exit_price IS NOT DISTINCT FROM b.exit_price;
    -- when a user switches between a demo key and a live key, the results of the environment they leave are moved here
    -- (kept, never mixed into their current numbers or the admin totals)
    CREATE TABLE IF NOT EXISTS pnl_ledger_old (LIKE pnl_ledger);
    ALTER TABLE pnl_ledger_old ADD COLUMN IF NOT EXISTS env TEXT;
    ALTER TABLE pnl_ledger_old ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS funding_ledger_old (LIKE funding_ledger);
    ALTER TABLE funding_ledger_old ADD COLUMN IF NOT EXISTS env TEXT;
    ALTER TABLE funding_ledger_old ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS master_log (
      id BIGSERIAL PRIMARY KEY,
      exec_id TEXT NOT NULL, bot TEXT NOT NULL DEFAULT '', kind TEXT, symbol TEXT, side TEXT,
      ok BOOLEAN, code TEXT, detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (exec_id, bot)
    );
    -- final-18: indexes for the dashboard's ledger reads (pnl_ledger had only its UNIQUE key) and for the retention job below
    CREATE INDEX IF NOT EXISTS pnl_ledger_user_closed_idx ON pnl_ledger(user_id, closed_at DESC);
    CREATE INDEX IF NOT EXISTS pnl_ledger_closed_idx ON pnl_ledger(closed_at);
    CREATE INDEX IF NOT EXISTS order_log_created_idx ON order_log(created_at);
    CREATE INDEX IF NOT EXISTS master_log_created_idx ON master_log(created_at);
    CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);
  `).then(() => console.log('[multiuser] ON. Database schema ready.'))
    .catch(e => { console.error('[multiuser] schema setup FAILED:', e.message); throw e; });

  // admin "pause all users": blocks NEW trades for every user (closes still go through). Stored in the meta table so it survives restarts.
  let pausedAll = false;
  let masterPlan = { ...PLAN_DEFAULT };
  let planVersion = null; // id of the plan_versions row the live plan came from (stamped on every order log row)
  let dryAll = false;     // admin 'dry run' switch: work out every user's trade, send nothing
  ready.then(async () => {
    // one-time: users that existed before per-user environments take the relay-wide environment they were trading in
    const m = await q(`INSERT INTO meta(k,v) VALUES('key_env_migrated','1') ON CONFLICT DO NOTHING RETURNING k`);
    if (m.rows[0] && DEFAULT_ENV === 'demo') await q(`UPDATE users SET key_env='demo'`);
  }).catch(e => console.error('[multiuser] key_env migration:', e.message));
  const globalReady = ready.then(async () => {
    const r = await q(`SELECT v FROM meta WHERE k='users_paused_all'`);
    pausedAll = !!(r.rows[0] && r.rows[0].v === '1');
    if (alertRouter) {                                   // the saved Telegram routing (group / DM / dev / off); defaults apply if nothing is saved or it cannot be read
      try { const ar = await q(`SELECT v FROM meta WHERE k='alert_routes'`); if (ar.rows[0]) alertRouter.state.cfg = alertRouter.route.normalize(JSON.parse(ar.rows[0].v)); }
      catch (e) { console.error('[multiuser] alert routes not loaded, using defaults:', e.message); }
    }
    try {                                                // Profit Guard: saved settings and the peaks/floors of trades that were open (so a restart forgets nothing)
      const pg = await q(`SELECT k, v FROM meta WHERE k IN ('profit_guard','profit_guard_state','profit_guard_watch','sentinel','sentinel_state','guards_master','burst_brake','sn_start_0_7','swing_mgr','sw_v2912','pace_model','scalp_lane','scalp_state')`);
      for (const row of pg.rows) {
        if (row.k === 'guards_master') guardsMaster = JSON.parse(row.v).on !== false;
        else if (row.k === 'burst_brake') burstCfg = burstNorm(JSON.parse(row.v));
        else if (row.k === 'profit_guard') pgCfg = PG.normalize(JSON.parse(row.v));
        else if (row.k === 'sentinel') snCfg = SN.normalize(JSON.parse(row.v));
        else if (row.k === 'sn_start_0_7' || row.k === 'sw_v2912') { /* marker only */ }
        else if (row.k === 'swing_mgr') swCfg = SW.normalize(JSON.parse(row.v));
        else if (row.k === 'pace_model') pcCfg = PM.normalize(JSON.parse(row.v));
        else if (row.k === 'scalp_lane') scCfg = scNorm(JSON.parse(row.v));
        else if (row.k === 'scalp_state') { const st = JSON.parse(row.v); for (const [k, v] of Object.entries(st || {})) scState.set(k, v); }
        else if (row.k === 'sentinel_state') { const st = JSON.parse(row.v); for (const [k, v] of Object.entries(st || {})) snState.set(k, v); }
        else if (row.k === 'profit_guard_watch') { const st = JSON.parse(row.v); for (const [k, v] of Object.entries(st || {})) pgWatch.set(k, v); }
        else { const st = JSON.parse(row.v); for (const [k, v] of Object.entries(st || {})) pgState.set(k, v); }
      }
      if (!pg.rows.some(r => r.k === 'sn_start_0_7')) {   // v2.9.10: the Sentinel's profit start 0.3R -> 0.7R, once, only if it was never changed from the old default
        const m = SN.migrateStart(snCfg, pg.rows.some(r => r.k === 'sentinel'));
        if (m.changed) {
          snCfg = m.cfg;
          await q(`INSERT INTO meta(k,v) VALUES('sentinel',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(snCfg)]);
          console.log('[sentinel] profit start moved from 0.3R to 0.7R (v2.9.10 default; change it in the Sentinel card if you prefer another value)');
          if (sendAlert) Promise.resolve(sendAlert('🛡️ Sentinel: "in profit" now starts at +0.7R (was +0.3R). Between 0.3R and 0.7R an alert uses the loss-side stop instead of jumping to breakeven. Change it in the Sentinel card if you prefer.')).catch(() => {});
        }
        await q(`INSERT INTO meta(k,v) VALUES('sn_start_0_7','1') ON CONFLICT (k) DO NOTHING`);
      }
      if (!pg.rows.some(r => r.k === 'sw_v2912')) {   // v2.9.12: swing's own Profit Guard numbers (first lock 1.5R, 1.2% gap, one 30% partial at 1.75R), once, only if the saved swing profile is still the old default
        const sw = pgCfg.swing;
        if (pg.rows.some(r => r.k === 'profit_guard') && sw && sw.beR === 1 && sw.scale && sw.scale.on === false && JSON.stringify(sw.scale.steps) === '[[3,0.25]]') {
          pgCfg = PG.normalize({ ...pgCfg, swing: { ...sw, beR: 1.5, minGapPct: 1.2, scale: { on: true, steps: [[1.75, 0.3]] } } });
          await q(`INSERT INTO meta(k,v) VALUES('profit_guard',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(pgCfg)]);
          console.log('[profit guard] swing profile updated to the v2.9.12 defaults (first lock 1.5R, 1.2% gap, one 30% partial at 1.75R)');
        }
        await q(`INSERT INTO meta(k,v) VALUES('sw_v2912','1') ON CONFLICT (k) DO NOTHING`);
      }
    } catch (e) { console.error('[multiuser] profit guard settings not loaded, it stays off:', e.message); }
    const dr = await q(`SELECT v FROM meta WHERE k='dry_run_all'`);
    dryAll = !!(dr.rows[0] && dr.rows[0].v === '1');
    const mp = await q(`SELECT v FROM meta WHERE k='master_plan'`);
    let legacyPlan = null; // the plan as it was before Standard v1 (only needed by the one-time migration below)
    if (mp.rows[0]) {
      try {
        const stored = JSON.parse(mp.rows[0].v);
        legacyPlan = { ...LEGACY_PLAN, ...stored };
        const ok = parseControls(normalizeStoredPlan(stored), { current: PLAN_DEFAULT, allowed: CONTROL_KEYS.concat(['allowManual']) });
        if (!ok.error) masterPlan = { ...PLAN_DEFAULT, ...ok.values };
        else console.error('[multiuser] stored master plan is invalid, using defaults:', ok.error);
      } catch (e) { console.error('[multiuser] could not read master plan:', e.message); }
    }
    await migrateToStandardV1(legacyPlan || LEGACY_PLAN, !!mp.rows[0]);
    // plan history: the newest version is the live one; a fresh database (or one from before v1.4) gets a baseline row
    const lv = await q('SELECT id, plan FROM plan_versions ORDER BY id DESC LIMIT 1');
    if (lv.rows[0]) {
      planVersion = lv.rows[0].id;
      try { if (JSON.stringify(JSON.parse(lv.rows[0].plan)) !== JSON.stringify(masterPlan)) planVersion = await saveVersion('system', 'Plan loaded from settings', null); } catch { /* keep the id */ }
    } else planVersion = await saveVersion('system', 'Baseline', null);
  }).catch(e => { console.error('[multiuser] global state load failed:', e.message); });

  // ---------- Standard v1 migration (one time, safe to re-run: guarded by a meta flag) ----------
  // Old plan: "match" (copy the master's share of balance) x a multiplier. New: every account sizes from its own balance.
  //  - users that were on "match" become 10% x their multiplier (clamped 1-30) and get a one-time notice on their page
  //  - users already on fixed / percent keep exactly their amount
  //  - the stored plan moves to the Standard (20%, max 3 open, 10% daily loss, 30% drawdown, $500 cap); rails the admin had set are kept
  async function migrateToStandardV1(oldPlan, hadStoredPlan) {
    const done = await q(`SELECT 1 FROM meta WHERE k='std_v1_migrated'`);
    if (done.rows[0]) return;
    const users = (await q('SELECT * FROM users ORDER BY id')).rows;
    let converted = 0;
    for (const u of users) {
      const manual = u.control_mode === 'manual' && oldPlan.allowManual !== false;
      const mode = manual ? u.size_mode : oldPlan.sizeMode, mult = Number(manual ? u.size_mult : oldPlan.sizeMult) || 1;
      const usd = manual ? u.size_usd : oldPlan.sizeUsd, pct = manual ? u.size_pct : oldPlan.sizePct;
      const loss = manual ? u.daily_loss_limit_usd : oldPlan.dailyLossLimitUsd;
      if (mode === 'match') {
        const np = Math.min(STD.userPctMax, Math.max(1, Math.round(STD.legacyMatchPct * mult * 100) / 100));
        const text = 'Your trade size changed. Before, trades copied the master account\'s share of its balance. Now every trade uses a percent of YOUR own balance. Your new setting is ' + np + '% per trade. You can change it any time under Trade size.';
        await q(`UPDATE users SET size_mode='percent', size_pct=$2, size_usd=NULL, daily_loss_limit_usd=$3, control_mode='auto', notice=$4, notice_at=now() WHERE id=$1`, [u.id, np, loss, text]);
        converted++;
      } else {
        await q(`UPDATE users SET size_mode=$2, size_usd=$3, size_pct=$4, daily_loss_limit_usd=$5, control_mode='auto' WHERE id=$1`, [u.id, mode, usd, pct, loss]);
      }
    }
    // the plan itself
    const next = { ...PLAN_DEFAULT };
    if (hadStoredPlan) {
      const was = oldPlan;
      if (was.sizeMode === 'fixed' || was.sizeMode === 'percent') Object.assign(next, { sizeMode: was.sizeMode, sizeUsd: was.sizeUsd, sizePct: was.sizePct });
      for (const k of ['maxOpenTrades', 'symbols', 'direction', 'dailyLossLimitUsd', 'dailyProfitTargetUsd', 'drawdownStopPct']) if (was[k] !== null && was[k] !== undefined) next[k] = was[k];
      next.allowManual = true;
    }
    masterPlan = next;
    await q(`INSERT INTO meta(k,v) VALUES('master_plan',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(masterPlan)]);
    planVersion = await saveVersion('system', 'Standard v1 applied (' + converted + ' account(s) moved off "match" sizing)', null);
    await q(`INSERT INTO meta(k,v) VALUES('std_v1_migrated','1') ON CONFLICT DO NOTHING`);
    console.log('[multiuser] Standard v1 migration done: ' + users.length + ' account(s), ' + converted + ' converted from "match" sizing.');
  }

  async function saveVersion(by, summary, restoredFrom) {
    const r = await q('INSERT INTO plan_versions(plan,changed_by,summary,restored_from) VALUES($1,$2,$3,$4) RETURNING id', [JSON.stringify(masterPlan), by, String(summary || '').slice(0, 300), restoredFrom || null]);
    return r.rows[0].id;
  }
  const isDry = u => dryAll || !!u.dry_run;
  const PLAN_LABEL = { sizeMode: 'default amount mode', sizeUsd: 'default USD per trade', sizePct: 'default % of balance', maxOpenTrades: 'max open trades', symbols: 'coins', direction: 'direction',
    dailyLossLimitUsd: 'daily loss limit (USD)', dailyLossPct: 'daily loss limit (% of balance)', dailyProfitTargetUsd: 'daily profit target', drawdownStopPct: 'drawdown stop', maxTradeUsd: 'most any trade can use (USD)' };
  const showVal = v => (v === null || v === undefined ? 'none' : Array.isArray(v) ? v.map(x => x.replace('USDT', '')).join(',') : String(v));
  function planDiff(from, to) {
    return Object.keys(PLAN_LABEL).filter(k => JSON.stringify(from[k] === undefined ? null : from[k]) !== JSON.stringify(to[k] === undefined ? null : to[k]))
      .map(k => ({ key: k, label: PLAN_LABEL[k], from: from[k] === undefined ? null : from[k], to: to[k] === undefined ? null : to[k], text: PLAN_LABEL[k] + ' ' + showVal(from[k]) + ' → ' + showVal(to[k]) }));
  }

  // The settings that actually apply to a user's trades. Autopilot users follow the master plan. Manual users override only
  // their trade amount and loss limit; everything else (coins, direction, max open trades, leverage, profit target, drawdown stop) is always the plan.
  // Returns an object shaped like a users row, so the order code can read the usual columns.
  function effective(u) {
    const p = masterPlan;
    let mode = u.size_mode, pct = u.size_pct === null ? null : Number(u.size_pct), usd = u.size_usd === null ? null : Number(u.size_usd);
    if (mode === 'match') { mode = 'percent'; pct = Math.min(STD.userPctMax, Math.max(1, STD.legacyMatchPct * (Number(u.size_mult) > 0 ? Number(u.size_mult) : 1))); }
    if (mode === 'fixed' && !(usd > 0)) { mode = p.sizeMode === 'fixed' && p.sizeUsd > 0 ? 'fixed' : 'percent'; usd = p.sizeUsd; pct = pct > 0 ? pct : (p.sizePct || STD.pct); }
    if (mode === 'percent' && !(pct > 0)) pct = p.sizePct > 0 ? Number(p.sizePct) : STD.pct;
    return { ...u,
      control_mode: 'manual', // every account has its own settings now; kept so older screens keep working
      size_mode: mode, size_usd: usd, size_pct: pct,
      daily_loss_limit_usd: minPositive(u.daily_loss_limit_usd, p.dailyLossLimitUsd) || null, daily_loss_pct: p.dailyLossPct, // the admin's optional USD limit and the user's own both apply (the lower wins)
      max_trade_usd: minPositive(u.max_trade_usd, p.maxTradeUsd) || null,
      max_open_trades: p.maxOpenTrades, symbols_allow: p.symbols && p.symbols.length ? p.symbols.join(',') : null, direction: p.direction,
      user_max_lev: null, // leverage is always exactly what the signal says
      daily_profit_target_usd: p.dailyProfitTargetUsd, drawdown_stop_pct: p.drawdownStopPct };
  }
  const ownView = u => ({ sizeMode: u.size_mode, sizeMult: Number(u.size_mult), sizeUsd: u.size_usd === null ? null : Number(u.size_usd), sizePct: u.size_pct === null ? null : Number(u.size_pct),
    dailyLossLimitUsd: u.daily_loss_limit_usd === null ? null : Number(u.daily_loss_limit_usd) });

  // Express 4 does not catch errors thrown in async handlers; this wrapper makes every route fail cleanly instead of hanging.
  const h = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) { console.error('[multiuser] route error', req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' }); }
  };

  async function audit(actor, action, target, req, detail) {
    try { await q('INSERT INTO audit_log(actor,action,target,ip,detail) VALUES($1,$2,$3,$4,$5)', [actor, action, target || null, (req && req.ip) || null, String(detail || '').slice(0, 300)]); }
    catch (e) { console.error('[multiuser] audit failed:', e.message); }
  }

  // ---------- Telegram (optional) ----------
  async function tgApi(method, body) {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  async function tgSend(chatId, text) {
    if (!tgOn || !chatId) return false;
    try { const j = await tgApi('sendMessage', { chat_id: chatId, text }); if (!j.ok) console.error('[multiuser] telegram rejected message:', j.description); return !!j.ok; }
    catch (e) { console.error('[multiuser] telegram send failed:', e.message); return false; }
  }
  async function tgSendDoc(chatId, filename, content) {
    if (!tgOn || !chatId) return false;
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('document', new Blob([content], { type: 'text/csv' }), filename);
      const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendDocument', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) console.error('[multiuser] telegram rejected document:', j.description);
      return !!j.ok;
    } catch (e) { console.error('[multiuser] telegram document failed:', e.message); return false; }
  }
  const notify = (u, text) => { if (tgOn && u && u.tg_chat_id && u.tg_notify !== false) tgSend(u.tg_chat_id, (u.key_env === 'demo' ? '[DEMO] ' : '') + text).catch(() => {}); };
  let tgOffset = 0;
  async function tgPollOnce() {
    if (!tgOn) return;
    const j = await tgApi('getUpdates', { offset: tgOffset, timeout: 0, allowed_updates: ['message'] });
    if (!j.ok) return;
    for (const up of j.result || []) {
      tgOffset = up.update_id + 1;
      const m = up.message;
      if (!m || !m.text || !m.chat || m.chat.type !== 'private') continue;
      const code = (m.text.match(/\b[0-9A-Fa-f]{8}\b/) || [])[0];
      if (!code) { await tgSend(m.chat.id, 'To connect alerts, open your YM Oracle page, tap "Connect Telegram", and send me the 8-character code it shows.'); continue; }
      const r = await q('UPDATE users SET tg_chat_id=$2, tg_link_code=NULL, tg_link_expires=NULL WHERE tg_link_code=$1 AND tg_link_expires > now() RETURNING username', [code.toUpperCase(), String(m.chat.id)]);
      await tgSend(m.chat.id, r.rows[0] ? '✅ Connected. You will now get alerts for ' + r.rows[0].username + '.' : "That code isn't valid or has expired. Generate a new one on your page.");
    }
  }
  async function loadBotName() {
    if (!tgOn || tgBotUsername) return;
    try { const j = await tgApi('getMe'); if (j.ok) tgBotUsername = j.result.username || ''; } catch { /* optional */ }
  }

  // ---------- Bybit helpers ----------
  const userClient = u => {
    const { k, s } = JSON.parse(decrypt(u.key_enc, KEY));
    return new RestClientV5({ key: k, secret: s, ...envOpts(u.key_env) });
  };
  const bybitErr = r => { const e = new Error(r.retMsg || 'Bybit error'); e.retCode = r.retCode; return e; };

  async function getEquity(client) {
    const r = await client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
    if (r.retCode !== 0) throw bybitErr(r);
    const acct = (r.result.list || [])[0] || {};
    const c = (acct.coin || []).find(x => x.coin === 'USDT') || {};
    const equity = parseFloat(c.equity || c.walletBalance || 0);
    let available = parseFloat(acct.totalAvailableBalance);
    if (!Number.isFinite(available)) available = equity;
    return { equity, available };
  }
  async function getPositionState(client, symbol) {
    const r = await client.getPositionInfo({ category: 'linear', symbol });
    if (r.retCode !== 0) throw bybitErr(r);
    const list = r.result.list || [];
    const lev = parseFloat((list.find(p => parseFloat(p.size) > 0) || list[0] || {}).leverage);
    return { open: list.find(p => parseFloat(p.size) > 0) || null, leverage: lev > 0 ? lev : null };
  }
  async function getOpenPosition(client, symbol) { return (await getPositionState(client, symbol)).open; }
  async function listOpenPositions(client) {
    const out = [];
    let cursor;
    do {
      const r = await client.getPositionInfo({ category: 'linear', settleCoin: 'USDT', limit: 200, cursor });
      if (r.retCode !== 0) throw bybitErr(r);
      for (const p of (r.result.list || [])) if (parseFloat(p.size) > 0) out.push(p);
      cursor = r.result.nextPageCursor || undefined;
    } while (cursor);
    return out;
  }

  // Reads from the MASTER account / Bybit market data that every user's order depends on. A single failed read used to make
  // every user's copy of that trade fail with "could not read the master account"; now each read is tried up to 3 times, and if
  // Bybit stays unreachable a recent known value is used instead (equity up to 15 min old, an instrument's rules of any age).
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function withRetry(fn, tries) {
    let last;
    for (let i = 0; i < (tries || 3); i++) {
      try { return await fn(); } catch (e) { last = e; if (i < (tries || 3) - 1) await sleep(400 * (i + 1)); }
    }
    throw last;
  }
  let adminEq = { at: 0, v: null };
  // The master account's own Bybit key can be changed from the dashboard. It is stored encrypted (same AES-GCM key as users' keys)
  // in the meta table and overrides the BYBIT_API_KEY / BYBIT_API_SECRET environment variables until reset.
  const MASTER_META = 'master_creds';
  async function loadMasterCreds() {
    await ready;
    const r = await q(`SELECT v FROM meta WHERE k=$1`, [MASTER_META]);
    if (!r.rows[0]) return null;
    try { const o = JSON.parse(decrypt(r.rows[0].v, KEY)); return o && o.k && o.s ? o : null; } catch { return null; }
  }
  async function saveMasterCreds(o) {
    await ready;
    await q(`INSERT INTO meta(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [MASTER_META, encrypt(JSON.stringify({ k: o.k, s: o.s, env: normEnv(o.env) === 'demo' ? 'demo' : 'live', at: Date.now() }), KEY)]);
    adminEq = { at: 0, v: null };
    return { ok: true };
  }
  async function clearMasterCreds() {
    await ready;
    await q(`DELETE FROM meta WHERE k=$1`, [MASTER_META]);
    adminEq = { at: 0, v: null };
    return { ok: true };
  }
  async function getAdminEquity() {
    if (Date.now() - adminEq.at < 60000 && adminEq.v) return adminEq.v;
    try {
      const v = (await withRetry(() => getEquity(restClient))).equity;
      adminEq = { at: Date.now(), v };
      return v;
    } catch (e) {
      if (adminEq.v && Date.now() - adminEq.at < 15 * 60000) { console.warn('[multiuser] master equity unreadable, using the value from ' + Math.round((Date.now() - adminEq.at) / 1000) + 's ago'); return adminEq.v; }
      throw e;
    }
  }
  const instCache = new Map();
  async function getInstrument(symbol) {
    const hit = instCache.get(symbol);
    if (hit && Date.now() - hit.at < 600000) return hit.v;
    try {
      const r = await withRetry(() => restClient.getInstrumentsInfo({ category: 'linear', symbol }));
      if (r.retCode !== 0 || !(r.result.list || []).length) return null;
      const i = r.result.list[0];
      const v = { qtyStep: parseFloat(i.lotSizeFilter.qtyStep), minQty: parseFloat(i.lotSizeFilter.minOrderQty), status: i.status, tickSize: parseFloat((i.priceFilter || {}).tickSize) || 0 };
      instCache.set(symbol, { at: Date.now(), v });
      return v;
    } catch (e) {
      if (hit) { console.warn('[multiuser] instrument lookup failed for ' + symbol + ', using the cached rules'); return hit.v; }
      throw e;
    }
  }
  async function getRefPrice(symbol) {
    try { const r = await withRetry(() => restClient.getTickers({ category: 'linear', symbol }), 2); const p = parseFloat(r.result.list[0].lastPrice); return p > 0 ? p : null; }
    catch { return null; }
  }

  async function validateKey(apiKey, apiSecret, env) {
    env = normEnv(env);
    const opts = envOpts(env);
    const client = new RestClientV5({ key: apiKey, secret: apiSecret, ...opts });
    const warnings = [];
    let ipsUnrestricted = false;
    // demo keys, testnet and a fake base URL have no permission/IP restrictions worth checking
    if (env === 'live' && !opts.baseUrl && !opts.testnet) {
      const info = await client.getQueryApiKey();
      if (info.retCode !== 0) return { ok: false, message: 'Bybit rejected this key: ' + (info.retMsg || 'unknown error') };
      const problem = permissionProblem(info.result);
      if (problem) return { ok: false, message: problem };
      const ips = String(info.result.ips || '');
      ipsUnrestricted = !ips || ips.includes('*');
      if (ipsUnrestricted) warnings.push('This key is not IP-restricted. Strongly recommended: whitelist the server IP on the key.');
    }
    let eq;
    try { eq = await getEquity(client); } catch (e) { return { ok: false, message: 'Could not read the account balance with this key: ' + e.message + (env === 'demo' ? ' (Is this a Bybit DEMO-trading key? Create it while in Demo Trading mode.)' : ' (If this is a demo-trading key, choose Demo.)') }; }
    return { ok: true, equity: eq.equity, warnings, ipsUnrestricted };
  }

  // ---------- logging / alerts ----------
  async function logOrder(row) {
    await ready;
    try {
      const r = await q(
        `INSERT INTO order_log(user_id,kind,order_link_id,symbol,side,qty,code,ok,detail,bybit_order_id,plan_version,signal_key,risk_usd)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
        [row.userId, row.kind, row.link || null, row.symbol || null, row.side || null, row.qty || null, row.code, row.ok, String(row.detail || '').slice(0, 300), row.bybitOrderId || null, planVersion, row.signalKey || null, row.riskUsd ?? null]);
      return r.rows[0] ? r.rows[0].id : null;
    } catch (e) { console.error('[multiuser] logOrder failed:', e.message); return null; }
  }
  async function markKeyError(u, detail) {
    const r = await q(`UPDATE users SET key_status='error', key_error=$2 WHERE id=$1 AND key_status<>'error' RETURNING username`, [u.id, String(detail || '').slice(0, 200)]);
    if (r.rows[0]) {
      if (sendAlert) sendAlert('⚠️ User ' + r.rows[0].username + ': Bybit API key stopped working (' + detail + '). Their trading is paused until it is fixed.');
      notify(u, '⚠️ Your Bybit API key stopped working (' + String(detail || '').slice(0, 80) + '). Trading on your account is off until you replace the key on your page.');
      await audit('system', 'key_error', u.username, null, detail);
    }
  }

  // ---------- fan-out ----------
  const queues = new Map(); // per-user serial queue so leverage -> order -> stops never overlap or reorder
  function enqueue(userId, fn) {
    const prev = queues.get(userId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(userId, next);
    next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); }).catch(() => {});
    return next;
  }
  async function runLimited(items, limit, fn) {
    for (let i = 0; i < items.length; i += limit) await Promise.allSettled(items.slice(i, i + limit).map(fn));
  }
  // LANES: every existing fan-out (orders, stops, partial closes, leverage) is the CORE lane. Scalp-lane users are a separate
  // group and are never returned unless a caller asks for lane 'scalp' explicitly (only the scalp lane code does).
  async function tradableUsers({ forOpen, lane = 'core' }) {
    await ready; await globalReady;
    if (forOpen && pausedAll) return [];
    const r = await q(`SELECT * FROM users WHERE active AND key_enc IS NOT NULL AND key_status='ok' AND lane=$1 ${forOpen ? 'AND NOT paused' : ''} ORDER BY id`, [lane === 'scalp' ? 'scalp' : 'core']);
    return r.rows;
  }
  async function todaysPnl(userId) {
    const r = await q(`SELECT COALESCE(SUM(closed_pnl),0) AS p FROM pnl_ledger WHERE user_id=$1 AND closed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, [userId]);
    return Number(r.rows[0].p);
  }
  function failFrom(e) {
    if (e && e.retCode !== undefined) return { code: classifyRet(e.retCode), detail: e.message, auth: AUTH_RET_CODES.has(e.retCode) };
    return { code: 'NET', detail: (e && e.message) || 'network error', auth: false };
  }
  async function recordFill(client, rowId, link, side, ref) {
    try {
      const r = await client.getHistoricOrders({ category: 'linear', orderLinkId: link, limit: 1 });
      const o = ((r.result && r.result.list) || [])[0];
      const fill = o ? parseFloat(o.avgPrice) : NaN;
      if (!(fill > 0)) return;
      const bps = ref > 0 ? ((fill - ref) / ref) * 10000 * (side === 'Buy' ? 1 : -1) : null; // positive = the user paid more than the reference
      await q('UPDATE order_log SET fill_price=$2, ref_price=$3, slippage_bps=$4 WHERE id=$1', [rowId, fill, ref > 0 ? ref : null, bps]);
    } catch { /* slippage tracking is best-effort */ }
  }

  async function orderForUser(u, o, ctx) {
    u = effective(u); // autopilot users get the master plan; manual users only override amount + loss limit
    const link = ('u' + u.id + '-' + sha1(ctx.signalKey)).slice(0, 36);
    const base = { userId: u.id, kind: 'ORDER', link: null, symbol: o.symbol, side: o.side, signalKey: ctx.signalKeyRaw || null };
    const finish = async (code, ok, detail, extra) => {
      const id = await logOrder({ ...base, ...(extra || {}), code, ok, detail });
      const friendly = code === 'MINQ' || code === 'BAL' || (code === 'HALT' && detail !== 'Global halt is on'); // these carry a specific, user-readable explanation
      if (!ok && !QUIET_CODES.has(code)) notify(u, '⚠️ ' + o.symbol.replace('USDT', '') + ': ' + (friendly ? detail : (CODE_TEXT[code] || detail)));
      return id;
    };
    if (breakerIsTripped()) return finish('HALT', false, 'Global halt is on');
    if (ctx.mode === 'paper') return finish('PAPER', true, 'Paper mode, nothing sent');
    try {
      const client = userClient(u);
      let qty;
      if (ctx.reduceOnly) {
        const pos = await getOpenPosition(client, o.symbol);
        if (!pos) return finish('NOPOS', true, 'No open position to close');
        const closes = (pos.side === 'Buy' && o.side === 'Sell') || (pos.side === 'Sell' && o.side === 'Buy');
        if (!closes) return finish('SIDE', false, 'Their position is on the other side');
        qty = pos.size;
      } else {
        // the user's own filters (no Bybit call needed)
        const isLong = o.side === 'Buy';
        if ((u.direction === 'long' && !isLong) || (u.direction === 'short' && isLong)) return finish('FILT', true, 'Skipped: you only copy ' + u.direction + ' trades');
        if (u.symbols_allow) {
          const allowed = String(u.symbols_allow).split(',').filter(Boolean);
          if (allowed.length && !allowed.includes(o.symbol)) return finish('FILT', true, 'Skipped: ' + o.symbol.replace('USDT', '') + ' is not in your coin list');
        }
        const pstate = await getPositionState(client, o.symbol);
        if (pstate.open) return finish('HELD', false, 'Already holding this pair');
        if (u.max_open_trades > 0) {
          const open = await listOpenPositions(client);
          if (open.length >= u.max_open_trades) return finish('MAXT', true, 'Skipped: you already have ' + open.length + ' open trade(s) and the limit is ' + u.max_open_trades + '. This protects your balance');
        }
        if (u.daily_loss_limit_usd !== null && Number(u.daily_loss_limit_usd) > 0 || u.daily_profit_target_usd !== null && Number(u.daily_profit_target_usd) > 0) {
          const today = await todaysPnl(u.id);
          if (u.daily_loss_limit_usd !== null && Number(u.daily_loss_limit_usd) > 0 && today <= -Number(u.daily_loss_limit_usd)) return finish('HALT', false, 'Daily loss limit reached: you are down $' + (-today).toFixed(2) + ' today. New trades start again tomorrow');
          if (u.daily_profit_target_usd !== null && Number(u.daily_profit_target_usd) > 0 && today >= Number(u.daily_profit_target_usd)) return finish('HALT', true, 'Daily profit target reached (+' + today.toFixed(2) + ' USD today). New trades resume tomorrow');
        }
        if (!ctx.inst) return finish('PAIR', false, 'Pair not tradable');
        const bal = await getEquity(client);
        // drawdown stop: remember the highest balance we have seen, and pause the user if they fall too far below it
        const peak = Math.max(Number(u.equity_peak) || 0, bal.equity);
        if (peak !== Number(u.equity_peak)) await q('UPDATE users SET equity_peak=$2 WHERE id=$1', [u.id, peak]);
        if (u.drawdown_stop_pct !== null && Number(u.drawdown_stop_pct) > 0 && peak > 0 && bal.equity <= peak * (1 - Number(u.drawdown_stop_pct) / 100)) {
          await q('UPDATE users SET paused=TRUE WHERE id=$1', [u.id]);
          return finish('HALT', false, 'Drawdown stop hit: your balance is ' + (((peak - bal.equity) / peak) * 100).toFixed(1) + '% below its peak (limit ' + Number(u.drawdown_stop_pct) + '%). Trading is paused until you resume it on your page');
        }
        // daily loss limit as a share of the balance the day started with (the admin's USD limit, if any, still applies above)
        if (Number(u.daily_loss_pct) > 0) {
          const today = await todaysPnl(u.id);
          if (today < 0) {
            const sn = await q(`SELECT equity FROM equity_snap WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date`, [u.id]);
            const opening = sn.rows[0] ? Number(sn.rows[0].equity) : bal.equity - today;
            const limit = opening * Number(u.daily_loss_pct) / 100;
            if (opening > 0 && -today >= limit) return finish('HALT', false, 'Daily loss limit reached: you are down $' + (-today).toFixed(2) + ' today (limit ' + Number(u.daily_loss_pct) + '% of the $' + opening.toFixed(2) + ' you started the day with). New trades start again tomorrow');
          }
        }
        const levCap = minPositive(MAX_USER_LEVERAGE, u.max_lev_ceiling, u.user_max_lev);
        const lev = pstate.leverage && levCap ? Math.min(pstate.leverage, levCap) : pstate.leverage;
        const s = sizeForUser({ mode: u.size_mode, adminQty: o.qty, adminEquity: ctx.adminEquity, userEquity: bal.equity, available: bal.available, mult: u.size_mult,
          sizeUsd: u.size_usd, sizePct: u.size_pct, maxTradeUsd: u.max_trade_usd, leverage: lev, price: ctx.refPrice,
          qtyStep: ctx.inst.qtyStep, minQty: ctx.inst.minQty, maxRatio: MAX_RATIO });
        if (!s.qty) return finish(s.code, false, s.detail);
        qty = s.qty;
        if (ctx.burst && ctx.burst.mode === 'live' && ctx.burst.factor < 1) {   // BURST BRAKE: a later same-direction copy in a burst is smaller (never below the exchange minimum)
          const stepB = Number(ctx.inst.qtyStep) || 0, minB = Number(ctx.inst.minQty) || 0;
          let qb = qty * ctx.burst.factor; if (stepB > 0) qb = Math.floor(qb / stepB + 1e-9) * stepB;
          qb = Number(qb.toFixed(12));
          if (qb >= minB && qb > 0) { base.burstNote = 'Burst brake: ' + ctx.burst.n + ' other same-direction trade(s) opened recently, this copy is ' + Math.round(ctx.burst.factor * 100) + '% size'; qty = qb; }
        }
        // what this trade would lose if the signal's stop is hit (an estimate from the market price at signal time)
        const stopPx = Number(o.stopLoss);
        if (stopPx > 0 && ctx.refPrice > 0) base.riskUsd = Math.round(qty * Math.abs(ctx.refPrice - stopPx) * 100) / 100;
        await q('UPDATE users SET last_equity=$2 WHERE id=$1', [u.id, bal.equity]);
        // dry run: everything above ran for real (filters, limits, sizing); stop here and only record what would have been sent
        if (isDry(u)) return finish('DRY', true, 'Dry run: would ' + (o.side === 'Buy' ? 'buy' : 'sell') + ' ' + qty + ' ' + o.symbol.replace('USDT', '') + (lev ? ' at ' + lev + 'x' : '') + (ctx.refPrice ? ' (about $' + (qty * ctx.refPrice / (lev || 1)).toFixed(2) + ' margin)' : ''), { link: 'dry-' + link, qty });
      }
      // claim the idempotency slot BEFORE sending, so a retransmitted signal can never double-trade this user
      const claimed = await logOrder({ ...base, link, qty, code: 'PENDING', ok: false, detail: 'Sending' });
      if (!claimed) return;
      const orderBody = { ...o, qty: String(qty), orderLinkId: link };
      let res;
      // a dropped connection says nothing about whether Bybit got it; the same orderLinkId makes every retry safe (a duplicate is refused)
      for (let attempt = 0; ; attempt++) {
        try { res = await client.submitOrder(orderBody); break; }
        catch (e1) { if (attempt >= 2) throw e1; await sleep(500 * (attempt + 1)); }
      }
      if (res.retCode === 110072) res = { ...res, retCode: 0, result: res.result || {} }; // duplicate = our earlier try did land
      if (res.retCode === 0) {
        await q(`UPDATE order_log SET code='OK', ok=true, detail=$3, bybit_order_id=$2 WHERE id=$1`, [claimed, (res.result && res.result.orderId) || null, 'Placed' + (base.burstNote ? ' (' + base.burstNote + ')' : '')]);
        if (!ctx.reduceOnly) {
          notify(u, '✅ Opened ' + o.symbol.replace('USDT', '') + ' ' + (o.side === 'Buy' ? 'long' : 'short') + ' (' + qty + ')');
          const t = setTimeout(() => recordFill(client, claimed, link, o.side, ctx.refPrice), 3000);
          if (t.unref) t.unref();
        }
      } else {
        const f = failFrom({ retCode: res.retCode, message: res.retMsg });
        await q(`UPDATE order_log SET code=$2, ok=false, detail=$3 WHERE id=$1`, [claimed, f.code, res.retMsg]);
        if (f.auth) await markKeyError(u, res.retMsg); else notify(u, '⚠️ ' + o.symbol.replace('USDT', '') + ': ' + (CODE_TEXT[f.code] || res.retMsg));
      }
    } catch (e) {
      const f = failFrom(e);
      await logOrder({ ...base, code: f.code, ok: false, detail: f.detail });
      if (f.auth) await markKeyError(u, f.detail);
    }
  }

  const expoCache = { at: 0, list: [] };
  async function openSameSide(side, symbol) {   // other coins the master holds on this side right now (cached 20 s)
    if (Date.now() - expoCache.at > 20000) { expoCache.list = await listOpenPositions(restClient); expoCache.at = Date.now(); }
    return expoCache.list.filter(p => p.side === side && p.symbol !== symbol).length;
  }
  async function fanOutOrder(body) {
    const o = sanitizeOrder(body);
    if (!o) { console.warn('[multiuser] fan-out skipped: order failed validation'); return; }
    const reduceOnly = o.reduceOnly === true;
    await markOrderSeen(body && body.orderLinkId).catch(() => {});   // the bot's signal reached the relay: stops the "never arrived" alarm
    let burst = null;
    if (!reduceOnly && burstCfg.mode !== 'off') {   // BURST BRAKE: count same-side opens on other coins in the last few minutes (a retransmit of the same signal is not counted twice)
      const nowB = Date.now(), keyB = (body && body.orderLinkId) || (o.symbol + '|' + o.side + '|' + Math.floor(nowB / 60000));
      while (burstRecent.length && nowB - burstRecent[0].at > 3 * 3600000) burstRecent.shift();
      if (!burstRecent.some(r => r.key === keyB)) {
        burst = burstFactor(burstRecent, o.symbol, o.side, nowB, burstCfg);
        burstRecent.push({ symbol: o.symbol, side: o.side, at: nowB, key: keyB });
        try {   // v2.9.12 exposure across fast + swing: the smaller of the two factors wins
          if (burstCfg.expo && burstCfg.expo.on) {
            const open = await openSameSide(o.side, o.symbol), fx = burstCfg.expo.factors[Math.min(open, burstCfg.expo.factors.length - 1)];
            if (fx < burst.factor) burst = { n: burst.n, factor: fx, mode: burst.mode, expo: open };
          }
        } catch (e) { console.error('[multiuser] exposure check:', e.message); }
        if (burst.factor < 1) { burstLog.push({ at: new Date(nowB).toISOString(), symbol: o.symbol, side: o.side, n: burst.n, factor: burst.factor, mode: burst.mode, ...(burst.expo !== undefined ? { sameSideOpen: burst.expo } : {}) }); if (burstLog.length > 60) burstLog.shift(); }
      }
    }
    const users = await tradableUsers({ forOpen: !reduceOnly }); // pause stops NEW trades only; closes always go through
    if (!users.length) return;
    const mode = getMode();
    const minute = Math.floor(Date.now() / 60000);
    const signalKey = (body && body.orderLinkId) || [o.symbol, o.side, o.qty, reduceOnly, minute].join('|');
    const ctx = { mode, reduceOnly, signalKey, signalKeyRaw: (body && typeof body.orderLinkId === 'string' && body.orderLinkId.slice(0, 40)) || null, adminEquity: null, inst: null, refPrice: null, burst };
    if (mode === 'live' && !reduceOnly) {
      let sizingErr = null;
      try { ctx.adminEquity = await getAdminEquity(); ctx.inst = await getInstrument(o.symbol); }
      catch (e) { sizingErr = e; console.error('[multiuser] could not size order (admin equity / instrument):', e.message); }
      if (!ctx.adminEquity || (sizingErr && !ctx.inst)) {
        await Promise.allSettled(users.map(u => logOrder({ userId: u.id, kind: 'ORDER', symbol: o.symbol, side: o.side, code: 'NET', ok: false, detail: 'Could not read the master account to size this order' })));
        return;
      }
      ctx.refPrice = await getRefPrice(o.symbol);
    }
    await runLimited(users, 5, u => enqueue(u.id, () => orderForUser(u, o, ctx)));
  }

  async function fanOutTradingStop(body) {
    const st = sanitizeStop(body);
    if (!st || getMode() === 'paper' || breakerIsTripped()) return;
    const users = await tradableUsers({ forOpen: false });
    await runLimited(users, 5, u => enqueue(u.id, async () => {
      if (isDry(u)) return;
      const base = { userId: u.id, kind: 'SLTP', symbol: st.symbol };
      try {
        const client = userClient(u);
        const pos = await getOpenPosition(client, st.symbol);
        if (!pos) return;
        const res = await client.setTradingStop({ category: 'linear', ...st });
        if (res.retCode === 0 || res.retCode === 34040) return logOrder({ ...base, side: pos.side, code: 'OK', ok: true, detail: 'Stops updated' });
        const f = failFrom({ retCode: res.retCode, message: res.retMsg });
        await logOrder({ ...base, side: pos.side, code: f.code, ok: false, detail: res.retMsg });
        if (f.auth) await markKeyError(u, res.retMsg);
      } catch (e) {
        const f = failFrom(e);
        await logOrder({ ...base, code: f.code, ok: false, detail: f.detail });
        if (f.auth) await markKeyError(u, f.detail);
      }
    }));
  }

  // Closes every open USDT position (and cancels resting orders) on one user's account. Used by the user's own
  // "close all" button, "pause and close everything", and the admin's emergency close-all.
  async function closeAllForUser(u, why) {
    const out = { closed: 0, failed: 0, error: null };
    try {
      const client = userClient(u);
      const positions = await listOpenPositions(client);
      try { await client.cancelAllOrders({ category: 'linear', settleCoin: 'USDT' }); } catch { /* best effort */ }
      for (const p of positions) {
        const side = p.side === 'Buy' ? 'Sell' : 'Buy';
        try {
          const res = await client.submitOrder({ category: 'linear', symbol: p.symbol, side, orderType: 'Market', qty: String(p.size), reduceOnly: true, positionIdx: Number(p.positionIdx) || 0 });
          if (res.retCode === 0) { out.closed++; await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, qty: Number(p.size), code: 'OK', ok: true, detail: 'Closed: ' + why }); }
          else { out.failed++; await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, code: classifyRet(res.retCode), ok: false, detail: res.retMsg }); }
        } catch (e) { out.failed++; await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, code: failFrom(e).code, ok: false, detail: e.message }); }
      }
    } catch (e) { out.error = e.message; out.failed++; if (failFrom(e).auth) await markKeyError(u, e.message); }
    return out;
  }

  async function fanOutLeverage(body) {
    if (!sanitizeLeverage(body, 0) || getMode() === 'paper' || breakerIsTripped()) return;
    const users = await tradableUsers({ forOpen: true });
    await runLimited(users, 5, u => enqueue(u.id, async () => {
      // each user's leverage is capped by the global cap, the admin's ceiling for them, and their own setting (lowest wins)
      if (isDry(u)) return; // dry run never touches an account
      const lv = sanitizeLeverage(body, minPositive(MAX_USER_LEVERAGE, u.max_lev_ceiling, effective(u).user_max_lev));
      const base = { userId: u.id, kind: 'LEV', symbol: lv.symbol };
      try {
        const res = await userClient(u).setLeverage(lv);
        if (res.retCode === 0 || res.retCode === 110043) return;
        const f = failFrom({ retCode: res.retCode, message: res.retMsg });
        await logOrder({ ...base, code: 'LEV', ok: false, detail: res.retMsg });
        if (f.auth) await markKeyError(u, res.retMsg);
      } catch (e) {
        const f = failFrom(e);
        await logOrder({ ...base, code: f.code, ok: false, detail: f.detail });
        if (f.auth) await markKeyError(u, f.detail);
      }
    }));
  }

  // ---------- master account journal + interrupted-order recovery (v1.6) ----------
  // What the manager reported for each signal on the MASTER account. Kept in the database (the relay's own files are wiped
  // by a Render restart), so "why did nothing happen for that trade" can always be answered afterwards.
  async function recordExec(rec) {
    await ready;
    await q(`INSERT INTO master_log(exec_id,bot,kind,symbol,side,ok,code,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (exec_id, bot) DO UPDATE SET ok=EXCLUDED.ok, code=EXCLUDED.code, detail=EXCLUDED.detail, created_at=now()`,
      [rec.id, rec.bot || '', rec.kind, rec.symbol, rec.side, rec.ok === true, rec.code, rec.detail]);
    await markOrderSeen('ym-' + rec.id).catch(() => {});
  }

  // ---------- master account sizing (v3, OFF by default) ----------
  // Until now the master account traded whatever margin the bot/manager asked for ($100), while every user was sized from their own
  // balance. With MASTER_FOLLOWS_PLAN=true the relay sizes the master's open orders with the SAME rule as everyone else (balance x plan
  // percent, capped, at the leverage already set for the pair). The manager keeps working unchanged: it just sends its usual order and the
  // relay replaces the quantity. If anything can't be worked out the manager's own quantity is used, so a trade is never lost to this.
  const masterFollows = () => process.env.MASTER_FOLLOWS_PLAN === 'true';
  async function sizeMasterOrder(body) {
    if (!masterFollows()) return null;
    const o = sanitizeOrder(body);
    if (!o || o.reduceOnly === true || getMode() !== 'live') return null;
    try {
      const [bal, inst, ref, ps] = await Promise.all([withRetry(() => getEquity(restClient)), getInstrument(o.symbol), getRefPrice(o.symbol), getPositionState(restClient, o.symbol)]);
      if (!inst || ps.open || !ps.leverage) return null;   // unknown pair / already holding it: the normal rules handle it
      const sz = sizeForUser({ mode: masterPlan.sizeMode, sizePct: masterPlan.sizePct, sizeUsd: masterPlan.sizeUsd, maxTradeUsd: masterPlan.maxTradeUsd, leverage: ps.leverage, price: ref,
        userEquity: bal.equity, available: bal.available, qtyStep: inst.qtyStep, minQty: inst.minQty });
      if (!sz.qty) return { skipped: sz.code, detail: sz.detail };
      return { qty: sz.qty, marginUsd: sz.marginUsd, leverage: ps.leverage, from: Number(o.qty) };
    } catch (e) { console.warn('[multiuser] master sizing skipped:', e.message); return null; }
  }

  // ---------- signal ledger (v2): what each bot says it did, matched to what actually reached the relay ----------
  // Every bot posts open / relay / close / status events to /api/bot-event (firmware 'WEBLEDGER'). They are stored by the bot's own key
  // `k`, so a retransmit (the bots resend until they get a 2xx) can never create a second row or change an earlier one.
  let lastBotTestAt = 0;
  const KEY_RE = /^[\w.\-]{1,60}$/;
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
  const numOr = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const sideOf = v => (String(v).toUpperCase() === 'BUY' ? 'BUY' : String(v).toUpperCase() === 'SELL' ? 'SELL' : null);
  async function markOrderSeen(orderLinkId) {
    if (typeof orderLinkId !== 'string') return;
    const rid = orderLinkId.replace(/^ym-/, '');
    if (!rid) return;
    await ready;
    await q(`UPDATE signals SET order_seen_at=now() WHERE rid=$1 AND order_seen_at IS NULL`, [rid]);
  }
  async function recordBotEvent(b) {
    await ready;
    if (!b || typeof b !== 'object' || Number(b.v) !== 1) return { status: 400, message: 'unsupported event' };
    const bot = clip(b.bot, 30);
    if (!bot) return { status: 400, message: 'bot is required' };
    const ev = String(b.ev || '');
    // Abuse guard: while DEVICE_KEY_MODE is 'warn' anyone who knows the URL can post here, so alerts and new ledger rows are capped. A bot that is capped
    // gets a 429, which it treats as "try again later" (it keeps the report), so a real alert is delayed, never lost.
    if (ev === 'msg') {
      const rc = await q(`SELECT COUNT(*) FILTER (WHERE bot=$1)::int AS mine, COUNT(*)::int AS total FROM bot_msgs WHERE created_at > now() - interval '10 minutes'`, [bot]);
      if (rc.rows[0].mine >= 40 || rc.rows[0].total >= 120) return { status: 429, message: 'too many alerts, try again shortly' };
    }
    if (ev === 'test') {
      if (Date.now() - lastBotTestAt < 15000) return { status: 429, message: 'one test at a time' };
      lastBotTestAt = Date.now();
    }
    if (ev === 'read') {                                                   // the bot's own reversal reading for one open trade (memory only, never the ledger)
      const rs = String(b.sym || '').toUpperCase();
      if (!SYMBOL_RE.test(rs)) return { status: 400, message: 'bad symbol' };
      const rsd = sideOf(b.side);
      if (rsd !== 'BUY' && rsd !== 'SELL') return { status: 400, message: 'bad side' };
      const u = numOr(b.urg), rpv = numOr(b.rp);
      if (u === null || u === undefined || u < 0 || u > 1.5) return { status: 400, message: 'bad reading' };
      const rkey = rs + '|' + (rsd === 'BUY' ? 'Buy' : 'Sell');
      botReads.set(rkey, { urg: u, rp: rpv, st: b.st ? 1 : 0, tr: b.tr ? 1 : 0, pf: numOr(b.pf), rm: numOr(b.rm), at: Date.now(), bot });
      if (botReads.size > 200) for (const [kk, vv] of botReads) if (Date.now() - vv.at > 1800000) botReads.delete(kk);
      // "hold" = the relay is acting on this trade right now, so the bot may leave the whole-trade close to it (unless the reading is very strong)
      const g0 = pgState.get(rkey);
      const hold = !!(guardsMaster && pgCfg.smart.rev.on && pgCfg.smart.curve.on && g0 && PG.effMode(pgCfg, g0.profile) === 'live' && getMode() === 'live' && !breakerIsTripped());
      // v2.9.4 close feedback: if the exchange position this bot is still tracking has already closed, hand back the real exit. The bot sends the
      // epoch second it opened the trade (ot); the relay's own trade must have started shortly after that and ended after it, so an older or newer trade
      // on the same coin is never mistaken for it. No ot (older firmware) = no feedback.
      let closed = null;
      const otMs = numOr(b.ot) > 1e9 ? numOr(b.ot) * 1000 : 0;
      const mc = masterClosed.get(rkey);
      if (otMs && mc && mc.exit > 0 && mc.since >= otMs - 120000 && mc.since <= otMs + 900000 && mc.at > otMs && Date.now() - mc.at < 48 * 3600000) closed = { x: mc.exit, r: mc.exitR };
      // v2.9.11: the memory above is lost on every restart or redeploy. Fall back to the saved scorecard: the first trade on this coin and side that closed after the bot opened its own, with a real exit.
      if (!closed && otMs) closed = await closedFromDb(rkey, otMs);
      // v2.9.6: the stop that is really on Bybit for this trade, only while the Profit Guard is LIVE for it and the relay is trading normally. The bot copies it
      // (tighter only) and, while it receives it, leaves stop moves to the relay instead of sending its own through the manager.
      let slNow = (g0 && guardsMaster && PG.effMode(pgCfg, g0.profile) === 'live' && getMode() === 'live' && !breakerIsTripped() && Number(g0.curSl) > 0 && Date.now() - (g0.seenAt || Date.now()) < 120000) ? Number(g0.curSl) : 0;
      // v2.9.12: a swing trade's stop may be moved by the swing manager (live) rather than the Profit Guard: report that real stop too, so the bot's own picture follows it and never re-sends a looser one
      const sw0 = swState.get(rkey);
      if (sw0 && sw0.profile === 'swing' && swCfg.mode === 'live' && guardsMaster && getMode() === 'live' && !breakerIsTripped() && Number(sw0.curSl) > 0 && Date.now() - (sw0.seenAt || 0) < 120000) {
        const swS = Number(sw0.curSl);                                     // the tighter of the two reported stops
        if (!(slNow > 0) || (rsd === 'BUY' ? swS > slNow : swS < slNow)) slNow = swS;
      }
      const out = { status: 200, hold };
      if (closed) out.closed = closed;
      if (slNow > 0) out.sl = slNow;
      return out;
    }
    if (ev === 'test') { // the "test alert" button on a bot: proves bot -> relay -> Telegram/email works end to end
      const r = await deliverAlert('✅ Test alert from ' + bot.replace('YM ORACLE ', 'Oracle ') + '. The bot reached Render and Render can reach you. Trade alerts will arrive the same way.', { cat: 'tests' });
      return { status: 200, message: r.muted ? 'delivered (muted by the alert settings: ' + (r.reason || 'see the console') + ')' : r.ok ? 'delivered' : (r.configured === false ? 'alerts are not configured on Render' : 'delivery failed') };
    }
    if (ev === 'msg') { // an alert the bot composed itself (zone found, trade management, daily summary, the full entry/result text): stored first, then delivered with retries
      const k = String(b.k || '');
      if (!KEY_RE.test(k)) return { status: 400, message: 'bad key' };
      const text = String(b.text === undefined || b.text === null ? '' : b.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, 3800);
      if (!text.trim()) return { status: 400, message: 'empty message' };
      const kind = ['entry', 'result', 'daily', 'zone', 'mgmt', 'ops', 'other'].includes(b.kind) ? b.kind : 'other';
      const sym = String(b.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || null;
      await q(`INSERT INTO bot_msgs(k,bot,kind,sym,priv,text) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (k) DO NOTHING`, [k, bot, kind, sym, b.priv === true || b.priv === 1, text]);
      pushBotMsgs().then(() => (kind === 'entry' || kind === 'result') ? pushSignalAlerts() : 0).catch(e => console.error('[multiuser] bot msg:', e.message));
      return { status: 200 };
    }
    if (ev === 'status') {
      await q(`INSERT INTO bot_status(bot,payload,at) VALUES($1,$2,now()) ON CONFLICT (bot) DO UPDATE SET payload=EXCLUDED.payload, at=now()`, [bot, JSON.stringify(b).slice(0, 4000)]);
      return { status: 200 };
    }
    if (!['open', 'relay', 'close'].includes(ev)) return { status: 400, message: 'unknown event' };
    const k = String(b.k || '');
    if (!KEY_RE.test(k)) return { status: 400, message: 'bad key' };
    const sym = String(b.sym || '').toUpperCase();
    if (sym && !SYMBOL_RE.test(sym)) return { status: 400, message: 'bad symbol' };
    const side = sideOf(b.side), eng = ['fast', 'swing'].includes(b.eng) ? b.eng : null;
    const known = await q(`SELECT 1 FROM signals WHERE k=$1`, [k]);
    if (!known.rows[0]) {                                               // a brand-new ledger row: cap how many can appear in a short time
      const nr = await q(`SELECT COUNT(*)::int AS n FROM signals WHERE opened_at > now() - interval '10 minutes'`);
      if (nr.rows[0].n >= 200) return { status: 429, message: 'too many new signals, try again shortly' };
    }
    // make sure the row exists (events can arrive out of order: a close before its open, etc.)
    await q(`INSERT INTO signals(k,bot,symbol,side,eng,bot_t) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (k) DO NOTHING`, [k, bot, sym || null, side, eng, numOr(b.t)]);
    if (ev === 'open') {
      const rid = clip(b.rid, 16);
      await q(`UPDATE signals SET symbol=COALESCE(symbol,$2), side=COALESCE(side,$3), eng=COALESCE(eng,$4), entry=COALESCE(entry,$5), sl=COALESCE(sl,$6), tp=COALESCE(tp,$7),
          lev=COALESCE(lev,$8), margin=COALESCE(margin,$9), relay_flag=COALESCE(relay_flag,$10), rid=COALESCE(NULLIF(rid,''),$11), bot_t=COALESCE(bot_t,$12), updated_at=now() WHERE k=$1`,
        [k, sym || null, side, eng, numOr(b.entry), numOr(b.sl), numOr(b.tp), numOr(b.lev), numOr(b.m), ['SENT', 'NOT_SENT'].includes(b.relay) ? b.relay : null, rid || null, numOr(b.t)]);
      // the order may have reached the relay before this (late) report did: then there is nothing to alarm about
      if (rid) await q(`UPDATE signals SET order_seen_at=now() WHERE k=$1 AND order_seen_at IS NULL AND (
          EXISTS (SELECT 1 FROM master_log WHERE exec_id=$2) OR EXISTS (SELECT 1 FROM order_log WHERE signal_key=$3))`, [k, rid, 'ym-' + rid]);
    } else if (ev === 'relay') {
      const rid = clip(b.rid, 16);
      await q(`UPDATE signals SET relay_ok=COALESCE(relay_ok,$2), relay_code=COALESCE(relay_code,$3), relay_secs=COALESCE(relay_secs,$4), relay_at=COALESCE(relay_at,now()),
          rid=COALESCE(NULLIF(rid,''),$5), updated_at=now() WHERE k=$1`, [k, b.ok === true, clip(b.code, 12) || null, numOr(b.secs), rid || null]);
    } else {
      await q(`UPDATE signals SET closed_at=COALESCE(closed_at,now()), won=COALESCE(won,$2), exit_price=COALESCE(exit_price,$3), pct=COALESCE(pct,$4), relayed=COALESCE(relayed,$5),
          close_why=COALESCE(close_why,$6), updated_at=now() WHERE k=$1`, [k, b.won === true, numOr(b.exit), numOr(b.pct), b.relayed === true, clip(b.why, 64) || null]);
    }
    if (ev === 'open' || ev === 'close') pushSignalAlerts().catch(e => console.error('[multiuser] trade alert:', e.message));
    return { status: 200 };
  }

  // ---------- trade alerts pushed from here (so the bots no longer need their own email/Telegram for trades) ----------
  // One message when a bot opens a trade and one when it closes it, each sent once: the row is claimed first, and given back if every channel
  // failed so the 20-second sweep tries again (up to 8 times). Only recent signals are considered, so a restart never replays old trades.
  const tradeAlertsOn = () => String(process.env.TRADE_ALERTS || '').toLowerCase() !== 'off';
  const coinOf = x => String(x.symbol || '').replace('USDT', '');
  const whoOf = x => String(x.bot || '').replace('YM ORACLE ', 'Oracle ');
  const fnum = v => (v === null || v === undefined ? '?' : String(Number(Number(v).toPrecision(6))));
  function openAlertText(x) {
    const dir = x.side === 'BUY' ? 'LONG' : 'SHORT', head = whoOf(x) + ' ' + coinOf(x) + ' ' + dir + (x.eng ? ' (' + x.eng + ')' : '');
    const lines = [(x.relay_flag === 'NOT_SENT' ? '⚠️ ' : '🟢 ') + head + ' opened', 'Entry ' + fnum(x.entry) + ' · SL ' + fnum(x.sl) + ' · TP ' + fnum(x.tp) + (x.lev ? ' · ' + fnum(x.lev) + 'x' : '') + (x.margin ? ' · $' + fnum(x.margin) + ' margin' : '')];
    lines.push(x.relay_flag === 'NOT_SENT' ? 'The bot did NOT send this one to Bybit (relay switch off or not sent). No copy trades.' : 'Sent to the relay for Bybit and your users.');
    return lines.join('\n');
  }
  function closeAlertText(x) {
    const dir = x.side === 'BUY' ? 'long' : 'short', pct = x.pct === null || x.pct === undefined ? '' : ' ' + (Number(x.pct) >= 0 ? '+' : '') + Number(x.pct).toFixed(2) + '%';
    return (x.won ? '✅ ' : '🔴 ') + whoOf(x) + ' ' + coinOf(x) + ' ' + dir + ' closed: ' + (x.won ? 'WIN' : 'LOSS') + pct + (x.close_why ? ' (' + x.close_why + ')' : '') + (x.relayed === false ? '\nThis trade was not relayed, so nothing was closed on Bybit.' : '');
  }
  const stripTags = t => String(t).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const symKey = v => String(v || '').toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
  const HOLD_S = () => (process.env.TRADE_ALERT_HOLD_S !== undefined && Number.isFinite(Number(process.env.TRADE_ALERT_HOLD_S)) ? Number(process.env.TRADE_ALERT_HOLD_S) : 45);
  // Alerts the bot composed itself. Stored on arrival (the bot gets its 200 at once and drops its copy), then delivered here, retried up to 8 times.
  // Which alert category a bot message belongs to (the firmware tags entry/result/zone/mgmt/daily/ops; an untagged one from older firmware is guessed from where it was addressed).
  const catOfMsg = m => (m.kind === 'entry' || m.kind === 'result') ? 'signals' : m.kind === 'zone' ? 'zones' : m.kind === 'daily' ? 'daily' : m.kind === 'mgmt' ? 'updates' : m.kind === 'ops' ? 'ops'
    : m.priv ? (/zone/i.test(stripTags(m.text)) ? 'zones' : 'ops') : 'updates';
  async function pushBotMsgs() {
    if (!tradeAlertsOn()) return 0;
    await ready;
    let sent = 0;
    const r = await q(`SELECT k FROM bot_msgs WHERE sent_at IS NULL AND tries < 8 AND created_at > now() - interval '2 hours' ORDER BY created_at LIMIT 10`);
    for (const row of r.rows) {
      const c = await q(`UPDATE bot_msgs SET claimed_at=now() WHERE k=$1 AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < now() - interval '40 seconds') RETURNING *`, [row.k]);
      const m = c.rows[0]; if (!m) continue;
      let res; try { res = await deliverAlert(await pcAlertText(m), { html: true, priv: m.priv, email: m.kind === 'daily', cat: catOfMsg(m) }); } catch (e) { res = { ok: false, configured: true }; }
      if (res && res.ok) { sent++; await q(`UPDATE bot_msgs SET sent_at=now(), last_result=$2 WHERE k=$1`, [m.k, [res.telegram && 'telegram ' + res.telegram, res.email && res.email !== 'off' && 'email ' + res.email].filter(Boolean).join(', ')]); continue; }
      const cfgd = !(res && res.configured === false);
      await q(`UPDATE bot_msgs SET claimed_at=NULL, tries=tries+$2, last_result=$3 WHERE k=$1`, [m.k, cfgd ? 1 : 0, res ? [res.telegram, res.email].filter(x => x && x !== 'off').join(', ') || 'not configured' : 'failed']);
      if (!cfgd) return sent;
    }
    return sent;
  }
  const alertSweep = () => pushBotMsgs().then(() => pushSignalAlerts());   // run every 20 s: retries failed deliveries, sends the short safety-net alerts
  async function pushSignalAlerts() {
    if (!tradeAlertsOn()) return 0;
    await ready;
    let sent = 0;
    for (const [col, kind] of [['alert_open_at', 'open'], ['alert_close_at', 'close']]) {
      const cond = kind === 'open' ? 'relay_flag IS NOT NULL' : 'closed_at IS NOT NULL';
      const r = await q(`SELECT k, bot, symbol, opened_at, closed_at FROM signals WHERE ${cond} AND ${col} IS NULL AND alert_tries < 8 AND opened_at > now() - interval '2 hours' ORDER BY opened_at LIMIT 10`);
      for (const row of r.rows) {
        // A bot running the new firmware also sends its own detailed text for the same trade. When that arrives, the short ledger alert is not sent as well.
        // If the bot is new-firmware but its detailed text has not arrived yet, the ledger alert waits TRADE_ALERT_HOLD_S seconds, then goes out as the safety net.
        const msgKind = kind === 'open' ? 'entry' : 'result';
        const since = kind === 'open' ? row.opened_at : row.closed_at;
        const m = await q(`SELECT sym, created_at >= $3::timestamptz - interval '3 minutes' AS fresh FROM bot_msgs WHERE bot=$1 AND kind=$2 AND created_at > now() - interval '2 hours'`, [row.bot, msgKind, since]);
        if (m.rows.some(x => x.fresh && symKey(x.sym) === symKey(row.symbol))) { await q(`UPDATE signals SET ${col}=now() WHERE k=$1 AND ${col} IS NULL`, [row.k]); continue; }
        const cap = await q(`SELECT 1 FROM bot_msgs WHERE bot=$1 AND created_at > now() - interval '24 hours' LIMIT 1`, [row.bot]);
        if (cap.rows[0] && (Date.now() - new Date(since).getTime()) / 1000 < HOLD_S()) continue;
        const c = await q(`UPDATE signals SET ${col}=now() WHERE k=$1 AND ${col} IS NULL RETURNING *`, [row.k]);
        const x = c.rows[0];
        if (!x) continue;                                    // another call took it
        let res;
        try { res = await deliverAlert(kind === 'open' ? openAlertText(x) : closeAlertText(x), { cat: 'signals' }); } catch (e) { res = { ok: false, configured: true }; }
        if (res && res.ok) { sent++; continue; }
        await q(`UPDATE signals SET ${col}=NULL, alert_tries=alert_tries+(CASE WHEN $2 THEN 1 ELSE 0 END) WHERE k=$1`, [x.k, !(res && res.configured === false)]);
        if (res && res.configured === false) return sent;    // nothing is set up: don't spin
      }
    }
    return sent;
  }

  // Alarm: a bot said it SENT a trade, over a minute passed, and no order for it ever reached the relay. This is the failure that
  // used to be invisible (the bot's own screen says "relayed", Bybit shows nothing). One alert per signal.
  const ALARM_AFTER_S = Number(process.env.SIGNAL_ALARM_SECONDS) || 60;
  async function checkSignalAlarms() {
    await ready;
    const r = await q(`SELECT k, bot, symbol, side, opened_at FROM signals WHERE relay_flag='SENT' AND order_seen_at IS NULL AND alarm_at IS NULL
        AND opened_at < now() - ($1 || ' seconds')::interval AND opened_at > now() - interval '3 hours' AND closed_at IS NULL ORDER BY opened_at LIMIT 20`, [String(ALARM_AFTER_S)]);
    for (const x of r.rows) {
      const c = await q(`UPDATE signals SET alarm_at=now() WHERE k=$1 AND alarm_at IS NULL RETURNING k`, [x.k]);
      if (!c.rows[0]) continue;
      const who = String(x.bot || '').replace('YM ORACLE ', 'Oracle ');
      if (sendAlert) sendAlert('🚨 ' + who + ' ' + String(x.symbol || '').replace('USDT', '') + ' ' + (x.side === 'BUY' ? 'long' : 'short') + ': the bot says it sent this trade over ' + ALARM_AFTER_S + ' seconds ago, but no order has reached the relay. Nothing was placed on Bybit or copied to users. Check the manager ESP32 (power, Wi-Fi, serial log).');
    }
    return r.rows.length;
  }

  // A copy that was claimed (PENDING) but never finished means the relay restarted or lost its connection mid-order. Ask Bybit
  // by orderLinkId what really happened and make the log tell the truth. An order that never reached Bybit is NOT re-sent:
  // by now the price has moved, and opening late is a different trade than the one the bot signalled.
  let settling = false;
  async function settlePending() {
    if (settling) return { settled: 0 };
    settling = true;
    let settled = 0;
    try {
      await ready;
      const r = await q(`SELECT id, user_id, order_link_id, symbol, side FROM order_log
        WHERE code='PENDING' AND created_at < now() - interval '60 seconds' AND created_at > now() - interval '2 days' ORDER BY id LIMIT 50`);
      for (const row of r.rows) {
        const ur = await q('SELECT * FROM users WHERE id=$1', [row.user_id]);
        const u = ur.rows[0];
        const sym = String(row.symbol || '').replace('USDT', '');
        const done = async (code, ok, detail, orderId) => {
          await q(`UPDATE order_log SET code=$2, ok=$3, detail=$4, bybit_order_id=COALESCE($5, bybit_order_id) WHERE id=$1 AND code='PENDING'`, [row.id, code, ok, detail, orderId || null]);
          settled++;
        };
        if (!u || !u.key_enc || !row.order_link_id) { await done('NET', false, 'Interrupted before it finished'); continue; }
        try {
          const client = userClient(u);
          let o = null;
          for (const fn of ['getActiveOrders', 'getHistoricOrders']) {
            const res = await client[fn]({ category: 'linear', symbol: row.symbol, orderLinkId: row.order_link_id, limit: 1 });
            if (res.retCode !== 0) throw bybitErr(res);
            o = ((res.result && res.result.list) || [])[0];
            if (o) break;
          }
          if (o && /^(Filled|PartiallyFilled|New|Untriggered|Triggered)$/.test(o.orderStatus)) await done('OK', true, 'Placed (confirmed after an interruption)', o.orderId);
          else if (o) await done('BYBIT', false, 'Bybit did not accept it (' + o.orderStatus + ')', o.orderId);
          else {
            await done('NET', false, 'Interrupted before it reached Bybit. It was not retried because the price has moved on');
            if (!QUIET_CODES.has('NET')) notify(u, '⚠️ ' + sym + ': the copy of this trade was interrupted and was not placed.');
          }
        } catch (e) {
          if (e && e.retCode !== undefined && AUTH_RET_CODES.has(e.retCode)) await markKeyError(u, e.message);
          // anything else (Bybit unreachable): leave it PENDING and look again next round
        }
      }
    } catch (e) { console.error('[multiuser] settlePending:', e.message); }
    finally { settling = false; }
    return { settled };
  }

  // ---------- PnL ledger sync (pulled from Bybit into OUR database, so history survives withdrawals / key removal) ----------
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  async function insertLedger(u, c) {
    const r = await q(
      `INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,entry_price,exit_price,closed_pnl,open_fee,close_fee,leverage,closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0)) ON CONFLICT (user_id, order_id) DO NOTHING`,
      [u.id, c.orderId, c.symbol, c.side, num(c.qty), num(c.avgEntryPrice), num(c.avgExitPrice), num(c.closedPnl) || 0, num(c.openFee), num(c.closeFee), num(c.leverage), parseInt(c.updatedTime, 10)]);
    if (r.rowCount && Date.now() - parseInt(c.updatedTime, 10) < 2 * 3600 * 1000) {
      const p = num(c.closedPnl) || 0; // only fresh closes ping the user, never a first-time history backfill
      notify(u, (p >= 0 ? '🟢 ' : '🔴 ') + 'Closed ' + String(c.symbol || '').replace('USDT', '') + ': ' + (p >= 0 ? '+$' : '-$') + Math.abs(p).toFixed(2));
    }
    return r.rowCount;
  }
  async function syncFunding(u, client, now) {
    try {
      const WEEK = 7 * 24 * 3600 * 1000 - 1000;
      const prev = u.last_funding_sync_ms ? Number(u.last_funding_sync_ms) : new Date(u.created_at).getTime();
      let start = prev;
      while (start < now) {
        const end = Math.min(start + WEEK, now);
        let cursor;
        do {
          const r = await client.getTransactionLog({ accountType: 'UNIFIED', category: 'linear', type: 'SETTLEMENT', startTime: start, endTime: end, limit: 50, cursor });
          if (r.retCode !== 0) throw bybitErr(r);
          for (const t of (r.result.list || [])) {
            const amount = parseFloat(t.change);
            if (!Number.isFinite(amount) || amount === 0) continue;
            await q(`INSERT INTO funding_ledger(user_id,tx_key,symbol,amount,at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0)) ON CONFLICT (user_id, tx_key) DO NOTHING`,
              [u.id, sha1([t.symbol, t.transactionTime, t.change, t.type].join('|')), t.symbol, amount, parseInt(t.transactionTime, 10)]);
          }
          cursor = r.result.nextPageCursor || undefined;
        } while (cursor);
        start = end;
      }
      await q('UPDATE users SET last_funding_sync_ms=$2 WHERE id=$1', [u.id, Math.max(prev, now - 600000)]);
    } catch (e) { console.error('[multiuser] funding sync skipped for', u.username + ':', e.message); }
  }
  async function syncUser(u) {
    const client = userClient(u);
    const WEEK = 7 * 24 * 3600 * 1000 - 1000; // Bybit's max query window
    const now = Date.now();
    const prev = u.last_pnl_sync_ms ? Number(u.last_pnl_sync_ms) : new Date(u.created_at).getTime();
    let start = prev;
    let added = 0;
    while (start < now) {
      const end = Math.min(start + WEEK, now);
      let cursor;
      do {
        const r = await client.getClosedPnL({ category: 'linear', startTime: start, endTime: end, limit: 100, cursor });
        if (r.retCode !== 0) throw bybitErr(r);
        for (const c of (r.result.list || [])) added += await insertLedger(u, c);
        cursor = r.result.nextPageCursor || undefined;
      } while (cursor);
      start = end;
    }
    await syncFunding(u, client, now);
    const eq = await getEquity(client);
    await q(`INSERT INTO equity_snap(user_id,day,equity) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING`, [u.id, eq.equity]);
    // keep a 10-minute overlap so trades that were still settling get picked up next time (duplicates are ignored)
    await q(`UPDATE users SET last_pnl_sync_ms=$2, last_synced_at=now(), last_equity=$3, key_status='ok', key_error=NULL WHERE id=$1`, [u.id, Math.max(prev, now - 600000), eq.equity]);
    return added;
  }
  let syncing = false;
  async function syncAll() {
    if (syncing) return { skipped: true };
    syncing = true;
    let users = 0, added = 0, failed = 0;
    try {
      await ready;
      await q('DELETE FROM sessions WHERE expires_at < now()');
      await q('DELETE FROM admin_sessions WHERE expires_at < now()');
      const r = await q(`SELECT * FROM users WHERE key_enc IS NOT NULL ORDER BY id`);
      for (const u of r.rows) {
        try { added += await syncUser(u); users++; }
        catch (e) {
          failed++;
          console.error('[multiuser] sync failed for', u.username + ':', e.message);
          if (e.retCode !== undefined && AUTH_RET_CODES.has(e.retCode)) await markKeyError(u, e.message);
        }
      }
    } finally { syncing = false; }
    return { users, added, failed };
  }

  // ---------- Profit Guard ----------
  // Watches the MASTER account's open trades every few seconds (see profitguard.js). Three jobs, each switchable per profile (fast / swing):
  //   1. lock profit: only ever RAISES a stop toward the profit side (never loosens it) and keeps the stop on Bybit
  //   2. scale-out (optional): closes a small slice at set R levels and leaves a runner
  //   3. re-entry RECORDER: after a winner closes, notes when a "pulled back, then resumed" entry would have appeared and how it would have ended. It never trades.
  // shadow = records what it would do and touches nothing. live = does it for real (master and copies).
  const pgRun = { at: 0, ok: null, note: '', err: null, positions: 0, busy: false, raises: 0, scales: 0 };
  let pgSavedAt = 0, pgForce = false;
  const pgClosing = [];           // trades that just closed, waiting for Bybit's closed-PnL record (in memory only)
  const pgEm = st => PG.effMode(pgCfg, st.profile);
  async function pgLog(row) {
    try {
      await q(`INSERT INTO profit_guard_log(symbol,side,mode,profile,event,entry,mark,old_sl,new_sl,peak_r,lock_pct,detail,result_r,score,feat) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [row.symbol, row.side || null, row.mode || pgCfg.mode, row.profile || null, row.event, row.entry ?? null, row.mark ?? null, row.oldSl ?? null, row.newSl ?? null, row.peakR ?? null, row.lockPct ?? null, String(row.detail || '').slice(0, 300), row.resultR ?? null, Number.isFinite(row.score) ? row.score : null, row.feat ? JSON.stringify(row.feat).slice(0, 600) : null]);
    } catch (e) { console.error('[multiuser] profit guard log:', e.message); }
  }
  // v2.9.7: the Halt switch and the paper/live mode are mirrored here, so a redeploy or restart on a host with no persistent disk cannot silently undo them.
  async function loadControl() {
    await q(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    const r = await q(`SELECT k, v FROM meta WHERE k IN ('ctl_halt','ctl_mode')`);
    const out = {};
    for (const row of r.rows) { try { out[row.k === 'ctl_halt' ? 'halt' : 'mode'] = JSON.parse(row.v); } catch { /* unreadable: ignore */ } }
    return out;
  }
  async function saveControl(which, obj) {
    const k = which === 'halt' ? 'ctl_halt' : 'ctl_mode';
    for (let i = 0; i < 3; i++) {
      try { await q(`INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, JSON.stringify(obj)]); return true; }
      catch (e) { if (i === 2) { console.error('[control] could not save ' + which + ' to the database:', e.message); return false; } await new Promise(r => setTimeout(r, 300 * (i + 1))); }
    }
    return false;
  }

  async function pgSaveState(force) {
    if (!force && Date.now() - pgSavedAt < 15000) return;
    pgSavedAt = Date.now();
    try {
      await q(`INSERT INTO meta(k,v) VALUES('profit_guard_state',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(Object.fromEntries(pgState))]);
      await q(`INSERT INTO meta(k,v) VALUES('profit_guard_watch',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(Object.fromEntries(pgWatch))]);
    } catch (e) { console.error('[multiuser] profit guard state:', e.message); }
  }
  // Which profile a trade follows, and the stop the bot originally planned for it (from what the bot reported when it opened the trade).
  // v2.9.14: the Profit Guard, the Sentinel and the Swing Manager each read the positions at the start of their own pass and may write a stop a second or two later. Without a check the last one to write wins,
  // even when it is LOOSER than a stop another one has just set. This reads the real stop on Bybit right before writing and refuses anything that is not tighter (and reads the real size before a close).
  async function freshPos(symbol, side, positionIdx) {
    try {
      const r = await restClient.getPositionInfo({ category: 'linear', symbol });
      if (r.retCode !== 0) return null;
      const list = (r.result && r.result.list || []).filter(x => parseFloat(x.size) > 0 && x.side === side);
      const hit = list.find(x => (Number(x.positionIdx) || 0) === (Number(positionIdx) || 0)) || list[0];
      return hit ? { size: parseFloat(hit.size), stopLoss: parseFloat(hit.stopLoss) || 0 } : { size: 0, stopLoss: 0 };
    } catch { return null; }
  }
  async function stopWrite(side, body) {   // -> { res } when written, { skipped: true, cur } when the real stop is already as tight or tighter
    const fp = await freshPos(body.symbol, side, body.positionIdx), nw = Number(body.stopLoss);
    if (fp && fp.size > 0 && fp.stopLoss > 0 && nw > 0 && (side === 'Buy' ? nw <= fp.stopLoss : nw >= fp.stopLoss)) return { skipped: true, cur: fp.stopLoss };
    return { res: await restClient.setTradingStop(body) };
  }
  async function pgLookup(symbol, side, peek) {   // peek = true: read the plan without using it up (only the Profit Guard uses a re-entry plan up; the Sentinel, Swing Manager and Pace tracker just look)
    const pl = pgPlanned.get(symbol + '|' + side);
    if (pl && Date.now() - pl.at < 600000) { if (!peek) pgPlanned.delete(symbol + '|' + side); return { bot: pl.bot, sl: pl.sl, eng: pl.eng, reentry: true, score: pl.score, src: pl.src }; }
    try {
      const r = await q(`SELECT bot, sl, eng FROM signals WHERE symbol=$1 AND side=$2 AND opened_at > now() - interval '30 days' ORDER BY opened_at DESC LIMIT 1`, [symbol, side === 'Buy' ? 'BUY' : 'SELL']);
      const x = r.rows[0]; if (!x) return { bot: '', sl: 0, eng: null };
      return { bot: x.bot || '', sl: Number(x.sl) || 0, eng: x.eng || null };
    } catch { return { bot: '', sl: 0, eng: null }; }
  }
  // Scale-out for the copies: each user closes the same SHARE of their OWN position (not the master's quantity).
  async function fanOutPartialClose(symbol, posSide, frac, inst) {
    if (getMode() !== 'live' || breakerIsTripped() || !inst) return { users: 0, closed: 0 };
    const opp = posSide === 'Buy' ? 'Sell' : 'Buy';
    const users = await tradableUsers({ forOpen: false });
    let closed = 0;
    await runLimited(users, 5, u => enqueue(u.id, async () => {
      if (isDry(u)) return;
      const base = { userId: u.id, kind: 'CLOSE', symbol, side: opp };
      try {
        const client = userClient(u);
        const pos = await getOpenPosition(client, symbol);
        if (!pos || pos.side !== posSide) return;
        const qty = PG.sliceQty(pos.size, frac, inst.qtyStep, inst.minQty);
        if (!qty) return logOrder({ ...base, code: 'MINQ', ok: true, detail: 'Scale-out skipped: the position is too small to split' });
        const res = await client.submitOrder({ category: 'linear', symbol, side: opp, orderType: 'Market', qty: String(qty), reduceOnly: true, positionIdx: Number(pos.positionIdx) || 0 });
        if (res.retCode === 0) { closed++; await logOrder({ ...base, qty, code: 'OK', ok: true, detail: 'Scale-out: took ' + Math.round(frac * 100) + '% profit, the rest keeps running' }); }
        else { const f = failFrom({ retCode: res.retCode, message: res.retMsg }); await logOrder({ ...base, qty, code: f.code, ok: false, detail: 'Scale-out failed: ' + res.retMsg }); if (f.auth) await markKeyError(u, res.retMsg); }
      } catch (e) { const f = failFrom(e); await logOrder({ ...base, code: f.code, ok: false, detail: 'Scale-out failed: ' + f.detail }); if (f.auth) await markKeyError(u, f.detail); }
    }));
    return { users: users.length, closed };
  }
  // A trade has closed: find Bybit's own exit, store the scorecard row, and (for a winner) start a re-entry watch.
  async function pgRecordClose(it) {
    const st = it.st, [symbol, side] = it.key.split('|'), long = side === 'Buy';
    let exit = 0, pnl = null;
    try {
      const r = await restClient.getClosedPnL({ category: 'linear', symbol, limit: 10 });
      const rows = ((r.result && r.result.list) || []).filter(x => x.symbol === symbol && Number(x.updatedTime || x.createdTime || 0) >= st.since - 60000);
      // v2.9.11: the newest closing row of THIS trade. It used to also require the row to be within 3 minutes before we noticed the close, so a relay that woke from a sleep
      // or restart (it noticed hours later) found no exit price at all: 5 of 19 trades on 21-22 Oct. Rows are already limited to those after the trade began; the upper bound keeps a LATER trade out.
      const last = rows.filter(x => Number(x.updatedTime || x.createdTime || 0) <= it.at + 120000).sort((a, b) => Number(b.updatedTime || b.createdTime || 0) - Number(a.updatedTime || a.createdTime || 0))[0];
      if (last && parseFloat(last.avgExitPrice) > 0) { exit = parseFloat(last.avgExitPrice); pnl = rows.reduce((t, x) => t + (Number(x.closedPnl) || 0), 0); }
    } catch { /* retried below */ }
    if (!(exit > 0) && it.tries < 6) { it.tries++; return false; }
    const entry = st.entry, risk = st.initialSl > 0 ? Math.abs(entry - st.initialSl) : 0;
    const peakDist = long ? st.peak - entry : entry - st.peak, exitDist = exit > 0 ? (long ? exit - entry : entry - exit) : null;
    const peakPct = peakDist / entry * 100, exitPct = exitDist === null ? null : exitDist / entry * 100;
    const peakR = risk > 0 ? peakDist / risk : null, exitR = risk > 0 && exitDist !== null ? exitDist / risk : null;
    const gb = exitPct === null ? null : peakPct - exitPct;
    try {
      const closedBy = exit > 0 ? PL.attributeExit({ side, entry, initialSl: st.initialSl, exit, guardFloor: st.floor, sentinelFloor: st.snFloor, botStop: st.botSl }) : 'UNKNOWN';
      st.closedBy = closedBy;
      await q(`INSERT INTO pg_trades(symbol,side,profile,mode,entry,initial_sl,peak_price,exit_price,peak_pct,exit_pct,giveback_pct,peak_r,exit_r,guard_floor,scaled,pnl,closed_by,reentry,reentry_score,reentry_src)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::boolean,$19::numeric,$20::text
               WHERE NOT EXISTS (SELECT 1 FROM pg_trades WHERE symbol=$1 AND side=$2 AND entry=$5 AND exit_price IS NOT DISTINCT FROM $8::numeric)`,
        [symbol, side, st.profile, it.em, entry, st.initialSl || null, st.peak, exit || null, peakPct, exitPct, gb, peakR, exitR, st.floor || st.shadowSl || null, (st.scaled || []).length, pnl, closedBy, st.reentry === true, Number.isFinite(st.reentryScore) ? st.reentryScore : null, st.reentrySrc || null]);
    } catch (e) { console.error('[multiuser] profit guard scorecard:', e.message); }
    await pgLog({ symbol, side, profile: st.profile, mode: it.em, event: 'closed', entry, mark: exit || null, newSl: st.floor || st.shadowSl || null, peakR, detail: 'trade closed' + (st.closedBy && st.closedBy !== 'UNKNOWN' ? ' [exit at: ' + st.closedBy + ']' : '') + (exitPct !== null ? ': best +' + peakPct.toFixed(2) + '%, exit ' + (exitPct >= 0 ? '+' : '') + exitPct.toFixed(2) + '%, gave back ' + gb.toFixed(2) + '%' : ' (exit price not found)') + (st.shadowSl > 0 && !st.shadowHit ? ' (price never touched the guard\'s shadow stop)' : '') });
    if (exit > 0) {
      masterClosed.set(it.key, { since: st.since || 0, entry, exit, exitR: exitR === null ? null : exitR, at: Date.now() });
      if (masterClosed.size > 100) for (const [kk, vv] of masterClosed) if (Date.now() - vv.at > 48 * 3600000) masterClosed.delete(kk);
    }
    const rc = pgCfg.reentry, pf = pgCfg[st.profile];
    // v2.9.9 SHAKE-OUT: a protective stop closed the trade near breakeven (the original stop was never touched) although it had shown some profit: the thesis may be intact. Watched like a winner, tagged 'shake'.
    const isShake = !!(rc.shake && ['GUARD_STOP', 'SENTINEL_STOP', 'BOT_STOP', 'OTHER'].includes(st.closedBy) && peakR !== null && peakR >= 0.2 && peakR < pf.beR && exitR !== null && exitR > -0.35 && exitR < 0.75);
    if (st.reentry) {   // v2.9.8: a re-entry never starts another watch (no chains), and its result may pause live re-entry
      await pgLog({ symbol, side, profile: st.profile, mode: 'live', event: 'reentry_closed', entry, mark: exit || null, peakR, resultR: exitR, detail: 'the re-entry trade closed' + (exitR !== null ? ' at ' + (exitR >= 0 ? '+' : '') + exitR.toFixed(2) + 'R of its own stop' : '') + (st.closedBy && st.closedBy !== 'UNKNOWN' ? ' [exit at: ' + st.closedBy + ']' : '') });
      await reentryCheckPause().catch(e => console.error('[multiuser] re-entry pause check:', e.message));
    } else if (rc.on && it.em !== 'off' && risk > 0 && (peakR >= pf.beR || isShake)) {
      pgWatch.set(it.key, { symbol, side, profile: st.profile, src: peakR >= pf.beR ? 'winner' : 'shake', bot: st.bot || '', lev: st.lev || 0, margin: st.margin || 0, entry, exit: exit || it.mark, peak: st.peak, risk, extreme: exit || it.mark, cand: null, expiresAt: Date.now() + (st.profile === 'swing' ? rc.hoursSwing : rc.hoursFast) * 3600000 });
      for (const k of [...pgWatch.keys()].slice(0, Math.max(0, pgWatch.size - 20))) pgWatch.delete(k);
    }
    return true;
  }
  // ---- LIVE RE-ENTRY (v2.9.8) -----------------------------------------------------------------------------------------------------------------------------
  // The recorder spots "pulled back, then resumed". When live re-entry is ON (off by default, needs the LIVE confirm), that spot may become ONE real order on the MASTER account
  // only (never copied to users), sized at sizeMult x the original trade's margin, stop = the pullback low, target = +targetR. PG.reentryGate decides; every refusal is logged
  // with its reason. A re-entry is managed like any trade (guard, sentinel, Bybit stop/target), never starts another watch, and three bad results in a row pause it.
  const tickCache = new Map();
  async function tickOf(symbol) {
    if (tickCache.has(symbol)) return tickCache.get(symbol);
    const r = await restClient.getInstrumentsInfo({ category: 'linear', symbol });
    const t = r && r.result && r.result.list && r.result.list[0] && r.result.list[0].priceFilter && r.result.list[0].priceFilter.tickSize;
    if (!(Number(t) > 0)) throw new Error('no tick size for ' + symbol);
    tickCache.set(symbol, t); return t;
  }
  // ---- the brain's data (v2.9.9): candles of the pair (15m, 1h), BTC (1h), the 24h turnover, and the pair's earlier re-entry results ----
  const klCache = new Map();
  async function klines(symbol, interval, limit, ttlMs) {
    const k = symbol + '|' + interval, hit = klCache.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return hit.bars;
    const r = await restClient.getKline({ category: 'linear', symbol, interval, limit });
    if (!r || r.retCode !== 0) throw new Error('kline ' + ((r && (r.retMsg || r.retCode)) || 'no reply'));
    const bars = snBarsFrom(r.result && r.result.list).sort((a, b) => a.t - b.t);
    klCache.set(k, { at: Date.now(), bars });
    return bars;
  }
  async function turnoverOf(symbol) {
    const r = await restClient.getTickers({ category: 'linear', symbol });
    const t = r && r.result && r.result.list && r.result.list[0] ? parseFloat(r.result.list[0].turnover24h) : NaN;
    return Number.isFinite(t) ? t : null;
  }
  async function pairRecord(symbol) {
    try {
      const r = (await q(`SELECT COUNT(*)::int AS n, AVG(x) AS avg FROM (SELECT result_r AS x FROM profit_guard_log WHERE event='reentry_result' AND symbol=$1 AND at > now() - interval '60 days' AND result_r IS NOT NULL
        UNION ALL SELECT exit_r FROM pg_trades WHERE reentry AND symbol=$1 AND at > now() - interval '60 days' AND exit_r IS NOT NULL) t`, [symbol])).rows[0];
      return Number(r.n) > 0 ? { n: Number(r.n), avgR: Number(r.avg) } : null;
    } catch { return null; }
  }
  // Scores one chance. Never throws: when the data cannot be read the answer is { ok:false, reason } and a live order is refused.
  async function reentryBrain(w, c, mk) {
    try {
      const [c15, c60, btc, turn, pair] = await Promise.all([klines(w.symbol, '15', 60, 60000), klines(w.symbol, '60', 60, 300000), klines('BTCUSDT', '60', 30, 120000).catch(() => null), turnoverOf(w.symbol).catch(() => null), pairRecord(w.symbol)]);
      return RB.score({ side: w.side, price: mk, stop: c.stop, peak: w.peak, entry: w.entry, src: w.src || 'winner', c15, c60, btc, turnover: turn, pair });
    } catch (e) { return { ok: false, reason: 'market data: ' + String(e && e.message || e).slice(0, 100) }; }
  }
  async function reentryTry(w, e, mk, positions, brain) {
    if (w.placed) return;
    w.placed = true;                       // one attempt per candidate, whatever happens (kept with the watch)
    const rc = pgCfg.reentry, c = w.cand || { price: e.price, stop: e.stop, pullR: e.pullR };
    c.pullR = e.pullR;
    const base = { symbol: w.symbol, side: w.side, profile: w.profile, mode: 'live', entry: w.entry };
    const skip = async (code, detail) => { await pgLog({ ...base, event: 'reentry_skipped', mark: mk, newSl: c.stop, peakR: c.pullR, detail: code + ': ' + detail }); return false; };
    const liveOk = !!(guardsMaster && PG.effMode(pgCfg, w.profile) === 'live' && getMode() === 'live' && !breakerIsTripped() && typeof execTrade === 'function');
    const today = Number((await q(`SELECT COUNT(*)::int AS n FROM profit_guard_log WHERE event='reentry_placed' AND at > now() - interval '24 hours'`)).rows[0].n) || 0;
    const openN = [...pgState.values()].filter(x => x.reentry).length + [...pgClosing].filter(x => x.st && x.st.reentry).length + [...pgPlanned.values()].filter(x => Date.now() - x.at < 600000).length;
    const lossRow = (await q(`SELECT EXTRACT(EPOCH FROM (now() - at)) / 3600 AS h FROM pg_trades WHERE reentry AND symbol=$1 AND exit_r < 0 ORDER BY at DESC LIMIT 1`, [w.symbol])).rows[0];
    const ctx = { score: brain && brain.ok ? brain.score : undefined, scoreWhy: brain && !brain.ok ? brain.reason : '', turnover: brain && brain.ok && brain.feat.turn !== undefined ? brain.feat.turn : null, mark: mk, todayCount: today, openCount: openN, symbolHeld: (positions || []).some(p => p.symbol === w.symbol && parseFloat(p.size) > 0), lastLossAgoH: lossRow ? Number(lossRow.h) : null, liveOk };
    const g = PG.reentryGate(w, c, ctx, rc);
    if (!g.ok) { if (g.code === 'SHAKEOFF') return false; return skip(g.code, g.detail); }
    let tick; try { tick = await tickOf(w.symbol); } catch (err) { return skip('NOTICK', err.message); }
    const plan = PG.reentryPlan(w, c, rc, tick, mk, brain && brain.ok ? brain.score : undefined);
    const long = w.side === 'Buy';
    if (!(plan.sl > 0) || !(plan.tp > 0) || (long ? !(plan.tp > mk && plan.sl < mk) : !(plan.tp < mk && plan.sl > mk))) return skip('BADPLAN', 'stop ' + plan.sl + ' / target ' + plan.tp + ' do not fit around ' + mk);
    const id = 'RE' + require('crypto').createHash('sha1').update([w.symbol, w.side, c.at || 0, w.entry].join('|')).digest('hex').slice(0, 12);
    const key = w.symbol + '|' + w.side;
    pgPlanned.set(key, { sl: plan.sl, eng: w.profile, bot: w.bot || '', at: Date.now(), score: brain && brain.ok ? brain.score : null, src: w.src || 'winner' });
    let res;
    try { res = await execTrade({ kind: 'open', id, bot: ('RE ' + (w.bot || '')).trim(), side: plan.side, symbol: w.symbol, usdMargin: plan.usdMargin, leverage: plan.leverage, sl: String(plan.sl), tp: String(plan.tp), trailPct: 0 }); }
    catch (err) { res = { body: { ok: false, code: 'NET', detail: String(err && err.message || err).slice(0, 120) } }; }
    const b = (res && res.body) || {};
    if (b.ok) {
      await pgLog({ ...base, event: 'reentry_placed', mark: mk, newSl: plan.sl, peakR: c.pullR, score: brain && brain.ok ? brain.score : undefined, feat: brain && brain.ok ? { ...brain.feat, src: w.src || 'winner' } : undefined, detail: (w.src === 'shake' ? 'SHAKE-OUT ' : '') + 'RE-ENTRY PLACED on the master account: ' + plan.side + ' $' + plan.usdMargin + ' margin at ' + plan.leverage + 'x, stop ' + plan.sl + ' (' + plan.stopPct.toFixed(2) + '% away), target ' + plan.tp + ' (+' + plan.rr + 'R)' + (brain && brain.ok ? ', score ' + brain.score + ' ' + brain.verdict : '') + ' [' + b.code + ']' });
      if (sendAlert) Promise.resolve(sendAlert('🔁 Re-entry placed (master only): ' + w.symbol.replace('USDT', '') + ' ' + (long ? 'long' : 'short') + ' after a ' + c.pullR.toFixed(1) + 'R pullback' + (w.src === 'shake' ? ' (a shake-out)' : '') + (brain && brain.ok ? ', score ' + brain.score + '/100 ' + brain.verdict : '') + '. Stop ' + plan.sl + ', target ' + plan.tp + ', $' + plan.usdMargin + ' margin at ' + plan.leverage + 'x.')).catch(() => {});
      return true;
    }
    pgPlanned.delete(key);
    await pgLog({ ...base, event: 'reentry_failed', mark: mk, newSl: plan.sl, peakR: c.pullR, detail: (b.code || 'ERR') + ': ' + (b.detail || b.message || 'the order was not placed') });
    return false;
  }
  async function reentryCheckPause() {
    const rc = pgCfg.reentry; if (!rc.live) return false;
    const r = await q(`SELECT exit_r FROM pg_trades WHERE reentry ORDER BY id DESC LIMIT 3`);
    const rs = r.rows.map(x => Number(x.exit_r) || 0);
    if (!PG.reentryShouldPause(rs, rc)) return false;
    const next = PG.normalize({ ...pgCfg, reentry: { ...rc, live: false } });
    await q(`INSERT INTO meta(k,v) VALUES('profit_guard',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    pgCfg = next;
    const sum = rs.reduce((t, x) => t + x, 0);
    await pgLog({ symbol: '-', mode: 'live', event: 'reentry_paused', resultR: sum, detail: 'Live re-entry paused itself: the last 3 re-entries lost ' + sum.toFixed(2) + 'R together (limit -' + rc.pauseR + 'R). It is back to recording only; switch it on again in the Profit Guard card when you are ready.' });
    if (sendAlert) Promise.resolve(sendAlert('⏸ Live re-entry paused itself: the last 3 re-entries lost ' + sum.toFixed(2) + 'R together. It only records now. Review the Profit Guard log before switching it back on.')).catch(() => {});
    return true;
  }
  async function pgTick() {
    if (pgRun.busy || pgCfg.mode === 'off') return;
    if (!guardsMaster) { pgRun.note = 'master switch is off: trades run on their own stops'; return; }
    if (getMode() !== 'live' || breakerIsTripped()) { pgRun.note = 'paused: the relay is not live or trading is halted'; return; }
    pgRun.busy = true;
    try {
      await ready;
      const positions = await listOpenPositions(restClient);
      const seen = new Set();
      for (const p of positions) {
        if (p.side !== 'Buy' && p.side !== 'Sell') continue;
        const symbol = p.symbol, side = p.side, key = symbol + '|' + side, long = side === 'Buy'; seen.add(key);
        const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice), curSl = parseFloat(p.stopLoss) || 0;
        if (!(entry > 0) || !(mark > 0)) continue;
        let st = pgState.get(key);
        if (st && Math.abs(st.entry - entry) / st.entry > 0.005) st = null;   // a different trade on the same pair: start fresh
        if (!st) {
          const lk = await pgLookup(symbol, side);
          let init = lk.sl > 0 && (long ? lk.sl < entry : lk.sl > entry) ? lk.sl : 0;                     // the bot's own planned stop
          if (!init && curSl > 0 && (long ? curSl < entry : curSl > entry)) init = curSl;                    // else the first stop we saw on the position
          st = { entry, initialSl: init, peak: entry, peakAt: Date.now(), maxPull: 0, floor: 0, shadowSl: 0, shadowHit: false, scaled: [], profile: PG.profileOf(pgCfg, lk.eng, lk.bot), bot: lk.bot, since: Date.now(), lastAlert: 0, reentry: lk.reentry === true, reentryScore: lk.score, reentrySrc: lk.src };
          pgState.set(key, st); pgWatch.delete(key);
        }
        st.scaled = st.scaled || [];
        const peak0 = st.peak;
        st.peak = PG.updatePeak(st.peak, side, mark, entry); st.mark = mark; st.curSl = curSl; st.size = Number(p.size) || 0; st.seenAt = Date.now();
        { const lv = Number(p.leverage) || 0, pv = Number(p.positionValue) || (st.size * entry); if (lv >= 1 && pv > 0) { st.lev = lv; st.margin = pv / lv; } }   // v2.9.8: what a re-entry will be sized from
        { const sn1 = snState.get(key); if (sn1 && sn1.floor > 0) st.snFloor = sn1.floor; const bs = botStopSeen.get(symbol); if (bs > 0) st.botSl = bs; }   // v2.9.5: who set which stop, for the exit attribution
        if (st.peak !== peak0 || !(st.peakAt > 0)) { st.peakAt = Date.now(); st.dirty = true; }          // smart: a new best resets the stall clock
        const pull0 = st.maxPull || 0; st.maxPull = PG.updatePull(pull0, side, st.peak, mark);          // smart: the trade's own largest pullback so far
        if (st.maxPull !== pull0) st.dirty = true;
        const em = pgEm(st);
        st.em = em;
        if (em === 'off') { st.lastWhy = 'switched off for this profile'; continue; }
        const inst = await getInstrument(symbol).catch(() => null);
        const pf = pgCfg[st.profile];

        // ---- scale-out ----
        if (pf.scale.on && st.initialSl > 0 && !PG_BAD_RISK(long, entry, st.initialSl)) {
          const risk = Math.abs(entry - st.initialSl), curR = (long ? mark - entry : entry - mark) / risk;
          const doneList = em === 'live' ? st.scaled : (st.scaledShadow = st.scaledShadow || []);
          const i = PG.scaleDue(pf.scale.steps, curR, doneList);
          if (i >= 0 && Date.now() >= (st.scaleRetryAt || 0)) {
            const frac = pf.scale.steps[i][1];
            if (em === 'shadow') {
              doneList.push(i); st.dirty = true;
              await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'would_scale', entry, mark, peakR: curR, detail: 'would take ' + Math.round(frac * 100) + '% off at ' + curR.toFixed(1) + 'R' });
            } else {
              const qty = PG.sliceQty(p.size, frac, inst && inst.qtyStep, inst && inst.minQty);
              if (!qty) { doneList.push(i); st.dirty = true; await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'scale_skipped', entry, mark, detail: 'position too small to split' }); }
              else {
                let res = null, err = null;
                try { res = await restClient.submitOrder({ category: 'linear', symbol, side: long ? 'Sell' : 'Buy', orderType: 'Market', qty: String(qty), reduceOnly: true, positionIdx: Number(p.positionIdx) || 0 }); }
                catch (e) { err = e.message || String(e); }
                if (res && res.retCode === 0) {
                  doneList.push(i); st.dirty = true; pgForce = true; pgRun.scales++;
                  await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'scaled', entry, mark, peakR: curR, detail: 'took ' + Math.round(frac * 100) + '% profit at ' + curR.toFixed(1) + 'R (' + qty + ')' });
                  fanOutPartialClose(symbol, side, frac, inst).catch(e => console.error('[multiuser] profit guard scale-out fan-out:', e.message));
                  if (pgCfg.alerts) deliverAlert('💰 Profit banked: ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' ' + Math.round(frac * 100) + '% closed at ' + curR.toFixed(1) + 'R. The rest keeps running with its stop.', { cat: 'updates' }).catch(() => {});
                } else {
                  st.scaleRetryAt = Date.now() + 60000;
                  await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', entry, mark, detail: 'scale-out: ' + (err || (res && res.retMsg) || 'no answer') });
                }
              }
            }
          }
        }

        // ---- profit lock ----
        // ADAPT: the pair's own speed (1-minute ATR) and BTC's direction, from the candles the Sentinel already keeps. If they cannot be read, the plain rules apply.
        let adaptNow = {}, curveNow = {};
        const rvNow = PG.revOf(pgCfg, botReads.get(key));          // the bot's own reversal reading for this trade (null when off, missing or too old)
        st.rev = rvNow ? { urg: rvNow.urg, t: rvNow.t } : null;
        if ((pgCfg.smart.adapt && pgCfg.smart.adapt.on) || (pgCfg.smart.curve && pgCfg.smart.curve.on)) {
          try {
            const bars = st.profile === 'swing' ? await swBars(symbol, '60', 40, 900000).catch(() => snBars(symbol)) : await snBars(symbol), btcRaw = await snBtcMove();   // v2.9.12: a swing trade's pace is read from hourly candles
            const risk0 = st.initialSl > 0 ? Math.abs(entry - st.initialSl) : 0, peakD0 = long ? st.peak - entry : entry - st.peak, peakR0 = risk0 > 0 ? Math.max(0, peakD0 / risk0) : 0;
            const btcDir = long ? btcRaw : -btcRaw;
            adaptNow = PG.adaptOf(pgCfg, { atr: SN.atrOf(bars), btcPct: btcDir, peakR: peakR0, maxPull: st.maxPull });
            const sn0 = snState.get(key), snSig = sn0 && sn0.mem && snEm(sn0) !== 'off' && Date.now() - (sn0.seenAt || 0) < 60000 ? { state: sn0.mem.state } : null;
            curveNow = PG.curveOf(pgCfg, { btcPct: btcDir, peakDist: peakD0, maxPull: st.maxPull, pullNow: long ? st.peak - mark : mark - st.peak, atr: SN.atrOf(bars), sn: snSig, rev: rvNow });
            st.curveWhy = curveNow.curveWhy || '';
            st.adapt = { atrPct: adaptNow.atrPrice ? Math.round(adaptNow.atrPrice / pgCfg.smart.adapt.atrMult / mark * 10000) / 100 : null, keepAdj: adaptNow.keepAdj || 0, curveMul: curveNow.curveMul || null };
          } catch { adaptNow = {}; curveNow = {}; }
        }
        // ---- early slice: bank a share once the trade is a little over 1R; the size and the trigger follow the same per-trade room reading as the curve ----
        let slc = !pf.scale.on && st.initialSl > 0 && !PG_BAD_RISK(long, entry, st.initialSl) ? PG.sliceOf(pgCfg, { mul: curveNow.curveMul }) : null;
        if (rvNow && rvNow.sliceNow && !pf.scale.on && st.initialSl > 0 && !PG_BAD_RISK(long, entry, st.initialSl)) slc = { atR: 0.3, frac: rvNow.frac, why: 'the bot reads a reversal (' + rvNow.urg.toFixed(2) + ')' };   // a strong reversal read: bank a share now, leave the rest running
        if (slc) {
          const riskS = Math.abs(entry - st.initialSl), curRS = (long ? mark - entry : entry - mark) / riskS, flag = em === 'live' ? 'sliced' : 'slicedShadow';
          st.slicePlan = { atR: slc.atR, frac: slc.frac, why: slc.why };
          if (!st[flag] && curRS >= slc.atR && Date.now() >= (st.scaleRetryAt || 0)) {
            const note = Math.round(slc.frac * 100) + '% at ' + curRS.toFixed(2) + 'R (' + slc.why + ')';
            if (em === 'shadow') { st[flag] = true; st.dirty = true; await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'would_scale', entry, mark, peakR: curRS, detail: 'early slice: would take ' + note }); }
            else {
              const qty = PG.sliceQty(p.size, slc.frac, inst && inst.qtyStep, inst && inst.minQty);
              if (!qty) { st[flag] = true; st.dirty = true; await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'scale_skipped', entry, mark, detail: 'early slice: position too small to split' }); }
              else {
                let res = null, err = null;
                try { res = await restClient.submitOrder({ category: 'linear', symbol, side: long ? 'Sell' : 'Buy', orderType: 'Market', qty: String(qty), reduceOnly: true, positionIdx: Number(p.positionIdx) || 0 }); }
                catch (e) { err = e.message || String(e); }
                if (res && res.retCode === 0) {
                  st[flag] = true; st.scaled.push('slice'); st.dirty = true; pgForce = true; pgRun.scales++;
                  await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'scaled', entry, mark, peakR: curRS, detail: 'early slice: took ' + note + ' (' + qty + ')' });
                  fanOutPartialClose(symbol, side, slc.frac, inst).catch(e => console.error('[multiuser] early slice fan-out:', e.message));
                  if (pgCfg.alerts) deliverAlert('💰 Profit banked: ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' ' + Math.round(slc.frac * 100) + '% closed at ' + curRS.toFixed(1) + 'R. The rest keeps running with its stop.', { cat: 'updates' }).catch(() => {});
                } else {
                  st.scaleRetryAt = Date.now() + 60000;
                  await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', entry, mark, detail: 'early slice: ' + (err || (res && res.retMsg) || 'no answer') });
                }
              }
            }
          }
        }
        const eff = em === 'shadow' && st.shadowSl > 0 ? (long ? Math.max(curSl, st.shadowSl) : (curSl > 0 ? Math.min(curSl, st.shadowSl) : st.shadowSl)) : curSl;
        const d = PG.decide({ side, entry, mark, peak: st.peak, curSl: eff, initialSl: st.initialSl, tick: inst && inst.tickSize || 0, profile: pf, cfg: pgCfg,
          smart: { ...PG.noiseOf(pgCfg, st.maxPull), ...adaptNow, ...curveNow, stallExtra: PG.stallExtra(pgCfg, st.profile, Date.now(), st.peakAt) } });
        st.lastWhy = d.action === 'raise' ? d.label : d.why; st.peakR = d.peakR !== undefined ? d.peakR : st.peakR;
        if (em === 'shadow' && st.shadowSl > 0 && !st.shadowHit && (long ? mark <= st.shadowSl : mark >= st.shadowSl)) {
          st.shadowHit = true;
          await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'would_exit', entry, mark, newSl: st.shadowSl, peakR: st.peakR, lockPct: (long ? st.shadowSl - entry : entry - st.shadowSl) / entry * 100, detail: 'price touched the guard\'s stop: it would have been closed here with the profit locked' });
        }
        if (d.action !== 'raise') continue;
        if (em === 'shadow') {
          st.shadowSl = d.newSl; st.dirty = true;
          await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'would_raise', entry, mark, oldSl: curSl || null, newSl: d.newSl, peakR: d.peakR, lockPct: d.lockPct, detail: d.label });
          continue;
        }
        // live: move the master's real stop, then the copies' stops
        const body = { category: 'linear', symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) };
        let res;
        try { const w = await stopWrite(side, body); if (w.skipped) { st.floor = Math.max(st.floor || 0, 0); st.curSl = w.cur; await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'skipped', entry, mark, oldSl: w.cur, newSl: d.newSl, peakR: d.peakR, detail: 'the stop on Bybit is already ' + w.cur + ' (as tight or tighter than ' + d.newSl + '): left alone' }); continue; } res = w.res; }
        catch (e) { await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', entry, mark, oldSl: curSl || null, newSl: d.newSl, peakR: d.peakR, detail: 'Bybit call failed: ' + (e.message || e) }); continue; }
        if (res.retCode !== 0 && res.retCode !== 34040) { await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', entry, mark, oldSl: curSl || null, newSl: d.newSl, peakR: d.peakR, detail: 'Bybit refused: ' + (res.retMsg || res.retCode) }); continue; }
        st.floor = d.newSl; st.curSl = d.newSl; st.dirty = true; pgRun.raises++; pgForce = true;
        await pgLog({ symbol, side, profile: st.profile, mode: em, event: 'raised', entry, mark, oldSl: curSl || null, newSl: d.newSl, peakR: d.peakR, lockPct: d.lockPct, detail: d.label });
        fanOutTradingStop({ symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) }).catch(e => console.error('[multiuser] profit guard fan-out:', e.message));
        if (pgCfg.alerts && Date.now() - st.lastAlert > 60000) {
          st.lastAlert = Date.now();
          deliverAlert('🔒 Profit locked: ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' stop moved to ' + d.newSl + ' (' + (d.lockPct >= 0 ? '+' : '') + d.lockPct.toFixed(2) + '% from entry, ' + d.label + '). Best so far was ' + d.peakR.toFixed(1) + 'R.', { cat: 'updates' }).catch(() => {});
        }
      }
      // trades that have closed since the last look: queue them for the scorecard
      let gone = false;
      for (const [key, st] of [...pgState.entries()]) {
        if (seen.has(key)) continue;
        pgClosing.push({ key, st, em: st.em || pgEm(st), at: Date.now(), tries: 0, mark: st.mark });
        pgState.delete(key); swFloor.delete(key); swState.delete(key); gone = true;
      }
      for (let i = 0; i < pgClosing.length;) { if (await pgRecordClose(pgClosing[i]).catch(() => false)) { pgClosing.splice(i, 1); gone = true; } else i++; }
      // re-entry watches (recording only: this never places a trade)
      for (const [key, w] of [...pgWatch.entries()]) {
        if (seen.has(key) || Date.now() > w.expiresAt + 3600000) { pgWatch.delete(key); gone = true; continue; }
        if (!pgCfg.reentry.on || PG.effMode(pgCfg, w.profile) === 'off') continue;
        let mk = 0;
        try { const r = await restClient.getTickers({ category: 'linear', symbol: w.symbol }); mk = parseFloat(r.result.list[0].lastPrice); } catch { continue; }
        const out = PG.reentryStep(w, mk, Date.now(), pgCfg.reentry);
        if (out.events.length || out.finished) gone = true;
        for (const e of out.events) {
          const base = { symbol: w.symbol, side: w.side, profile: w.profile, mode: 'shadow', entry: w.entry };
          if (e.type === 'would_reenter') {
            const brain = await reentryBrain(w, { price: e.price, stop: e.stop }, mk);   // scored (and logged) for EVERY chance, live or not: that is how the score is checked against results
            if (w.cand) { w.cand.score = brain.ok ? brain.score : null; w.cand.pullR = e.pullR; }
            await pgLog({ ...base, event: 'would_reenter', mark: e.price, newSl: e.stop, peakR: e.pullR, score: brain.ok ? brain.score : undefined, feat: brain.ok ? { ...brain.feat, src: w.src || 'winner' } : { src: w.src || 'winner', unreadable: brain.reason },
              detail: (w.src === 'shake' ? 'SHAKE-OUT chance: ' : '') + 'pulled back ' + e.pullR.toFixed(1) + 'R then resumed' + (pgCfg.reentry.live ? '' : ' (recording only)') + ' | ' + RB.summary(brain) });
            if (pgCfg.reentry.live) await reentryTry(w, e, mk, positions, brain).catch(err => console.error('[multiuser] live re-entry:', err.message));
          }
          else if (e.type === 'reentry_result') await pgLog({ ...base, event: 'reentry_result', mark: mk, resultR: e.r, peakR: e.bestR, score: w.cand && Number.isFinite(w.cand.score) ? w.cand.score : undefined, detail: e.why });
          else if (e.type === 'no_reentry') await pgLog({ ...base, event: 'no_reentry', mark: mk, peakR: e.pullR, detail: 'no pullback-and-resume appeared within the window' });
        }
        if (out.finished) pgWatch.delete(key);
      }
      await pgAutoTune().catch(e => console.error('[multiuser] profit guard tuning:', e.message));
      pgRun.at = Date.now(); pgRun.ok = true; pgRun.err = null; pgRun.note = ''; pgRun.positions = positions.length;
      const changed = gone || [...pgState.values()].some(s => s.dirty);
      for (const s of pgState.values()) s.dirty = false;
      if (changed) { await pgSaveState(gone || pgForce); pgForce = false; }
    } catch (e) { pgRun.at = Date.now(); pgRun.ok = false; pgRun.err = e.message; console.error('[multiuser] profit guard:', e.message); }
    finally { pgRun.busy = false; }
  }
  // ---------- Trade Sentinel ----------
  // Scores how much an OPEN master trade looks like a trap (see sentinel.js) from its own path and 1-minute candles. At alert/danger it may TIGHTEN the stop on Bybit
  // (never loosen), for the master and the copy users. Shadow records what it would do. It shares the stop floor with the Profit Guard (guardClamp), takes no new orders,
  // and when anything is missing (candles, the original stop) it does nothing.
  const snRun = { at: 0, ok: null, note: '', err: null, positions: 0, busy: false, moves: 0 };
  const snCandles = new Map();     // symbol -> { at, bars }
  const snClosing = [];
  let snBtc = { at: 0, pct: 0 }, snSavedAt = 0, snPathAt = new Map();
  const snEm = st => SN.effMode(snCfg, st.profile);
  const snSleep = ms => new Promise(r => setTimeout(r, ms));
  async function snLog(row) {
    try {
      await q(`INSERT INTO sentinel_log(symbol,side,mode,profile,event,state,score,entry,mark,old_sl,new_sl,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.symbol, row.side || null, row.mode || snCfg.mode, row.profile || null, row.event, row.state || null, row.score ?? null, row.entry ?? null, row.mark ?? null, row.oldSl ?? null, row.newSl ?? null, String(row.detail || '').slice(0, 300)]);
    } catch (e) { console.error('[multiuser] sentinel log:', e.message); }
  }
  async function snSaveState(force) {
    if (!force && Date.now() - snSavedAt < 15000) return;
    snSavedAt = Date.now();
    try { await q(`INSERT INTO meta(k,v) VALUES('sentinel_state',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(Object.fromEntries(snState))]); }
    catch (e) { console.error('[multiuser] sentinel state:', e.message); }
  }
  const snBarsFrom = list => (list || []).map(x => ({ t: Number(x[0]), o: parseFloat(x[1]), h: parseFloat(x[2]), l: parseFloat(x[3]), c: parseFloat(x[4]), v: parseFloat(x[5]) })).filter(b => b.t > 0 && b.c > 0).sort((a, b) => a.t - b.t);
  async function snBars(symbol) {
    const hit = snCandles.get(symbol);
    if (hit && Date.now() - hit.at < snCfg.candleSec * 1000) return hit.bars;
    const r = await restClient.getKline({ category: 'linear', symbol, interval: '1', limit: 60 });
    if (r.retCode !== 0) throw new Error('kline ' + (r.retMsg || r.retCode));
    const bars = snBarsFrom(r.result && r.result.list);
    snCandles.set(symbol, { at: Date.now(), bars });
    return bars;
  }
  async function snBtcMove() {                 // BTC's move over ~15 minutes in %, direction as it happened (the caller flips it for a short)
    if (Date.now() - snBtc.at < 60000) return snBtc.pct;
    try { const b = await snBars('BTCUSDT'); if (b.length > 16) snBtc = { at: Date.now(), pct: (b[b.length - 1].c - b[b.length - 16].c) / b[b.length - 16].c * 100 }; else snBtc.at = Date.now(); }
    catch { snBtc.at = Date.now() - 30000; }
    return snBtc.pct;
  }
  async function snExitOf(symbol, sinceMs) {
    try {
      const r = await restClient.getClosedPnL({ category: 'linear', symbol, limit: 10 });
      // v2.9.11: newest row first by its own time (never trust the list order), the same pick the Profit Guard scorecard makes: on 21 Oct the two scorecards disagreed on the exit of the same trade (AVAX 0.06R vs 0.73R)
      const rows = ((r.result && r.result.list) || []).filter(x => x.symbol === symbol && Number(x.updatedTime || x.createdTime || 0) >= sinceMs - 60000).sort((a, b) => Number(b.updatedTime || b.createdTime || 0) - Number(a.updatedTime || a.createdTime || 0));
      if (rows.length && parseFloat(rows[0].avgExitPrice) > 0) return { exit: parseFloat(rows[0].avgExitPrice), pnl: rows.reduce((t, x) => t + (Number(x.closedPnl) || 0), 0) };
    } catch { /* retried */ }
    return null;
  }
  async function snRecordClose(it) {
    const st = it.st, [symbol, side] = it.key.split('|'), long = side === 'Buy';
    const ex = await snExitOf(symbol, st.entryAt || st.since);
    if (!ex && it.tries < 6) { it.tries++; return false; }
    const risk = st.initialSl > 0 ? Math.abs(st.entry - st.initialSl) : 0;
    const rOf = px => (risk > 0 && px > 0 ? (long ? px - st.entry : st.entry - px) / risk : null);
    const peakR = risk > 0 ? (long ? st.peak - st.entry : st.entry - st.peak) / risk : null;
    try {
      await q(`INSERT INTO sentinel_trades(symbol,side,profile,mode,label,entry,initial_sl,peak_r,max_score,first_alert_at,first_danger_at,moves,shadow_exit_r,exit_price,exit_r,pnl)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
               WHERE NOT EXISTS (SELECT 1 FROM sentinel_trades WHERE symbol=$1 AND side=$2 AND entry=$6::numeric AND exit_price IS NOT DISTINCT FROM $14::numeric)`,
        [symbol, side, st.profile, it.em, st.label || null, st.entry, st.initialSl || null, peakR, st.maxScore || 0, st.firstAlertAt ? new Date(st.firstAlertAt) : null, st.firstDangerAt ? new Date(st.firstDangerAt) : null, st.moves || 0,
         st.shadowHit ? rOf(st.shadowSl) : null, ex ? ex.exit : null, ex ? rOf(ex.exit) : null, ex ? ex.pnl : null]);
    } catch (e) { console.error('[multiuser] sentinel scorecard:', e.message); }
    return true;
  }
  // ---- SWING MANAGER (v2.9.12) -------------------------------------------------------------------------------------------------------------------------
  // Swing trades live for days. This reads them on hours-and-days evidence (closed 4h candles, hourly ranges) instead of the seconds-and-minutes reads of the fast engines:
  // breakeven only after a CLOSED 4h candle held +holdR, a thesis exit when a closed 4h candle shows the setup has failed, a time rule for trades that go nowhere.
  // Default mode is SHADOW (it only records what it would do). The real stop on Bybit is never removed.
  const swState = new Map();   // 'SYMBOL|Side' -> { profile, entry, initialSl, entryAt, peak, logged }
  const swFloor = new Map();   // 'SYMBOL|Side' -> the stop the manager set (live)
  const swRun = { at: 0, ok: null, err: null, busy: false, raised: 0, exits: 0, note: '' };
  const swBarCache = new Map();
  async function swBars(symbol, interval, limit, ttlMs) {
    const k = symbol + '|' + interval, hit = swBarCache.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return hit.bars;
    const r = await restClient.getKline({ category: 'linear', symbol, interval, limit });
    if (r.retCode !== 0) throw new Error('kline ' + (r.retMsg || r.retCode));
    const bars = snBarsFrom(r.result && r.result.list);
    swBarCache.set(k, { at: Date.now(), bars });
    if (swBarCache.size > 120) for (const [kk, vv] of swBarCache) if (Date.now() - vv.at > 3600000) swBarCache.delete(kk);
    return bars;
  }
  const swLog = row => pgLog({ ...row, profile: 'swing', mode: row.mode || swCfg.mode });
  async function swTick() {
    if (swRun.busy || swCfg.mode === 'off') return;
    if (!guardsMaster) { swRun.note = 'master switch is off: trades run on their own stops'; return; }
    if (getMode() !== 'live' || breakerIsTripped()) { swRun.note = 'paused: the relay is not live or trading is halted'; return; }
    swRun.busy = true;
    try {
      await ready;
      const positions = await listOpenPositions(restClient), seen = new Set(), now = Date.now();
      for (const p of positions) {
        if (p.side !== 'Buy' && p.side !== 'Sell') continue;
        const symbol = p.symbol, side = p.side, key = symbol + '|' + side, long = side === 'Buy'; seen.add(key);
        const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice), curSl = parseFloat(p.stopLoss) || 0;
        if (!(entry > 0) || !(mark > 0)) continue;
        let st = swState.get(key);
        if (st && Math.abs(st.entry - entry) / st.entry > 0.005) st = null;
        if (!st) {
          const lk = await pgLookup(symbol, side, true);
          let init = lk.sl > 0 && (long ? lk.sl < entry : lk.sl > entry) ? lk.sl : 0;
          if (!init && curSl > 0 && (long ? curSl < entry : curSl > entry)) init = curSl;
          st = { profile: PG.profileOf(pgCfg, lk.eng, lk.bot), entry, initialSl: init, entryAt: Number(p.createdTime) > 0 ? Number(p.createdTime) : now, peak: entry, logged: {} };
          swState.set(key, st);
        }
        if (st.profile !== 'swing') continue;
        st.peak = long ? Math.max(st.peak, mark) : Math.min(st.peak, mark);
        const g0 = pgState.get(key); if (g0 && g0.peak > 0) st.peak = long ? Math.max(st.peak, g0.peak) : Math.min(st.peak, g0.peak);
        st.mark = mark; st.curSl = curSl; st.seenAt = now;
        const risk = st.initialSl > 0 ? Math.abs(entry - st.initialSl) : 0, peakR = risk > 0 ? Math.max(0, (long ? st.peak - entry : entry - st.peak) / risk) : 0;
        st.peakR = peakR; st.nowR = risk > 0 ? (long ? mark - entry : entry - mark) / risk : null;
        let bars4h;
        try { bars4h = await swBars(symbol, '240', 12, 300000); } catch (e) { st.why = 'no 4h candles: ' + e.message; continue; }
        const inst = await getInstrument(symbol).catch(() => null);
        const inp = { side, entry, initialSl: st.initialSl, curSl, mark, peakR, now, entryAt: st.entryAt, bars4h, tick: inst && inst.tickSize || 0, cfg: swCfg };
        const th = SW.thesis(inp), tm = SW.timeRule(inp), be = SW.breakeven(inp);
        const base = { symbol, side, entry, mark, peakR };
        const act = async (kind, d) => {   // one decision: shadow records it once per trade and kind, live does it
          if (swCfg.mode === 'shadow') {
            const sig = kind + ':' + (d.newSl || '');
            if (st.logged[sig]) return;
            st.logged[sig] = 1;
            await swLog({ ...base, mode: 'shadow', event: 'would_' + kind, newSl: d.newSl || null, oldSl: curSl || null, detail: d.label || d.why });
            return;
          }
          if (d.action === 'exit') {
            const opp = long ? 'Sell' : 'Buy', pos = Number(p.positionIdx) || 0, fp = await freshPos(symbol, side, pos), size = String(fp && fp.size > 0 ? fp.size : p.size);   // the real size right now (a scale-out may have just reduced it)
            if (fp && fp.size === 0) return;                                                // already closed
            let res = null, err = null;
            try { res = await restClient.submitOrder({ category: 'linear', symbol, side: opp, orderType: 'Market', qty: size, reduceOnly: true, positionIdx: pos }); } catch (e) { err = e.message || String(e); }
            if (res && res.retCode === 0) {
              swRun.exits++;
              await swLog({ ...base, mode: 'live', event: 'sw_' + kind, detail: d.why });
              fanOutOrder({ symbol, side: opp, orderType: 'Market', qty: size, reduceOnly: true, positionIdx: pos }).catch(e => console.error('[multiuser] swing exit fan-out:', e.message));
              deliverAlert('🧭 Swing exit (' + (kind === 'thesis' ? 'thesis' : 'time rule') + '): ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' closed. ' + d.why, { cat: 'updates' }).catch(() => {});
            } else await swLog({ ...base, mode: 'live', event: 'failed', detail: 'swing ' + kind + ' exit: ' + (err || (res && res.retMsg) || 'no answer') });
            return;
          }
          if (st.lastMoveAt && now - st.lastMoveAt < 60000) return;
          let res = null;
          try { const w = await stopWrite(side, { category: 'linear', symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) }); if (w.skipped) { st.lastMoveAt = now; st.curSl = w.cur; await swLog({ ...base, mode: 'live', event: 'skipped', oldSl: w.cur, newSl: d.newSl, detail: 'the stop on Bybit is already ' + w.cur + ' (as tight or tighter than ' + d.newSl + '): left alone' }); return; } res = w.res; }
          catch (e) { st.lastMoveAt = now; await swLog({ ...base, mode: 'live', event: 'failed', oldSl: curSl || null, newSl: d.newSl, detail: 'Bybit call failed: ' + (e.message || e) }); return; }
          if (res.retCode !== 0 && res.retCode !== 34040) { st.lastMoveAt = now; await swLog({ ...base, mode: 'live', event: 'failed', oldSl: curSl || null, newSl: d.newSl, detail: 'Bybit refused: ' + (res.retMsg || res.retCode) }); return; }
          st.lastMoveAt = now; swRun.raised++; swFloor.set(key, d.newSl);
          await swLog({ ...base, mode: 'live', event: 'sw_' + kind, oldSl: curSl || null, newSl: d.newSl, detail: d.label });
          fanOutTradingStop({ symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) }).catch(e => console.error('[multiuser] swing stop fan-out:', e.message));
        };
        if (th.action === 'exit') { st.why = th.why; await act('thesis', th); continue; }
        if (tm.action === 'exit') { st.why = tm.why; await act('time', tm); continue; }
        const cand = [['time', tm], ['breakeven', be]].filter(([, d]) => d.action === 'raise').sort((a, b) => (long ? b[1].newSl - a[1].newSl : a[1].newSl - b[1].newSl))[0];
        if (cand) { st.why = cand[1].label; await act(cand[0], cand[1]); }
        else st.why = be.why === 'breakeven rule is off' ? th.why : be.why;
      }
      for (const key of [...swState.keys()]) if (!seen.has(key)) { swState.delete(key); swFloor.delete(key); }
      swRun.at = Date.now(); swRun.ok = true; swRun.err = null; swRun.note = '';
    } catch (e) { swRun.at = Date.now(); swRun.ok = false; swRun.err = e.message; console.error('[multiuser] swing manager:', e.message); }
    finally { swRun.busy = false; }
  }
  async function swView() {
    const trades = [...swState.entries()].filter(([, st]) => st.profile === 'swing').map(([key, st]) => ({ symbol: key.split('|')[0], side: key.split('|')[1], entry: st.entry, mark: st.mark || null, nowR: st.nowR ?? null, peakR: st.peakR || 0, curSl: st.curSl || null, floor: swFloor.get(key) || null, ageH: Math.round((Date.now() - st.entryAt) / 360000) / 10, why: st.why || '' }));
    const log = (await q(`SELECT at, symbol, side, mode, event, entry, mark, old_sl, new_sl, detail FROM profit_guard_log WHERE profile='swing' AND (event LIKE 'would\\_%' ESCAPE '\\' OR event LIKE 'sw\\_%' ESCAPE '\\') ORDER BY id DESC LIMIT 30`)).rows;
    return { cfg: swCfg, run: { at: swRun.at, ok: swRun.ok, err: swRun.err, note: swRun.note, raised: swRun.raised, exits: swRun.exits }, trades, log };
  }
  // ===== PACE MODEL (v2.9.13) =====
  // Which calls run fast (hours) and which are slow (days)? At signal time the relay scores the call (stop distance in hourly ranges, speed now, volume, move already used, BTC) and shows
  // one line on the entry alert. After entry it records the R really made by 15/30/60/120/240 min and labels the trade FAST / NORMAL / SLOW afterwards, so the score can be checked against
  // what happened. SHADOW by default: it records and shows, it never changes a trade. 'alert' mode also sends one Telegram note when a trade proves slow.
  const pcPre = new Map();     // 'SYMBOL|Side' -> { at, entry, sl, f, sc }   (signal-time reading, reused by the alert line and the tracker)
  const pcState = new Map();   // 'SYMBOL|Side' -> the open trade being tracked
  const pcRun = { at: 0, ok: null, err: null, busy: false, note: '' };
  let pcHist = { at: 0, rows: [] };
  let pcCal = { at: 0, cal: null, busy: false };   // v2.9.14: observed durations by group (history + the live-recorded trades), refreshed in the background every 10 min
  const PC_CPS = [15, 30, 60, 120, 240];
  async function pcCompute(symbol, side, entry, sl) {
    const key = symbol + '|' + side, hit = pcPre.get(key);
    if (hit && Date.now() - hit.at < 1800000 && Math.abs(hit.entry - entry) / entry < 0.005 && Math.abs(hit.sl - sl) / sl < 0.005) return hit;
    const [m1, h1, btc] = await Promise.all([snBars(symbol).catch(() => []), swBars(symbol, '60', 40, 900000).catch(() => []), snBtcMove().catch(() => NaN)]);
    const f = PM.features({ side, entry, sl, bars1m: m1, bars1h: h1, btcPct: btc });
    const out = { at: Date.now(), entry, sl, f, sc: f ? PM.score(f, pcCfg) : null };
    if (out.sc) { pcPre.set(key, out); if (pcPre.size > 100) for (const [k2, v2] of pcPre) if (Date.now() - v2.at > 3600000) pcPre.delete(k2); }
    return out;
  }
  async function pcCalRefresh() {
    if (pcCal.busy) return; pcCal.busy = true;
    try {
      const hist = await pcHistory().catch(() => []);
      const live = (await q(`SELECT features, t10_min, label, EXTRACT(EPOCH FROM (closed_at - entry_at))/60 AS life FROM pace_trades WHERE closed_at IS NOT NULL AND label IS NOT NULL ORDER BY entry_at DESC LIMIT 600`)).rows
        .map(r => ({ stopPct: Number((r.features || {}).stopPct), stopAtr: (r.features || {}).stopAtr === undefined ? null : Number(r.features.stopAtr), t10Min: r.t10_min === null ? null : Number(r.t10_min), lifeMin: Number(r.life), closed: true }));
      const rows = hist.map(h => ({ stopPct: h.stopPct, stopAtr: null, t10Min: h.t10Min, lifeMin: h.lifeMin, closed: true })).concat(live);
      pcCal = { at: Date.now(), cal: PM.calibrate(rows), busy: false };
    } catch (e) { pcCal.busy = false; pcCal.at = Date.now() - 480000; console.error('[multiuser] pace calibration:', e.message); }
  }
  const pcEstimate = (f, sc) => { if (Date.now() - pcCal.at > 600000 && !pcCal.busy) pcCalRefresh(); return PM.estimate(f, pcCal.cal, sc); };
  // The line for the bot's entry alert. The text is the bot's own; entry, stop and direction are read back out of it. Any problem = no line (the alert is never held up for long).
  async function pcAlertText(m) {
    if (!m || m.kind !== 'entry' || pcCfg.mode === 'off' || /Pace\s+(FAST|NORMAL|SLOW)/.test(m.text)) return m && m.text;
    try {
      const plain = stripTags(m.text), num = re => { const x = re.exec(plain); return x ? parseFloat(x[1]) : NaN; };
      const entry = num(/Entry\s+\$?([0-9.]+)/), sl = num(/Stop\s+\$?([0-9.]+)/), symbol = String(m.sym || '').toUpperCase();
      const side = /\bSHORT\b/.test(plain) ? 'Sell' : /\bLONG\b/.test(plain) ? 'Buy' : '';
      if (!(entry > 0) || !(sl > 0) || !side || !SYMBOL_RE.test(symbol)) return m.text;
      const r = await Promise.race([pcCompute(symbol, side, entry, sl), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]);
      const line = r && r.sc ? PM.lineOfEst(r.sc, pcEstimate(r.f, r.sc)) : '';
      if (!line) return m.text;
      return /<\/pre>\s*$/.test(m.text) ? m.text.replace(/<\/pre>\s*$/, '\n' + line + '</pre>') : m.text + '\n' + line;
    } catch { return m.text; }
  }
  async function pcSave(st, closed) {
    const peakR = st.peakR || 0;
    await q(`INSERT INTO pace_trades(k,symbol,side,bot,eng,entry_at,entry,sl,tp,features,score,klass,hours,why,late,cp,peak_r,t05_min,t10_min,proof,label,closed_at,exit_r,updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now())
             ON CONFLICT (k) DO UPDATE SET cp=EXCLUDED.cp, peak_r=EXCLUDED.peak_r, t05_min=EXCLUDED.t05_min, t10_min=EXCLUDED.t10_min, proof=EXCLUDED.proof, label=EXCLUDED.label, closed_at=EXCLUDED.closed_at, exit_r=EXCLUDED.exit_r, updated_at=now()`,
      [st.k, st.symbol, st.side, st.bot || '', st.eng || null, new Date(st.entryAt), st.entry, st.sl, st.tp || null, st.f ? JSON.stringify(st.f) : null, st.sc ? st.sc.score : null, st.sc ? st.sc.klass : null, st.sc ? st.sc.hours : null,
       st.sc ? st.sc.why.join('; ').slice(0, 600) : null, !!st.late, JSON.stringify(st.cp || {}), Math.round(peakR * 100) / 100, st.t05, st.t10, st.proof ? st.proof.state : null, closed ? closed.label : null, closed ? new Date() : null, closed && closed.exitR !== null ? closed.exitR : null]);
  }

  // ===================== SCALP LANE (v2.9.15, smarter in v2.9.16) =====================
  // SHADOW ONLY. For every call the master opens, record the price every few seconds for SC_TRACK_MIN minutes, then replay the scalp rules
  // on that path (SC.simulate). No order is ever sent for the scalp lane in this version; the ledger and the Lab are the evidence for
  // deciding whether it should ever go live. v2.9.16 adds, per call: a target picked from the coin's own recorded history, leverage worked
  // out from the stop distance and the loss you accept, trailing / stall exits, quality gates and portfolio guards. Every call is also
  // replayed with the plain v2.9.15 rules (fixed target, fixed leverage) so the card shows whether the smarter parts really help.
  // It reads positions and prices only. It never writes stops, never touches users, and does not depend on PG / Sentinel / Swing / Pace.
  const scalpSignupOpen = () => process.env.SCALP_SIGNUP_OPEN === '1';   // v2.9.16: scalp sign-up and scalp invites stay CLOSED until you set SCALP_SIGNUP_OPEN=1 on Render
  const SCALP_MAX_TRADE_USD = Math.max(10, Number(process.env.SCALP_MAX_TRADE_USD) || 10000);   // scalp accounts are funded for size: their own ceiling, not the $500 core cap
  const SC_TRACK_MIN = 50;                     // covers the longest confirm window + time stop the Lab tries
  const scState = new Map();                   // k -> { k, symbol, side, bot, eng, signalPx, signalAt, klass, score, target, baseTarget, lev, plan, feat, cfg, path:[[sec, price]], lastAt }
  const scSeen = new Set();                    // keys already registered or stored (this process)
  const scRun = { at: 0, ok: null, err: null, busy: false, note: '', lastDisc: 0, lastSave: 0, tick: 0 };
  const scTgt = { at: 0, v: null };
  const scGrp = new Map();                     // symbol -> { at, rows } recorded paths of that coin; '*' = all coins
  async function scTarget() {
    if (scTgt.v && Date.now() - scTgt.at < 600000) return scTgt.v;
    let w = [];
    try { w = (await q(`SELECT peak_pct FROM pg_trades WHERE at > now() - interval '14 days' AND exit_pct > 0 AND peak_pct > 0 ORDER BY at DESC LIMIT 400`)).rows.map(r => Number(r.peak_pct)); } catch { /* fallback target */ }
    scTgt.v = SC.targetPct(w, scCfg); scTgt.at = Date.now();
    return scTgt.v;
  }
  // step 3 = keep every third point (about 15 s apart) for the target picker so the cache stays small; the Lab uses every point
  const scPathRows = (rs, step = 1) => rs.filter(r => Array.isArray(r.path) && r.path.length > 2).map(r => ({ side: r.side, signalPx: Number(r.signal_px), ts: new Date(r.signal_at).getTime(), path: r.path.filter((x, i, a) => step === 1 || i % step === 0 || i === a.length - 1).map(x => ({ t: x[0] * 1000, p: x[1] })) }));
  async function scGroup(symbol) {
    const hit = scGrp.get(symbol);
    if (hit && Date.now() - hit.at < 600000) return hit.rows;
    let rows = scPathRows((await q(`SELECT side, signal_px, signal_at, path FROM scalp_trades WHERE symbol=$1 AND signal_at > now() - interval '30 days' AND path IS NOT NULL ORDER BY signal_at DESC LIMIT 120`, [symbol])).rows, 3);
    let src = symbol;
    if (rows.length < scCfg.minGroupRows) {
      const all = scGrp.get('*');
      if (all && Date.now() - all.at < 600000) rows = all.rows;
      else { rows = scPathRows((await q(`SELECT side, signal_px, signal_at, path FROM scalp_trades WHERE signal_at > now() - interval '30 days' AND path IS NOT NULL ORDER BY signal_at DESC LIMIT 200`)).rows, 3); scGrp.set('*', { at: Date.now(), rows }); }
      src = '*';
    }
    const out = { rows, src }; scGrp.set(symbol, { at: Date.now(), rows: out.rows, src });
    if (scGrp.size > 8) for (const k of scGrp.keys()) { if (k !== '*' && k !== symbol) { scGrp.delete(k); break; } }   // keep memory small: at most 8 cached groups
    return out.rows;
  }
  // the plan for one call: target (from the coin's history, else all coins, else the winners rule) and the leverage that follows from its stop
  async function scPlan(symbol) {
    const tg = await scTarget();
    const rows = await scGroup(symbol);
    const bt = SC.bestTarget(rows, { ...scCfg, fallbackTargetPct: tg.pct });
    const stopPct = bt.pct * scCfg.stopFrac, lv = SC.leverageFor(stopPct, scCfg);
    return { target: bt.pct, baseTarget: tg.pct, tgtSrc: bt.source === 'group' ? ((scGrp.get(symbol) || {}).src === symbol ? 'coin' : 'all coins') : tg.source, n: bt.n, skip: !!bt.skip, why: bt.why || null, lev: lv.lev, limitedBy: lv.limitedBy };
  }
  function scPathPts(st) { return (st.path || []).map(x => ({ t: x[0] * 1000, p: x[1] })); }
  function scSim(st, cfg) { return SC.simulate(scPathPts(st), st.side, st.signalPx, cfg || st.cfg || scCfg, { target: st.target }); }
  async function scSaveState(force) {
    if (!force && Date.now() - scRun.lastSave < 180000) return;
    scRun.lastSave = Date.now();
    const o = {}; for (const [k, v] of scState.entries()) o[k] = v;
    await q(`INSERT INTO meta(k,v) VALUES('scalp_state',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(o)]).catch(() => {});
  }
  async function scFinish(st) {
    let klass = st.klass, score = st.score, feat = { ...(st.feat || {}) };
    try {
      const r = (await q(`SELECT klass, score, features FROM pace_trades WHERE k=$1`, [st.k])).rows[0];
      if (r) { if (!klass && r.klass) { klass = r.klass; score = Number(r.score); } if (r.features && r.features.movedAtr !== undefined && feat.movedAtr === undefined) feat.movedAtr = Number(r.features.movedAtr); }
    } catch { /* unknown class */ }
    const cfg = st.cfg || scCfg, sim = scSim(st, cfg);
    const baseCfg = { ...cfg, ...SC.styleOf('fixed', cfg) };
    const base = SC.simulate(scPathPts(st), st.side, st.signalPx, baseCfg, { target: st.baseTarget || st.target });
    const inst = SC.simulate(scPathPts(st), st.side, st.signalPx, { ...baseCfg, instant: true }, { target: st.baseTarget || st.target });
    const lev = st.lev || cfg.leverage;
    const usd = sim.entered ? SC.usdOf(sim.netPct, cfg, cfg.shadowUsd, lev) : null;
    const baseUsd = base.entered ? SC.usdOf(base.netPct, cfg, cfg.shadowUsd, cfg.leverage) : null;
    const gate = !sim.entered ? null : (st.plan && st.plan.skip ? 'no edge for this coin' : SC.gateCheck(feat, sim.entryT / 60000, klass, cfg));
    await q(`INSERT INTO scalp_trades(k,symbol,side,bot,eng,klass,score,signal_px,signal_at,target,entered,reason,exit,gross_pct,net_pct,usd,mfe,mae,held_min,inst_exit,inst_net,path,cfg,lev,base_net,base_exit,base_usd,feat,gate,tgt_src,entry_min)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) ON CONFLICT (k) DO NOTHING`,
      [st.k, st.symbol, st.side, st.bot || null, st.eng || null, klass || null, score ?? null, st.signalPx, new Date(st.signalAt), st.target, !!sim.entered, sim.reason || null, sim.exit || null,
       sim.entered ? sim.grossPct : null, sim.entered ? sim.netPct : null, usd, sim.entered ? sim.mfePct : null, sim.entered ? sim.maePct : null, sim.entered ? sim.heldMin : null,
       inst.entered ? inst.exit : null, inst.entered ? inst.netPct : null, JSON.stringify(st.path || []), JSON.stringify(cfg), lev,
       base.entered ? base.netPct : null, base.entered ? base.exit : null, baseUsd, JSON.stringify(feat), gate, st.plan ? st.plan.tgtSrc : null, sim.entered ? Math.round(sim.entryT / 600) / 100 : null]);
  }
  async function scTick() {
    if (scCfg.mode === 'off' || scRun.busy) return;
    if (getMode() !== 'live') { scRun.note = 'paper mode: nothing is open on Bybit'; return; }
    scRun.busy = true; scRun.tick++;
    try {
      await ready;
      const now = Date.now();
      // 1. find new calls the master has just opened (every 10 s)
      if (now - scRun.lastDisc >= 10000) {
        scRun.lastDisc = now;
        const positions = await listOpenPositions(restClient);
        for (const p of positions) {
          if (p.side !== 'Buy' && p.side !== 'Sell') continue;
          const entry = parseFloat(p.avgPrice), created = Number(p.createdTime) > 0 ? Number(p.createdTime) : now;
          if (!(entry > 0) || now - created > 180000) continue;            // only fresh calls: a position found late would have a wrong starting point
          const key = p.symbol + '|' + p.side, k = key + '|' + Math.floor(created / 1000);
          if (scSeen.has(k) || scState.has(k)) continue;
          scSeen.add(k); if (scSeen.size > 2000) scSeen.delete(scSeen.values().next().value);
          const done = await q(`SELECT 1 FROM scalp_trades WHERE k=$1`, [k]);
          if (done.rows[0] || scState.size >= 40) continue;
          const lk = await pgLookup(p.symbol, p.side, true).catch(() => ({}));
          const plan = await scPlan(p.symbol).catch(() => null) || { target: scCfg.fallbackTargetPct, baseTarget: scCfg.fallbackTargetPct, tgtSrc: 'default', n: 0, skip: false, lev: SC.leverageFor(scCfg.fallbackTargetPct * scCfg.stopFrac, scCfg).lev };
          scState.set(k, { k, symbol: p.symbol, side: p.side, bot: lk.bot || null, eng: lk.eng || null, signalPx: entry, signalAt: created, klass: null, score: null, target: plan.target, baseTarget: plan.baseTarget, lev: plan.lev, plan, feat: null, cfg: { ...scCfg }, path: [[0, entry]], lastAt: now });
        }
      }
      // 2. one price call for every watched symbol, then record a point each
      if (scState.size) {
        const r = await restClient.getTickers({ category: 'linear' });
        const px = new Map(); for (const t of (r.result.list || [])) { const v = parseFloat(t.lastPrice); if (v > 0) px.set(t.symbol, { v, t }); }
        for (const [k, st] of [...scState.entries()]) {
          const age = now - st.signalAt;
          const pc = pcState.get(st.symbol + '|' + st.side);
          if (!st.klass && pc && pc.sc && pc.sc.klass) { st.klass = pc.sc.klass; st.score = pc.sc.score; }
          const tk = px.get(st.symbol);
          if (tk && !st.feat) {            // quality facts, read once at the start: how wide the bid/ask gap is and how thin the coin is
            const bid = parseFloat(tk.t.bid1Price), ask = parseFloat(tk.t.ask1Price), tov = parseFloat(tk.t.turnover24h);
            st.feat = { spreadPct: bid > 0 && ask > 0 ? Math.round((ask - bid) / ((ask + bid) / 2) * 1e5) / 1e3 : null, turnoverUsd: tov > 0 ? tov : null };
            if (pc && pc.f && pc.f.movedAtr !== undefined) st.feat.movedAtr = Number(pc.f.movedAtr);
          }
          if (tk && now - st.lastAt >= 4000 && age < SC_TRACK_MIN * 60000) { st.path.push([Math.round(age / 100) / 10, tk.v]); st.lastAt = now; }
          if (age >= SC_TRACK_MIN * 60000) {
            try { await scFinish(st); scState.delete(k); } catch (e) { st.fails = (st.fails || 0) + 1; if (st.fails > 5) scState.delete(k); console.error('[multiuser] scalp finish:', e.message); }
          }
        }
      }
      await scSaveState(false);
      scRun.at = now; scRun.ok = true; scRun.err = null; scRun.note = scState.size + ' call' + (scState.size === 1 ? '' : 's') + ' being watched';
    } catch (e) { scRun.ok = false; scRun.err = e.message; throw e; }
    finally { scRun.busy = false; }
  }
  const scN = v => v === null || v === undefined ? null : Number(v);
  const scRows = rs => rs.map(r => ({ k: r.k, symbol: r.symbol, side: r.side, klass: r.klass, at: r.signal_at, target: scN(r.target), lev: scN(r.lev), entered: r.entered, reason: r.reason, exit: r.exit, net: scN(r.net_pct), usd: scN(r.usd), baseNet: scN(r.base_net), baseUsd: scN(r.base_usd), gate: r.gate, src: r.tgt_src, mfe: scN(r.mfe), mae: scN(r.mae), heldMin: scN(r.held_min), instNet: scN(r.inst_net), instExit: r.inst_exit }));
  async function scView(withLab) {
    const cols = withLab ? '*' : 'k,symbol,side,bot,eng,klass,score,signal_px,signal_at,target,entered,reason,exit,gross_pct,net_pct,usd,mfe,mae,held_min,inst_exit,inst_net,lev,base_net,base_exit,base_usd,feat,gate,tgt_src,entry_min';
    const all = (await q(`SELECT ${cols} FROM scalp_trades WHERE signal_at > now() - interval '60 days' ORDER BY signal_at DESC LIMIT 600`)).rows;
    const entered = all.filter(r => r.entered);
    const tsOf = r => new Date(r.signal_at).getTime();
    const mkTrade = r => ({ netPct: Number(r.net_pct), exit: r.exit, ts: tsOf(r), klass: r.klass });
    const sumUsd = rs => Math.round(rs.reduce((a, r) => a + (Number(r.usd) || 0), 0) * 100) / 100;
    const smartAll = SC.summarize(entered.map(mkTrade));
    const passed = entered.filter(r => !r.gate);
    const pf = SC.portfolio(passed.map(r => ({ startMs: tsOf(r) + (Number(r.entry_min) || 0) * 60000, endMs: tsOf(r) + ((Number(r.entry_min) || 0) + (Number(r.held_min) || 0)) * 60000, side: r.side, usd: Number(r.usd) || 0, r })), scCfg);
    const smart = SC.summarize(pf.accepted.map(x => mkTrade(x.r)));
    const base = SC.summarize(all.filter(r => r.base_net !== null).map(r => ({ netPct: Number(r.base_net), exit: r.base_exit, ts: tsOf(r) })));
    const inst = SC.summarize(all.filter(r => r.inst_net !== null).map(r => ({ netPct: Number(r.inst_net), exit: r.inst_exit, ts: tsOf(r) })));
    const byClass = {}; for (const c of ['FAST', 'NORMAL', 'SLOW', null]) { const sub = pf.accepted.filter(x => (x.r.klass || null) === c).map(x => mkTrade(x.r)); if (sub.length) byClass[c || 'unknown'] = SC.summarize(sub); }
    const fastConf = SC.summarize(pf.accepted.filter(x => Number(x.r.entry_min) <= 5).map(x => mkTrade(x.r))), slowConf = SC.summarize(pf.accepted.filter(x => Number(x.r.entry_min) > 5).map(x => mkTrade(x.r)));
    const fast = SC.summarize(pf.accepted.filter(x => x.r.klass === 'FAST').map(x => mkTrade(x.r)));
    const gates = {}; for (const r of entered) if (r.gate) gates[r.gate] = (gates[r.gate] || 0) + 1;
    const lanes = (await q(`SELECT lane, COUNT(*) AS n, COUNT(*) FILTER (WHERE active AND key_status='ok') AS ready FROM users GROUP BY lane`)).rows;
    const tg = await scTarget();
    const levs = pf.accepted.map(x => Number(x.r.lev)).filter(v => v > 0);
    const live = [...scState.values()].map(st => { const s = scSim(st); const last = st.path[st.path.length - 1]; return { symbol: st.symbol, side: st.side, klass: st.klass, ageMin: Math.round((Date.now() - st.signalAt) / 6000) / 10, target: st.target, lev: st.lev, src: st.plan && st.plan.tgtSrc, move: Math.round((st.side === 'Buy' ? last[1] - st.signalPx : st.signalPx - last[1]) / st.signalPx * 10000) / 100, entered: !!s.entered, exit: s.exit || null, net: s.entered ? s.netPct : null }; });
    const rowsForLab = withLab ? scPathRows(all) : null;
    return {
      cfg: scCfg, run: { at: scRun.at, ok: scRun.ok, err: scRun.err, note: scRun.note }, target: tg, trackMin: SC_TRACK_MIN,
      summary: smartAll, smart, base, instant: inst, fast, byClass, speed: { fast: fastConf, slow: slowConf },
      usdTotal: sumUsd(pf.accepted.map(x => x.r)), usdAll: sumUsd(entered), usdBase: Math.round(all.reduce((a, r) => a + (Number(r.base_usd) || 0), 0) * 100) / 100,
      guards: { gated: gates, crowd: pf.skipped.crowd, dayloss: pf.skipped.dayloss, passed: pf.accepted.length }, avgLev: levs.length ? Math.round(levs.reduce((a, b) => a + b, 0) / levs.length * 10) / 10 : null,
      calls: all.length, notEntered: all.length - entered.length,
      verdict: SC.verdict(smart), verdictBasis: 'smart rules after gates and guards',
      lanes: Object.fromEntries(lanes.map(x => [x.lane, { users: Number(x.n), ready: Number(x.ready) }])), watching: live,
      recent: scRows(all.slice(0, 30)),
      lab: rowsForLab ? SC.lab(rowsForLab.filter(r => r.path.length > 2), scCfg) : null,
      suggestion: rowsForLab ? SC.walkForward(rowsForLab, scCfg) : null,
    };
  }

  async function pcTick() {
    if (pcCfg.mode !== 'off' && Date.now() - pcCal.at > 600000 && !pcCal.busy) pcCalRefresh();
    if (pcRun.busy || pcCfg.mode === 'off') return;
    if (getMode() !== 'live') { pcRun.note = 'paper mode: nothing is open on Bybit'; return; }
    pcRun.busy = true;
    try {
      await ready;
      const positions = await listOpenPositions(restClient), seen = new Set(), now = Date.now();
      for (const p of positions) {
        if (p.side !== 'Buy' && p.side !== 'Sell') continue;
        const symbol = p.symbol, side = p.side, key = symbol + '|' + side, long = side === 'Buy'; seen.add(key);
        const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice);
        if (!(entry > 0) || !(mark > 0)) continue;
        let st = pcState.get(key);
        if (st && Math.abs(st.entry - entry) / st.entry > 0.005) { await pcFinish(key, st, now).catch(() => {}); st = null; }
        if (!st) {
          const lk = await pgLookup(symbol, side, true);
          const g0 = pgState.get(key), s0 = snState.get(key), sw0 = swState.get(key);
          let sl = lk.sl > 0 && (long ? lk.sl < entry : lk.sl > entry) ? lk.sl : 0;
          if (!sl) for (const c of [g0 && g0.initialSl, s0 && s0.initialSl, sw0 && sw0.initialSl]) if (c > 0 && (long ? c < entry : c > entry)) { sl = c; break; }
          if (!sl) continue;                                                     // no original stop (a manual trade without a signal): nothing to measure R from
          const entryAt = Number(p.createdTime) > 0 ? Number(p.createdTime) : now, k = key + '|' + Math.floor(entryAt / 1000);
          st = { k, key, symbol, side, entryAt, entry, sl, tp: parseFloat(p.takeProfit) || 0, bot: lk.bot, eng: lk.eng, cp: {}, peakPx: entry, peakR: 0, t05: null, t10: null, proof: null, alerted: false, late: false, f: null, sc: null };
          const old = (await q(`SELECT features, score, klass, hours, why, late, cp, peak_r, t05_min, t10_min FROM pace_trades WHERE k=$1`, [k])).rows[0];
          if (old) { st.f = old.features; st.cp = old.cp || {}; st.peakR = Number(old.peak_r) || 0; st.t05 = old.t05_min === null ? null : Number(old.t05_min); st.t10 = old.t10_min === null ? null : Number(old.t10_min); st.late = !!old.late;
            st.sc = old.klass ? { score: Number(old.score), klass: old.klass, hours: old.hours === null ? null : Number(old.hours), why: old.why ? old.why.split('; ') : [] } : null; }
          else {
            try { const r = await pcCompute(symbol, side, entry, sl); st.f = r.f; st.sc = r.sc; st.late = now - entryAt > 600000 || r.at > entryAt + 900000; } catch { /* the trade is still tracked, without a signal-time class */ }
          }
          pcState.set(key, st);
        }
        const risk = Math.abs(st.entry - st.sl);
        let bars = []; try { bars = await snBars(symbol); } catch { /* marks only */ }
        let peak = st.peakPx; const g1 = pgState.get(key); if (g1 && g1.peak > 0) peak = long ? Math.max(peak, g1.peak) : Math.min(peak, g1.peak);
        for (const b of bars) { if (b.t < st.entryAt - 60000) continue; const ex = long ? b.h : b.l; if (long ? ex > peak : ex < peak) peak = ex; }
        if (long ? mark > peak : mark < peak) peak = mark;
        st.peakPx = peak;
        const rOf = px => (long ? px - st.entry : st.entry - px) / risk;
        st.peakR = Math.max(st.peakR || 0, rOf(peak)); st.nowR = rOf(mark);
        const elapsed = (now - st.entryAt) / 60000;
        const crossMin = lvl => { for (const b of bars) { if (b.t < st.entryAt - 60000) continue; if (rOf(long ? b.h : b.l) >= lvl) return Math.max(0, Math.round((b.t - st.entryAt) / 600) / 100); } return Math.max(0, Math.round(elapsed * 100) / 100); };
        if (st.t05 === null && st.peakR >= pcCfg.label.slowR) st.t05 = crossMin(pcCfg.label.slowR);
        if (st.t10 === null && st.peakR >= pcCfg.label.fastR) st.t10 = crossMin(pcCfg.label.fastR);
        for (const c of PC_CPS) if (!st.cp[c] && elapsed >= c) st.cp[c] = { r: Math.round(st.nowR * 100) / 100, p: Math.round(st.peakR * 100) / 100 };
        st.proof = PM.proof({ elapsedMin: elapsed, peakR: st.peakR, nowR: st.nowR }, pcCfg);
        st.seenAt = now;
        if (pcCfg.mode === 'alert' && st.proof.state === 'slow' && !st.alerted && elapsed < 600) {
          st.alerted = true;
          deliverAlert('⏳ Pace: ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' is moving like a slow trade (' + st.proof.why + (st.sc ? '; at signal time it was read as ' + st.sc.klass + ', about ' + PM.hoursText(st.sc.hours) + ' to +1R' : '') + '). Nothing was changed.', { cat: 'updates' }).catch(() => {});
        }
        if (!st.lastSave || now - st.lastSave > 60000) { st.lastSave = now; await pcSave(st, null).catch(e => console.error('[multiuser] pace save:', e.message)); }
      }
      for (const [key, st] of [...pcState.entries()]) {
        if (seen.has(key)) { st.missed = 0; continue; }
        st.missed = (st.missed || 0) + 1;                                   // a position list that is briefly empty must not close the record: two misses in a row
        if (st.missed >= 2) await pcFinish(key, st, now).catch(e => console.error('[multiuser] pace finish:', e.message));
      }
      pcRun.at = Date.now(); pcRun.ok = true; pcRun.err = null; pcRun.note = '';
    } catch (e) { pcRun.at = Date.now(); pcRun.ok = false; pcRun.err = e.message; console.error('[multiuser] pace:', e.message); }
    finally { pcRun.busy = false; }
  }
  async function pcFinish(key, st, now) {
    pcState.delete(key);
    const life = (now - st.entryAt) / 60000;
    const label = PM.label({ t05Min: st.t05, t10Min: st.t10, lifeMin: life, closed: true }, pcCfg);
    await pcSave(st, { label, exitR: st.nowR === undefined ? null : Math.round(st.nowR * 100) / 100 });
  }
  const pcOpenView = () => [...pcState.values()].map(st => ({ est: st.f && st.sc ? PM.estimate(st.f, pcCal.cal, st.sc) : null, symbol: st.symbol, side: st.side, entry: st.entry, sl: st.sl, ageMin: Math.round((Date.now() - st.entryAt) / 60000), klass: st.sc ? st.sc.klass : null, score: st.sc ? st.sc.score : null, hours: st.sc ? st.sc.hours : null,
    why: st.sc ? st.sc.why : [], late: !!st.late, nowR: st.nowR === undefined ? null : Math.round(st.nowR * 100) / 100, peakR: Math.round((st.peakR || 0) * 100) / 100, proof: st.proof ? st.proof.state : null, proofWhy: st.proof ? st.proof.why : '', cp: st.cp || {}, f: st.f }));
  // Past trades from the Sentinel's own records: stop distance and the recorded path give a label for each, so the stop-distance split can be read today (a separate report from the live-recorded rows).
  async function pcHistory() {
    if (Date.now() - pcHist.at < 21600000) return pcHist.rows;   // past trades change slowly and this reads a lot of path rows: once every 6 hours is plenty
    const tr = (await q(`SELECT at, symbol, side, entry, initial_sl FROM sentinel_trades WHERE initial_sl > 0 AND entry > 0 ORDER BY at DESC LIMIT 150`)).rows, rows = [];
    for (const t of tr) {
      const end = new Date(t.at).getTime();
      const path = (await q(`SELECT at, peak_r FROM trade_path WHERE symbol=$1 AND side=$2 AND at <= $3 AND at > $4 ORDER BY at DESC LIMIT 8000`, [t.symbol, t.side, new Date(end + 120000), new Date(end - 7 * 86400000)])).rows;
      if (path.length < 3) continue;
      const run = [path[0]];
      for (let i = 1; i < path.length; i++) { if (new Date(path[i - 1].at).getTime() - new Date(path[i].at).getTime() > 900000) break; run.push(path[i]); }
      run.reverse(); const t0 = new Date(run[0].at).getTime();
      const pts = run.map(x => ({ min: (new Date(x.at).getTime() - t0) / 60000, peakR: Number(x.peak_r) || 0 })), life = pts[pts.length - 1].min, tm = PM.timesFromPath(pts, pcCfg);
      rows.push({ symbol: t.symbol, side: t.side, at: end, stopPct: Math.abs(Number(t.entry) - Number(t.initial_sl)) / Number(t.entry) * 100, lifeMin: Math.round(life), t05Min: tm.t05Min, t10Min: tm.t10Min, label: PM.label({ ...tm, lifeMin: life, closed: true }, pcCfg) });
    }
    pcHist = { at: Date.now(), rows };
    return rows;
  }
  async function pcView() {
    const recent = (await q(`SELECT k, symbol, side, bot, entry_at, entry, sl, features, score, klass, hours, why, late, cp, peak_r, t05_min, t10_min, proof, label, closed_at, exit_r FROM pace_trades ORDER BY entry_at DESC LIMIT 40`)).rows;
    const done = (await q(`SELECT features, klass, label FROM pace_trades WHERE label IN ('FAST','NORMAL','SLOW') AND klass IS NOT NULL ORDER BY entry_at DESC LIMIT 500`)).rows;
    let hist = []; try { hist = await pcHistory(); } catch (e) { hist = []; }
    const liveRows = done.map(r => ({ klass: r.klass, label: r.label, features: r.features || {}, stopPct: Number((r.features || {}).stopPct) }));
    return { cfg: pcCfg, run: { at: pcRun.at, ok: pcRun.ok, err: pcRun.err, note: pcRun.note }, open: pcOpenView(), recent,
      cal: pcCal.cal, calAt: pcCal.at,
      report: { recorded: done.length, accuracy: PM.accuracy(liveRows), separation: PM.separation(liveRows), history: { n: hist.length, byStop: PM.buckets(hist) } } };
  }
  async function snTick() {
    if (snRun.busy || snCfg.mode === 'off') return;
    if (!guardsMaster) { snRun.note = 'master switch is off: trades run on their own stops'; return; }
    if (getMode() !== 'live' || breakerIsTripped()) { snRun.note = 'paused: the relay is not live or trading is halted'; return; }
    snRun.busy = true;
    const pathRows = [];
    try {
      await ready;
      const positions = await listOpenPositions(restClient), seen = new Set(), now = Date.now();
      let snGone = false;
      for (const p of positions) {
        if (p.side !== 'Buy' && p.side !== 'Sell') continue;
        const symbol = p.symbol, side = p.side, key = symbol + '|' + side, long = side === 'Buy'; seen.add(key);
        const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice), curSl = parseFloat(p.stopLoss) || 0;
        if (!(entry > 0) || !(mark > 0)) continue;
        let st = snState.get(key);
        if (st && Math.abs(st.entry - entry) / st.entry > 0.005) st = null;
        if (!st) {
          const lk = await pgLookup(symbol, side, true);
          let init = lk.sl > 0 && (long ? lk.sl < entry : lk.sl > entry) ? lk.sl : 0;
          if (!init && curSl > 0 && (long ? curSl < entry : curSl > entry)) init = curSl;
          const created = Number(p.createdTime) > 0 ? Number(p.createdTime) : now;
          st = { entry, initialSl: init, peak: entry, peakAt: created, entryAt: created, profile: PG.profileOf(pgCfg, lk.eng, lk.bot), bot: lk.bot, since: now, mem: { state: 'calm', want: null, n: 0 }, moves: 0, lastMoveAt: 0, floor: 0, shadowSl: 0, shadowHit: false, label: 'unlabeled', maxScore: 0, alerted: false };
          snState.set(key, st);
        }
        st.mark = mark; st.curSl = curSl; st.seenAt = Date.now();
        const em = snEm(st); st.em = em;
        if (em === 'off') { st.why = 'switched off for this profile'; continue; }
        let bars;
        try { bars = await snBars(symbol); } catch (e) { st.why = 'no candles: ' + e.message; continue; }   // nothing known about the market: do nothing
        for (const b of bars) { if (b.t < st.entryAt - 60000) continue; const ex = long ? b.h : b.l; if (long ? ex > st.peak : ex < st.peak) { st.peak = ex; st.peakAt = b.t; } }
        if (long ? mark > st.peak : mark < st.peak) { st.peak = mark; st.peakAt = now; }
        const btcRaw = await snBtcMove(), btcPct = long ? btcRaw : -btcRaw;
        const f = SN.features({ side, entry, mark, peak: st.peak, peakAt: st.peakAt, entryAt: st.entryAt, now, initialSl: st.initialSl, candles: bars, btcPct, profile: st.profile, cfg: snCfg });
        if (!f) { st.why = 'cannot judge (no original stop or too few candles)'; continue; }
        if (st.label === 'unlabeled' && f.elapsedMin >= snCfg.label.afterMin) {
          let crosses = 0, prev = 0;
          for (const b of bars) { if (b.t < st.entryAt) continue; const s = Math.sign(b.c - entry); if (s && prev && s !== prev) crosses++; if (s) prev = s; }
          st.label = SN.labelTrade({ elapsedMin: f.elapsedMin, peakR: f.peakR, crosses }, snCfg);
        }
        const nf = SN.normFeatures(f, st.profile, snCfg), sc = SN.score(nf, snCfg.weights, SN.labelMult(st.label, snCfg));
        const prevState = st.mem.state;
        st.mem = SN.step(st.mem, sc, snCfg.th); st.score = sc; st.f = { peakR: f.peakR, nowR: f.nowR, giveback: f.giveback, advAtr: f.advAtr, stallMin: f.stallMin };
        if (sc > (st.maxScore || 0)) st.maxScore = sc;
        if (st.mem.state !== prevState) {
          if (st.mem.state === 'alert' && !st.firstAlertAt) st.firstAlertAt = now;
          if (st.mem.state === 'danger' && !st.firstDangerAt) st.firstDangerAt = now;
          await snLog({ symbol, side, profile: st.profile, mode: em, event: 'state', state: st.mem.state, score: sc, entry, mark, detail: prevState + ' -> ' + st.mem.state + ' (peak ' + f.peakR.toFixed(2) + 'R, now ' + f.nowR.toFixed(2) + 'R, label ' + st.label + ')' });
          if (snCfg.alerts && !st.alerted && (st.mem.state === 'alert' || st.mem.state === 'danger')) {
            st.alerted = true;
            deliverAlert('⚠️ Sentinel: ' + symbol.replace(/USDT$/, '') + ' ' + (long ? 'long' : 'short') + ' looks like it is turning against the trade (' + st.mem.state + ', score ' + sc + '). ' + (em === 'live' ? 'It may tighten the stop.' : 'Shadow mode: nothing was changed.'), { cat: 'updates' }).catch(() => {});
          }
        }
        if (now - (snPathAt.get(key) || 0) >= 10000) { snPathAt.set(key, now); pathRows.push([symbol, side, mark, f.nowR, f.peakR, f.atr, sc, st.mem.state]); }
        // the shadow stop would have been touched
        if (em === 'shadow' && st.shadowSl > 0 && !st.shadowHit && (long ? mark <= st.shadowSl : mark >= st.shadowSl)) {
          st.shadowHit = true;
          await snLog({ symbol, side, profile: st.profile, mode: em, event: 'would_exit', state: st.mem.state, score: sc, entry, mark, newSl: st.shadowSl, detail: 'price touched the Sentinel\'s shadow stop: the trade would have been closed here' });
        }
        // act (tighten only)
        if (st.mem.state !== 'alert' && st.mem.state !== 'danger') { st.why = 'state ' + st.mem.state; continue; }
        if (st.profile === 'swing') {   // v2.9.12: 15-second reads must not drive a multi-day trade: a grace period, then danger only
          const sws = snCfg.swing;
          if (SW.graceActive(st.entryAt, now, sws.graceH)) { st.why = 'swing: grace period (' + sws.graceH + ' h after entry)'; continue; }
          if (sws.actOn === 'danger' && st.mem.state !== 'danger') { st.why = 'swing: acts only in danger'; continue; }
        }
        if ((st.moves || 0) >= snCfg.limits.maxMoves || now - (st.lastMoveAt || 0) < snCfg.limits.moveGapSec * 1000) { st.why = 'move limit or pause between moves'; continue; }
        const inst = await getInstrument(symbol).catch(() => null);
        const eff = em === 'shadow' && st.shadowSl > 0 ? (long ? Math.max(curSl, st.shadowSl) : (curSl > 0 ? Math.min(curSl, st.shadowSl) : st.shadowSl)) : curSl;
        let keepFrac = 0;
        try { const g0 = pgState.get(key), cm = PG.curveOf(pgCfg, { btcPct, peakDist: long ? st.peak - entry : entry - st.peak, maxPull: g0 ? g0.maxPull : undefined, pullNow: long ? st.peak - mark : mark - st.peak, atr: f.atr, sn: { state: st.mem.state }, rev: PG.revOf(pgCfg, botReads.get(key)) }); keepFrac = PG.curveKeep(pgCfg, f.peakR, cm.curveMul) || 0; } catch { keepFrac = 0; }
        let atrD = f.atr;
        if (st.profile === 'swing') { try { atrD = SN.atrOf(await swBars(symbol, '60', 40, 900000)) || f.atr; } catch { /* the 1-minute ATR stays */ } }   // v2.9.12: the danger gap is measured in hourly ranges for a swing trade
        const d = SN.decide({ side, entry, mark, peak: st.peak, curSl: eff, initialSl: st.initialSl, tick: inst && inst.tickSize || 0, atr: atrD, state: st.mem.state, cfg: snCfg, keepFrac, profile: st.profile });
        st.why = d.action === 'raise' ? d.label : d.why;
        if (d.action !== 'raise') continue;
        if (em === 'shadow') {
          st.shadowSl = d.newSl; st.moves = (st.moves || 0) + 1; st.lastMoveAt = now;
          await snLog({ symbol, side, profile: st.profile, mode: em, event: 'would_raise', state: st.mem.state, score: sc, entry, mark, oldSl: curSl || null, newSl: d.newSl, detail: d.label });
          continue;
        }
        const body = { category: 'linear', symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) };
        let res;
        try { const w = await stopWrite(side, body); if (w.skipped) { st.curSl = w.cur; st.lastMoveAt = now; await snLog({ symbol, side, profile: st.profile, mode: em, event: 'skipped', state: st.mem.state, score: sc, entry, mark, oldSl: w.cur, newSl: d.newSl, detail: 'the stop on Bybit is already ' + w.cur + ' (as tight or tighter than ' + d.newSl + '): left alone' }); continue; } res = w.res; }
        catch (e) { await snLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', state: st.mem.state, score: sc, entry, mark, oldSl: curSl || null, newSl: d.newSl, detail: 'Bybit call failed: ' + (e.message || e) }); st.lastMoveAt = now; continue; }
        if (res.retCode !== 0 && res.retCode !== 34040) { await snLog({ symbol, side, profile: st.profile, mode: em, event: 'failed', state: st.mem.state, score: sc, entry, mark, oldSl: curSl || null, newSl: d.newSl, detail: 'Bybit refused: ' + (res.retMsg || res.retCode) }); st.lastMoveAt = now; continue; }
        st.floor = d.newSl; st.curSl = d.newSl; st.moves = (st.moves || 0) + 1; st.lastMoveAt = now; snRun.moves++;
        await snLog({ symbol, side, profile: st.profile, mode: em, event: 'raised', state: st.mem.state, score: sc, entry, mark, oldSl: curSl || null, newSl: d.newSl, detail: d.label });
        fanOutTradingStop({ symbol, positionIdx: Number(p.positionIdx) || 0, stopLoss: String(d.newSl) }).catch(e => console.error('[multiuser] sentinel fan-out:', e.message));
      }
      for (const [key, st] of [...snState.entries()]) {
        if (seen.has(key)) continue;
        snClosing.push({ key, st, em: st.em || snEm(st), at: now, tries: 0 });
        snState.delete(key); snPathAt.delete(key); snGone = true;
      }
      if (snGone) await snSaveState(true);   // v2.9.5: save at once, so a restart cannot bring a closed trade back and record it twice
      for (let i = 0; i < snClosing.length;) { if (await snRecordClose(snClosing[i]).catch(() => false)) snClosing.splice(i, 1); else i++; }
      if (pathRows.length) {
        const vals = [], ph = pathRows.map((r, i) => { vals.push(...r); const b = i * 8; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`; });
        await q(`INSERT INTO trade_path(symbol,side,mark,now_r,peak_r,atr,score,state) VALUES ${ph.join(',')}`, vals).catch(e => console.error('[multiuser] sentinel path:', e.message));
      }
      snRun.at = Date.now(); snRun.ok = true; snRun.err = null; snRun.note = ''; snRun.positions = positions.length;
      await snSaveState(false);
    } catch (e) { snRun.at = Date.now(); snRun.ok = false; snRun.err = e.message; console.error('[multiuser] sentinel:', e.message); }
    finally { snRun.busy = false; }
  }

  // ---- learn from the history the server already has: the bot signals (entry, original stop, exit) + Bybit's public candles. Nothing to upload. ----
  const snBack = { running: false, at: 0, done: 0, total: 0, used: 0, err: null, note: '' };
  async function snRangeBars(symbol, fromMs, toMs) {
    const all = new Map();
    let end = toMs;
    for (let page = 0; page < 6; page++) {
      const r = await restClient.getKline({ category: 'linear', symbol, interval: '1', start: fromMs, end, limit: 1000 });
      if (r.retCode !== 0) throw new Error('kline ' + (r.retMsg || r.retCode));
      const bars = snBarsFrom(r.result && r.result.list);
      if (!bars.length) break;
      for (const b of bars) all.set(b.t, b);
      if (bars[0].t <= fromMs) break;
      end = bars[0].t - 1;
      await snSleep(250);
    }
    return [...all.values()].sort((a, b) => a.t - b.t);
  }
  async function snBackfill(opts) {
    if (snBack.running) return { started: false, note: 'already running' };
    const days = Math.min(90, Math.max(3, Number(opts && opts.days) || 60)), max = Math.min(300, Math.max(10, Number(opts && opts.max) || 120));
    Object.assign(snBack, { running: true, at: Date.now(), done: 0, total: 0, used: 0, err: null, note: 'reading the bot signals' });
    (async () => {
      try {
        await ready;
        const rows = (await q(`SELECT symbol, side, eng, opened_at, closed_at, entry, sl FROM signals WHERE relay_ok = true AND closed_at IS NOT NULL AND sl > 0 AND entry > 0 AND opened_at > now() - ($1 || ' days')::interval AND closed_at > opened_at ORDER BY opened_at DESC LIMIT $2`, [String(days), max])).rows;
        snBack.total = rows.length; snBack.note = 'replaying ' + rows.length + ' closed trades';
        const samples = []; let traps = 0, usedTrades = 0;
        for (const s of rows) {
          try {
            const side = s.side === 'BUY' ? 'Buy' : 'Sell', entryAt = new Date(s.opened_at).getTime(), exitAt = new Date(s.closed_at).getTime();
            if (exitAt - entryAt > 36 * 3600000) { snBack.done++; continue; }
            const bars = await snRangeBars(s.symbol, entryAt - 45 * 60000, exitAt + 60000);
            const profile = s.eng === 'swing' ? 'swing' : 'fast';
            const rep = SN.replay({ side, entry: Number(s.entry), initialSl: Number(s.sl), entryAt, exitAt }, bars, snCfg, profile);
            if (rep.length) { usedTrades++; if (rep.some(x => x.y === 1)) traps++; for (let i = 0; i < rep.length; i += 2) samples.push(rep[i]); }
          } catch (e) { snBack.note = 'a trade was skipped: ' + e.message; }
          snBack.done++; snBack.used = usedTrades;
          await snSleep(300);
        }
        const w = (usedTrades >= snCfg.fit.minTrades && traps >= snCfg.fit.minTraps) ? SN.fitWeights(samples, snCfg) : null;
        const fit = { at: Date.now(), trades: usedTrades, samples: samples.length, traps, weights: w, current: snCfg.weights, before: SN.evalWeights(samples, snCfg.weights, snCfg.th), after: w ? SN.evalWeights(samples, w, snCfg.th) : null,
          note: w ? '' : 'not enough evidence yet: needs ' + snCfg.fit.minTrades + ' replayed trades with at least ' + snCfg.fit.minTraps + ' that reached the original stop (' + usedTrades + ' and ' + traps + ' so far)' };
        await q(`INSERT INTO meta(k,v) VALUES('sentinel_fit',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(fit)]);
        snBack.note = fit.note || 'done: a weight suggestion is ready';
      } catch (e) { snBack.err = e.message; snBack.note = 'failed'; console.error('[multiuser] sentinel backfill:', e.message); }
      finally { snBack.running = false; }
    })();
    return { started: true };
  }
  async function snView() {
    const trades = [...snState.entries()].map(([key, st]) => ({ symbol: key.split('|')[0], side: key.split('|')[1], profile: st.profile, mode: st.em || snEm(st), state: st.mem && st.mem.state, score: st.score ?? null, label: st.label, peakR: st.f ? st.f.peakR : null, nowR: st.f ? st.f.nowR : null, moves: st.moves || 0, stop: st.curSl || null, shadowStop: st.shadowSl || null, why: st.why || '' }));
    const log = (await q(`SELECT at, symbol, side, mode, event, state, score, old_sl, new_sl, detail FROM sentinel_log ORDER BY id DESC LIMIT 30`)).rows;
    const card = (await q(`SELECT at, symbol, side, mode, label, peak_r, max_score, first_alert_at, moves, shadow_exit_r, exit_r FROM sentinel_trades ORDER BY id DESC LIMIT 20`)).rows;
    const agg = (await q(`SELECT mode, COUNT(*)::int AS n, COUNT(first_alert_at)::int AS alerted, AVG(exit_r) AS avg_exit_r, AVG(shadow_exit_r) FILTER (WHERE shadow_exit_r IS NOT NULL) AS avg_shadow_exit_r, COUNT(shadow_exit_r)::int AS shadow_hits FROM sentinel_trades GROUP BY mode ORDER BY mode`)).rows;
    let fit = null; try { const r = await q(`SELECT v FROM meta WHERE k='sentinel_fit'`); if (r.rows[0]) fit = JSON.parse(r.rows[0].v); } catch { /* none yet */ }
    return { master: guardsMaster, cfg: snCfg, run: { at: snRun.at, ok: snRun.ok, note: snRun.note, err: snRun.err, positions: snRun.positions, moves: snRun.moves, relayMode: getMode(), halted: !!breakerIsTripped() }, trades, log, scorecard: { recent: card, summary: agg }, fit, backfill: { ...snBack } };
  }
  const PG_BAD_RISK = (long, entry, init) => !(init > 0) || (long ? init >= entry : init <= entry);
  // Called by the stop route before a bot's stop is applied: while the guard is live for that trade, a looser stop is held at the guard's floor (and a stop removal is refused).
  const botStopSeen = new Map();   // v2.9.5: the last stop a bot asked for per coin that was NOT held back (so it is what the bot really set), used to tell who closed a trade
  function guardClamp(body) {
    try {
      if (!guardsMaster) return body;
      if (!body || typeof body !== 'object' || body.stopLoss === undefined) return body;
      if (swCfg.mode === 'live') {   // v2.9.12: a stop the Swing Manager raised is not loosened by a bot's own (wider) structure stop
        for (const sd of ['Buy', 'Sell']) {
          const fl = swFloor.get(String(body.symbol) + '|' + sd), use = fl > 0 ? PG.clampStop(sd, body.stopLoss, fl) : null;
          if (use !== null) { pgLog({ symbol: body.symbol, side: sd, profile: 'swing', mode: 'live', event: 'held', newSl: fl, oldSl: Number(body.stopLoss) || null, detail: 'a stop of ' + body.stopLoss + ' was held at the Swing Manager floor ' + fl }); body = { ...body, stopLoss: String(use) }; }
        }
      }
      const sym = String(body.symbol), cands = [];
      for (const side of ['Buy', 'Sell']) {                       // the tighter of the Profit Guard's and the Sentinel's floor, each only while it is live
        let floor = 0, st = pgState.get(sym + '|' + side);
        if (st && st.floor > 0 && pgEm(st) === 'live') floor = st.floor; else st = null;
        const sn = snState.get(sym + '|' + side);
        if (sn && sn.floor > 0 && snEm(sn) === 'live' && (!floor || (side === 'Buy' ? sn.floor > floor : sn.floor < floor))) { floor = sn.floor; st = sn; }
        if (floor > 0) cands.push([side, floor, st]);
      }
      if (cands.length !== 1) { if (!cands.length) botStopSeen.set(sym, Number(body.stopLoss) || 0); return body; }
      const [side, floor, st] = cands[0];
      const use = PG.clampStop(side, body.stopLoss, floor);
      if (use === null) { botStopSeen.set(sym, Number(body.stopLoss) || 0); return body; }
      pgLog({ symbol: body.symbol, side, profile: st.profile, mode: 'live', event: 'held', entry: st.entry, newSl: floor, oldSl: Number(body.stopLoss) || null, detail: 'a stop of ' + body.stopLoss + ' was held at the floor ' + floor });
      return { ...body, stopLoss: String(use) };
    } catch { return body; }
  }
  // After a scale-out the bot still thinks it holds the whole position. When it later sends its own close, fit the quantity to what is really left.
  async function guardFitClose(body) {
    try {
      if (!body || body.reduceOnly !== true || !(Number(body.qty) > 0)) return body;
      const st = ['Buy', 'Sell'].map(s => pgState.get(String(body.symbol) + '|' + s)).find(x => x && x.scaled && x.scaled.length);
      if (!st) return body;
      const left = parseFloat(((await getPositionState(restClient, body.symbol)).open || {}).size);
      if (left > 0 && left < Number(body.qty)) return { ...body, qty: String(left) };
    } catch { /* the original order goes ahead untouched */ }
    return body;
  }

  // ---- smart tuning: read the scorecard, suggest (or, with consent, apply) small changes to the keep shares ----
  async function pgTuneEval(profile) {
    const rows = (await q(`SELECT peak_pct, exit_pct, giveback_pct, peak_r FROM pg_trades WHERE profile=$1 AND mode='live' AND exit_pct IS NOT NULL ORDER BY id DESC LIMIT 300`, [profile])).rows
      .map(r => ({ peak_pct: Number(r.peak_pct), exit_pct: r.exit_pct === null ? null : Number(r.exit_pct), giveback_pct: Number(r.giveback_pct), peak_r: Number(r.peak_r) }));
    const re = (await q(`SELECT COUNT(*)::int AS done, COUNT(*) FILTER (WHERE result_r>0)::int AS wins, AVG(result_r) AS avg_r FROM profit_guard_log WHERE event='reentry_result' AND profile=$1`, [profile])).rows[0];
    return PG.suggestTuning(pgCfg, profile, rows, { done: re.done, wins: re.wins, avg_r: re.avg_r === null ? null : Number(re.avg_r) });
  }
  async function pgApplyTuning(profile, sug, who) {
    if (!sug || !sug.next) return false;
    const next = PG.normalize({ ...pgCfg, [profile]: { ...pgCfg[profile], ladder: sug.next }, smart: { ...pgCfg.smart, tune: { ...pgCfg.smart.tune, lastAtN: { ...pgCfg.smart.tune.lastAtN, [profile]: sug.n } } } });
    await q(`INSERT INTO meta(k,v) VALUES('profit_guard',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    pgCfg = next;
    const txt = sug.changes.map(c => 'step at ' + c.atR + 'R: keep ' + Math.round(c.from * 100) + '% -> ' + Math.round(c.to * 100) + '%').join('; ');
    await pgLog({ symbol: '-', profile, mode: 'live', event: 'tuned', detail: (who || 'auto') + ' (' + sug.n + ' trades): ' + txt + '. ' + sug.reasons.join(' ') });
    await audit('admin', 'profit_guard_tuned', null, null, profile + ': ' + txt).catch(() => {});
    if (pgCfg.alerts) deliverAlert('🧠 Profit Guard tuned the ' + profile + ' ladder: ' + txt + '. Why: ' + sug.reasons.join(' '), { kind: 'master' });
    return true;
  }
  let pgTunedAt = 0;
  async function pgAutoTune(force) {
    if (pgCfg.smart.tune.mode !== 'auto' || (!force && Date.now() - pgTunedAt < 60000)) return;
    pgTunedAt = Date.now();
    for (const profile of ['fast', 'swing']) {
      if (PG.effMode(pgCfg, profile) !== 'live') continue;
      const sug = await pgTuneEval(profile);
      if (!sug.ready || sug.since < pgCfg.smart.tune.every) continue;
      if (sug.action === 'hold') { pgCfg = PG.normalize({ ...pgCfg, smart: { ...pgCfg.smart, tune: { ...pgCfg.smart.tune, lastAtN: { ...pgCfg.smart.tune.lastAtN, [profile]: sug.n } } } }); await q(`INSERT INTO meta(k,v) VALUES('profit_guard',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(pgCfg)]); continue; }
      await pgApplyTuning(profile, sug, 'auto');
    }
  }
  const pgView = async () => {
    const log = (await q(`SELECT at, symbol, side, mode, profile, event, entry, mark, old_sl, new_sl, peak_r, lock_pct, detail, result_r FROM profit_guard_log ORDER BY id DESC LIMIT 60`)).rows;
    const trades = [...pgState.entries()].map(([key, st]) => ({ symbol: key.split('|')[0], side: key.split('|')[1], profile: st.profile, bot: st.bot, mode: st.em || pgEm(st), entry: st.entry, mark: st.mark || null, peak: st.peak, peakR: st.peakR || 0, initialSl: st.initialSl || null, stop: st.curSl || null, floor: st.floor || null, shadowStop: st.shadowSl || null, scaled: (st.scaled || []).length, why: st.lastWhy || '', pullR: st.initialSl > 0 ? (st.maxPull || 0) / Math.abs(st.entry - st.initialSl) : null, stallPts: Math.round(PG.stallExtra(pgCfg, st.profile, Date.now(), st.peakAt) * 100) }));
    const card = (await q(`SELECT at, symbol, side, profile, mode, peak_pct, exit_pct, giveback_pct, peak_r, exit_r, scaled, pnl, closed_by FROM pg_trades ORDER BY id DESC LIMIT 20`)).rows;
    const agg = (await q(`SELECT profile, mode, COUNT(*)::int AS n, AVG(peak_pct) AS peak, AVG(exit_pct) AS exit, AVG(giveback_pct) AS giveback FROM pg_trades WHERE exit_pct IS NOT NULL GROUP BY profile, mode ORDER BY profile, mode`)).rows;
    const bands = (await q(`SELECT CASE WHEN score < 45 THEN '<45' WHEN score < 60 THEN '45-60' WHEN score < 75 THEN '60-75' ELSE '75+' END AS band, COUNT(*)::int AS n, AVG(result_r) AS avg_r, COUNT(*) FILTER (WHERE result_r > 0)::int AS wins FROM profit_guard_log WHERE event='reentry_result' AND score IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
    const lv = (await q(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE exit_r > 0)::int AS wins, COALESCE(SUM(exit_r), 0) AS sum_r, AVG(exit_r) AS avg_r FROM pg_trades WHERE reentry`)).rows[0];
    const re = (await q(`SELECT COUNT(*) FILTER (WHERE event='would_reenter')::int AS spotted, COUNT(*) FILTER (WHERE event='reentry_result')::int AS done, COUNT(*) FILTER (WHERE event='reentry_result' AND result_r>0)::int AS wins, AVG(result_r) FILTER (WHERE event='reentry_result') AS avg_r, COUNT(*) FILTER (WHERE event='no_reentry')::int AS none FROM profit_guard_log`)).rows[0];
    const watching = [...pgWatch.values()].map(w => ({ symbol: w.symbol, side: w.side, profile: w.profile, cand: !!w.cand, expiresAt: w.expiresAt }));
    const tuning = {}; for (const pr of ['fast', 'swing']) { try { const t = await pgTuneEval(pr); delete t.next; tuning[pr] = t; } catch { tuning[pr] = null; } }
    return { master: guardsMaster, cfg: pgCfg, tuning, run: { at: pgRun.at, ok: pgRun.ok, note: pgRun.note, err: pgRun.err, positions: pgRun.positions, raises: pgRun.raises, scales: pgRun.scales, relayMode: getMode(), halted: !!breakerIsTripped() }, trades, log, scorecard: { recent: card, summary: agg, reentry: { ...re, live: lv, bands }, watching } };
  };

  // ---------- CSV export + daily backup ----------

  // ---------- one file with everything about a bot (or all bots) for a date range ----------
  // Sections in one CSV: SIGNALS (the bot's own ledger plus what Bybit and the copy users did with each trade), ORDERS (the relay's journal of
  // what reached Bybit), GUARD and SENTINEL (every stop move or note while a trade was open), the two per-trade summaries, PATH (the price path
  // of each open trade in R), and ALERTS (the messages the bot sent). The logs that carry no bot name are matched to the bot by pair, side and time.
  async function buildExportAll(bot, fromD, toD) {
    await ready;
    const b = bot && bot !== 'all' ? bot : null;
    const cap = 60000;
    const sec = [];
    const add = (name, cols, rows) => sec.push('## ' + name + ' (' + rows.length + ' rows' + (rows.length >= cap ? ', capped' : '') + ')\n' + cols.join(',') + '\n' + rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n'));
    const onBot = (tbl, t) => `AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM signals s WHERE s.bot=$3 AND s.symbol=${tbl}.symbol AND UPPER(${tbl}.side)=s.side AND ${tbl}.${t} >= s.opened_at - interval '1 minute' AND ${tbl}.${t} <= COALESCE(s.closed_at, now()) + interval '10 minutes'))`;
    const P = [fromD, toD, b];
    const sig = (await q(`SELECT s.bot, s.k, s.symbol, s.side, s.eng, s.opened_at, s.entry, s.sl, s.tp, s.lev, s.margin, s.relay_flag, s.relay_ok, s.relay_code, s.relay_secs,
        s.closed_at, s.won, s.exit_price, s.pct, s.relayed, s.close_why,
        (SELECT COUNT(*)::int FROM order_log o WHERE o.signal_key = 'ym-' || s.rid AND o.ok = true) AS users_filled,
        (SELECT ROUND(AVG(o.slippage_bps)::numeric, 2) FROM order_log o WHERE o.signal_key = 'ym-' || s.rid AND o.slippage_bps IS NOT NULL) AS user_slip_bps
      FROM signals s WHERE s.opened_at >= $1 AND s.opened_at < $2 AND ($3::text IS NULL OR s.bot=$3) ORDER BY s.opened_at LIMIT ${cap}`, P)).rows;
    for (const r of sig) {
      const e = Number(r.entry), sl = Number(r.sl), x = Number(r.exit_price), risk = Math.abs(e - sl);
      r.risk_pct = e > 0 && sl > 0 ? Math.round(risk / e * 10000) / 100 : null;
      r.exit_r = e > 0 && sl > 0 && x > 0 && risk > 0 ? Math.round(((r.side === 'BUY' ? x - e : e - x) / risk) * 100) / 100 : null;
      r.minutes_open = r.closed_at ? Math.round((new Date(r.closed_at) - new Date(r.opened_at)) / 60000) : null;
    }
    add('SIGNALS', ['bot', 'k', 'symbol', 'side', 'eng', 'opened_at', 'entry', 'sl', 'tp', 'risk_pct', 'lev', 'margin', 'relay_flag', 'relay_ok', 'relay_code', 'relay_secs', 'users_filled', 'user_slip_bps',
      'closed_at', 'minutes_open', 'won', 'exit_price', 'pct', 'exit_r', 'relayed', 'close_why'], sig);
    add('ORDERS', ['bot', 'exec_id', 'kind', 'symbol', 'side', 'ok', 'code', 'detail', 'created_at'],
      (await q(`SELECT bot, exec_id, kind, symbol, side, ok, code, detail, created_at FROM master_log WHERE created_at >= $1 AND created_at < $2 AND ($3::text IS NULL OR bot=$3) ORDER BY created_at LIMIT ${cap}`, P)).rows);
    add('GUARD', ['at', 'symbol', 'side', 'mode', 'profile', 'event', 'entry', 'mark', 'old_sl', 'new_sl', 'peak_r', 'lock_pct', 'result_r', 'detail'],
      (await q(`SELECT * FROM profit_guard_log g WHERE at >= $1 AND at < $2 ${onBot('g', 'at')} ORDER BY at LIMIT ${cap}`, P)).rows);
    add('SENTINEL', ['at', 'symbol', 'side', 'mode', 'profile', 'event', 'state', 'score', 'entry', 'mark', 'old_sl', 'new_sl', 'detail'],
      (await q(`SELECT * FROM sentinel_log g WHERE at >= $1 AND at < $2 ${onBot('g', 'at')} ORDER BY at LIMIT ${cap}`, P)).rows);
    add('GUARD_TRADES', ['at', 'symbol', 'side', 'profile', 'mode', 'entry', 'initial_sl', 'peak_price', 'exit_price', 'peak_pct', 'exit_pct', 'giveback_pct', 'peak_r', 'exit_r', 'guard_floor', 'scaled', 'pnl'],
      (await q(`SELECT * FROM pg_trades g WHERE at >= $1 AND at < $2 ${onBot('g', 'at')} ORDER BY at LIMIT ${cap}`, P)).rows);
    add('PACE', ['entry_at', 'symbol', 'side', 'eng', 'read_class', 'read_score', 'read_hours', 'stop_pct', 'stop_atr', 'vol_exp', 'vol_ratio', 'moved_atr', 'btc_dir', 'late', 'r15', 'r30', 'r60', 'r120', 'r240', 'peak_r', 't05_min', 't10_min', 'proof', 'label', 'closed_at', 'exit_r', 'why'],
      (await q(`SELECT g.entry_at, g.symbol, g.side, g.eng, g.klass AS read_class, g.score AS read_score, g.hours AS read_hours, g.features->>'stopPct' AS stop_pct, g.features->>'stopAtr' AS stop_atr, g.features->>'volExp' AS vol_exp,
          g.features->>'volRatio' AS vol_ratio, g.features->>'movedAtr' AS moved_atr, g.features->>'btcDir' AS btc_dir, g.late, g.cp->'15'->>'p' AS r15, g.cp->'30'->>'p' AS r30, g.cp->'60'->>'p' AS r60, g.cp->'120'->>'p' AS r120, g.cp->'240'->>'p' AS r240,
          g.peak_r, g.t05_min, g.t10_min, g.proof, g.label, g.closed_at, g.exit_r, g.why FROM pace_trades g WHERE g.entry_at >= $1 AND g.entry_at < $2 ${onBot('g', 'entry_at')} ORDER BY g.entry_at LIMIT ${cap}`, P)).rows);
    add('SENTINEL_TRADES', ['at', 'symbol', 'side', 'profile', 'mode', 'label', 'entry', 'initial_sl', 'peak_r', 'max_score', 'first_alert_at', 'first_danger_at', 'moves', 'shadow_exit_r', 'exit_price', 'exit_r', 'pnl'],
      (await q(`SELECT * FROM sentinel_trades g WHERE at >= $1 AND at < $2 ${onBot('g', 'at')} ORDER BY at LIMIT ${cap}`, P)).rows);
    add('PATH', ['at', 'symbol', 'side', 'mark', 'now_r', 'peak_r', 'atr', 'score', 'state'],
      (await q(`SELECT * FROM trade_path g WHERE at >= $1 AND at < $2 ${onBot('g', 'at')} ORDER BY at LIMIT ${cap}`, P)).rows);
    add('ALERTS', ['bot', 'created_at', 'kind', 'sym', 'text'],
      (await q(`SELECT bot, created_at, kind, sym, REGEXP_REPLACE(LEFT(text, 600), E'[\\r\\n]+', ' | ', 'g') AS text FROM bot_msgs WHERE created_at >= $1 AND created_at < $2 AND ($3::text IS NULL OR bot=$3) ORDER BY created_at LIMIT ${cap}`, P)).rows);
    const head = ['# YM Oracle export', '# bot: ' + (b || 'all bots'), '# range (UTC): ' + fromD.toISOString() + ' to ' + toD.toISOString(), '# generated: ' + new Date().toISOString(),
      '# exit_r = result in R using the bot\'s planned stop (1 = it made what it risked, -1 = it lost it). All times are UTC (Lagos = UTC+1).'];
    return head.join('\n') + '\n\n' + sec.join('\n\n') + '\n';
  }

  async function buildCsv(userId) {
    const where = userId ? 'WHERE u.id=$1' : '';
    const params = userId ? [userId] : [];
    const r = await q(`
      SELECT * FROM (
        SELECT u.username, 'TRADE' AS kind, l.closed_at AS at, l.symbol, l.side, l.qty, l.entry_price, l.exit_price, l.closed_pnl AS amount, l.open_fee, l.close_fee, l.leverage
        FROM pnl_ledger l JOIN users u ON u.id=l.user_id ${where}
        UNION ALL
        SELECT u.username, 'FUNDING', f.at, f.symbol, NULL::text, NULL::numeric, NULL::numeric, NULL::numeric, f.amount, NULL::numeric, NULL::numeric, NULL::numeric
        FROM funding_ledger f JOIN users u ON u.id=f.user_id ${where}
      ) x ORDER BY at`, params);
    const cols = ['username', 'kind', 'at', 'symbol', 'side', 'qty', 'entry_price', 'exit_price', 'amount', 'open_fee', 'close_fee', 'leverage'];
    const lines = [cols.join(',')].concat(r.rows.map(row => cols.map(c => csvCell(row[c])).join(',')));
    return { csv: lines.join('\n') + '\n', rows: r.rows.length };
  }
  async function runBackupIfDue(force) {
    await ready;
    // The ledger holds every user's trades, so it goes to YOUR private chat only, never the public group. (Without the routing layer: the old single chat.)
    let chat = TG_ADMIN_CHAT;
    if (alertRouter) {
      const cfg = alertRouter.state.cfg, env = alertRouter.envChats();
      chat = cfg.dmChat || env.dmChat || '';
      if (!chat) return { sent: false, reason: 'No private chat set: add ALERT_TELEGRAM_PRIVATE_CHAT_ID on Render (the ledger is never sent to the group)' };
      if (!force && alertRouter.route.effectiveMode(cfg, Date.now()) === 'off') return { sent: false, reason: 'Telegram is switched off' };
    }
    if (!tgOn || !chat) return { sent: false, reason: 'Telegram is not configured' };
    const last = await q(`SELECT v FROM meta WHERE k='last_backup_ms'`);
    if (!force && last.rows[0] && Date.now() - Number(last.rows[0].v) < 23 * 3600 * 1000) return { sent: false, reason: 'not due yet' };
    const { csv, rows } = await buildCsv();
    if (!rows && !force) return { sent: false, reason: 'nothing to back up yet' };
    const ok = await tgSendDoc(chat, 'ym-ledger-' + new Date().toISOString().slice(0, 10) + '.csv', csv);
    if (ok) await q(`INSERT INTO meta(k,v) VALUES('last_backup_ms',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [String(Date.now())]);
    return { sent: ok, rows };
  }

  // ---- RETENTION (final-18) ---------------------------------------------------------------------------------------------
  // Only pure log tables are pruned. NEVER pruned: pnl_ledger, funding_ledger, equity_snap, the *_old archives (the user's money
  // history and the CSV backup), and pg_trades (one row per guarded trade; the Profit Guard tuner learns from it).
  //   RETENTION_DAYS        signals, order_log (settled rows only), master_log   default 90, minimum 14, 0 = keep everything
  //   AUDIT_RETENTION_DAYS  audit_log, profit_guard_log                           default 180, minimum 30
  // Deletes run in batches of 5000 so a first run on a big table never holds a long lock; at most 20 batches per table per run.
  const retentionDays = () => { const v = process.env.RETENTION_DAYS; if (v === undefined || v === '') return 90; const n = Number(v); return n === 0 ? 0 : (Number.isFinite(n) ? Math.max(14, Math.floor(n)) : 90); };
  const auditRetentionDays = () => { const n = Number(process.env.AUDIT_RETENTION_DAYS); return Number.isFinite(n) && n > 0 ? Math.max(30, Math.floor(n)) : 180; };
  async function pruneOldRows() {
    await ready;
    const days = retentionDays(), adays = auditRetentionDays(), out = {};
    const batch = async (table, cond, d) => {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await q(`DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${cond} LIMIT 5000))`, [d]);
        total += r.rowCount || 0;
        if ((r.rowCount || 0) < 5000) break;
      }
      return total;
    };
    const jobs = [];
    if (days > 0) jobs.push(
      ['signals', `opened_at < now() - ($1 || ' days')::interval`, days],
      ['order_log', `created_at < now() - ($1 || ' days')::interval AND code <> 'PENDING'`, days],
      ['master_log', `created_at < now() - ($1 || ' days')::interval`, days]);
    jobs.push(
      ['audit_log', `at < now() - ($1 || ' days')::interval`, adays],
      ['profit_guard_log', `at < now() - ($1 || ' days')::interval`, adays],
      ['sentinel_log', `at < now() - ($1 || ' days')::interval`, adays],
      ['scalp_trades', `signal_at < now() - ($1 || ' days')::interval`, 60],   // v2.9.15: shadow scalp ledger (each row carries its price path)
      ['trade_path', `at < now() - ($1 || ' days')::interval`, Math.max(7, Number(process.env.SENTINEL_PATH_DAYS) || 30)]);   // sentinel_trades is never pruned
    for (const [table, cond, d] of jobs) {
      try { out[table] = await batch(table, cond, String(d)); }
      catch (e) { out[table] = -1; console.error('[multiuser] retention ' + table + ':', e.message); }
    }
    const removed = Object.entries(out).filter(([, n]) => n > 0).map(([t, n]) => t + '=' + n).join(' ');
    if (removed) console.log('[multiuser] retention removed: ' + removed);
    return out;
  }

  if (process.env.NODE_ENV !== 'test' || process.env.YM_TEST_TIMERS === '1') {
    { const t1 = setTimeout(() => pruneOldRows().catch(e => console.error('[multiuser] retention:', e.message)), 5 * 60000); if (t1.unref) t1.unref();
      const t2 = setInterval(() => pruneOldRows().catch(e => console.error('[multiuser] retention:', e.message)), 6 * 3600 * 1000); if (t2.unref) t2.unref(); }
    setTimeout(() => settlePending().catch(() => {}), 20000);
    setInterval(() => settlePending().catch(() => {}), 30000);
    setInterval(() => alertSweep().catch(e => console.error('[multiuser] alert sweep:', e.message)), Number(process.env.ALERT_SWEEP_MS) || 20000);   // retries failed deliveries and sends the short safety-net alerts
    setInterval(() => q(`DELETE FROM bot_msgs WHERE created_at < now() - interval '30 days'`).catch(() => {}), 6 * 3600 * 1000);
    const pgLoop = () => { pgTick().catch(e => console.error('[multiuser] profit guard:', e.message)).finally(() => { const t = setTimeout(pgLoop, Math.max(3000, (pgCfg.pollSec || 5) * 1000)); if (t.unref) t.unref(); }); };
    setTimeout(pgLoop, 15000);
    const snLoop = () => { snTick().catch(e => console.error('[multiuser] sentinel:', e.message)).finally(() => { const t = setTimeout(snLoop, Math.max(3000, (snCfg.pollSec || 5) * 1000)); if (t.unref) t.unref(); }); };
    setTimeout(snLoop, 17000);
    const swLoop = () => { swTick().catch(e => console.error('[multiuser] swing manager:', e.message)).finally(() => { const t = setTimeout(swLoop, 30000); if (t.unref) t.unref(); }); };
    setTimeout(swLoop, 21000);
    const pcLoop = () => { pcTick().catch(e => console.error('[multiuser] pace:', e.message)).finally(() => { const t = setTimeout(pcLoop, 30000); if (t.unref) t.unref(); }); };
    const scLoop = () => { scTick().catch(e => console.error('[multiuser] scalp lane:', e.message)).finally(() => { const t = setTimeout(scLoop, 5000); if (t.unref) t.unref(); }); };
    setTimeout(scLoop, 27000);   // Scalp lane shadow recorder (every 5 s; does nothing while off)
    setTimeout(pcLoop, 25000);   // Pace model loop (every 30 s; does nothing while it is off)   // Swing Manager loop (every 30 s; does nothing while it is off)   // Trade Sentinel loop (does nothing while it is switched off)   // Profit Guard loop (does nothing while it is switched off)
    setInterval(() => checkSignalAlarms().catch(e => console.error('[multiuser] signal alarm:', e.message)), Number(process.env.ALERT_SWEEP_MS) || 20000);
    setTimeout(() => syncAll().catch(e => console.error('[multiuser] initial sync:', e.message)), 20000);
    setInterval(() => syncAll().catch(e => console.error('[multiuser] sync:', e.message)), SYNC_INTERVAL_MS);
    setTimeout(() => runBackupIfDue(false).catch(e => console.error('[multiuser] backup:', e.message)), 90000);
    setInterval(() => runBackupIfDue(false).catch(e => console.error('[multiuser] backup:', e.message)), 3600 * 1000);
    if (tgOn) {
      loadBotName();
      const t = setInterval(() => tgPollOnce().catch(e => console.error('[multiuser] telegram poll:', e.message)), 8000);
      if (t.unref) t.unref();
    }
  }

  // ---------- auth: users ----------
  const authLimiter = sec.makeLimiter({ windowMs: 15 * 60000, max: 20 });
  const limited = (req, res, next) => (authLimiter.hit(req.ip || 'x') ? next() : res.status(429).json({ success: false, message: 'Too many attempts. Try again in 15 minutes.' }));
  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2, now() + ($3 || ' days')::interval)`, [sha256(token), userId, String(SESSION_DAYS)]);
    return token;
  }
  const MUST_CHANGE_OK = new Set(['/api/me', '/api/me/password', '/api/auth/logout']);
  const userAuth = h(async (req, res, next) => {
    await ready;
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!m) return res.status(401).json({ success: false, message: 'Not signed in' });
    const r = await q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha256(m[1])]);
    if (!r.rows[0]) return res.status(401).json({ success: false, message: 'Session expired' });
    req.user = r.rows[0];
    req.tokenHash = sha256(m[1]);
    if (req.user.must_change_password && !MUST_CHANGE_OK.has(req.path)) return res.status(403).json({ success: false, mustChangePassword: true, message: 'Please change your password first.' });
    next();
  });
  const validUsername = s => /^[a-zA-Z0-9_]{3,24}$/.test(s || '');
  async function registerFailure(u, req) {
    const r = await q(`UPDATE users SET
        locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END
      WHERE id=$1 RETURNING locked_until, failed_logins`, [u.id]);
    const locked = r.rows[0] && r.rows[0].failed_logins === 0;
    await audit(u.username, locked ? 'login_locked' : 'login_failed', u.username, req, '');
  }

  app.get('/api/public-info', (req, res) => res.json({ success: true, outboundIps: process.env.PUBLIC_OUTBOUND_IPS || '', demo: demoLike, demoKeys: DEMO_KEYS_ALLOWED }));

  // tells the sign-up page which kind of invite this is (core or scalp) so it can show the right step; reveals nothing else
  app.get('/api/auth/invite-info', limited, h(async (req, res) => {
    await ready;
    const r = await q('SELECT used_by, lane FROM invites WHERE code=$1', [String(req.query.code || '').trim().toUpperCase()]);
    if (!r.rows[0] || r.rows[0].used_by !== null) return res.status(400).json({ success: false, message: 'Invalid or already-used invite code.' });
    res.json({ success: true, lane: r.rows[0].lane === 'scalp' ? 'scalp' : 'core' });
  }));
  app.post('/api/auth/signup', limited, h(async (req, res) => {
    await ready;
    const { username, password, inviteCode, apiKey, apiSecret } = req.body || {};
    const env = normEnv(req.body && req.body.env);
    if (env === 'demo' && !DEMO_KEYS_ALLOWED) return res.status(400).json({ success: false, message: 'Demo keys are switched off on this server. Use a live key.' });
    if (!validUsername(username)) return res.status(400).json({ success: false, message: 'Username: 3-24 letters, numbers or underscore.' });
    if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ success: false, message: 'Password must be at least 10 characters.' });
    if (!apiKey || !apiSecret) return res.status(400).json({ success: false, message: 'Bybit API key and secret are required.' });
    const code = String(inviteCode || '').trim().toUpperCase();
    const inv = await q('SELECT used_by, lane FROM invites WHERE code=$1', [code]);
    if (!inv.rows[0] || inv.rows[0].used_by !== null) return res.status(400).json({ success: false, message: 'Invalid or already-used invite code.' });
    const lane = inv.rows[0].lane === 'scalp' ? 'scalp' : 'core'; // the invite decides the lane; nobody can pick it themselves
    if (lane === 'scalp' && !scalpSignupOpen()) return res.status(400).json({ success: false, message: 'Scalp accounts are not open yet. Scalp trading is still being tested.' });

    // the starting trade size picked on the sign-up page (optional; otherwise the plan's standard percent)
    const sb = req.body || {};
    let startMode = masterPlan.sizeMode, startPct = masterPlan.sizePct, startUsd = masterPlan.sizeUsd;
    if (sb.sizeMode !== undefined || sb.sizePct !== undefined || sb.sizeUsd !== undefined) {
      const mode = sb.sizeMode || (sb.sizeUsd !== undefined && sb.sizePct === undefined ? 'fixed' : 'percent');
      const pv = parseControls({ sizeMode: mode, sizePct: mode === 'percent' ? sb.sizePct : null, sizeUsd: mode === 'fixed' ? sb.sizeUsd : null },
        { current: {}, allowed: MANUAL_KEYS, pctMax: STD.userPctMax, ceilUsd: masterPlan.maxTradeUsd || 0 });
      if (pv.error) return res.status(400).json({ success: false, message: pv.error });
      if (pv.values.sizePct > STD.userPctConfirmAbove && sb.confirmHigh !== true) return res.status(400).json({ success: false, needConfirm: true, message: 'More than ' + STD.userPctConfirmAbove + '% per trade is risky. Confirm that you understand to continue.' });
      startMode = pv.values.sizeMode; startPct = pv.values.sizePct ?? null; startUsd = pv.values.sizeUsd ?? null;
    }
    if (lane === 'scalp') { // scalp accounts always use a fixed USD amount per trade (set by the user, changeable any time)
      const usd = Number(sb.sizeUsd);
      if (!(usd >= 10)) return res.status(400).json({ success: false, message: 'Scalp accounts need a fixed amount per trade in USD (at least 10).' });
      if (usd > SCALP_MAX_TRADE_USD) return res.status(400).json({ success: false, message: 'The most a scalp account can use per trade is $' + SCALP_MAX_TRADE_USD + '.' });
      if (sb.riskAck !== true) return res.status(400).json({ success: false, message: 'Please accept the scalp risk notice first.' });
      startMode = 'fixed'; startPct = null; startUsd = usd;
    }

    const v = await validateKey(String(apiKey).trim(), String(apiSecret).trim(), env);
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    if (env === 'live' && MIN_LIVE_BALANCE > 0 && !(v.equity >= MIN_LIVE_BALANCE)) return res.status(400).json({ success: false, message: 'A live account needs at least $' + MIN_LIVE_BALANCE + ' to copy trades safely (yours shows $' + Number(v.equity || 0).toFixed(2) + '). Add funds, or try a Bybit demo account first.' });

    const passHash = await hashPassword(password);
    const keyEnc = encrypt(JSON.stringify({ k: String(apiKey).trim(), s: String(apiSecret).trim() }), KEY);
    const client = await pool.connect();
    let userId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO users(username,pass_hash,key_enc,key_hash,ips_unrestricted,last_equity,key_env,size_mode,size_pct,size_usd,risk_ack_at,lane) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [username.toLowerCase(), passHash, keyEnc, sha256(String(apiKey).trim()), v.ipsUnrestricted, v.equity, env, startMode, startPct, startUsd, sb.riskAck === true ? new Date() : null, lane]);
      userId = ins.rows[0].id;
      const claim = await client.query('UPDATE invites SET used_by=$2 WHERE code=$1 AND used_by IS NULL RETURNING code', [code, userId]);
      if (!claim.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Invalid or already-used invite code.' }); }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        const dupKey = /key_hash/.test(e.detail || e.constraint || '');
        return res.status(400).json({ success: false, message: dupKey ? 'This API key is already registered.' : 'That username is taken.' });
      }
      throw e;
    } finally { client.release(); }
    await audit(username.toLowerCase(), 'signup', username.toLowerCase(), req, (lane === 'scalp' ? 'SCALP lane. ' : '') + (env === 'demo' ? 'DEMO key' : '') + (v.ipsUnrestricted && env === 'live' ? (env === 'demo' ? ', ' : '') + 'key not IP-restricted' : ''));
    res.status(200).json({ success: true, token: await newSession(userId), warnings: v.warnings });
  }));

  app.post('/api/auth/login', limited, h(async (req, res) => {
    await ready;
    const { username, password, totp } = req.body || {};
    const r = await q('SELECT * FROM users WHERE username=$1', [String(username || '').toLowerCase()]);
    const u = r.rows[0];
    if (u && u.locked_until && new Date(u.locked_until) > new Date()) return res.status(429).json({ success: false, message: 'Too many wrong attempts. This account is locked for a few minutes.' });
    const ok = u ? await verifyPassword(String(password || ''), u.pass_hash) : (await verifyPassword('x', 'scrypt$AAAA$AAAA'), false);
    if (!ok) { if (u) await registerFailure(u, req); return res.status(401).json({ success: false, message: 'Wrong username or password.' }); }
    if (u.totp_enabled) {
      if (!totp) return res.status(200).json({ success: false, needTotp: true, message: 'Enter the 6-digit code from your authenticator app.' });
      const counter = sec.verifyTotp(decrypt(u.totp_secret_enc, KEY), totp, { minCounter: u.totp_last_counter });
      if (counter === null) { await registerFailure(u, req); return res.status(401).json({ success: false, needTotp: true, message: 'Wrong or already-used code.' }); }
      await q('UPDATE users SET totp_last_counter=$2 WHERE id=$1', [u.id, counter]);
    }
    await q('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
    res.status(200).json({ success: true, token: await newSession(u.id), mustChangePassword: u.must_change_password });
  }));

  app.post('/api/auth/logout', userAuth, h(async (req, res) => {
    await q('DELETE FROM sessions WHERE token_hash=$1', [req.tokenHash]);
    res.json({ success: true });
  }));

  // ---------- trading controls ----------
  const numOrNull = v => (v === null || v === undefined ? null : Number(v));
  function limitsView(u) {
    const e = effective(u);
    return { ...ownView(e), dailyLossLimitUsd: numOrNull(u.daily_loss_limit_usd), sizeMultMax: 1, pctMax: STD.userPctMax, pctConfirmAbove: STD.userPctConfirmAbove,
      ceilings: { maxTradeUsd: numOrNull(e.max_trade_usd), maxLeverage: minPositive(MAX_USER_LEVERAGE, u.max_lev_ceiling) || null } };
  }
  // what "restore" puts a manual user's controls back to: the master plan's own values
  function defaultsFor() {
    return { sizeMode: masterPlan.sizeMode, sizeMult: 1, sizeUsd: masterPlan.sizeUsd, sizePct: masterPlan.sizePct, dailyLossLimitUsd: null };
  }
  const planColumns = () => [masterPlan.sizeMode, 1, masterPlan.sizeUsd, masterPlan.sizePct, null];

  app.get('/api/me', userAuth, h(async (req, res) => {
    const u = req.user;
    const s = await q(`SELECT COALESCE(SUM(closed_pnl),0) AS pnl, COUNT(*) AS trades, COUNT(*) FILTER (WHERE closed_pnl>0) AS wins FROM pnl_ledger WHERE user_id=$1`, [u.id]);
    const f = await q('SELECT COALESCE(SUM(amount),0) AS funding FROM funding_ledger WHERE user_id=$1', [u.id]);
    const first = await q('SELECT equity FROM equity_snap WHERE user_id=$1 ORDER BY day LIMIT 1', [u.id]);
    const ledger = await q(`SELECT symbol, side, qty, closed_pnl, closed_at FROM pnl_ledger WHERE user_id=$1 ORDER BY closed_at DESC LIMIT 40`, [u.id]);
    const t = s.rows[0];
    const todayPnl = await todaysPnl(u.id);
    const eff = effective(u);
    // the loss meter shows whichever daily limit bites first: the USD limit, or the % of the balance the day started with
    const pctLimit = Number(eff.daily_loss_pct) > 0 && Number(u.last_equity) > 0 ? (Number(u.last_equity) - todayPnl) * Number(eff.daily_loss_pct) / 100 : 0;
    const lossLimitNow = minPositive(eff.daily_loss_limit_usd, pctLimit) || null;
    res.json({
      success: true, username: u.username, paused: u.paused, active: u.active, hasKey: !!u.key_enc, env: normEnv(u.key_env), demoKeys: DEMO_KEYS_ALLOWED,
      lane: u.lane === 'scalp' ? 'scalp' : 'core', scalpLive: false,   // scalp accounts are accepted now; real scalp orders start only after the shadow test passes
      keyStatus: u.key_status, keyError: u.key_error, equity: u.last_equity === null ? null : Number(u.last_equity),
      pnl: Number(t.pnl), funding: Number(f.rows[0].funding), trades: Number(t.trades), wins: Number(t.wins),
      shareToken: u.share_token || null, shareShowBalance: !!u.share_show_balance,
      mustChangePassword: !!u.must_change_password, totpEnabled: !!u.totp_enabled,
      telegram: { available: tgOn, linked: !!u.tg_chat_id, notify: u.tg_notify !== false, botUsername: tgBotUsername },
      limits: limitsView(u), defaults: defaultsFor(), plan: masterPlan, globalPause: pausedAll, dry: isDry(u),
      control: 'manual', allowManual: true, manualAckAt: u.manual_ack_at || null,
      planMatch: 100, standard: { ...STD }, notice: u.notice || null, noticeAt: u.notice_at || null,
      rails: { maxOpenTrades: masterPlan.maxOpenTrades, dailyLossPct: masterPlan.dailyLossPct, drawdownStopPct: masterPlan.drawdownStopPct, maxTradeUsd: masterPlan.maxTradeUsd },
      startEquity: first.rows[0] ? Number(first.rows[0].equity) : null,
      todayPnl, lossLimit: lossLimitNow === null || lossLimitNow === undefined ? null : Number(lossLimitNow),
      ledger: ledger.rows.map(r => ({ symbol: r.symbol, side: r.side, qty: Number(r.qty), pnl: Number(r.closed_pnl), at: r.closed_at })),
    });
  }));

  // ----- new: the user's own open trades (live from Bybit, cached 10s) and result curve -----
  const openCache = new Map();
  app.get('/api/me/open', userAuth, h(async (req, res) => {
    const u = req.user;
    if (!u.key_enc || u.key_status === 'error') return res.json({ success: true, open: [] });
    const hit = openCache.get(u.id);
    if (hit && Date.now() - hit.at < 10000) return res.json({ success: true, open: hit.open });
    try {
      const list = await listOpenPositions(userClient(u));
      const fin = v => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
      const open = list.map(p => ({
        symbol: p.symbol, side: p.side === 'Buy' ? 'LONG' : 'SHORT', size: fin(p.size), entry: fin(p.avgPrice), mark: fin(p.markPrice),
        pnl: fin(p.unrealisedPnl) === null ? 0 : fin(p.unrealisedPnl), leverage: fin(p.leverage) > 0 ? fin(p.leverage) : null,
        stop: fin(p.stopLoss) > 0 ? fin(p.stopLoss) : null, target: fin(p.takeProfit) > 0 ? fin(p.takeProfit) : null,
      }));
      openCache.set(u.id, { at: Date.now(), open });
      res.json({ success: true, open });
    } catch (e) {
      res.json({ success: false, message: 'Could not read your open trades from Bybit right now.' });
    }
  }));

  // cumulative result per day (closed PnL plus funding) for the last N days, one point per day with gaps filled
  async function resultSeries(userId, days) {
    const vals = [String(days)], who = userId ? ' AND user_id=$2' : '';
    if (userId) vals.push(userId);
    // the window starts at 00:00 UTC of the first day shown, so every row counted lands in a day we return
    const from = `(date_trunc('day', now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval + interval '1 day') AT TIME ZONE 'UTC'`;
    const r = await q(`SELECT to_char(day, 'YYYY-MM-DD') AS d, SUM(v) AS v FROM (
        SELECT date_trunc('day', closed_at AT TIME ZONE 'UTC') AS day, closed_pnl AS v FROM pnl_ledger WHERE closed_at >= ${from}${who}
        UNION ALL
        SELECT date_trunc('day', at AT TIME ZONE 'UTC') AS day, amount AS v FROM funding_ledger WHERE at >= ${from}${who}
      ) x GROUP BY day ORDER BY day`, vals);
    const by = {};
    for (const x of r.rows) by[x.d] = Number(x.v);
    const out = [];
    let run = 0;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      run += by[d] || 0;
      out.push({ day: d, net: Math.round(run * 100) / 100 });
    }
    return out;
  }
  const seriesDays = req => Math.min(365, Math.max(2, parseInt((req.query || {}).days, 10) || 30));
  app.get('/api/me/series', userAuth, h(async (req, res) => { res.json({ success: true, points: await resultSeries(req.user.id, seriesDays(req)) }); }));

  app.post('/api/me/pause', userAuth, h(async (req, res) => {
    const paused = !!(req.body && req.body.paused);
    // resuming restarts the drawdown measurement from the current balance (otherwise the stop would re-trigger on the very next signal)
    await q(paused ? 'UPDATE users SET paused=TRUE WHERE id=$1' : 'UPDATE users SET paused=FALSE, equity_peak=NULL WHERE id=$1', [req.user.id]);
    let closed = null;
    if (paused && req.body && req.body.closeAll === true) {
      closed = await enqueue(req.user.id, () => closeAllForUser(req.user, 'user paused and closed everything'));
      await audit(req.user.username, 'pause_and_close_all', req.user.username, req, JSON.stringify(closed));
    }
    res.json({ success: true, closed });
  }));

  // emergency button: closes everything open on this user's account right now (does not pause or change settings)
  app.post('/api/me/close-all', userAuth, limited, h(async (req, res) => {
    if (!req.user.key_enc) return res.status(400).json({ success: false, message: 'No API key on your account.' });
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ success: false, message: 'Confirmation required.' });
    const r = await enqueue(req.user.id, () => closeAllForUser(req.user, 'user pressed close all'));
    await audit(req.user.username, 'close_all', req.user.username, req, JSON.stringify(r));
    if (r.error) return res.status(502).json({ success: false, message: "Couldn't reach Bybit: " + r.error });
    res.json({ success: true, closed: r.closed, failed: r.failed });
  }));

  // manual mode only: put the trade amount and loss limit back to the master plan's values (autopilot users have nothing to restore)
  app.post('/api/me/reset-defaults', userAuth, h(async (req, res) => {
    await q('UPDATE users SET size_mode=$2, size_mult=$3, size_usd=$4, size_pct=$5, daily_loss_limit_usd=$6 WHERE id=$1', [req.user.id, ...planColumns()]);
    await audit(req.user.username, 'limits_reset', req.user.username, req, 'restored to the standard trade size');
    res.json({ success: true });
  }));

  // Retired: there is no Autopilot/Manual switch any more (everyone has "Your settings"). Kept so an old open page does not error.
  app.post('/api/me/mode', userAuth, limited, h(async (req, res) => {
    res.json({ success: true, control: 'manual' });
  }));

  app.post('/api/me/password', userAuth, limited, h(async (req, res) => {
    const { current, next } = req.body || {};
    if (!(await verifyPassword(String(current || ''), req.user.pass_hash))) return res.status(400).json({ success: false, message: 'Your current password is wrong.' });
    if (typeof next !== 'string' || next.length < 10) return res.status(400).json({ success: false, message: 'New password must be at least 10 characters.' });
    if (next === current) return res.status(400).json({ success: false, message: 'Choose a different password.' });
    await q('UPDATE users SET pass_hash=$2, must_change_password=FALSE WHERE id=$1', [req.user.id, await hashPassword(next)]);
    await q('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, req.tokenHash]); // every other device is signed out
    await audit(req.user.username, 'password_changed', req.user.username, req, '');
    res.json({ success: true });
  }));

  // two-factor (authenticator app)
  app.post('/api/me/2fa/setup', userAuth, h(async (req, res) => {
    if (req.user.totp_enabled) return res.status(400).json({ success: false, message: '2FA is already on.' });
    const secret = sec.newTotpSecret();
    await q('UPDATE users SET totp_secret_enc=$2 WHERE id=$1', [req.user.id, encrypt(secret, KEY)]);
    res.json({ success: true, secret, uri: sec.otpauthUri(req.user.username, secret, 'YM Oracle') });
  }));
  app.post('/api/me/2fa/enable', userAuth, limited, h(async (req, res) => {
    if (!req.user.totp_secret_enc) return res.status(400).json({ success: false, message: 'Start setup first.' });
    const counter = sec.verifyTotp(decrypt(req.user.totp_secret_enc, KEY), (req.body || {}).code);
    if (counter === null) return res.status(400).json({ success: false, message: 'That code is wrong. Check your phone clock and try the newest code.' });
    await q('UPDATE users SET totp_enabled=TRUE, totp_last_counter=$2 WHERE id=$1', [req.user.id, counter]);
    await audit(req.user.username, '2fa_enabled', req.user.username, req, '');
    res.json({ success: true });
  }));
  app.post('/api/me/2fa/disable', userAuth, limited, h(async (req, res) => {
    const { password, code } = req.body || {};
    if (!req.user.totp_enabled) return res.status(400).json({ success: false, message: '2FA is not on.' });
    if (!(await verifyPassword(String(password || ''), req.user.pass_hash))) return res.status(400).json({ success: false, message: 'Wrong password.' });
    if (sec.verifyTotp(decrypt(req.user.totp_secret_enc, KEY), code, { minCounter: req.user.totp_last_counter }) === null) return res.status(400).json({ success: false, message: 'Wrong code.' });
    await q('UPDATE users SET totp_enabled=FALSE, totp_secret_enc=NULL, totp_last_counter=NULL WHERE id=$1', [req.user.id]);
    await audit(req.user.username, '2fa_disabled', req.user.username, req, '');
    res.json({ success: true });
  }));

  // The user's own trade size (percent of their balance, or a fixed amount) and optional USD loss limit.
  // Above 20% the page must send confirmHigh:true (the user has read the warning).
  app.post('/api/me/limits', userAuth, h(async (req, res) => {
    const u = req.user, body = { ...(req.body || {}) };
    delete body.sizeMult; // retired
    if (body.sizeMode === 'match') return res.status(400).json({ success: false, message: 'Choose a percent of your balance or a fixed amount.' });
    if (u.lane === 'scalp') { // scalp accounts always trade a fixed USD amount that the user can change any time
      if (body.sizeMode !== undefined && body.sizeMode !== 'fixed') return res.status(400).json({ success: false, message: 'Scalp accounts use a fixed amount per trade in USD.' });
      if (body.sizeUsd !== undefined && !(Number(body.sizeUsd) >= 10)) return res.status(400).json({ success: false, message: 'The amount per trade must be at least 10 USD.' });
      body.sizeMode = 'fixed'; delete body.sizePct;
    }
    const parsed = parseControls(body, { current: ownView(effective(u)), allowed: MANUAL_KEYS, pctMax: STD.userPctMax,
      ceilUsd: u.lane === 'scalp' ? SCALP_MAX_TRADE_USD : (Number(effective(u).max_trade_usd) > 0 ? Number(effective(u).max_trade_usd) : 0) });
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    if (parsed.values.sizePct > STD.userPctConfirmAbove && body.confirmHigh !== true) return res.status(400).json({ success: false, needConfirm: true, message: 'More than ' + STD.userPctConfirmAbove + '% per trade risks a lot of your balance on a single signal. Confirm that you understand to continue.' });
    const colOf = { sizeMode: 'size_mode', sizeUsd: 'size_usd', sizePct: 'size_pct', dailyLossLimitUsd: 'daily_loss_limit_usd' };
    const sets = [], vals = [u.id];
    for (const [k, val] of Object.entries(parsed.values)) { vals.push(val); sets.push(colOf[k] + '=$' + vals.length); }
    // keep the unused field empty so one setting is always unambiguous
    if (parsed.values.sizeMode === 'percent') sets.push('size_usd=NULL'); else if (parsed.values.sizeMode === 'fixed') sets.push('size_pct=NULL');
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    sets.push('notice=NULL');
    await q('UPDATE users SET ' + sets.join(',') + ' WHERE id=$1', vals);
    await audit(u.username, 'limits_changed', u.username, req, JSON.stringify(body).slice(0, 200));
    res.json({ success: true });
  }));

  // The user's own recent signals in plain words: copied, skipped (and why), or failed. A skipped trade is never silent.
  const OUTCOME_TEXT = { OK: 'Copied', DRY: 'Practice only, nothing was sent' };
  app.get('/api/me/activity', userAuth, h(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const r = await q(`SELECT created_at, symbol, side, qty, code, ok, detail, risk_usd FROM order_log
        WHERE user_id=$1 AND kind='ORDER' AND code<>'PENDING' AND code NOT IN ('DUP','PAPER') ORDER BY id DESC LIMIT $2`, [req.user.id, limit]);
    const eq = Number(req.user.last_equity) || 0;
    const SKIP = new Set(['FILT', 'MAXT', 'HALT', 'MINQ', 'BAL', 'HELD', 'PAIR', 'NOPOS', 'SIDE']);
    res.json({ success: true, items: r.rows.map(x => {
      const outcome = x.code === 'OK' ? 'copied' : x.code === 'DRY' ? 'practice' : SKIP.has(x.code) ? 'skipped' : 'failed';
      const risk = x.risk_usd === null ? null : Number(x.risk_usd);
      return { at: x.created_at, symbol: x.symbol, side: x.side === 'Buy' ? 'LONG' : x.side === 'Sell' ? 'SHORT' : null, qty: x.qty === null ? null : Number(x.qty), outcome,
        text: outcome === 'copied' ? 'Copied' : outcome === 'practice' ? x.detail : (x.detail || CODE_TEXT[x.code] || 'Not copied'),
        riskUsd: risk, riskPct: risk !== null && eq > 0 ? Math.round(risk / eq * 1000) / 10 : null };
    }) });
  }));

  // the user has read the notice about the change to their trade size
  app.post('/api/me/notice/dismiss', userAuth, h(async (req, res) => { await q('UPDATE users SET notice=NULL WHERE id=$1', [req.user.id]); res.json({ success: true }); }));

  // telegram
  app.post('/api/me/telegram/link', userAuth, h(async (req, res) => {
    if (!tgOn) return res.status(400).json({ success: false, message: 'Telegram alerts are not set up on this server.' });
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await q(`UPDATE users SET tg_link_code=$2, tg_link_expires=now() + interval '15 minutes' WHERE id=$1`, [req.user.id, code]);
    res.json({ success: true, code, botUsername: tgBotUsername, minutes: 15 });
  }));
  app.post('/api/me/telegram/unlink', userAuth, h(async (req, res) => {
    await q('UPDATE users SET tg_chat_id=NULL, tg_link_code=NULL, tg_link_expires=NULL WHERE id=$1', [req.user.id]);
    res.json({ success: true });
  }));
  app.post('/api/me/telegram/notify', userAuth, h(async (req, res) => {
    await q('UPDATE users SET tg_notify=$2 WHERE id=$1', [req.user.id, !!(req.body && req.body.enabled)]);
    res.json({ success: true });
  }));
  app.post('/api/me/telegram/test', userAuth, h(async (req, res) => {
    if (!req.user.tg_chat_id) return res.status(400).json({ success: false, message: 'Connect Telegram first.' });
    const ok = await tgSend(req.user.tg_chat_id, '✅ Test alert from YM Oracle. Alerts are working.');
    res.json({ success: ok, message: ok ? undefined : 'Telegram did not accept the message.' });
  }));

  app.post('/api/me/key', userAuth, limited, h(async (req, res) => {
    const { apiKey, apiSecret } = req.body || {};
    if (!apiKey || !apiSecret) return res.status(400).json({ success: false, message: 'Key and secret are required.' });
    const prevEnv = normEnv(req.user.key_env);
    const env = req.body && req.body.env ? normEnv(req.body.env) : prevEnv;
    if (env === 'demo' && !DEMO_KEYS_ALLOWED) return res.status(400).json({ success: false, message: 'Demo keys are switched off on this server. Use a live key.' });
    const v = await validateKey(String(apiKey).trim(), String(apiSecret).trim(), env);
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    const switched = req.user.key_enc && env !== prevEnv;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (switched) {
        // The results of the environment being left are filed away, so demo money never shows up in live numbers (or the reverse).
        await client.query(`INSERT INTO pnl_ledger_old SELECT l.*, $2, now() FROM pnl_ledger l WHERE user_id=$1`, [req.user.id, prevEnv]);
        await client.query(`DELETE FROM pnl_ledger WHERE user_id=$1`, [req.user.id]);
        await client.query(`INSERT INTO funding_ledger_old SELECT f.*, $2, now() FROM funding_ledger f WHERE user_id=$1`, [req.user.id, prevEnv]);
        await client.query(`DELETE FROM funding_ledger WHERE user_id=$1`, [req.user.id]);
        await client.query(`DELETE FROM equity_snap WHERE user_id=$1`, [req.user.id]);
      }
      await client.query(`UPDATE users SET key_enc=$2, key_hash=$3, key_status='ok', key_error=NULL, ips_unrestricted=$4, last_equity=$5, key_env=$6${switched ? ", paused=TRUE, equity_peak=NULL, last_pnl_sync_ms=$7, last_funding_sync_ms=$7" : ''} WHERE id=$1`,
        [req.user.id, encrypt(JSON.stringify({ k: String(apiKey).trim(), s: String(apiSecret).trim() }), KEY), sha256(String(apiKey).trim()), v.ipsUnrestricted, v.equity, env].concat(switched ? [Date.now()] : []));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(400).json({ success: false, message: 'This API key is already registered.' });
      throw e;
    } finally { client.release(); }
    await audit(req.user.username, 'key_replaced', req.user.username, req, switched ? prevEnv + ' -> ' + env + ' (history filed away, trading paused)' : env);
    res.json({ success: true, warnings: v.warnings, env, switched: !!switched, pausedForSwitch: !!switched });
  }));

  // Wipes the stored key. The PnL history stays (that is the point of the ledger).
  app.post('/api/me/remove-key', userAuth, h(async (req, res) => {
    try { await syncUser(req.user); } catch { /* final sync is best-effort; the key may already be dead */ }
    await q(`UPDATE users SET key_enc=NULL, key_hash=NULL, key_status='removed', paused=TRUE WHERE id=$1`, [req.user.id]);
    await audit(req.user.username, 'key_removed', req.user.username, req, '');
    res.json({ success: true });
  }));

  // ---------- public monitoring link (read-only, opt-in, revocable) ----------
  app.post('/api/me/share', userAuth, h(async (req, res) => {
    const b = req.body || {};
    let token = req.user.share_token || null;
    if (b.enabled === false) token = null;
    else if (b.regenerate === true || (b.enabled === true && !token)) token = crypto.randomBytes(18).toString('base64url');
    const showBal = typeof b.showBalance === 'boolean' ? b.showBalance : !!req.user.share_show_balance;
    await q('UPDATE users SET share_token=$2, share_show_balance=$3 WHERE id=$1', [req.user.id, token, showBal]);
    await audit(req.user.username, 'share_link_changed', req.user.username, req, token ? (b.regenerate ? 'regenerated' : 'on') : 'off');
    res.json({ success: true, token, showBalance: showBal });
  }));

  const pubLimiter = sec.makeLimiter({ windowMs: 60000, max: 120 });
  const publicHeaders = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  app.get('/api/share/:token', h(async (req, res) => {
    res.set(publicHeaders);
    if (!pubLimiter.hit(req.ip || 'x')) return res.status(429).json({ success: false, message: 'Slow down.' });
    await ready;
    const t = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(t)) return res.status(404).json({ success: false, message: 'Link not found' });
    const ur = await q('SELECT id, username, paused, active, key_status, last_equity, last_synced_at, created_at, share_show_balance, key_env FROM users WHERE share_token=$1', [t]);
    const u = ur.rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'Link not found or switched off' });
    const rows = (await q('SELECT symbol, side, closed_pnl, closed_at FROM pnl_ledger WHERE user_id=$1 ORDER BY closed_at ASC LIMIT 1000', [u.id])).rows;
    const fund = (await q('SELECT amount, at FROM funding_ledger WHERE user_id=$1 ORDER BY at ASC LIMIT 1000', [u.id])).rows;
    const events = rows.map(r => ({ at: new Date(r.closed_at).getTime(), v: Number(r.closed_pnl) })).concat(fund.map(f => ({ at: new Date(f.at).getTime(), v: Number(f.amount) }))).sort((a, b) => a.at - b.at);
    let run = 0;
    const curve = events.map(e => { run += e.v; return Math.round(run * 100) / 100; });
    const fundingTotal = fund.reduce((a, f) => a + Number(f.amount), 0);
    const wins = rows.filter(r => Number(r.closed_pnl) > 0).length;
    res.json({
      success: true, username: u.username, env: normEnv(u.key_env),
      status: (u.active && !u.paused && u.key_status === 'ok') ? 'Active' : 'Not trading',
      since: u.created_at, lastSyncedAt: u.last_synced_at,
      pnl: Math.round(run * 100) / 100, funding: Math.round(fundingTotal * 100) / 100, trades: rows.length, wins, curve,
      balance: u.share_show_balance && u.last_equity !== null ? Number(u.last_equity) : null,
      recent: rows.slice(-40).reverse().map(r => ({ symbol: r.symbol, side: r.side, pnl: Number(r.closed_pnl), at: r.closed_at })),
    });
  }));

  // ---------- admin (session login + optional authenticator code; refuses to work without DASHBOARD_PASSWORD) ----------
  const adminLimiter = sec.makeLimiter({ windowMs: 15 * 60000, max: 8 });
  let adminLastCounter = 0;
  app.post('/api/admin/login', h(async (req, res) => {
    const pw = process.env.DASHBOARD_PASSWORD || '';
    if (!pw) return res.status(503).json({ success: false, message: 'Set DASHBOARD_PASSWORD on Render first. Admin is disabled without it.' });
    if (!adminLimiter.hit(req.ip || 'x')) { await audit('admin', 'admin_login_blocked', null, req, 'rate limited'); return res.status(429).json({ success: false, message: 'Too many attempts. Try again in 15 minutes.' }); }
    await ready;
    const { password, totp } = req.body || {};
    const adminTotp = process.env.ADMIN_TOTP_SECRET || '';
    if (!sec.safeEqual(String(password || ''), pw)) { await audit('admin', 'admin_login_failed', null, req, ''); return res.status(401).json({ success: false, message: 'Wrong password or code.' }); }
    if (adminTotp) {
      if (!totp) return res.status(200).json({ success: false, needTotp: true, message: 'Enter the 6-digit code from your authenticator app.' });
      const counter = sec.verifyTotp(adminTotp, totp, { minCounter: adminLastCounter });
      if (counter === null) { await audit('admin', 'admin_login_failed', null, req, 'bad code'); return res.status(401).json({ success: false, needTotp: true, message: 'Wrong password or code.' }); }
      adminLastCounter = counter;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1, now() + ($2 || ' hours')::interval)`, [sha256(token), String(ADMIN_SESSION_HOURS)]);
    adminLimiter.reset(req.ip || 'x');
    await audit('admin', 'admin_login', null, req, '');
    res.json({ success: true, token, hours: ADMIN_SESSION_HOURS });
  }));
  async function verifyAdminToken(token) {
    if (!process.env.DASHBOARD_PASSWORD || !token) return false;
    await ready;
    const r = await q('SELECT 1 FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(String(token))]);
    return !!r.rows[0];
  }
  const adminAuth = h(async (req, res, next) => {
    if (!process.env.DASHBOARD_PASSWORD) return res.status(503).json({ success: false, message: 'Admin is disabled until DASHBOARD_PASSWORD is set.' });
    await ready;
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!m) return res.status(401).json({ success: false, message: 'Not signed in' });
    const r = await q('SELECT 1 FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(m[1])]);
    if (!r.rows[0]) return res.status(401).json({ success: false, message: 'Session expired' });
    req.adminTokenHash = sha256(m[1]);
    next();
  });
  app.post('/api/admin/logout', adminAuth, h(async (req, res) => { await q('DELETE FROM admin_sessions WHERE token_hash=$1', [req.adminTokenHash]); res.json({ success: true }); }));

  app.get('/api/admin/users', adminAuth, h(async (req, res) => {
    const r = await q(`
      SELECT u.id, u.username, u.active, u.paused, u.key_status, u.key_error, u.size_mult, u.size_mult_max, u.daily_loss_limit_usd, u.ips_unrestricted,
             u.size_mode, u.size_usd, u.size_pct, u.max_open_trades, u.symbols_allow, u.direction, u.user_max_lev, u.max_trade_usd, u.max_lev_ceiling, u.control_mode, u.manual_ack_at, u.dry_run,
             u.created_at, u.last_equity, u.last_synced_at, u.totp_enabled, u.key_env, u.lane, (u.tg_chat_id IS NOT NULL) AS tg_linked,
             COALESCE((SELECT SUM(closed_pnl) FROM pnl_ledger WHERE user_id=u.id),0) AS pnl,
             (SELECT COUNT(*) FROM pnl_ledger WHERE user_id=u.id) AS trades,
             (SELECT COUNT(*) FROM pnl_ledger WHERE user_id=u.id AND closed_pnl>0) AS wins,
             COALESCE((SELECT SUM(amount) FROM funding_ledger WHERE user_id=u.id),0) AS funding,
             (SELECT equity FROM equity_snap s WHERE s.user_id=u.id ORDER BY day LIMIT 1) AS start_equity,
             (SELECT AVG(slippage_bps) FROM order_log WHERE user_id=u.id AND kind='ORDER' AND slippage_bps IS NOT NULL) AS slip
      FROM users u ORDER BY u.id`);
    const users = r.rows.map(x => {
      const eff = effective(x);
      const pnl = Number(x.pnl), funding = Number(x.funding);
      const start = x.start_equity === null ? null : Number(x.start_equity);
      const eq = x.last_equity === null ? null : Number(x.last_equity);
      return {
        id: x.id, username: x.username, active: x.active, paused: x.paused, keyStatus: x.key_status, keyError: x.key_error,
        sizeMult: Number(x.size_mult), sizeMultMax: Number(x.size_mult_max), dailyLossLimitUsd: x.daily_loss_limit_usd === null ? null : Number(x.daily_loss_limit_usd),
        dryRun: !!x.dry_run, controlMode: eff.control_mode, planMatch: null,
        sizeMode: eff.size_mode, sizeUsd: numOrNull(eff.size_usd), sizePct: numOrNull(eff.size_pct), maxOpenTrades: eff.max_open_trades,
        coins: eff.symbols_allow ? String(eff.symbols_allow).split(',').length : null, direction: eff.direction, userMaxLeverage: numOrNull(eff.user_max_lev),
        maxTradeUsd: numOrNull(x.max_trade_usd), maxLeverageCeiling: numOrNull(x.max_lev_ceiling),
        ipsUnrestricted: x.ips_unrestricted, createdAt: x.created_at, equity: eq, lastSyncedAt: x.last_synced_at,
        totpEnabled: x.totp_enabled, tgLinked: x.tg_linked, env: normEnv(x.key_env), lane: x.lane === 'scalp' ? 'scalp' : 'core',
        pnl, funding, net: pnl + funding, trades: Number(x.trades), wins: Number(x.wins), startEquity: start,
        // what the balance change can't be explained by trading = money moved in or out (an estimate; snapshots are daily)
        estNetDeposits: (start !== null && eq !== null) ? Math.round((eq - start - pnl - funding) * 100) / 100 : null,
        avgSlippageBps: x.slip === null ? null : Math.round(Number(x.slip) * 10) / 10,
      };
    });
    res.json({ success: true, users, pausedAll, dryAll, planVersion, plan: masterPlan, totalPnl: users.reduce((a, b) => a + b.pnl, 0), totalNet: users.reduce((a, b) => a + b.net, 0) });
  }));

  app.post('/api/admin/users/:id', adminAuth, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = [id];
    const add = (col, v) => { vals.push(v); sets.push(col + '=$' + vals.length); };
    if (typeof b.paused === 'boolean') { add('paused', b.paused); if (!b.paused) sets.push('equity_peak=NULL'); }
    if (typeof b.active === 'boolean') add('active', b.active);
    if (b.controlMode === 'auto') sets.push(`control_mode='auto'`);
    if (typeof b.dryRun === 'boolean') add('dry_run', b.dryRun);
    if (b.sizeMult !== undefined && Number(b.sizeMult) > 0 && Number(b.sizeMult) <= 20) { add('size_mult', Number(b.sizeMult)); add('size_mult_max', Number(b.sizeMult)); }
    if (b.dailyLossLimitUsd !== undefined) add('daily_loss_limit_usd', b.dailyLossLimitUsd === null || b.dailyLossLimitUsd === '' ? null : Math.max(0, Number(b.dailyLossLimitUsd)));
    if (b.maxTradeUsd !== undefined) {
      const v = posOrNull(b.maxTradeUsd, 1e7); if (Number.isNaN(v)) return res.status(400).json({ success: false, message: 'Max trade amount must be a positive number, or empty for no limit.' });
      add('max_trade_usd', v);
      // pull the user's own amount down under the new ceiling (a CASE, not LEAST(): LEAST ignores NULL and would invent a value)
      if (v !== null) sets.push(`size_usd=CASE WHEN size_usd > $${vals.length} THEN $${vals.length} ELSE size_usd END`);
    }
    if (b.maxLeverage !== undefined) {
      const v = posOrNull(b.maxLeverage, 125); if (Number.isNaN(v)) return res.status(400).json({ success: false, message: 'Max leverage must be between 1 and 125, or empty for no limit.' });
      add('max_lev_ceiling', v);
      if (v !== null) sets.push(`user_max_lev=CASE WHEN user_max_lev > $${vals.length} THEN $${vals.length} ELSE user_max_lev END`);
    }
    if (b.clearKeyError === true) { sets.push(`key_status=CASE WHEN key_enc IS NULL THEN key_status ELSE 'ok' END`); sets.push('key_error=NULL'); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to change' });
    await q(`UPDATE users SET ${sets.join(',')} WHERE id=$1`, vals);
    await audit('admin', 'user_updated', String(id), req, JSON.stringify(b).slice(0, 150));
    res.json({ success: true });
  }));

  // ----- the Master Plan: one set of settings for every autopilot account -----
  app.get('/api/admin/plan', adminAuth, h(async (req, res) => {
    const c = await q(`SELECT COUNT(*) AS total FROM users WHERE key_enc IS NOT NULL AND active`);
    const total = Number(c.rows[0].total);
    res.json({ success: true, plan: masterPlan, defaults: PLAN_DEFAULT, standard: { ...STD }, manualUsers: total, autoUsers: 0, accounts: total, masterFollowsPlan: masterFollows() });
  }));

  // Switches the live plan, records a new history row, restarts the drawdown measurement if that rule changed.
  async function applyPlan(newPlan, req, restoredFrom) {
    const before = masterPlan;
    masterPlan = newPlan;
    await q(`INSERT INTO meta(k,v) VALUES('master_plan',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(masterPlan)]);
    if (masterPlan.drawdownStopPct !== before.drawdownStopPct) await q('UPDATE users SET equity_peak=NULL'); // a changed drawdown rule restarts everyone's "highest balance" measurement
    const diff = planDiff(before, masterPlan);
    const summary = (restoredFrom ? 'Restored version ' + restoredFrom + (diff.length ? ': ' : '') : '') + diff.map(d => d.text).join('; ');
    planVersion = await saveVersion('admin', summary || 'Saved (no changes)', restoredFrom);
    await audit('admin', restoredFrom ? 'plan_restored' : 'plan_changed', 'all', req, ('v' + planVersion + ' ' + summary).slice(0, 300));
    return { diff, version: planVersion };
  }
  const mergePlan = body => { const b = { ...(body || {}) }; delete b.sizeMult; delete b.maxLeverage; return parseControls(b, { current: masterPlan, allowed: CONTROL_KEYS.concat(['allowManual']), openMax: STD.adminMaxOpen }); };

  app.post('/api/admin/plan', adminAuth, h(async (req, res) => {
    const parsed = mergePlan(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    if (!Object.keys(parsed.values).length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    const r = await applyPlan({ ...masterPlan, ...parsed.values }, req, null);
    res.json({ success: true, plan: masterPlan, version: r.version, changes: r.diff.map(d => d.text) });
  }));

  // "What would this change?" without saving: the differences, how many accounts follow the plan, and (for amount changes) a sample trade for each
  app.post('/api/admin/plan/preview', adminAuth, h(async (req, res) => {
    const parsed = mergePlan(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const next = { ...masterPlan, ...parsed.values };
    const diff = planDiff(masterPlan, next);
    const c = await q(`SELECT COUNT(*) AS total FROM users WHERE key_enc IS NOT NULL AND active`);
    const total = Number(c.rows[0].total);
    res.json({ success: true, changes: diff, unchanged: !diff.length, autopilotAccounts: 0, manualAccounts: total, accounts: total, forcedToAutopilot: 0 });
  }));

  app.get('/api/admin/plan/history', adminAuth, h(async (req, res) => {
    const r = await q('SELECT id, plan, changed_by, summary, restored_from, created_at FROM plan_versions ORDER BY id DESC LIMIT $1', [Math.min(100, parseInt(req.query.limit, 10) || 30)]);
    const rows = r.rows.map(x => { let plan = null; try { plan = JSON.parse(x.plan); } catch { /* corrupt row: shown without values */ } return { id: x.id, plan, changedBy: x.changed_by, summary: x.summary, restoredFrom: x.restored_from, at: x.created_at, live: x.id === planVersion }; });
    res.json({ success: true, live: planVersion, versions: rows });
  }));

  app.post('/api/admin/plan/restore', adminAuth, h(async (req, res) => {
    const id = parseInt((req.body || {}).id, 10);
    const r = Number.isInteger(id) ? await q('SELECT plan FROM plan_versions WHERE id=$1', [id]) : { rows: [] };
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'No such plan version.' });
    let stored;
    try { stored = JSON.parse(r.rows[0].plan); } catch { return res.status(400).json({ success: false, message: 'That version is damaged and cannot be restored.' }); }
    const ok = parseControls(normalizeStoredPlan(stored), { current: PLAN_DEFAULT, allowed: CONTROL_KEYS.concat(['allowManual']) });
    if (ok.error) return res.status(400).json({ success: false, message: 'That version is not valid any more: ' + ok.error });
    const next = { ...PLAN_DEFAULT, ...ok.values };
    if (!planDiff(masterPlan, next).length) return res.status(400).json({ success: false, message: 'That is already the live plan.' });
    const out = await applyPlan(next, req, id);
    res.json({ success: true, plan: masterPlan, version: out.version, changes: out.diff.map(d => d.text) });
  }));

  // ----- dry run: every signal is worked out for every user (filters, limits, sizing) but nothing is sent to Bybit -----
  app.post('/api/admin/dry-run', adminAuth, h(async (req, res) => {
    if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ success: false, message: 'Send enabled:true or enabled:false.' });
    dryAll = req.body.enabled;
    await q(`INSERT INTO meta(k,v) VALUES('dry_run_all',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [dryAll ? '1' : '0']);
    await audit('admin', dryAll ? 'dry_run_on' : 'dry_run_off', 'all', req, '');
    res.json({ success: true, dryAll });
  }));

  // ----- everyone at once -----
  app.post('/api/admin/pause-all', adminAuth, h(async (req, res) => {
    pausedAll = !!(req.body && req.body.paused);
    await q(`INSERT INTO meta(k,v) VALUES('users_paused_all',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [pausedAll ? '1' : '0']);
    await audit('admin', pausedAll ? 'pause_all_users' : 'resume_all_users', 'all', req, '');
    res.json({ success: true, pausedAll });
  }));

  app.post('/api/admin/close-all', adminAuth, h(async (req, res) => {
    if (!(req.body && req.body.confirm === 'CLOSE')) return res.status(400).json({ success: false, message: 'Send confirm:"CLOSE" to close every user\'s open trades.' });
    const users = (await q(`SELECT * FROM users WHERE key_enc IS NOT NULL AND active ORDER BY id`)).rows;
    let closed = 0, failed = 0;
    await runLimited(users, 5, u => enqueue(u.id, async () => {
      const r = await closeAllForUser(u, 'admin closed all trades');
      closed += r.closed; failed += r.failed;
      if (r.closed) notify(u, '🛑 The admin closed all open trades on your account (' + r.closed + ').');
    }));
    await audit('admin', 'close_all_users', 'all', req, 'closed ' + closed + ', failed ' + failed + ', users ' + users.length);
    res.json({ success: true, users: users.length, closed, failed });
  }));

  // ---------- CLOSE TRADES (admin) ----------
  // One trade, a whole pair, one bot's trades, all winners, all losers, all longs, all shorts, or everything: on the MASTER account and on every copy account.
  // (The older /api/admin/close-all above only reaches the copy accounts. This one is what the Live trades page uses.)
  // It sends reduce-only market closes, so it can never open a position. It does not touch the guards' settings; a closed trade just disappears from their watch.
  const CLOSE_SCOPES = ['all', 'trade', 'pair', 'bot', 'winners', 'losers', 'longs', 'shorts'];
  const botKey = v => String(v || '').trim().toUpperCase().replace(/^YM\s+/, '').replace(/^ORACLE\s+/, '');
  const normSide = v => { const t = String(v || '').trim().toLowerCase(); return t === 'buy' || t === 'long' ? 'Buy' : t === 'sell' || t === 'short' ? 'Sell' : ''; };
  async function closeSomeForUser(u, want, why) {
    const out = { closed: 0, failed: 0, error: null, pairs: [] };
    try {
      const client = userClient(u);
      const positions = (await listOpenPositions(client)).filter(want);
      for (const p of positions) {
        const side = p.side === 'Buy' ? 'Sell' : 'Buy';
        try { await client.cancelAllOrders({ category: 'linear', symbol: p.symbol }); } catch { /* best effort */ }
        try {
          const res = await client.submitOrder({ category: 'linear', symbol: p.symbol, side, orderType: 'Market', qty: String(p.size), reduceOnly: true, positionIdx: Number(p.positionIdx) || 0 });
          if (res.retCode === 0) { out.closed++; out.pairs.push(p.symbol.replace(/USDT$/, '')); await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, qty: Number(p.size), code: 'OK', ok: true, detail: 'Closed: ' + why }); }
          else { out.failed++; await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, code: classifyRet(res.retCode), ok: false, detail: res.retMsg }); }
        } catch (e) { out.failed++; await logOrder({ userId: u.id, kind: 'CLOSE', symbol: p.symbol, side, code: failFrom(e).code, ok: false, detail: e.message }); }
      }
    } catch (e) { out.error = e.message; out.failed++; if (failFrom(e).auth) await markKeyError(u, e.message); }
    return out;
  }
  async function closeTrades(b, req) {
    const scope = String(b.scope || ''), symbol = String(b.symbol || '').trim().toUpperCase(), side = normSide(b.side), bot = String(b.bot || '').trim();
    const bad = m => ({ status: 400, body: { success: false, message: m } });
    if (!CLOSE_SCOPES.includes(scope)) return bad('scope must be one of: ' + CLOSE_SCOPES.join(', '));
    if ((scope === 'trade' || scope === 'pair') && !/^[A-Z0-9]{3,20}$/.test(symbol)) return bad('a valid symbol is needed');
    if (scope === 'trade' && !side) return bad('a side (long or short) is needed to close one trade');
    if (scope === 'bot' && !botKey(bot)) return bad('a bot name is needed');
    const out = { scope, symbol: symbol || null, side: side || null, bot: bot || null, matched: [], master: { closed: 0, failed: 0, errors: [] }, users: { accounts: 0, closed: 0, failed: 0 }, note: '' };
    const live = getMode() === 'live';
    let mpos = [];
    if (live) { await ready; mpos = (await listOpenPositions(restClient)).filter(p => p.side === 'Buy' || p.side === 'Sell'); }
    else out.note = 'Paper mode: nothing is open on Bybit, so only copy accounts were looked at.';
    const sel = [];
    for (const p of mpos) {
      const pnl = parseFloat(p.unrealisedPnl) || 0;
      let hit = false;
      if (scope === 'all') hit = true;
      else if (scope === 'trade') hit = p.symbol === symbol && p.side === side;
      else if (scope === 'pair') hit = p.symbol === symbol;
      else if (scope === 'winners') hit = pnl > 0;
      else if (scope === 'losers') hit = pnl < 0;
      else if (scope === 'longs') hit = p.side === 'Buy';
      else if (scope === 'shorts') hit = p.side === 'Sell';
      else if (scope === 'bot') { const lk = await pgLookup(p.symbol, p.side).catch(() => ({})); hit = botKey(lk && lk.bot) === botKey(bot); }
      if (hit) sel.push(p);
    }
    const stamp = Date.now().toString(36);
    let n = 0;
    for (const p of sel) {
      const closeSide = p.side === 'Buy' ? 'Sell' : 'Buy', coin = p.symbol.replace(/USDT$/, '');
      out.matched.push({ symbol: p.symbol, side: p.side, upl: parseFloat(p.unrealisedPnl) || 0 });
      try { await restClient.cancelAllOrders({ category: 'linear', symbol: p.symbol }); } catch { /* best effort */ }
      let ok = false, detail = '';
      try {
        const res = await restClient.submitOrder({ category: 'linear', symbol: p.symbol, side: closeSide, orderType: 'Market', qty: String(p.size), reduceOnly: true, positionIdx: Number(p.positionIdx) || 0, orderLinkId: 'adm' + stamp + (n++) });
        ok = res.retCode === 0; detail = ok ? 'Closed by the admin (' + scope + ')' : (res.retMsg || ('Bybit code ' + res.retCode));
      } catch (e) { detail = e.message || String(e); }
      if (ok) out.master.closed++; else { out.master.failed++; out.master.errors.push(coin + ': ' + detail); }
      await recordExec({ id: 'adm' + stamp + '-' + n, bot: 'ADMIN', kind: 'CLOSE', symbol: p.symbol, side: p.side === 'Buy' ? 'BUY' : 'SELL', ok, code: ok ? 'OK' : 'BYBIT', detail }).catch(() => {});
    }
    // the copy accounts: the same trades. "all", "longs", "shorts" and a named pair or trade look at each account's own positions; winners / losers / one bot follow what the master selected
    const keys = new Set(sel.map(p => p.symbol + '|' + p.side));
    const want = scope === 'trade' ? (p => p.symbol === symbol && p.side === side) : scope === 'pair' ? (p => p.symbol === symbol)
      : scope === 'longs' ? (p => p.side === 'Buy') : scope === 'shorts' ? (p => p.side === 'Sell') : (p => keys.has(p.symbol + '|' + p.side));
    if (scope === 'all' || scope === 'trade' || scope === 'pair' || scope === 'longs' || scope === 'shorts' || keys.size) {
      const users = (await q(`SELECT * FROM users WHERE key_enc IS NOT NULL AND active ORDER BY id`)).rows;
      out.users.accounts = users.length;
      await runLimited(users, 5, u => enqueue(u.id, async () => {
        const r = scope === 'all' ? await closeAllForUser(u, 'admin closed all trades') : await closeSomeForUser(u, want, 'admin closed ' + (scope === 'pair' || scope === 'trade' ? symbol : scope));
        out.users.closed += r.closed; out.users.failed += r.failed;
        if (r.closed) notify(u, '🛑 The admin closed ' + (scope === 'all' ? 'all open trades' : r.closed === 1 ? 'a trade' : r.closed + ' trades') + ' on your account' + (scope === 'all' ? ' (' + r.closed + ').' : (r.pairs && r.pairs.length ? ': ' + r.pairs.slice(0, 6).join(', ') + '.' : '.')));
      }));
    }
    liveCache = { at: 0, v: null };
    await audit('admin', 'close_trades', scope + (symbol ? ':' + symbol : '') + (side ? ':' + side : '') + (bot ? ':' + bot : ''), req, 'master closed ' + out.master.closed + ', failed ' + out.master.failed + '; copy accounts closed ' + out.users.closed + ', failed ' + out.users.failed + ' (' + out.users.accounts + ' accounts)');
    if (out.master.closed || out.users.closed) deliverAlert('🛑 Admin closed ' + (scope === 'all' ? 'everything' : scope === 'trade' || scope === 'pair' ? symbol.replace(/USDT$/, '') : scope === 'bot' ? bot : scope) + ': master ' + out.master.closed + ', copy accounts ' + out.users.closed + (out.master.failed + out.users.failed ? ', failed ' + (out.master.failed + out.users.failed) : '') + '.', { cat: 'updates' }).catch(() => {});
    return { status: 200, body: { success: true, ...out } };
  }
  app.post('/api/admin/close-trades', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.confirm !== 'CLOSE') return res.status(400).json({ success: false, message: 'Send confirm:"CLOSE" to close trades.' });
    const r = await closeTrades(b, req);
    res.status(r.status).json(r.body);
  }));

  app.post('/api/admin/users/:id/reset-password', adminAuth, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const temp = crypto.randomBytes(9).toString('base64url'); // shown once; the user must change it at next login
    const r = await q('UPDATE users SET pass_hash=$2, must_change_password=TRUE, failed_logins=0, locked_until=NULL WHERE id=$1 RETURNING username', [id, await hashPassword(temp)]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'No such user' });
    await q('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit('admin', 'password_reset', r.rows[0].username, req, '');
    res.json({ success: true, username: r.rows[0].username, tempPassword: temp });
  }));
  app.post('/api/admin/users/:id/disable-2fa', adminAuth, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await q('UPDATE users SET totp_enabled=FALSE, totp_secret_enc=NULL, totp_last_counter=NULL WHERE id=$1 RETURNING username', [id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'No such user' });
    await q('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit('admin', '2fa_disabled_by_admin', r.rows[0].username, req, '');
    res.json({ success: true });
  }));

  app.get('/api/admin/users/:id/ledger', adminAuth, h(async (req, res) => {
    const r = await q(`SELECT symbol, side, qty, entry_price, exit_price, closed_pnl, open_fee, close_fee, closed_at FROM pnl_ledger WHERE user_id=$1 ORDER BY closed_at DESC LIMIT $2`, [parseInt(req.params.id, 10), Math.min(500, parseInt(req.query.limit, 10) || 100)]);
    res.json({ success: true, rows: r.rows });
  }));
  app.get('/api/admin/orders', adminAuth, h(async (req, res) => {
    const where = [], vals = [];
    const qs = req.query || {};
    if (qs.user) { vals.push(String(qs.user)); where.push('u.username=$' + vals.length); }
    if (qs.code) { vals.push(String(qs.code).toUpperCase().slice(0, 8)); where.push('o.code=$' + vals.length); }
    if (qs.failed === '1') where.push(`o.ok=false AND o.code<>'PENDING'`);
    if (qs.dry === '1') where.push(`o.code='DRY'`);
    vals.push(Math.min(200, parseInt(qs.limit, 10) || 60));
    const r = await q(`SELECT o.id, u.username, o.kind, o.symbol, o.side, o.qty, o.code, o.ok, o.detail, o.slippage_bps, o.plan_version, o.created_at
      FROM order_log o JOIN users u ON u.id=o.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT $${vals.length}`, vals);
    res.json({ success: true, rows: r.rows });
  }));

  // What a dry run (or the last day of live trading) did, per user: how many would trade, how many were skipped and why
  app.get('/api/admin/orders/summary', adminAuth, h(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const r = await q(`SELECT u.username, o.code, COUNT(*) AS n FROM order_log o JOIN users u ON u.id=o.user_id
      WHERE o.kind='ORDER' AND o.created_at > now() - ($1 || ' hours')::interval AND o.code<>'PENDING' GROUP BY u.username, o.code ORDER BY u.username, o.code`, [String(hours)]);
    const by = {};
    for (const x of r.rows) (by[x.username] = by[x.username] || {})[x.code] = Number(x.n);
    res.json({ success: true, hours, users: Object.entries(by).map(([username, codes]) => ({ username, codes })) });
  }));

  // ----- new: console cards (bots, signal feed, result curve) and per-user close-all -----
  app.get('/api/admin/series', adminAuth, h(async (req, res) => { res.json({ success: true, points: await resultSeries(null, seriesDays(req)) }); }));

  app.get('/api/admin/bots', adminAuth, h(async (req, res) => {
    const f = getFleet(), now = Date.now();
    const bots = Object.keys(f.last || {}).sort().map(name => {
      const info = (f.info || {})[name] || {};
      return { name, lastSeenAt: f.last[name], online: f.offlineMs ? (now - f.last[name]) < f.offlineMs : true,
        uptimeMin: info.uptimeMin === undefined ? null : info.uptimeMin, resetReason: info.resetReason || null,
        freeHeap: info.freeHeap === undefined ? null : info.freeHeap, build: info.build || null,
        relayOn: info.relayOn === undefined ? null : info.relayOn, relayMarginUsd: info.relayMarginUsd === undefined ? null : info.relayMarginUsd };
    });
    res.json({ success: true, bots });
  }));

  // What happened on the MASTER account (the one the bots trade directly) and whether the relay's records match Bybit.
  const MASTER_TEXT = {
    OK: 'Placed', DUP: 'Already placed', NOCHG: 'Already at that value', PAPER: 'Paper mode', NOPOS: 'Nothing open to change',
    BAL: 'Not enough free balance', MINQ: "Below Bybit's minimum size", PAIR: 'Pair not on Bybit', LEV: 'Bybit rejected the leverage',
    NET: "Couldn't reach Bybit", BYBIT: 'Bybit refused it', BAD: 'Command malformed', PRICE: 'Price did not match',
    HELD: 'Already holding this pair', HALT: 'Trading is halted', SIDE: 'Position is on the other side',
    NOTRL: 'Opened, trailing stop not set', SCALED: 'Opened smaller than asked', LEVCLMP: 'Opened at lower leverage',
  };
  const M_QUIET = new Set(['OK', 'DUP', 'NOCHG', 'PAPER', 'NOPOS']);
  const M_WARN = new Set(['NOTRL', 'SCALED', 'LEVCLMP', 'HELD', 'HALT', 'SIDE']);
  const mSev = r => (M_QUIET.has(r.code) ? 'quiet' : M_WARN.has(r.code) ? 'warn' : (r.ok ? 'quiet' : 'fail'));
  async function masterReports(hours, limit) {
    let rows = [];
    try {
      rows = (await q(`SELECT exec_id, bot, kind, symbol, side, ok, code, detail, created_at FROM master_log
        WHERE created_at > now() - ($1 || ' hours')::interval ORDER BY created_at DESC LIMIT $2`, [String(hours), limit])).rows
        .map(x => ({ id: x.exec_id, bot: x.bot, kind: x.kind, symbol: x.symbol, side: x.side, ok: x.ok, code: x.code, detail: x.detail, at: new Date(x.created_at).getTime() }));
    } catch (e) { console.error('[multiuser] master_log read:', e.message); }
    if (!rows.length) { const cut = Date.now() - hours * 3600000; rows = (getExecReports() || []).filter(r => r.at >= cut).slice(0, limit); } // nothing in the database yet: fall back to what the relay remembers
    return rows.map(r => ({ ...r, sev: mSev(r), text: MASTER_TEXT[r.code] || r.code || 'Unknown' }));
  }
  app.get('/api/admin/master', adminAuth, h(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const reports = await masterReports(hours, 40);
    const sy = getMasterSync() || {};
    const counts = { ok: 0, warn: 0, fail: 0 };
    reports.filter(r => r.kind === 'TRADE').forEach(r => { counts[r.sev === 'fail' ? 'fail' : r.sev === 'warn' ? 'warn' : 'ok']++; });
    res.json({ success: true, counts, reports: reports.slice(0, 12),
      sync: { mode: sy.mode || null, lastOkAt: sy.lastOkAt || null, lastRunAt: sy.lastRunAt || null, masterOpen: sy.masterOpen === undefined ? null : sy.masterOpen, loggedOpen: sy.loggedOpen === undefined ? null : sy.loggedOpen,
        recoveredTotal: sy.recoveredTotal || 0, lastRecovered: sy.lastRecovered || null, staleOpen: sy.staleOpen || 0, lastError: sy.lastError || null } });
  }));

  // one row per bot signal: when it arrived and what happened across all accounts (signals fan out within seconds, so a 2 minute bucket groups them)
  app.get('/api/admin/signals', adminAuth, h(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const SK = `('FILT','MAXT','HALT','MINQ','BAL','HELD')`;
    const r = await q(`SELECT o.symbol, o.side, MIN(o.created_at) AS at,
        COUNT(*) FILTER (WHERE o.code='OK') AS placed,
        COUNT(*) FILTER (WHERE o.code='DRY') AS dry,
        COUNT(*) FILTER (WHERE o.code IN ${SK}) AS skipped,
        COUNT(*) FILTER (WHERE o.ok=false AND o.code NOT IN ${SK} AND o.code<>'PENDING') AS failed,
        COUNT(*) FILTER (WHERE o.code<>'PENDING') AS total
      FROM order_log o WHERE o.kind='ORDER' AND o.created_at > now() - ($1 || ' hours')::interval
      GROUP BY o.symbol, o.side, floor(extract(epoch from o.created_at) / 120)
      ORDER BY MIN(o.created_at) DESC LIMIT $2`, [String(hours), limit]);
    res.json({ success: true, signals: r.rows.map(x => ({ symbol: x.symbol, side: x.side === 'Buy' ? 'LONG' : 'SHORT', at: x.at,
      placed: Number(x.placed), dry: Number(x.dry), skipped: Number(x.skipped), failed: Number(x.failed), total: Number(x.total) })) });
  }));

  app.get('/api/admin/alerts', adminAuth, h(async (req, res) => {
    const r = await q(`SELECT k, bot, kind, sym, priv, text, created_at, sent_at, tries, last_result FROM bot_msgs ORDER BY created_at DESC LIMIT 15`);
    const un = await q(`SELECT COUNT(*)::int AS n FROM bot_msgs WHERE sent_at IS NULL AND created_at > now() - interval '2 hours'`);
    res.json({ success: true, undelivered: un.rows[0].n, alerts: r.rows.map(x => ({ key: x.k, bot: x.bot, kind: x.kind, sym: x.sym, text: stripTags(x.text).split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 160), at: x.created_at, sent: !!x.sent_at, tries: x.tries, result: x.last_result })) });
  }));
  app.post('/api/admin/test-alert', adminAuth, h(async (req, res) => {
    const to = (req.body && (req.body.target === 'group' || req.body.target === 'dm')) ? req.body.target : null;
    const label = to === 'group' ? 'the GROUP' : to === 'dm' ? 'your DM' : 'the chat(s) your alert settings choose';
    const r = await deliverAlert('✅ Test alert from the YM Oracle admin page, sent to ' + label + '. If you can read this, alerts from Render reach it.', to ? { force: to } : { cat: 'tests' });
    res.json({ success: !!r.ok, configured: r.configured !== false, telegram: r.telegram || null, email: r.email || null, muted: !!r.muted, reason: r.reason || null, tradeAlerts: tradeAlertsOn() });
  }));

  // Telegram routing: who gets what (group / DM / both / off), the Dev and Off modes, and an optional timer. Saved in the database, effective at once.
  const routeView = () => {
    const R = alertRouter.route, env = alertRouter.envChats(), cfg = alertRouter.state.cfg, now = Date.now();
    return { ...R.describe(cfg, now), tokenSet: alertRouter.tokenSet(), groupSet: !!(cfg.groupChat || env.groupChat), dmSet: !!(cfg.dmChat || env.dmChat),
      groupFromEnv: !cfg.groupChat && !!env.groupChat, dmFromEnv: !cfg.dmChat && !!env.dmChat, tradeAlerts: tradeAlertsOn(), now,
      cats: R.CAT_IDS.map(id => ({ id, label: R.CATS[id].label, hint: R.CATS[id].hint, def: R.CATS[id].def })) };
  };
  app.get('/api/admin/alert-routes', adminAuth, h(async (req, res) => {
    if (!alertRouter) return res.status(503).json({ success: false, message: 'not available' });
    res.json({ success: true, ...routeView() });
  }));
  app.post('/api/admin/alert-routes', adminAuth, h(async (req, res) => {
    if (!alertRouter) return res.status(503).json({ success: false, message: 'not available' });
    const R = alertRouter.route, b = req.body || {};
    if (b.mode !== undefined && !R.MODES.includes(b.mode)) return res.status(400).json({ success: false, message: 'mode must be live, dev or off' });
    if (b.routes && typeof b.routes === 'object') for (const [k, v] of Object.entries(b.routes)) if (!R.CAT_IDS.includes(k) || !R.DESTS.includes(v)) return res.status(400).json({ success: false, message: 'bad route for ' + k });
    for (const k of ['groupChat', 'dmChat']) if (b[k] !== undefined && String(b[k]).trim() !== '' && R.normalize({ [k]: b[k] })[k] === '') return res.status(400).json({ success: false, message: 'that chat id does not look right (use the number, e.g. -1001234567890, or @channelname)' });
    const next = R.fromRequest(b, Date.now(), alertRouter.state.cfg);
    // never let a setting silently swallow everything: dev mode and "DM" routes need a DM chat to land in
    const env = alertRouter.envChats();
    const dmKnown = !!(next.dmChat || env.dmChat);
    if (next.mode === 'dev' && !dmKnown) return res.status(400).json({ success: false, message: 'Dev mode sends everything to your DM, but no DM chat is set yet. Add your DM chat id first (ALERT_TELEGRAM_PRIVATE_CHAT_ID on Render, or the field on this panel).' });
    await q(`INSERT INTO meta(k,v) VALUES('alert_routes',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    alertRouter.state.cfg = next;
    await audit('admin', 'alert_routes_changed', null, req, (next.mode === 'live' ? 'live' : next.mode + (next.until ? ' until ' + new Date(next.until).toISOString() : ' until changed')) + ' ' + JSON.stringify(next.routes));
    res.json({ success: true, ...routeView() });
  }));

  // Profit Guard: settings, what it is watching, and its log. Going live needs an explicit confirm.
  app.get('/api/admin/profit-guard', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await pgView()) }); }));
  app.post('/api/admin/profit-guard', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.mode !== undefined && !PG.MODES.includes(b.mode)) return res.status(400).json({ success: false, message: 'mode must be off, shadow or live' });
    if (b.mode === 'live' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'Going live moves real stops on Bybit. Confirm it on the panel.' });
    if (b.applyTuning !== undefined) {                 // apply the current suggestion for one profile (the server recomputes it: nothing is taken from the page)
      const pr = b.applyTuning; if (pr !== 'fast' && pr !== 'swing') return res.status(400).json({ success: false, message: 'applyTuning must be fast or swing' });
      if (PG.effMode(pgCfg, pr) === 'live' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'This changes the live stop rules. Confirm it on the panel.' });
      const sug = await pgTuneEval(pr);
      if (!sug.ready || sug.action === 'hold' || !sug.next) return res.status(400).json({ success: false, message: 'There is nothing to apply: ' + sug.reasons.join(' ') });
      await pgApplyTuning(pr, sug, 'admin');
      return res.json({ success: true, ...(await pgView()) });
    }
    const sm = b.smart && typeof b.smart === 'object' ? { noise: { ...pgCfg.smart.noise, ...(b.smart.noise || {}) }, stall: { ...pgCfg.smart.stall, ...(b.smart.stall || {}) }, adapt: { ...pgCfg.smart.adapt, ...(b.smart.adapt || {}), mkt: { ...pgCfg.smart.adapt.mkt, ...((b.smart.adapt || {}).mkt || {}) } }, curve: { ...pgCfg.smart.curve, ...(b.smart.curve || {}) }, slice: { ...pgCfg.smart.slice, ...(b.smart.slice || {}) }, rev: { ...pgCfg.smart.rev, ...(b.smart.rev || {}) }, tune: { ...pgCfg.smart.tune, ...(b.smart.tune || {}), lastAtN: pgCfg.smart.tune.lastAtN } } : pgCfg.smart;
    const next = PG.normalize({ ...pgCfg, ...b, smart: sm, reentry: b.reentry ? { ...pgCfg.reentry, ...b.reentry } : pgCfg.reentry, fast: b.fast ? { ...pgCfg.fast, ...b.fast } : pgCfg.fast, swing: b.swing ? { ...pgCfg.swing, ...b.swing } : pgCfg.swing });
    if (((next.reentry.live && !pgCfg.reentry.live) || (next.reentry.liveShake && !pgCfg.reentry.liveShake)) && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'Live re-entry opens real trades on the master account. Confirm it on the panel.' });
    if (next.smart.tune.mode === 'auto' && pgCfg.smart.tune.mode !== 'auto' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'Auto-tuning changes the live stop rules by itself. Confirm it on the panel.' });
    for (const pr of ['fast', 'swing']) {      // anything that starts acting on real money needs the explicit confirm
      const goesLive = PG.effMode(next, pr) === 'live' && PG.effMode(pgCfg, pr) !== 'live';
      const scaleLive = PG.effMode(next, pr) === 'live' && ((next[pr].scale.on && !(PG.effMode(pgCfg, pr) === 'live' && pgCfg[pr].scale.on)) || (next.smart.slice.on && !(PG.effMode(pgCfg, pr) === 'live' && pgCfg.smart.slice.on)) || (next.smart.rev.on && !(PG.effMode(pgCfg, pr) === 'live' && pgCfg.smart.rev.on)));
      if ((goesLive || scaleLive) && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'This moves real stops or closes real positions on Bybit. Confirm it on the panel.' });
    }
    await q(`INSERT INTO meta(k,v) VALUES('profit_guard',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    const was = pgCfg.mode; pgCfg = next;
    await audit('admin', 'profit_guard_changed', null, req, was + ' -> ' + next.mode + ' ' + JSON.stringify({ fast: next.fast, swing: next.swing, minGapPct: next.minGapPct, smart: next.smart }));
    res.json({ success: true, ...(await pgView()) });
  }));

  // Trade Sentinel: settings, what it is watching, its log and scorecard, the self-backfill from history, and the weight suggestion.

  // ---- LIVE TRADES (final-18): every open position with a plain quality reading, for the admin "Live" tab. Read-only: it never touches an order or a stop. ----
  let liveCache = { at: 0, v: null };
  async function liveView() {
    if (liveCache.v && Date.now() - liveCache.at < 4000) return liveCache.v;
    await ready;
    const mode = getMode();
    const out = { mode, at: Date.now(), trades: [], note: '', master: guardsMaster };
    if (mode !== 'live') { out.note = 'Paper mode: nothing is open on Bybit.'; liveCache = { at: Date.now(), v: out }; return out; }
    let positions;
    try { positions = await listOpenPositions(restClient); } catch (e) { out.note = 'Could not read positions from Bybit: ' + (e.message || e); return out; }
    let btcRaw = 0; try { btcRaw = await snBtcMove(); } catch { /* the market part is then left out */ }
    for (const p of positions) {
      if (p.side !== 'Buy' && p.side !== 'Sell') continue;
      const symbol = p.symbol, side = p.side, key = symbol + '|' + side, long = side === 'Buy';
      const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice);
      if (!(entry > 0) || !(mark > 0)) continue;
      let sig = null;
      try { sig = (await q(`SELECT bot, eng, sl, tp, opened_at FROM signals WHERE symbol=$1 AND side=$2 AND opened_at > now() - interval '30 days' ORDER BY opened_at DESC LIMIT 1`, [symbol, long ? 'BUY' : 'SELL'])).rows[0] || null; } catch { sig = null; }
      const created = Number(p.createdTime) > 0 ? Number(p.createdTime) : (sig ? new Date(sig.opened_at).getTime() : Date.now());
      let bars = null; try { bars = await snBars(symbol); } catch { bars = null; }
      const gst = pgState.get(key), sst = snState.get(key);
      let peak = (gst && gst.peak > 0) ? gst.peak : (sst && sst.peak > 0) ? sst.peak : entry;
      if (bars) for (const b of bars) { if (b.t < created - 60000) continue; const ex = long ? b.h : b.l; if (long ? ex > peak : ex < peak) peak = ex; }
      if (long ? mark > peak : mark < peak) peak = mark;
      const initialSl = (gst && gst.initialSl > 0 ? gst.initialSl : 0) || (sst && sst.initialSl > 0 ? sst.initialSl : 0) || (sig && Number(sig.sl) > 0 ? Number(sig.sl) : 0);
      const atr = bars ? SN.atrOf(bars) : 0;
      let adv = NaN; if (bars && bars.length >= 4) { const last = bars[bars.length - 1], back = bars[bars.length - 4]; adv = long ? back.c - last.c : last.c - back.c; }
      const as = LQ.assess({ side, entry, mark, curSl: parseFloat(p.stopLoss) || 0, tp: parseFloat(p.takeProfit) || (sig ? Number(sig.tp) : 0) || 0, initialSl, peak, atr, btcPct: bars ? (long ? btcRaw : -btcRaw) : NaN, recent: { adv } });
      let trail = [];
      if (as && as.risk > 0 && bars) trail = bars.filter(b => b.t >= created - 60000).map(b => Math.round((long ? b.c - entry : entry - b.c) / as.risk * 100) / 100).slice(-60);
      const size = parseFloat(p.size) || 0, lev = parseFloat(p.leverage) || 1;
      out.trades.push({ symbol, side, bot: sig ? sig.bot : '', engine: sig ? sig.eng : null, entry, mark, peak, stopLoss: parseFloat(p.stopLoss) || 0, takeProfit: parseFloat(p.takeProfit) || (sig ? Number(sig.tp) : 0) || 0,
        initialSl, size, leverage: lev, upl: parseFloat(p.unrealisedPnl) || 0, margin: size * entry / lev, openedAt: created, atr,
        quality: as, trail, pace: (() => { const ps = pcState.get(key); return ps && ps.sc ? { klass: ps.sc.klass, score: ps.sc.score, hours: ps.sc.hours, proof: ps.proof ? ps.proof.state : null, proofWhy: ps.proof ? ps.proof.why : '', why: ps.sc.why.slice(0, 3) } : null; })(),
        profitGuard: gst ? { mode: gst.em || null, why: gst.lastWhy || '', shadowSl: gst.shadowSl || 0, room: gst.curveWhy || '', slice: gst.slicePlan || null, reversal: gst.rev || null, sliced: !!(gst.sliced || gst.slicedShadow), slicedLive: !!gst.sliced } : null,
        sentinel: sst ? { mode: sst.em || null, state: sst.mem && sst.mem.state, score: sst.score === undefined ? null : sst.score } : null });
    }
    out.trades.sort((a, b) => ((a.quality && a.quality.score) ?? 999) - ((b.quality && b.quality.score) ?? 999));
    const sc = out.trades.map(t => t.quality && t.quality.score).filter(x => x !== null && x !== undefined);
    out.master = guardsMaster;
    out.summary = { open: out.trades.length, upl: out.trades.reduce((t, x) => t + x.upl, 0), margin: out.trades.reduce((t, x) => t + x.margin, 0), avgScore: sc.length ? Math.round(sc.reduce((t, x) => t + x, 0) / sc.length) : null,
      bands: out.trades.reduce((o, x) => { const b = x.quality ? x.quality.band : 'unknown'; o[b] = (o[b] || 0) + 1; return o; }, {}) };
    liveCache = { at: Date.now(), v: out };
    return out;
  }
  app.get('/api/admin/live-trades', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await liveView()) }); }));
  // MASTER SWITCH: one switch for the Profit Guard, the Sentinel, the stop floor and the early slice. Off = trades run on their own stops (the bots' own trailing and fixed stops).
  // Turning it off needs no confirm; stops the guards already moved stay where they are on Bybit. Turning it back on starts a fresh watch of the open trades.
  // v2.9.5 Policy lab: READ-ONLY. Replays simple stop policies on the stored trade paths and tallies which layer's stop each closed trade exited at. Changes nothing.
  app.get('/api/admin/policy-lab', adminAuth, h(async (req, res) => {
    const days = Math.max(1, Math.min(60, Number(req.query.days) || 14));
    const rows = (await q(`SELECT at, symbol, side, now_r, peak_r FROM trade_path WHERE at >= now() - ($1 || ' days')::interval ORDER BY at LIMIT 250000`, [String(days)])).rows;
    const by = (await q(`SELECT COALESCE(closed_by, 'UNKNOWN') AS closed_by, COUNT(*)::int AS n, AVG(exit_r) AS avg_exit_r, AVG(peak_r) AS avg_peak_r, SUM(pnl) AS pnl FROM pg_trades WHERE at >= now() - ($1 || ' days')::interval AND exit_r IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [String(days)])).rows;
    res.json({ success: true, days, pathRows: rows.length, report: PL.report(rows), closedBy: by });
  }));
  app.get('/api/admin/burst-brake', adminAuth, h(async (req, res) => { res.json({ success: true, cfg: burstCfg, recent: burstLog.slice(-30) }); }));
  app.post('/api/admin/burst-brake', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.mode === 'live' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: "Going live needs confirm: 'LIVE'. Shadow mode only logs what it would do." });
    burstCfg = burstNorm({ ...burstCfg, ...(['off', 'shadow', 'live'].includes(b.mode) ? { mode: b.mode } : {}), ...(b.windowMin !== undefined ? { windowMin: b.windowMin } : {}), ...(b.factors !== undefined ? { factors: b.factors } : {}), ...(b.expo && typeof b.expo === 'object' ? { expo: { ...burstCfg.expo, ...b.expo } } : {}) });
    await q(`INSERT INTO meta(k,v) VALUES('burst_brake',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(burstCfg)]);
    await audit('admin', 'burst_brake', null, req, 'mode ' + burstCfg.mode + ', window ' + burstCfg.windowMin + ' min, factors ' + burstCfg.factors.join('/'));
    res.json({ success: true, cfg: burstCfg });
  }));
  app.get('/api/admin/swing-mgr', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await swView()) }); }));
  app.post('/api/admin/swing-mgr', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.mode === 'live' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: "Going live needs confirm: 'LIVE'. Shadow mode only records what it would do." });
    const was = swCfg.mode;
    swCfg = SW.normalize({ ...swCfg, ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.graceH !== undefined ? { graceH: b.graceH } : {}), ...(b.gapPct !== undefined ? { gapPct: b.gapPct } : {}),
      be: { ...swCfg.be, ...(b.be && typeof b.be === 'object' ? b.be : {}) }, thesis: { ...swCfg.thesis, ...(b.thesis && typeof b.thesis === 'object' ? b.thesis : {}) }, time: { ...swCfg.time, ...(b.time && typeof b.time === 'object' ? b.time : {}) } });
    if (swCfg.mode !== 'live') swFloor.clear();
    await q(`INSERT INTO meta(k,v) VALUES('swing_mgr',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(swCfg)]);
    await audit('admin', 'swing_mgr', null, req, was + ' -> ' + swCfg.mode + ' ' + JSON.stringify({ graceH: swCfg.graceH, be: swCfg.be, thesis: swCfg.thesis, time: swCfg.time }));
    res.json({ success: true, cfg: swCfg });
  }));
  app.get('/api/admin/scalp', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await scView(req.query.lab === '1')) }); }));
  app.post('/api/admin/scalp', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.mode !== undefined && b.mode !== 'off' && b.mode !== 'shadow') return res.status(400).json({ success: false, message: 'The scalp lane can only be Off or Shadow in this version. No real scalp orders are sent until the shadow test shows an edge.' });
    const was = scCfg.mode, keys = ['confirmPct', 'confirmWindowMin', 'targetFrac', 'targetFloorPct', 'targetCapPct', 'fallbackTargetPct', 'stopFrac', 'beFrac', 'timeStopMin', 'feePct', 'slipPct', 'minWins', 'leverage', 'shadowUsd',
      'riskPct', 'maxLev', 'liqMult', 'mmrPct', 'trail', 'trailGive', 'trailMinPct', 'trailLockFrac', 'stallMin', 'minGroupRows', 'maxSpreadPct', 'minTurnoverUsd', 'onlyFast', 'fastConfirmMin', 'maxMovedAtr', 'maxSameSide', 'dailyLossUsd'];
    const next = { ...scCfg }; for (const k of keys) if (b[k] !== undefined) next[k] = b[k]; if (b.mode !== undefined) next.mode = b.mode;
    scCfg = scNorm(next); scTgt.at = 0; scGrp.clear();
    await q(`INSERT INTO meta(k,v) VALUES('scalp_lane',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(scCfg)]);
    await audit('admin', 'scalp_lane', null, req, was + ' -> ' + scCfg.mode + ' ' + JSON.stringify({ confirmPct: scCfg.confirmPct, targetFrac: scCfg.targetFrac, timeStopMin: scCfg.timeStopMin, shadowUsd: scCfg.shadowUsd, riskPct: scCfg.riskPct, maxLev: scCfg.maxLev, trail: scCfg.trail, stallMin: scCfg.stallMin }));
    res.json({ success: true, cfg: scCfg });
  }));
  app.get('/api/admin/pace', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await pcView()) }); }));
  app.post('/api/admin/pace', adminAuth, h(async (req, res) => {
    const b = req.body || {}, was = pcCfg.mode;
    pcCfg = PM.normalize({ ...pcCfg, ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.fastAt !== undefined ? { fastAt: b.fastAt } : {}), ...(b.slowAt !== undefined ? { slowAt: b.slowAt } : {}),
      ...(b.hardSlowStopPct !== undefined ? { hardSlowStopPct: b.hardSlowStopPct } : {}), proof: { ...pcCfg.proof, ...(b.proof && typeof b.proof === 'object' ? b.proof : {}) }, label: { ...pcCfg.label, ...(b.label && typeof b.label === 'object' ? b.label : {}) } });
    pcPre.clear(); pcHist = { at: 0, rows: [] }; pcCal = { at: 0, cal: null, busy: false };
    await q(`INSERT INTO meta(k,v) VALUES('pace_model',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(pcCfg)]);
    await audit('admin', 'pace_model', null, req, was + ' -> ' + pcCfg.mode + ' ' + JSON.stringify({ fastAt: pcCfg.fastAt, slowAt: pcCfg.slowAt, hardSlowStopPct: pcCfg.hardSlowStopPct }));
    res.json({ success: true, cfg: pcCfg });
  }));
  app.get('/api/admin/guards-master', adminAuth, h(async (req, res) => { res.json({ success: true, master: guardsMaster }); }));
  app.post('/api/admin/guards-master', adminAuth, h(async (req, res) => {
    const on = req.body && req.body.on;
    if (typeof on !== 'boolean') return res.status(400).json({ success: false, message: 'on must be true or false' });
    if (on !== guardsMaster) {
      guardsMaster = on;
      if (!on) { pgState.clear(); snState.clear(); pgClosing.length = 0; snClosing.length = 0; pgWatch.clear(); }
      await q(`INSERT INTO meta(k,v) VALUES('guards_master',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify({ on })]);
      try { await q(`INSERT INTO meta(k,v) VALUES('profit_guard_state','{}') ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`); await q(`INSERT INTO meta(k,v) VALUES('sentinel_state','{}') ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`); } catch { /* state is rebuilt anyway */ }
      liveCache = { at: 0, v: null };
      await audit('admin', 'guards_master', null, req, on ? 'on: Profit Guard and Sentinel follow their own modes' : 'off: Profit Guard and Sentinel stopped, trades run on their own stops');
    }
    res.json({ success: true, master: guardsMaster });
  }));
  app.get('/api/admin/sentinel', adminAuth, h(async (req, res) => { res.json({ success: true, ...(await snView()) }); }));
  app.post('/api/admin/sentinel', adminAuth, h(async (req, res) => {
    const b = req.body || {};
    if (b.mode !== undefined && !SN.MODES.includes(b.mode)) return res.status(400).json({ success: false, message: 'mode must be off, shadow or live' });
    const next = SN.normalize({ ...snCfg, ...b, th: { ...snCfg.th, ...(b.th || {}) }, loss: { ...snCfg.loss, ...(b.loss || {}) }, profit: { ...snCfg.profit, ...(b.profit || {}) }, label: { ...snCfg.label, ...(b.label || {}) }, limits: { ...snCfg.limits, ...(b.limits || {}) },
      fast: { ...snCfg.fast, ...(b.fast || {}) }, swing: { ...snCfg.swing, ...(b.swing || {}) }, weights: b.weights ? { ...snCfg.weights, ...b.weights } : snCfg.weights });
    for (const pr of ['fast', 'swing']) {
      if (SN.effMode(next, pr) === 'live' && SN.effMode(snCfg, pr) !== 'live' && b.confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'Going live lets the Sentinel move real stops on Bybit. Confirm it on the panel.' });
    }
    await q(`INSERT INTO meta(k,v) VALUES('sentinel',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    const was = snCfg.mode; snCfg = next;
    await audit('admin', 'sentinel_changed', null, req, was + ' -> ' + next.mode + ' ' + JSON.stringify({ th: next.th, loss: next.loss, profit: next.profit, weights: next.weights }));
    res.json({ success: true, ...(await snView()) });
  }));
  app.post('/api/admin/sentinel/backfill', adminAuth, h(async (req, res) => {
    const r = await snBackfill(req.body || {});
    res.json({ success: true, ...r, ...(await snView()) });
  }));
  app.post('/api/admin/sentinel/apply-fit', adminAuth, h(async (req, res) => {   // the server reads its own stored suggestion: nothing is taken from the page
    const row = await q(`SELECT v FROM meta WHERE k='sentinel_fit'`); const fit = row.rows[0] ? JSON.parse(row.rows[0].v) : null;
    if (!fit || !fit.weights) return res.status(400).json({ success: false, message: 'There is no weight suggestion to apply yet.' });
    if ((SN.effMode(snCfg, 'fast') === 'live' || SN.effMode(snCfg, 'swing') === 'live') && (req.body || {}).confirm !== 'LIVE') return res.status(400).json({ success: false, message: 'This changes the live danger score. Confirm it on the panel.' });
    const next = SN.normalize({ ...snCfg, weights: fit.weights });
    await q(`INSERT INTO meta(k,v) VALUES('sentinel',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [JSON.stringify(next)]);
    snCfg = next; await audit('admin', 'sentinel_fit_applied', null, req, JSON.stringify(next.weights));
    res.json({ success: true, ...(await snView()) });
  }));

  // signal-first view: one row per bot signal with what the bot said, whether the order reached the relay, the master result and the copies
  app.get('/api/admin/signal-ledger', adminAuth, h(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const SK = `('FILT','MAXT','HALT','MINQ','BAL','HELD','PAIR','NOPOS','SIDE')`;
    const r = await q(`SELECT s.*,
        (SELECT code FROM master_log m WHERE m.exec_id=s.rid AND m.kind='TRADE' ORDER BY created_at DESC LIMIT 1) AS master_code,
        (SELECT ok FROM master_log m WHERE m.exec_id=s.rid AND m.kind='TRADE' ORDER BY created_at DESC LIMIT 1) AS master_ok,
        (SELECT detail FROM master_log m WHERE m.exec_id=s.rid AND m.kind='TRADE' ORDER BY created_at DESC LIMIT 1) AS master_detail,
        COUNT(o.id) FILTER (WHERE o.code='OK') AS copied,
        COUNT(o.id) FILTER (WHERE o.code='DRY') AS dry,
        COUNT(o.id) FILTER (WHERE o.code IN ${SK}) AS skipped,
        COUNT(o.id) FILTER (WHERE o.ok=false AND o.code NOT IN ${SK} AND o.code<>'PENDING') AS failed
      FROM signals s LEFT JOIN order_log o ON o.signal_key = 'ym-' || s.rid AND o.kind='ORDER' AND s.rid IS NOT NULL AND s.rid <> ''
      WHERE s.opened_at > now() - ($1 || ' hours')::interval
      GROUP BY s.k ORDER BY s.opened_at DESC LIMIT $2`, [String(hours), limit]);
    const bots = (await q('SELECT bot, payload, at FROM bot_status ORDER BY bot')).rows.map(b => { let p = {}; try { p = JSON.parse(b.payload); } catch { /* ignore */ } return { bot: b.bot, at: b.at, build: p.build || null, open: p.open ?? null, cfg: p.cfg || null, relayq: p.relayq || null, webq: p.webq || null }; });
    res.json({ success: true, bots, signals: r.rows.map(x => {
      const reached = !!x.order_seen_at;
      let state = 'ok', text = '';
      if (x.relay_flag === 'NOT_SENT') { state = 'info'; text = 'The bot chose not to relay this one'; }
      else if (x.alarm_at && !reached) { state = 'bad'; text = 'Never reached the relay'; }
      else if (!reached && x.relay_flag === 'SENT') { state = 'warn'; text = 'Waiting for the order to arrive'; }
      else if (x.master_ok === false) { state = 'bad'; text = 'Refused on the master account' + (x.master_detail ? ': ' + x.master_detail : ''); }
      else if (reached) { text = 'Reached the relay' + (x.relay_secs !== null ? ' in ' + Number(x.relay_secs) + 's' : ''); }
      return { key: x.k, bot: x.bot, symbol: x.symbol, side: x.side === 'BUY' ? 'LONG' : x.side === 'SELL' ? 'SHORT' : null, engine: x.eng, at: x.opened_at, entry: numOrNull(x.entry), stop: numOrNull(x.sl), target: numOrNull(x.tp), leverage: numOrNull(x.lev),
        botSaid: x.relay_flag, reached, state, text, relayOk: x.relay_ok, relaySecs: numOrNull(x.relay_secs), masterCode: x.master_code || null, masterOk: x.master_ok,
        closed: !!x.closed_at, won: x.won, pct: numOrNull(x.pct),
        copied: Number(x.copied), dry: Number(x.dry), skipped: Number(x.skipped), failed: Number(x.failed) };
    }) });
  }));

  app.post('/api/admin/users/:id/close-all', adminAuth, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!(req.body && req.body.confirm === 'CLOSE')) return res.status(400).json({ success: false, message: 'Send confirm:"CLOSE" to close this user\'s open trades.' });
    const r = await q('SELECT * FROM users WHERE id=$1 AND key_enc IS NOT NULL', [id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'That user has no key, so there is nothing to close.' });
    const out = await closeAllForUser(r.rows[0], 'admin closed this account\'s trades');
    if (out.closed) notify(r.rows[0], '\ud83d\uded1 The admin closed all open trades on your account (' + out.closed + ').');
    await audit('admin', 'close_all_user', String(id), req, 'closed ' + out.closed + ', failed ' + out.failed);
    res.json({ success: true, closed: out.closed, failed: out.failed });
  }));

  // Overview tiles + the "needs attention" list
  app.get('/api/admin/overview', adminAuth, h(async (req, res) => {
    const c = (await q(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE active AND key_enc IS NOT NULL) AS trading,
        COUNT(*) FILTER (WHERE active AND key_enc IS NOT NULL AND control_mode='manual') AS manual,
        COUNT(*) FILTER (WHERE active AND key_enc IS NOT NULL AND paused) AS paused,
        COUNT(*) FILTER (WHERE key_status='error') AS keyerr,
        COUNT(*) FILTER (WHERE dry_run) AS dry,
        COALESCE(SUM(last_equity) FILTER (WHERE active AND key_enc IS NOT NULL AND key_env='live'),0) AS equity,
        COUNT(*) FILTER (WHERE active AND key_enc IS NOT NULL AND key_env='demo') AS demo
      FROM users`)).rows[0];
    const o = (await q(`SELECT
        COUNT(*) FILTER (WHERE code='OK') AS placed,
        COUNT(*) FILTER (WHERE code='DRY') AS dry,
        COUNT(*) FILTER (WHERE ok=false AND code NOT IN ('PENDING')) AS failed,
        COUNT(*) FILTER (WHERE code IN ('FILT','MAXT','HALT') AND ok=true) AS skipped
      FROM order_log WHERE kind='ORDER' AND created_at > now() - interval '24 hours'`)).rows[0];
    const pn = (await q(`SELECT
        COALESCE(SUM(closed_pnl) FILTER (WHERE closed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS today,
        COALESCE(SUM(closed_pnl) FILTER (WHERE closed_at > now() - interval '7 days'),0) AS week,
        COALESCE(SUM(closed_pnl),0) AS total FROM pnl_ledger WHERE user_id IN (SELECT id FROM users WHERE key_env='live')`)).rows[0];
    const attention = [];
    const push = (kind, severity, u, text, action) => attention.push({ kind, severity, userId: u.id, username: u.username, text, action: action || null });
    const key = (await q(`SELECT id, username, key_error FROM users WHERE key_status='error' AND active ORDER BY id`)).rows;
    key.forEach(u => push('key', 'high', u, 'Bybit key stopped working' + (u.key_error ? ': ' + u.key_error : ''), 'clearKeyError'));
    const pz = (await q(`SELECT id, username FROM users WHERE paused AND active AND key_enc IS NOT NULL AND key_status<>'error' ORDER BY id`)).rows;
    pz.forEach(u => push('paused', 'medium', u, 'Trading is paused', 'resume'));
    const fl = (await q(`SELECT u.id, u.username, COUNT(*) AS n, MAX(o.detail) AS last FROM order_log o JOIN users u ON u.id=o.user_id
      WHERE o.kind='ORDER' AND o.ok=false AND o.code NOT IN ('PENDING','HALT','MINQ','BAL') AND o.created_at > now() - interval '24 hours' AND u.active AND u.key_status<>'error'
      GROUP BY u.id, u.username HAVING COUNT(*) >= 3 ORDER BY n DESC`)).rows;
    fl.forEach(u => push('failing', 'high', u, u.n + ' failed orders in the last 24h' + (u.last ? ' (' + String(u.last).slice(0, 80) + ')' : ''), null));
    const lowRows = (await q(`SELECT u.id, u.username, u.last_equity, o.n FROM users u JOIN (SELECT user_id, COUNT(*) AS n FROM order_log WHERE code IN ('MINQ','BAL') AND created_at > now() - interval '24 hours' GROUP BY user_id) o ON o.user_id=u.id WHERE u.active ORDER BY u.id`)).rows;
    lowRows.forEach(u => push('balance', 'medium', u, 'Trades skipped for size or margin ' + u.n + ' time(s) in 24h' + (u.last_equity !== null ? ' (balance $' + Number(u.last_equity).toFixed(2) + ')' : ''), null));
    const nk = (await q(`SELECT id, username FROM users WHERE key_enc IS NULL AND active AND created_at < now() - interval '1 day' ORDER BY id`)).rows;
    nk.forEach(u => push('nokey', 'low', u, 'Signed up over a day ago but has not added a Bybit key', null));
    // system-level items (not tied to one user): master account refusals, bots whose relay switch is off, bots that crashed, a relay/Bybit mismatch
    const sys = (kind, severity, who, text) => attention.push({ kind, severity, userId: null, username: who, text, action: null });
    try {
      const mr = await masterReports(24, 40);
      const bad = mr.filter(r => r.kind === 'TRADE' && r.sev === 'fail');
      if (bad.length) sys('master', 'high', 'Master account', bad.length + ' trade(s) refused in the last 24h, so they were not copied. Latest: ' + (bad[0].symbol || '').replace('USDT', '') + ' (' + (bad[0].text || bad[0].code) + ')');
      const nt = mr.filter(r => r.kind === 'TRADE' && r.code === 'NOTRL');
      if (nt.length) sys('master', 'high', 'Master account', nt.length + ' trade(s) opened without their trailing stop in the last 24h');
    } catch (e) { /* the journal is optional here */ }
    const fl2 = getFleet();
    Object.keys(fl2.last || {}).sort().forEach(name => {
      const inf = (fl2.info || {})[name] || {};
      const online = fl2.offlineMs ? (Date.now() - fl2.last[name]) < fl2.offlineMs : true;
      if (online && inf.relayOn === false) sys('relay', 'medium', name.replace('YM ORACLE ', 'Oracle '), 'Bybit Relay switch is OFF: trades this bot opens will not reach Bybit or any user');
      if (online && ['CRASH', 'WATCHDOG', 'BROWNOUT'].includes(inf.resetReason) && inf.uptimeMin !== null && inf.uptimeMin !== undefined && inf.uptimeMin < 180) sys('crash', 'low', name.replace('YM ORACLE ', 'Oracle '), 'Restarted ' + inf.uptimeMin + ' min ago (' + inf.resetReason + ')');
    });
    const sy2 = getMasterSync() || {};
    if (sy2.lastError) sys('sync', 'medium', 'Master account', 'Could not compare with Bybit: ' + sy2.lastError);
    if (sy2.lastRecovered && Date.now() - sy2.lastRecovered.at < 24 * 3600000) sys('sync', 'low', 'Master account', 'A ' + String(sy2.lastRecovered.side).toLowerCase() + ' on ' + String(sy2.lastRecovered.symbol).replace('USDT', '') + ' was open on Bybit but missing from the log; it was added automatically');
    const order = { high: 0, medium: 1, low: 2 };
    attention.sort((a, b) => order[a.severity] - order[b.severity]);
    res.json({ success: true,
      tiles: { users: Number(c.total), trading: Number(c.trading), autopilot: Number(c.trading) - Number(c.manual), manual: Number(c.manual), paused: Number(c.paused), keyErrors: Number(c.keyerr), dryUsers: Number(c.dry), demoUsers: Number(c.demo), equity: Number(c.equity),
        ordersPlaced24h: Number(o.placed), ordersDry24h: Number(o.dry), ordersFailed24h: Number(o.failed), ordersSkipped24h: Number(o.skipped),
        pnlToday: Number(pn.today), pnl7d: Number(pn.week), pnlTotal: Number(pn.total) },
      pausedAll, dryAll, planVersion, allowManual: masterPlan.allowManual, attention });
  }));
  app.get('/api/admin/audit', adminAuth, h(async (req, res) => {
    const r = await q('SELECT at, actor, action, target, ip, detail FROM audit_log ORDER BY id DESC LIMIT $1', [Math.min(300, parseInt(req.query.limit, 10) || 60)]);
    res.json({ success: true, rows: r.rows });
  }));

  app.get('/api/admin/invites', adminAuth, h(async (req, res) => {
    const r = await q('SELECT i.code, i.lane, i.created_at, u.username AS used_by FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC LIMIT 100');
    res.json({ success: true, invites: r.rows });
  }));
  app.post('/api/admin/invites', adminAuth, h(async (req, res) => {
    const n = Math.min(10, Math.max(1, parseInt((req.body || {}).count, 10) || 1));
    const codes = [];
    const laneIn = (req.body || {}).lane === 'scalp' ? 'scalp' : 'core';
    if (laneIn === 'scalp' && !scalpSignupOpen()) return res.status(400).json({ success: false, message: 'Scalp sign-up is closed while scalp is in testing. Set SCALP_SIGNUP_OPEN=1 on Render to open it.' });
    for (let i = 0; i < n; i++) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      await q('INSERT INTO invites(code, lane) VALUES($1,$2)', [code, laneIn]);
      codes.push(code);
    }
    await audit('admin', 'invites_created', null, req, String(n) + (laneIn === 'scalp' ? ' scalp' : ''));
    res.json({ success: true, codes, lane: laneIn });
  }));

  app.post('/api/admin/sync-now', adminAuth, h(async (req, res) => {
    await audit('admin', 'sync_now', null, req, '');
    res.json({ success: true, ...(await syncAll()) });
  }));

  app.get('/api/admin/export-all.csv', adminAuth, h(async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/, bot = String(req.query.bot || 'all').replace(/[^\w .\-]/g, '').slice(0, 30) || 'all';
    const toD = day.test(String(req.query.to || '')) ? new Date(new Date(req.query.to + 'T00:00:00Z').getTime() + 86400000) : new Date();
    const fromD = day.test(String(req.query.from || '')) ? new Date(req.query.from + 'T00:00:00Z') : new Date(toD.getTime() - 7 * 86400000);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD >= toD) return res.status(400).json({ success: false, message: 'Pick a valid date range (from before to).' });
    if (toD - fromD > 92 * 86400000) return res.status(400).json({ success: false, message: 'Pick at most 92 days (older rows are removed by the retention job).' });
    const text = await buildExportAll(bot, fromD, toD);
    await audit('admin', 'export_all', bot, req, fromD.toISOString().slice(0, 10) + ' to ' + toD.toISOString().slice(0, 10));
    const slug = bot.toLowerCase().replace(/ym oracle /, 'oracle-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ym-' + slug + '-' + fromD.toISOString().slice(0, 10) + '_' + new Date(toD.getTime() - 1).toISOString().slice(0, 10) + '.csv"', 'Cache-Control': 'no-store' });
    res.send(text);
  }));
  app.get('/api/admin/export.csv', adminAuth, h(async (req, res) => {
    const uid = parseInt(req.query.userId, 10) || null;
    const { csv } = await buildCsv(uid);
    await audit('admin', 'csv_export', uid ? String(uid) : 'all', req, '');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ym-ledger.csv"', 'Cache-Control': 'no-store' });
    res.send(csv);
  }));
  app.post('/api/admin/backup-now', adminAuth, h(async (req, res) => {
    await audit('admin', 'backup_now', null, req, '');
    const r = await runBackupIfDue(true);
    res.json({ success: !!r.sent, ...r });
  }));

  app.get('/api/admin/security', adminAuth, h(async (req, res) => {
    const info = getSecurityInfo();
    const us = (await q(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE totp_enabled) AS with2fa, COUNT(*) FILTER (WHERE ips_unrestricted AND key_enc IS NOT NULL) AS noip FROM users`)).rows[0];
    const n = Number(us.n);
    const checks = [
      { id: 'dash_pw', ok: !!process.env.DASHBOARD_PASSWORD, label: 'Admin password set', fix: 'Add DASHBOARD_PASSWORD on Render.' },
      { id: 'admin_2fa', ok: !!process.env.ADMIN_TOTP_SECRET, label: 'Admin 2FA (authenticator code) on', fix: 'Add ADMIN_TOTP_SECRET on Render (a base32 secret you also add to your authenticator app).' },
      { id: 'device_key', ok: !!info.deviceKeySet && info.deviceKeyMode === 'enforce', label: 'Trading endpoints require the device key', fix: info.deviceKeySet ? 'Key is set but in warn mode. After your ESP32s send it, set DEVICE_KEY_MODE=enforce.' : 'Anyone who finds your URL can place trades. Set DEVICE_API_KEY on Render and update the ESP32 firmware to send it.' },
      { id: 'device_misses', ok: !(info.deviceKeySet && info.deviceKeyMisses > 0), label: 'No unauthenticated trading requests seen since last restart', fix: info.deviceKeyMisses ? info.deviceKeyMisses + ' request(s) arrived without a valid device key.' : '' },
      { id: 'leverage_cap', ok: MAX_USER_LEVERAGE > 0, label: 'Leverage cap on users\' accounts', fix: 'Set MAX_USER_LEVERAGE (for example 10) so a bad signal can never over-leverage users.' },
      { id: 'telegram', ok: tgOn && !!TG_ADMIN_CHAT, label: 'Telegram alerts and daily backup on', fix: 'Set ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID.' },
      { id: 'user_2fa', ok: n === 0 || Number(us.with2fa) === n, label: 'All users have 2FA (' + us.with2fa + '/' + n + ')', fix: 'Encourage users to turn it on.' },
      { id: 'key_ip', ok: Number(us.noip) === 0, label: 'All user keys are IP-restricted', fix: Number(us.noip) + ' key(s) are not IP-locked.' },
    ];
    res.json({ success: true, checks });
  }));

  // ---------- pages ----------
  app.get('/join', sec.pageHeaders, (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
  app.get('/admin', sec.pageHeaders, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('/s/:token', sec.pageHeaders, (req, res) => res.sendFile(path.join(__dirname, 'public', 'share.html')));

  return { enabled: true, canPersist: true, loadControl, saveControl, loadMasterCreds, saveMasterCreds, clearMasterCreds, fanOutOrder, fanOutTradingStop, guardClamp, guardFitClose, fanOutLeverage, recordExec, recordBotEvent, sizeMasterOrder, syncAll, verifyAdminToken, _test: { ...off._test, tradableUsers, scState, scSeen, scGrp, scPlan, scTick, scView, scFinish, scSim, getScCfg: () => scCfg, scRun, scTgt, reentryTry, reentryBrain, reentryCheckPause, pgPlanned, pruneOldRows, pgTune: pgTuneEval, pgAutoTune, pgTick, snRecordClose, botStopSeen, pgState, botReads, masterClosed, closedDbMiss, swState, swFloor, swBarCache, snCandlesClear: () => snCandles.clear(), swTick, swView, pcState, pcPre, pcTick, pcView, pcAlertText, pcCalRefresh, getPcCal: () => pcCal, pcHist: () => pcHist, getPcCfg: () => pcCfg, getSwCfg: () => swCfg, pgWatch, pgClosing, pgRun, snTick, snState, snRun, snBackfill, snView, getSnCfg: () => snCfg, fanOutPartialClose, getPgCfg: () => pgCfg, envOpts, normEnv, tgPollOnce, runBackupIfDue, buildCsv, buildExportAll, settlePending, withRetry, checkSignalAlarms, pushSignalAlerts, pushBotMsgs, alertSweep, getPlan: () => masterPlan, rerunStdMigration: async (legacy) => { await q(`DELETE FROM meta WHERE k='std_v1_migrated'`); await migrateToStandardV1(legacy ? { ...LEGACY_PLAN, ...legacy } : LEGACY_PLAN, !!legacy); }, migrateOnce: (legacy) => migrateToStandardV1({ ...LEGACY_PLAN, ...(legacy || {}) }, !!legacy), ageAdminEquity: (ms, clear) => { adminEq = { at: Date.now() - ms, v: clear ? null : adminEq.v }; } } };
}

module.exports = { init };
