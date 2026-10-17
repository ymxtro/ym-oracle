const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { RestClientV5 } = require('bybit-api');

const { safeEqual, makeLimiter } = require('./security');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind one proxy; this makes req.ip the real client for rate limits and the audit log
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 3000;
// The master account's key can be replaced from the dashboard (stored encrypted in the database, see applyMaster below),
// so these are `let`. Until a saved key is loaded they hold whatever the Render environment says.
let API_KEY = process.env.BYBIT_API_KEY || '';
let API_SECRET = process.env.BYBIT_API_SECRET || '';
let IS_TESTNET = process.env.BYBIT_TESTNET === 'true';
// REAL BUG FOUND, fixed at the user's explicit request: Bybit's Demo
// Trading feature (virtual funds, real market data, a separate
// sub-account with its own dedicated API keys) is NOT the same thing
// as testnet -- it's a third, distinct base URL the bybit-api library
// only reaches via its own demoTrading option, which nothing here was
// ever setting. If your keys are demo-trading keys, every call was
// being sent to the wrong Bybit URL and would have been failing on
// auth, not silently returning empty/wrong data.
let IS_DEMO = process.env.BYBIT_DEMO === 'true';
// REAL FEATURE ADDED at the user's explicit request: BYBIT_BASE_URL was
// already sitting in the Render environment (set to
// https://api-demo.bybit.com), but nothing in this file ever read it --
// it was dead. This makes it a real, explicit override: when set, it
// wins outright, exactly matching the bybit-api library's own priority
// order (baseUrl beats both demoTrading and testnet), so this is safe
// to leave in place even if BYBIT_DEMO is also set -- the explicit URL
// always takes precedence.
let BYBIT_BASE_URL = process.env.BYBIT_BASE_URL || '';

// REAL FEATURE ADDED at the user's explicit request. Defaults to "live"
// deliberately, not "paper" -- this backend is already live in
// production right now. A silent default of "paper" would mean this
// update quietly stops real trading the moment it deploys, which would
// look like the bot broke, not like it got safer. Paper mode is an
// explicit opt-in for when you actually want to test something new,
// not a new default behavior nobody asked for.
// REAL FEATURE ADDED at the user's explicit request: mode is now
// switchable at runtime from the dashboard, not just fixed at boot from
// an env var. Persisted to a local file (same reasoning as the circuit
// breaker -- a Render restart shouldn't silently reset this), which
// takes priority over the env var once it exists. The env var still
// decides the very first boot, before any file exists.
const MODE_FILE = process.env.MODE_FILE || './data/trade_mode.json';
let TRADE_MODE = (process.env.TRADE_MODE || 'live').toLowerCase();
function loadModeFromDisk() {
  if (!fs.existsSync(MODE_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (saved.mode === 'paper' || saved.mode === 'live') TRADE_MODE = saved.mode;
  } catch { /* malformed file -- fall back to the env-var default already set above */ }
}
function setMode(mode) {
  TRADE_MODE = mode;
  ensureDir(MODE_FILE);
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, setAt: new Date().toISOString() }, null, 2));
}
loadModeFromDisk();

// REAL NOTE ON RENDER SPECIFICALLY: these are local files. They only
// persist across redeploys if this service has a Render persistent
// disk attached -- on the default ephemeral filesystem, a redeploy
// resets the local trade log to empty. Bybit's own closed-PnL history
// (synced in below) is NOT affected by this -- that lives on Bybit's
// side regardless -- but this service's own open-trade tracking would
// be. Worth attaching a disk if trade history matters to you long-term.
const TRADE_LOG_PATH = process.env.TRADE_LOG_PATH || './data/trades.jsonl';

// REAL FEATURE ADDED at the user's explicit request: the chosen
// dashboard design includes a working Halt trading control, so this
// needs to actually exist, not just be a button with nothing behind
// it. File-based, not just an in-memory flag -- a halt that resets
// itself on the next Render restart isn't a real safety switch.
const CIRCUIT_BREAKER_FILE = process.env.CIRCUIT_BREAKER_FILE || './data/TRADING_HALTED';

// REAL FEATURE ADDED at the user's explicit request: a genuinely opt-in
// password check for the dashboard's own data/control endpoints only
// (status, balance, positions, trade-log, halt, resume, clear-log) --
// NOT the order/trading-stop/set-leverage/price/instrument endpoints
// the manager ESP32 actually calls, since gating those would mean
// updating that firmware again too. If DASHBOARD_PASSWORD is unset,
// this changes nothing -- same open behavior as before. Set it, and a
// browser needs to send it back as a header to read balance/positions
// or hit halt/resume/clear. A page-only gate with the underlying API
// left open would be theater -- this actually protects the data and
// controls, not just the page that displays them.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// REAL FEATURE ADDED at the user's explicit request: which oracle bots
// are actually alive right now, visible from the dashboard from
// anywhere. In-memory only, deliberately not persisted to disk --
// heartbeats arrive every HEARTBEAT_INTERVAL_SEC from each bot, so a Render
// restart self-heals within about one interval; there's nothing meaningful to
// recover from a file that a fresh heartbeat won't overwrite anyway.
// REAL CHANGE at the user's explicit request: the interval is 180s (was 60s) to
// cut data use and stop one late beat from flapping the status. It MUST match
// HEARTBEAT_INTERVAL_SEC in the oracle firmware -- and this is the ONLY place on
// this side that knows it: the amber ("late") and offline thresholds below are
// derived from it, and the dashboard reads them from /api/fleet-status instead of
// keeping its own copy. Late = 1.5x (one missed beat), offline = 2.5x (room for a
// brief WiFi hiccup or a busy moment before actually flagging a bot as down).
const fleetStatus = {}; // { "YM ORACLE I": epochMs, ... }
// Optional extra health fields a bot may send with its heartbeat (uptime, why it last restarted, free memory, build).
// Older firmware sends only {name}; everything below is simply absent for those bots.
const fleetInfo = {}; // { "YM ORACLE I": { uptimeMin, resetReason, freeHeap, build } }
const HEARTBEAT_INTERVAL_SEC = 180;
const HEARTBEAT_LATE_AFTER_SEC = HEARTBEAT_INTERVAL_SEC * 1.5;      // 270s
const HEARTBEAT_OFFLINE_AFTER_SEC = HEARTBEAT_INTERVAL_SEC * 2.5;   // 450s
const HEARTBEAT_OFFLINE_THRESHOLD_MS = HEARTBEAT_OFFLINE_AFTER_SEC * 1000;
// REAL BUG FOUND, and it is the actual root cause of offline alerts never firing: there is ALSO a constant
// literally named ACTIVE_BOT_NAMES down inside public/dashboard.html -- but that one is CLIENT-SIDE
// JavaScript, embedded as plain text inside the page sent to the browser. It has never existed as a real
// server-side value. runOfflineCheck() referenced that name anyway and has been throwing a ReferenceError every
// single time it runs since this feature was first built -- silently, since nothing catches an error thrown
// inside a setInterval callback. This is the genuine, separate, server-side list the offline check actually
// needs. Keep this in sync with the one inside public/dashboard.html by hand if the active bot list ever changes;
// tools/verify_sync.py now guards against a server-side reference to the wrong one ever happening again.
const SERVER_TRACKED_BOT_NAMES = ['YM ORACLE I', 'YM ORACLE II', 'YM ORACLE III', 'YM ORACLE IV']; // IV (the swing bot) is watched too: a silent IV used to go unnoticed

// REAL FEATURE ADDED at the user's explicit request: manual "ping
// fleet" from the dashboard. The manager bot can't be pushed to --
// it only ever makes outbound HTTP requests -- so this works by
// polling: the dashboard creates a round, the manager bot's own loop
// notices it on its next poll (every ~10s), pings all four oracle bots
// over ESP-NOW, and reports each result back here as it arrives.
// pendingPingId is the "has the manager bot picked this up yet" flag,
// cleared the moment /api/ping-check hands it out, separate from
// pingRounds which keeps the actual results for the dashboard to read.
// In-memory only, same reasoning as fleetStatus -- a round is only
// ever relevant for the few seconds it's resolving.
let pendingPingId = null;
const pingRounds = {}; // { pingId: { requestedAt, results: { name: {ms} | {timeout:true} } } }
// REAL FIX at the user's explicit request: a ping request the manager bot never picked up (it was offline,
// or between polls) used to sit in pendingPingId indefinitely and fire whenever it next polled -- possibly
// minutes later, for a dashboard that had long since stopped waiting. Anything older than this is dropped
// instead of handed out. Must stay >= the dashboard's wait (PING_UI_WAIT_MS below in the page script).
const PENDING_PING_MAX_AGE_MS = 35000;
const MAX_PING_ROUNDS_KEPT = 10; // light cap so this can't grow unbounded over a long-running deploy
// SECURITY HARDENING: the password is compared in constant time (no timing leak), and a client that keeps sending
// wrong passwords is locked out for 15 minutes. An EMPTY password (the dashboard's first request before it prompts)
// is never counted as a guess, so normal use can't lock you out.
const dashFailLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 15 });
function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  // One sign-in for everything: the admin console's session token (from /api/admin/login) is accepted here too, so the trading controls
  // work from the same login. The old password header still works (the manager ESP32 and the classic dashboard use it) -- EXCEPT when the
  // admin authenticator (ADMIN_TOTP_SECRET) is on: then halting, switching mode or changing the trading key needs the signed-in console session,
  // so knowing the password alone is not enough. The manager keeps reading balance and positions with the password (req.allowDashPassword).
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  const pwOk = !process.env.ADMIN_TOTP_SECRET || req.allowDashPassword === true;
  const fallback = () => (pwOk ? checkDashboardPassword(req, res, next) : res.status(401).json({ success: false, message: 'Sign in to the console (the password alone is not accepted while the authenticator is on)' }));
  if (m && multiuser && typeof multiuser.verifyAdminToken === 'function') {
    return Promise.resolve(multiuser.verifyAdminToken(m[1])).then(ok => (ok ? next() : fallback()), () => fallback());
  }
  return fallback();
}
function checkDashboardPassword(req, res, next) {
  const given = req.get('X-Dashboard-Password') || '';
  if (given && dashFailLimiter.over(req.ip)) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again later.' });
  if (given && safeEqual(given, DASHBOARD_PASSWORD)) return next();
  if (given) dashFailLimiter.hit(req.ip);
  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

// SECURITY HARDENING: the ESP32-facing endpoints (order, stops, leverage, heartbeat, ping) used to be open to anyone
// who knew the URL -- and with multi-user on, one forged request would trade EVERY user's account. If DEVICE_API_KEY
// is set, those endpoints require it in an X-Device-Key header. DEVICE_KEY_MODE=warn (the default) only LOGS and counts
// requests that lack it, so you can update the firmware without stopping the bots; set DEVICE_KEY_MODE=enforce to block them.
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';
const DEVICE_KEY_MODE = (process.env.DEVICE_KEY_MODE || 'warn').toLowerCase() === 'enforce' ? 'enforce' : 'warn';
let deviceKeyMisses = 0;
function requireDevice(req, res, next) {
  if (!DEVICE_API_KEY) return next();
  const given = req.get('X-Device-Key') || '';
  if (given && safeEqual(given, DEVICE_API_KEY)) return next();
  deviceKeyMisses++;
  console.warn(`[security] ${req.method} ${req.path} without a valid X-Device-Key from ${req.ip} (${DEVICE_KEY_MODE === 'warn' ? 'allowed, warn mode' : 'BLOCKED'})`);
  if (DEVICE_KEY_MODE === 'warn') return next();
  return res.status(401).json({ success: false, message: 'Unauthorized device' });
}
// FIX: the manager ESP32 reads /api/balance and /api/positions before every trade. Those routes need the dashboard
// password, and the manager has none, so every trade failed with "Could not read the Bybit balance". They now also accept
// the ESP32 device key (X-Device-Key = DEVICE_API_KEY) -- the dashboard keeps working exactly as before.
function requireDashboardOrDevice(req, res, next) {
  if (DEVICE_API_KEY) {
    const given = req.get('X-Device-Key') || '';
    if (given && safeEqual(given, DEVICE_API_KEY)) return next();
  }
  req.allowDashPassword = true;   // the manager ESP32 only has the password for these two read-only routes
  return requireDashboardAuth(req, res, next);
}
function breakerIsTripped() { return fs.existsSync(CIRCUIT_BREAKER_FILE); }
function breakerTrip(reason) {
  ensureDir(CIRCUIT_BREAKER_FILE);
  fs.writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify({ trippedAt: new Date().toISOString(), reason: reason || 'manually halted' }, null, 2));
}
function breakerReset() { if (fs.existsSync(CIRCUIT_BREAKER_FILE)) fs.unlinkSync(CIRCUIT_BREAKER_FILE); }
function breakerStatus() {
  if (!breakerIsTripped()) return { tripped: false };
  try { return { tripped: true, ...JSON.parse(fs.readFileSync(CIRCUIT_BREAKER_FILE, 'utf8')) }; }
  catch { return { tripped: true, reason: 'unreadable breaker file' }; }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTradeLog() {
  if (!fs.existsSync(TRADE_LOG_PATH)) return [];
  return fs.readFileSync(TRADE_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeTradeLog(trades) {
  ensureDir(TRADE_LOG_PATH);
  fs.writeFileSync(TRADE_LOG_PATH, trades.map(t => JSON.stringify(t)).join('\n') + (trades.length ? '\n' : ''));
}
// REAL BUG FOUND at the user's explicit request ("unable to clear trade logs"): Clear used to just empty the
// local file, but the very next read of /api/trade-log re-imports Bybit's last 100 closed trades and refills it
// -- so every trade came straight back and Clear could never stick. Clear now also records WHEN it was pressed,
// and the import below ignores any Bybit record that closed at or before that moment. Bybit's own history is
// untouched; only trades that close after the clear show up again.
const CLEARED_AT_PATH = process.env.TRADE_LOG_CLEARED_AT_FILE || './data/trade_log_cleared_at.json';
function readClearedAt() {
  try { const v = JSON.parse(fs.readFileSync(CLEARED_AT_PATH, 'utf8')).clearedAt; return Number.isFinite(v) ? v : 0; } catch { return 0; }
}
function writeClearedAt(ms) { ensureDir(CLEARED_AT_PATH); fs.writeFileSync(CLEARED_AT_PATH, JSON.stringify({ clearedAt: ms })); }

function appendTrade(trade) {
  ensureDir(TRADE_LOG_PATH);
  fs.appendFileSync(TRADE_LOG_PATH, JSON.stringify(trade) + '\n');
}

// Initialize Bybit V5 Client
const buildClient = (key, secret, o) => new RestClientV5({ key, secret, testnet: !!o.testnet, demoTrading: !!o.demoTrading, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) });
let restClient = buildClient(API_KEY, API_SECRET, { testnet: IS_TESTNET, demoTrading: IS_DEMO, baseUrl: BYBIT_BASE_URL });
// What the master account is running on right now, as a plain word for the dashboard.
const masterEnvName = () => (IS_DEMO || /api-demo\./i.test(BYBIT_BASE_URL)) ? 'demo' : (IS_TESTNET ? 'testnet' : 'live');
let masterSource = 'render'; // 'render' = environment variables, 'saved' = key saved from the dashboard
let masterSavedAt = 0;
// Used by multiuser.js: always forwards to the CURRENT client, so swapping the key needs no restart.
const restClientProxy = new Proxy({}, { get: (_t, prop) => { const v = restClient[prop]; return typeof v === 'function' ? v.bind(restClient) : v; } });

// Where each Telegram alert goes (group / DM / both / off, plus the Dev and Off modes). The settings live in the database (loaded by multiuser.js
// at start-up, changed from the admin console) and take effect at once. With no database the defaults apply: everything to the main chat, as before.
const alertRoute = require('./alertroute');
const alertState = { cfg: alertRoute.defaults() };
const alertEnvChats = () => ({ groupChat: ALERT_TELEGRAM_CHAT_ID, dmChat: process.env.ALERT_TELEGRAM_PRIVATE_CHAT_ID || '' });

// MULTI-USER LAYER (see multiuser.js). Stays completely OFF unless DATABASE_URL and a 64-hex
// KEY_ENCRYPTION_SECRET are set on Render -- with neither set, every call below is a harmless no-op and this
// relay behaves exactly as the single-account version did. Adds /join (user signup), /admin and /api/me*,
// /api/auth*, /api/admin* routes, and copies each bot signal into every active user's own Bybit account.
const multiuser = require('./multiuser').init({
  app,
  restClient: restClientProxy,
  getMode: () => TRADE_MODE,
  breakerIsTripped,
  requireDashboardAuth,
  getSecurityInfo: () => ({ deviceKeySet: !!DEVICE_API_KEY, deviceKeyMode: DEVICE_KEY_MODE, deviceKeyMisses }),
  getFleet: () => ({ last: fleetStatus, info: fleetInfo, offlineMs: HEARTBEAT_OFFLINE_THRESHOLD_MS }),
  sendAlert: (text) => sendOfflineAlertTelegram(text),
  deliverAlert: (text, opts) => deliverTradeAlert(text, opts),
  alertRouter: { state: alertState, route: alertRoute, envChats: alertEnvChats, tokenSet: () => !!ALERT_TELEGRAM_BOT_TOKEN },
  getMasterSync: () => ({ ...syncStatus, mode: TRADE_MODE }),
  getExecReports: () => execReports,
  baseOpts: {
    testnet: IS_TESTNET,
    demoTrading: IS_DEMO,
    ...(BYBIT_BASE_URL ? { baseUrl: BYBIT_BASE_URL } : {})
  }
});

// ---- MASTER KEY, changeable from the dashboard (v1.8) ----------------------------------------------------------------
// Replaces having to edit BYBIT_API_KEY / BYBIT_API_SECRET on Render. The new key is checked against Bybit first, then stored
// encrypted in the database and swapped in live (no restart). "Use Render settings" removes it again. Needs the database.
const ENV_MASTER = { k: API_KEY, s: API_SECRET, testnet: IS_TESTNET, demo: IS_DEMO, baseUrl: BYBIT_BASE_URL };
// Tests point the key swap at their fake Bybit; outside NODE_ENV=test this is always empty (real Bybit URLs only).
const testBase = () => (process.env.NODE_ENV === 'test' && process.env.YM_TEST_BYBIT_URL) || '';
const masterKeyLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const lastFour = k => '••••' + String(k || '').slice(-4);
function applyMaster(cfg) {
  if (cfg.source === 'render') { API_KEY = ENV_MASTER.k; API_SECRET = ENV_MASTER.s; IS_TESTNET = ENV_MASTER.testnet; IS_DEMO = ENV_MASTER.demo; BYBIT_BASE_URL = ENV_MASTER.baseUrl; }
  else { API_KEY = cfg.k; API_SECRET = cfg.s; IS_TESTNET = false; IS_DEMO = cfg.env === 'demo'; BYBIT_BASE_URL = testBase(); }
  restClient = buildClient(API_KEY, API_SECRET, { testnet: IS_TESTNET, demoTrading: IS_DEMO, baseUrl: BYBIT_BASE_URL });
  masterSource = cfg.source; masterSavedAt = cfg.at || 0;
}
if (multiuser.canPersist) {
  multiuser.loadMasterCreds().then(c => {
    if (c) { applyMaster({ k: c.k, s: c.s, env: c.env, source: 'saved', at: c.at }); console.log('[master] using the key saved from the dashboard (' + lastFour(c.k) + ', ' + c.env + ')'); }
  }).catch(e => console.error('[master] could not load the saved key:', e.message));
}
async function checkMasterKey(k, s, env) {
  const c = buildClient(k, s, { demoTrading: env === 'demo', baseUrl: testBase() });
  let w;
  try { w = await c.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' }); } catch (e) { return { ok: false, message: 'Could not reach Bybit: ' + e.message }; }
  if (w.retCode !== 0) return { ok: false, message: 'Bybit rejected this key: ' + w.retMsg + (env === 'demo' ? ' (Is it a DEMO-trading key? Create it while Bybit is in Demo Trading mode.)' : ' (If it is a demo key, choose Demo.)') };
  const acct = (w.result.list || [])[0] || {};
  const coin = (acct.coin || []).find(x => x.coin === 'USDT') || {};
  const equity = parseFloat(coin.equity || coin.walletBalance || 0);
  let warning = null;
  if (env === 'live') {
    try {
      const info = await c.getQueryApiKey();
      if (info.retCode === 0 && info.result) {
        if (((info.result.permissions || {}).Wallet || []).includes('Withdraw')) warning = 'This key can withdraw funds. The relay never needs that, so it is safer to remove the Withdraw permission on Bybit.';
        else if (!String(info.result.ips || '') || String(info.result.ips).includes('*')) warning = 'This key is not IP-restricted. Whitelisting the relay\'s IP on Bybit makes it safer.';
      }
    } catch { /* the permission read is advisory only */ }
  }
  return { ok: true, equity, warning };
}
const needPassword = (req, res, next) => (DASHBOARD_PASSWORD ? next() : res.status(403).json({ success: false, message: 'Set DASHBOARD_PASSWORD on Render first. Changing the trading key is not allowed on an unprotected dashboard.' }));
app.get('/api/master-key', requireDashboardAuth, (req, res) => {
  res.status(200).json({ success: true, hint: lastFour(API_KEY), hasKey: !!API_KEY, env: masterEnvName(), source: masterSource, savedAt: masterSavedAt || null, canSave: !!multiuser.canPersist && !!DASHBOARD_PASSWORD });
});
app.post('/api/master-key', needPassword, requireDashboardAuth, async (req, res) => {
  if (!multiuser.canPersist) return res.status(400).json({ success: false, message: 'Saving a key here needs the database (DATABASE_URL and KEY_ENCRYPTION_SECRET on Render).' });
  if (!masterKeyLimiter.hit(req.ip)) return res.status(429).json({ success: false, message: 'Too many attempts. Try again in a few minutes.' });
  const b = req.body || {};
  const k = String(b.apiKey || '').trim(), sec = String(b.apiSecret || '').trim();
  const env = b.env === 'demo' ? 'demo' : 'live';
  if (!k || !sec) return res.status(400).json({ success: false, message: 'Key and secret are both required.' });
  if (k.length > 128 || sec.length > 256) return res.status(400).json({ success: false, message: 'That does not look like a Bybit key.' });
  const v = await checkMasterKey(k, sec, env);
  if (!v.ok) return res.status(400).json({ success: false, message: v.message });
  // Positions open on the CURRENT account would be left untracked by a switch to another account: make that a deliberate choice.
  if (k !== API_KEY && !b.confirmOpen) {
    try {
      const pr = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
      const open = pr.retCode === 0 ? (pr.result.list || []).filter(x => parseFloat(x.size) > 0).length : 0;
      if (open > 0) return res.status(409).json({ success: false, needConfirm: true, open, message: open + ' trade' + (open > 1 ? 's are' : ' is') + ' still open on the current account. Switching to a different account leaves them open on Bybit but no longer tracked here.' });
    } catch { /* if the current account cannot be read there is nothing useful to protect */ }
  }
  await multiuser.saveMasterCreds({ k, s: sec, env });
  applyMaster({ k, s: sec, env, source: 'saved', at: Date.now() });
  console.log('[master] key replaced from the dashboard (' + lastFour(k) + ', ' + env + ')');
  Promise.resolve().then(() => sendOfflineAlertTelegram('🔑 Master Bybit key changed from the dashboard (' + lastFour(k) + ', ' + env + ').')).catch(() => {});
  res.status(200).json({ success: true, hint: lastFour(k), env, equity: v.equity, warning: v.warning });
});
app.post('/api/master-key/reset', needPassword, requireDashboardAuth, async (req, res) => {
  if (!multiuser.canPersist) return res.status(400).json({ success: false, message: 'Nothing is saved: the database is not set up.' });
  await multiuser.clearMasterCreds();
  applyMaster({ source: 'render' });
  console.log('[master] back on the Render environment settings');
  Promise.resolve().then(() => sendOfflineAlertTelegram('🔑 Master Bybit key reset to the Render environment settings.')).catch(() => {});
  res.status(200).json({ success: true, hint: lastFour(API_KEY), env: masterEnvName() });
});

// Landing page for the owner: browsers get the hub, anything else (Render health checks, curl) still gets the JSON status.
const sendHome = (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'home.html')); };
app.get('/', (req, res) => {
  if (req.accepts(['json', 'html']) === 'html') return sendHome(req, res);
  res.status(200).json({ status: 'ok', message: 'YM Oracle Relay API Operational', mode: TRADE_MODE });
});
app.get('/home', sendHome);

// REAL FEATURE ADDED at the user's explicit request: the dashboard
// itself, served from this same backend rather than a separate host --
// same process as the data it shows, so there's no second deployment
// to keep in sync. If DASHBOARD_PASSWORD is set, every fetch() below
// sends whatever's saved in localStorage as the auth header; a 401
// triggers a plain password prompt, and the value is remembered for
// next time. If it's unset, this all just works with no prompt at all.
// One console now: /dashboard goes to the Trading section of /admin. The old standalone page stays at /dashboard/classic as a fallback.
app.get('/dashboard', (req, res) => res.redirect(302, '/admin#trading'));
app.get('/dashboard/classic', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 1. Get USDT Wallet Balance
app.get('/api/balance', requireDashboardOrDevice, async (req, res) => {
  try {
    const response = await restClient.getWalletBalance({
      accountType: 'UNIFIED', // Change to 'CONTRACT' if using classic contract account
      coin: 'USDT'
    });

    if (response.retCode === 0 && response.result.list.length > 0) {
      const acct = response.result.list[0];
      const coinData = (acct.coin || []).find(c => c.coin === 'USDT');
      const equity = parseFloat(coinData?.equity || coinData?.walletBalance || 0);
      // REAL GAP found at the user's request: 'balance' is account EQUITY, which still counts the margin already
      // locked in open positions -- so a "do I have enough?" check against it could pass while Bybit rejected the
      // order for insufficient available margin. 'available' is what is actually free to open a NEW position with.
      let available = parseFloat(acct.totalAvailableBalance);
      if (!Number.isFinite(available)) {
        const wallet = parseFloat(coinData?.walletBalance);
        available = Number.isFinite(wallet)
          ? Math.max(0, wallet - (parseFloat(coinData?.totalPositionIM) || 0) - (parseFloat(coinData?.totalOrderIM) || 0))
          : equity;
      }
      return res.status(200).json({ success: true, balance: equity, available });
    } else {
      return res.status(400).json({ success: false, message: response.retMsg });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch Live Price for Symbol
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const response = await restClient.getTickers({
      category: 'linear',
      symbol: symbol
    });

    if (response.retCode === 0 && response.result.list.length > 0) {
      const lastPrice = parseFloat(response.result.list[0].lastPrice);
      return res.status(200).json({ success: true, symbol, price: lastPrice });
    } else {
      return res.status(400).json({ success: false, message: 'Symbol price not found' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Fetch Symbol Precision (Lot Size Filter)
app.get('/api/instrument/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const response = await restClient.getInstrumentsInfo({
      category: 'linear',
      symbol: symbol
    });

    if (response.retCode === 0 && response.result.list.length > 0) {
      const inst = response.result.list[0];
      const lotSizeFilter = inst.lotSizeFilter || {};
      const leverageFilter = inst.leverageFilter || {};
      // A pair can be LISTED yet not tradable (pre-launch, settling, closed): say so up front, as "not
      // available", instead of letting the order fail later with a vaguer error.
      if (inst.status && inst.status !== 'Trading') {
        return res.status(400).json({ success: false, message: 'Symbol not tradable right now (status ' + inst.status + ')' });
      }
      return res.status(200).json({
        success: true,
        qtyStep: parseFloat(lotSizeFilter.qtyStep),
        minOrderQty: parseFloat(lotSizeFilter.minOrderQty),
        minNotional: parseFloat(lotSizeFilter.minNotionalValue) || 0, // 0 = Bybit did not say
        maxLeverage: parseFloat(leverageFilter.maxLeverage) || 0,     // 0 = Bybit did not say
        status: inst.status || null
      });
    } else {
      return res.status(400).json({ success: false, message: 'Symbol details not found' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Get Open Positions
app.get('/api/positions', requireDashboardOrDevice, async (req, res) => {
  try {
    const response = await restClient.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT'
    });

    if (response.retCode === 0) {
      const openPositions = response.result.list.filter(pos => parseFloat(pos.size) > 0);

      const formattedPositions = openPositions.map(pos => ({
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: parseFloat(pos.avgPrice).toFixed(4),
        markPrice: parseFloat(pos.markPrice).toFixed(4),
        unrealisedPnl: parseFloat(pos.unrealisedPnl).toFixed(2),
        leverage: pos.leverage,
        positionValue: parseFloat(pos.positionValue).toFixed(2)
      }));

      return res.status(200).json({ success: true, count: formattedPositions.length, positions: formattedPositions });
    } else {
      return res.status(400).json({ success: false, message: response.retMsg });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Create Order
// REAL FEATURE ADDED at the user's explicit request: paper mode and
// trade logging, both wired in right here since this is the one place
// every open (and every close, since a close is also just an order)
// passes through.
// ---- ORDER IDEMPOTENCY + JOURNAL (v1.6) ------------------------------------------------------------------------------
// The manager retries an order with the SAME orderLinkId whenever it gets no usable answer. Before this, every retry was
// treated as a brand-new order: it fanned out to users again, hit Bybit again, and -- worst -- when the FIRST try had really
// reached Bybit but its reply was lost, the retry came back as "duplicate" (retCode 110072), which was never written to the
// trade log. Result: the trade was live on Bybit and nowhere on the web. Now:
//   * one orderLinkId is processed once; a retry while it is still running waits for the same result, and a retry afterwards
//     gets the stored answer (marked replayed:true) without touching Bybit or the users again;
//   * a duplicate answer (110072) counts as "it is on Bybit" and is logged like any other open;
//   * the trade log never gets the same orderLinkId twice.
const RECENT_ORDER_TTL_MS = 15 * 60 * 1000;
const recentOrders = new Map(); // orderLinkId -> { at, response }
const inflightOrders = new Map(); // orderLinkId -> Promise<response>
function pruneRecentOrders() {
  const cutoff = Date.now() - RECENT_ORDER_TTL_MS;
  for (const [k, v] of recentOrders) if (v.at < cutoff) recentOrders.delete(k);
}
function cleanLink(v) { return typeof v === 'string' && /^[\w.\-]{1,36}$/.test(v) ? v : ''; }

function logMasterOpen(t) {
  try {
    if (t.orderLinkId && readTradeLog().some(x => x.orderLinkId === t.orderLinkId)) return false; // already there
    appendTrade({
      id: `${t.symbol}-${Date.now()}`, orderLinkId: t.orderLinkId || null, openedAt: t.openedAt || new Date().toISOString(),
      symbol: t.symbol, side: t.side, qty: t.qty || null, leverage: t.leverage || null,
      takeProfit: t.takeProfit || null, stopLoss: t.stopLoss || null, mode: TRADE_MODE, status: 'OPEN',
      closedAt: null, exitPrice: null, realizedPnl: null, roiPct: null, source: t.source || 'order',
    });
    return true;
  } catch (e) { console.error('[trade-log] could not log open:', e.message); return false; }
}

async function submitMasterOrder(body) {
  if (TRADE_MODE === 'paper') return { paper: true, wouldHaveSubmitted: body, retCode: 0, retMsg: 'PAPER MODE — not sent to Bybit' };
  try { return await restClient.submitOrder(body); }
  catch (e1) {
    // a dropped connection says nothing about whether Bybit got the order. Asking again with the SAME orderLinkId is safe:
    // if it did arrive, Bybit answers 110072 (duplicate) and the manager treats that as success.
    if (!body.orderLinkId) throw e1;
    await new Promise(r => setTimeout(r, 600));
    return await restClient.submitOrder(body);
  }
}

async function processOrder(body) {
  // Copy this signal to every active user's account. Fire-and-forget: the ESP32 must never wait on (or be
  // broken by) other people's accounts, and one user's failure never touches the master order below.
  multiuser.fanOutOrder(body).catch(e => console.error('[multiuser] fanOutOrder:', e.message));
  // Optional (MASTER_FOLLOWS_PLAN=true): size the master's open with the same rule as every user. Falls back to the manager's own quantity.
  if (!body.reduceOnly) {
    const sz = await multiuser.sizeMasterOrder(body).catch(() => null);
    if (sz && sz.qty) {
      console.log(`[master-sizing] ${body.symbol} qty ${body.qty} -> ${sz.qty} (about $${Number(sz.marginUsd).toFixed(2)} margin at ${sz.leverage}x, from the plan)`);
      body = { ...body, qty: String(sz.qty) };
    } else if (sz && sz.skipped) console.warn(`[master-sizing] plan size not possible (${sz.skipped}): using the manager's quantity. ${sz.detail}`);
  }
  const response = await submitMasterOrder(body);
  const isOpen = !body.reduceOnly;
  const landed = TRADE_MODE === 'paper' || response.retCode === 0 || response.retCode === 110072;
  if (isOpen && landed) {
    logMasterOpen({ orderLinkId: cleanLink(body.orderLinkId), symbol: body.symbol, side: body.side, qty: body.qty,
      takeProfit: body.takeProfit, stopLoss: body.stopLoss, source: response.retCode === 110072 ? 'order-dup' : 'order' });
  }
  return response;
}

// 5. Create Order
// Every open (and every close, since a close is also just an order) passes through here.
app.post('/api/order', requireDevice, async (req, res) => {
  if (breakerIsTripped()) {
    return res.status(503).json({ success: false, message: 'Trading halted', status: breakerStatus() });
  }
  const body = req.body || {};
  const link = cleanLink(body.orderLinkId);
  try {
    if (link) {
      pruneRecentOrders();
      const done = recentOrders.get(link);
      if (done) return res.status(200).json({ ...done.response, replayed: true });
      if (inflightOrders.has(link)) return res.status(200).json({ ...(await inflightOrders.get(link)), replayed: true });
    }
    const work = processOrder(body);
    if (link) inflightOrders.set(link, work);
    let response;
    try { response = await work; }
    finally { if (link) inflightOrders.delete(link); }
    if (link) recentOrders.set(link, { at: Date.now(), response });
    return res.status(200).json(response);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5b. Bot events (the signal ledger). Each Oracle bot reports "I opened / relayed / closed this trade" here, independently of the manager,
// so the relay can tell "the bot found a trade" from "the order reached me". Idempotent on the bot's own key; a 5xx makes the bot retry.
app.post('/api/bot-event', requireDevice, async (req, res) => {
  try {
    const r = await multiuser.recordBotEvent(req.body);
    return res.status(r.status).json({ success: r.status === 200, message: r.message });
  } catch (error) {
    console.error('[bot-event]', error.message);
    return res.status(500).json({ success: false });
  }
});

// 6. Configure Trailing Stops / Position Stop Lines
app.post('/api/trading-stop', requireDevice, async (req, res) => {
  if (breakerIsTripped()) {
    return res.status(503).json({ success: false, message: 'Trading halted', status: breakerStatus() });
  }
  try {
    multiuser.fanOutTradingStop(req.body).catch(e => console.error('[multiuser] fanOutTradingStop:', e.message));
    let response;
    if (TRADE_MODE === 'paper') {
      response = { paper: true, wouldHaveSubmitted: req.body, retCode: 0, retMsg: 'PAPER MODE — not sent to Bybit' };
    } else {
      response = await restClient.setTradingStop(req.body);
    }
    return res.status(200).json(response);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Set Leverage for Symbol
app.post('/api/set-leverage', requireDevice, async (req, res) => {
  try {
    const { category, symbol, buyLeverage, sellLeverage } = req.body;
    multiuser.fanOutLeverage(req.body).catch(e => console.error('[multiuser] fanOutLeverage:', e.message));

    let response;
    if (TRADE_MODE === 'paper') {
      response = { retCode: 0, retMsg: 'PAPER MODE — not sent to Bybit' };
    } else {
      response = await restClient.setLeverage({
        category: category || 'linear',
        symbol: symbol,
        buyLeverage: String(buyLeverage),
        sellLeverage: String(sellLeverage)
      });
    }

    // retCode 110043 means leverage is already set to this value on Bybit
    if (response.retCode === 0 || response.retCode === 110043) {
      return res.status(200).json({ success: true, message: 'Leverage adjusted', mode: TRADE_MODE });
    } else {
      return res.status(400).json({ success: false, message: response.retMsg });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// REAL FEATURE ADDED at the user's explicit request: receives an oracle
// bot's heartbeat, forwarded by the manager ESP32 over ESP-NOW. No auth
// -- matches every other ESP32-facing endpoint (order, trading-stop,
// set-leverage), since the manager bot can't do a browser-style
// password prompt. Deliberately tiny: record the name and the time,
// nothing else needs deciding here.
app.post('/api/heartbeat', requireDevice, (req, res) => {
  const name = req.body && req.body.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, message: 'name is required' });
  }
  const clean = name.replace(/[^\w .\-]/g, '').slice(0, 40);
  if (!clean) return res.status(400).json({ success: false, message: 'name is required' });
  fleetStatus[clean] = Date.now();
  const hb = req.body || {};
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const txt = (v, n) => (typeof v === 'string' && v ? v.replace(/[^\w .:\-]/g, '').slice(0, n) : null);
  const flag = v => (v === true || v === 1 || v === '1' ? true : (v === false || v === 0 || v === '0' ? false : null));
  const info = { uptimeMin: num(hb.uptimeMin), freeHeap: num(hb.freeHeap), resetReason: txt(hb.resetReason, 20), build: txt(hb.build, 30),
    relayOn: flag(hb.relayOn), relayMarginUsd: num(hb.relayMarginUsd), swingRelayOn: flag(hb.swingRelayOn) };
  if (info.uptimeMin !== null || info.freeHeap !== null || info.resetReason || info.build || info.relayOn !== null) {
    const prev = fleetInfo[clean];
    fleetInfo[clean] = info;
    // Silent failures made visible: a bot whose Bybit Relay switch flips OFF keeps opening trades on its own screen while
    // nothing reaches Bybit or any user; a bot that restarted after a crash may have lost an order it was sending.
    if (prev) {
      const short = clean.replace('YM ORACLE ', 'Oracle ');
      if (prev.relayOn === true && info.relayOn === false) sendOfflineAlertTelegram('⚠️ ' + short + ': its Bybit Relay switch is now OFF. New trades on this bot will NOT reach Bybit or your users until it is switched back on.');
      const restarted = prev.uptimeMin !== null && info.uptimeMin !== null && info.uptimeMin + 1 < prev.uptimeMin;
      if (restarted && ['CRASH', 'WATCHDOG', 'BROWNOUT'].includes(info.resetReason)) sendOfflineAlertTelegram('⚠️ ' + short + ' restarted by itself (' + info.resetReason + '). If it was sending a trade at that moment, check the Activity tab.');
    }
  }
  res.status(200).json({ success: true });
});

// ===== OFFLINEALERT-BEGIN (compiled and tested verbatim by the host simulator) =====
// REAL FEATURE ADDED at the user's explicit request: a bot or the manager going offline only ever showed as a
// colour change on the dashboard -- nothing told anyone unless they were looking at it right then. This fires one
// Telegram message the moment something crosses into offline, and one when it comes back, using the exact same
// HEARTBEAT_OFFLINE_THRESHOLD_MS the dashboard's own fleet-status chips already use, so "offline" here means
// exactly what it means there -- no separate, drifting definition of offline.
const ALERT_TELEGRAM_BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const ALERT_TELEGRAM_CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID || '';

const offlineState = {}; // name -> bool, only ever set for a name we've heard from at least once

// Pure decision logic, no network I/O -- this is what gets unit tested directly, against the real function, not a
// re-implementation of it. names: who to check. lastSeenMap: fleetStatus. offlineState: mutated in place (the
// caller's persistent memory of who was already known-offline, so a still-offline name is not re-alerted every
// interval). A name with NO entry in lastSeenMap yet (never heard from at all) is skipped entirely -- a cold start
// or a name that has simply never reported in is not an "offline" event; there is nothing to transition FROM.
function computeOfflineTransitions(names, lastSeenMap, nowMs, offlineAfterMs, offlineState) {
  const events = [];
  for (const name of names) {
    const lastSeen = lastSeenMap[name];
    if (lastSeen === undefined) continue;
    const isOffline = (nowMs - lastSeen) > offlineAfterMs;
    const wasOffline = offlineState[name] || false;
    if (isOffline && !wasOffline) events.push({ name, event: 'offline', downForMin: Math.round((nowMs - lastSeen) / 60000) });
    if (!isOffline && wasOffline) events.push({ name, event: 'online' });
    offlineState[name] = isOffline;
  }
  return events;
}

// The actual network call -- deliberately thin and not itself unit-tested against a live Telegram (nothing in this
// project can reach the internet from a test run). Silently does nothing if the two env vars below are unset,
// matching DASHBOARD_PASSWORD's own off-by-default pattern: a feature you have to opt into, not one that fails
// loudly if you haven't set it up yet.
function sendOfflineAlertTelegram(text, category) {
  if (!ALERT_TELEGRAM_BOT_TOKEN) return;
  const rt = alertRoute.resolve(alertState.cfg, category || 'ops', Date.now(), alertEnvChats());
  if (rt.muted) { console.log('[ALERT] not sent (' + rt.reason + '):', String(text).slice(0, 80)); return; }
  console.log('[OFFLINE ALERT] sending:', text);
  for (const t of rt.targets) {
    const payload = JSON.stringify({ chat_id: t.chat, text: rt.prefix + text });
    const tr = alertTransport('api.telegram.org');
    const req = tr.mod.request({
      hostname: tr.hostname, port: tr.port, path: `/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      // REAL BUG FOUND: this used to just drain the response and discard it, never checking whether Telegram
      // actually accepted the message. A rejection (bad token, bad chat id, the bot blocked, rate limited) would
      // fail completely silently -- nothing anywhere would show it happened. Now the outcome always reaches the
      // Render logs, whether it worked or not.
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) console.log('[OFFLINE ALERT] Telegram accepted it (' + t.kind + ')');
        else console.error('[OFFLINE ALERT] Telegram rejected it (' + t.kind + '): HTTP', res.statusCode, body);
      });
    });
    req.on('error', (e) => console.error('[OFFLINE ALERT] Telegram send failed:', e.message));
    req.write(payload);
    req.end();
  }
}

// ===== TRADEALERT-BEGIN =====
// Trade alerts that WAIT for the real result (the older sendOfflineAlertTelegram is fire-and-forget). Used for "trade opened / closed"
// messages and the test buttons, so a failed delivery can be retried instead of silently lost.
//   Telegram: ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID (already used for the other alerts)
//   Email (optional, plain HTTPS, no SMTP): RESEND_API_KEY + ALERT_EMAIL_TO [+ ALERT_EMAIL_FROM]
// Tests only (NODE_ENV=test and YM_TEST_ALERT_URL): alerts go to a local fake Telegram/Resend instead of the internet.
function alertTransport(hostname) {
  const o = process.env.NODE_ENV === 'test' && process.env.YM_TEST_ALERT_URL;
  if (o) { const u = new URL(o); return { mod: require('http'), hostname: u.hostname, port: Number(u.port) }; }
  return { mod: https, hostname };
}
function httpsJson(hostname, path, headers, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const tr = alertTransport(hostname);
    const req = tr.mod.request({ hostname: tr.hostname, port: tr.port, path, method: 'POST', timeout: 8000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers) }, (res) => {
      let d = ''; res.on('data', c => { d += c; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
    req.write(body); req.end();
  });
}
async function deliverTradeAlert(text, opts) {
  opts = opts || {};
  const cat = alertRoute.CAT_IDS.includes(opts.cat) ? opts.cat : (opts.priv ? 'zones' : 'signals');
  const env = alertEnvChats();
  const tgOn = !!(ALERT_TELEGRAM_BOT_TOKEN && (alertState.cfg.groupChat || alertState.cfg.dmChat || env.groupChat || env.dmChat));
  const mailOn = !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO);
  const wantMail = mailOn && (opts.email === true || process.env.ALERT_EMAIL_ALL === 'true' || (!opts.html && !opts.priv));
  const out = { ok: false, configured: tgOn || mailOn, telegram: 'off', email: 'off', muted: false, route: [] };
  const plain = String(text).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  if (tgOn) {
    // opts.force ('group' | 'dm') is for the test buttons only: an explicit "try this chat" that ignores the mode.
    let rt;
    if (opts.force === 'group' || opts.force === 'dm') {
      const chat = opts.force === 'dm' ? (alertState.cfg.dmChat || env.dmChat) : (alertState.cfg.groupChat || env.groupChat);
      rt = chat ? { targets: [{ kind: opts.force, chat }], muted: false, reason: '', prefix: '' } : { targets: [], muted: true, reason: 'no ' + opts.force + ' chat is set up', prefix: '', unset: true };
    } else rt = alertRoute.resolve(alertState.cfg, cat, Date.now(), env);
    if (rt.muted) {
      out.telegram = rt.unset ? 'failed (' + rt.reason + ')' : 'muted (' + rt.reason + ')'; out.muted = !rt.unset; out.reason = rt.reason;
    } else {
      let sentN = 0, firstFail = '';
      for (const t of rt.targets) {
        const body = rt.prefix + String(text);
        let r = await httpsJson('api.telegram.org', `/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {}, opts.html ? { chat_id: t.chat, text: body.slice(0, 4000), parse_mode: 'HTML' } : { chat_id: t.chat, text: body });
        if (!r.ok && opts.html && r.status === 400) r = await httpsJson('api.telegram.org', `/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {}, { chat_id: t.chat, text: (rt.prefix + plain).slice(0, 4000) }); // Telegram could not read the formatting: send it plain rather than lose it
        if (r.ok) { sentN++; out.route.push(t.kind); } else { if (!firstFail) firstFail = t.kind + ' ' + (r.status || r.body); console.error('[TRADE ALERT] Telegram failed (' + t.kind + '):', r.status, r.body); }
      }
      out.telegram = sentN > 0 ? 'sent' : 'failed (' + firstFail + ')';
      if (sentN > 0 && firstFail) out.telegram = 'sent (' + out.route.join('+') + '; ' + firstFail + ' failed)';
    }
  }
  if (wantMail) {
    const subject = plain.split('\n').map(x => x.trim()).filter(Boolean)[0].slice(0, 120) || 'YM Oracle alert';
    const r = await httpsJson('api.resend.com', '/emails', { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
      { from: process.env.ALERT_EMAIL_FROM || 'YM Oracle <onboarding@resend.dev>', to: String(process.env.ALERT_EMAIL_TO).split(',').map(x => x.trim()).filter(Boolean), subject, text: plain });
    out.email = r.ok ? 'sent' : 'failed (' + (r.status || r.body) + ')';
    if (!r.ok) console.error('[TRADE ALERT] Email failed:', r.status, r.body);
  }
  // delivered = at least one channel took it, OR it was deliberately muted (handled: it must not be retried and then sent later when you switch back to live)
  out.ok = out.telegram.startsWith('sent') || out.email === 'sent' || (out.muted && out.email !== 'failed' && !String(out.email).startsWith('failed'));
  return out;
}
// ===== TRADEALERT-END =====

function runOfflineCheck() {
  const names = SERVER_TRACKED_BOT_NAMES.concat(['YM ORACLE MANAGER']);
  const events = computeOfflineTransitions(names, fleetStatus, Date.now(), HEARTBEAT_OFFLINE_THRESHOLD_MS, offlineState);
  for (const e of events) {
    if (e.event === 'offline') sendOfflineAlertTelegram(`\u26a0\ufe0f ${e.name} has gone offline (no contact for ${e.downForMin}m)`);
    else sendOfflineAlertTelegram(`\u2705 ${e.name} is back online`);
  }
}
if (process.env.NODE_ENV !== 'test') {
  setInterval(runOfflineCheck, 30000); // a real interval would keep a test process alive forever; tests call runOfflineCheck()/computeOfflineTransitions() directly instead
  console.log('[OFFLINE ALERT] background check registered, running every 30s. Telegram configured:', !!(ALERT_TELEGRAM_BOT_TOKEN && ALERT_TELEGRAM_CHAT_ID));
}
// ===== OFFLINEALERT-END =====

// REAL FEATURE ADDED at the user's explicit request: what the
// dashboard actually reads to show which bots are alive. "online" is
// computed fresh on every read from the last heartbeat time, not
// stored as its own field -- a bot that goes quiet becomes "offline"
// automatically the moment enough time has passed, without needing a
// separate timer anywhere to notice and update anything.
// REAL FEATURE ADDED at the user's explicit request: after a real 20-minute test produced no Telegram alert (with
// Render confirmed awake), there was no way to tell WHICH half of the pipeline actually failed -- detection
// (fleetStatus never updating, or the threshold math) or delivery (the Telegram call itself, which nothing in
// development can ever test against the real internet). This answers both in one request instead of a 20-minute
// wait: it reports exactly what the background check currently sees for every tracked name, and can optionally
// fire one real Telegram message on demand so the send path itself can be proven working right now.
app.get('/api/test-offline-alert', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  const names = SERVER_TRACKED_BOT_NAMES.concat(['YM ORACLE MANAGER']);
  const seen = names.map(name => {
    const lastSeen = fleetStatus[name];
    return {
      name,
      lastSeenSecondsAgo: lastSeen === undefined ? null : Math.round((now - lastSeen) / 1000),
      trackedAsOffline: offlineState[name] || false,
      wouldBeConsideredOffline: lastSeen !== undefined && (now - lastSeen) > HEARTBEAT_OFFLINE_THRESHOLD_MS,
    };
  });
  const configured = !!(ALERT_TELEGRAM_BOT_TOKEN && ALERT_TELEGRAM_CHAT_ID);
  const result = { detection: seen, delivery: { configured } };
  if (req.query.send === 'true') {
    if (!configured) {
      result.delivery.sent = false;
      result.delivery.reason = 'ALERT_TELEGRAM_BOT_TOKEN or ALERT_TELEGRAM_CHAT_ID is not set on this deployment';
      return res.status(200).json(result);
    }
    sendOfflineAlertTelegram('\u2705 Test alert from /api/test-offline-alert -- if you see this in Telegram, delivery works.');
    result.delivery.sent = true;
    result.delivery.note = 'Sent (fire-and-forget -- check Telegram; a network failure on Render\'s side would only show up in the Render logs, not here)';
  } else {
    result.delivery.note = 'Add ?send=true to this URL to also fire a real test message';
  }
  res.status(200).json(result);
});

app.get('/api/fleet-status', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  const bots = Object.entries(fleetStatus).map(([name, lastSeenAt]) => ({
    name,
    lastSeenAt,
    online: (now - lastSeenAt) < HEARTBEAT_OFFLINE_THRESHOLD_MS,
  }));
  // The thresholds ride along so the dashboard never keeps its own (drift-prone) copy.
  res.status(200).json({ success: true, bots, intervalSecs: HEARTBEAT_INTERVAL_SEC, lateAfterSecs: HEARTBEAT_LATE_AFTER_SEC, offlineAfterSecs: HEARTBEAT_OFFLINE_AFTER_SEC });
});

// REAL FEATURE ADDED at the user's explicit request: dashboard-triggered.
// A fresh click always starts a fresh round, even if one is still
// technically resolving -- the manager bot only tracks one round at a
// time on its own side, so an old round left dangling would never get
// a chance to report its remaining results anyway. Trims old rounds
// past MAX_PING_ROUNDS_KEPT so this can't grow forever.
app.post('/api/ping-fleet', requireDashboardAuth, (req, res) => {
  const pingId = `ping-${Date.now()}`;
  pendingPingId = pingId;
  pingRounds[pingId] = { requestedAt: Date.now(), results: {} };

  const ids = Object.keys(pingRounds);
  if (ids.length > MAX_PING_ROUNDS_KEPT) {
    ids.sort((a, b) => pingRounds[a].requestedAt - pingRounds[b].requestedAt);
    delete pingRounds[ids[0]];
  }

  res.status(200).json({ success: true, pingId });
});

// REAL FEATURE ADDED at the user's explicit request: polled by the
// manager bot, not the dashboard. No auth, matching every other
// ESP32-facing endpoint. Hands out pendingPingId exactly once --
// cleared here so the manager bot's next poll doesn't start the same
// round twice.
// REAL FEATURE ADDED at the user's explicit request: the manager itself never had a heartbeat -- the dashboard
// could tell when a BOT went quiet, never when the MANAGER did. It already GETs this endpoint every ~10s on its
// own, so that traffic itself is proof of life; no new call or firmware change needed for this specific signal.
app.get('/api/ping-check', requireDevice, (req, res) => {
  fleetStatus['YM ORACLE MANAGER'] = Date.now();
  let pingId = pendingPingId;
  pendingPingId = null;
  if (pingId && pingRounds[pingId] && (Date.now() - pingRounds[pingId].requestedAt) > PENDING_PING_MAX_AGE_MS) {
    pingId = null; // stale -- see PENDING_PING_MAX_AGE_MS
  }
  // REAL FEATURE ADDED at the user's explicit request: the manager already polls this endpoint every ~10s, so the
  // current halt state rides along for free -- no new network traffic. This is what lets the manager keep its own
  // persistent copy (see the HALTCACHE block in its firmware) that survives a Render restart even if THIS backend's
  // own halt flag does not.
  res.status(200).json({ pingId, halted: breakerIsTripped() });
});

// REAL FEATURE ADDED at the user's explicit request: the manager bot
// reports each oracle bot's result here as it resolves -- either a
// real round-trip time or a timeout. A result for a pingId this
// backend no longer remembers (trimmed by the cap above, or from
// before a restart) is accepted and silently dropped rather than
// erroring -- the manager bot has no reason to care whether this
// backend still has room for it.
app.post('/api/ping-result', requireDevice, (req, res) => {
  const { pingId, name, ms, timeout } = req.body || {};
  if (!pingId || !name) {
    return res.status(400).json({ success: false, message: 'pingId and name are required' });
  }
  if (pingRounds[pingId]) {
    pingRounds[pingId].results[name] = timeout ? { timeout: true } : { ms };
  }
  res.status(200).json({ success: true });
});

// REAL FEATURE ADDED at the user's explicit request: what the
// dashboard polls to watch a round's results come in live.
app.get('/api/ping-status/:pingId', requireDashboardAuth, (req, res) => {
  const round = pingRounds[req.params.pingId];
  if (!round) {
    return res.status(404).json({ success: false, message: 'Unknown or expired pingId' });
  }
  res.status(200).json({ success: true, requestedAt: round.requestedAt, results: round.results });
});

// 8. Trade log — REAL FEATURE ADDED at the user's explicit request.
// Reconciles the local log (which knows about opens as they happen)
// against Bybit's own closed-PnL history (the authoritative source for
// what actually closed and what it actually made or lost) every time
// this is read, rather than relying on a background timer that might
// not reliably run on Render's free tier. ROI is computed against the
// actual margin used (entry value / leverage), not against raw PnL
// alone -- "5% of what I risked" is the meaningful number, not just a
// dollar figure with no reference point.
// REAL FEATURE ADDED at the user's explicit request: "Bybit execution can fail too, I want it never to fail" --
// and when it does, it must never fail SILENTLY. The manager bot reports the outcome of every trade, stop update
// and close it is asked to make (success OR failure, with a short code and a plain-English detail); they are
// kept here and shown on the dashboard. Keyed by command id, so a retransmitted command that finishes twice is
// listed once. Kept in memory and best-effort on disk (a restart of a free Render instance may clear the file --
// the dashboard is a live view, not the archive).
const EXEC_REPORTS_PATH = process.env.EXEC_REPORTS_FILE || './data/exec_reports.json';
const MAX_EXEC_REPORTS = 60;
let execReports = []; // newest first
try { const v = JSON.parse(fs.readFileSync(EXEC_REPORTS_PATH, 'utf8')); if (Array.isArray(v)) execReports = v.slice(0, MAX_EXEC_REPORTS); } catch { execReports = []; }
function saveExecReports() {
  try { ensureDir(EXEC_REPORTS_PATH); fs.writeFileSync(EXEC_REPORTS_PATH, JSON.stringify(execReports)); }
  catch (e) { console.error('[exec-report] could not save:', e.message); }
}
const EXEC_CODE_TEXT = {
  OK: 'Done', DUP: 'Already placed', NOCHG: 'Already at that value', PAPER: 'Paper mode, nothing sent', NOPOS: 'Nothing open to change',
  BAL: 'Not enough free balance', MINQ: "Below Bybit's minimum size", PAIR: 'Pair not on Bybit', LEV: 'Bybit rejected the leverage',
  NET: "Couldn't reach Bybit", BYBIT: 'Bybit refused it', BAD: 'Command malformed', PRICE: 'Price did not match',
  HELD: 'Already holding this pair', HALT: 'Trading is halted', SIDE: 'Position is on the other side',
  NOTRL: 'Opened, but the trailing stop was not set', SCALED: 'Opened smaller than asked', LEVCLMP: 'Opened at lower leverage'
};
// Every result code belongs to exactly ONE severity (tools/verify_sync.py checks that every code the manager can send is listed here):
//   quiet -- routine or harmless. Never raises the dashboard strip or the dot. (NOPOS: the manager flags "no position to update" as
//            not-ok, but it only means Bybit's own stop already closed the trade -- an alarm there would be a false one.)
//   warn  -- amber: it happened, or was safely skipped, but not exactly as planned.
//   fail  -- red: the order did not go through.
const EXEC_QUIET_CODES = new Set(['OK', 'DUP', 'NOCHG', 'PAPER', 'NOPOS']);
const EXEC_WARN_CODES = new Set(['NOTRL', 'SCALED', 'LEVCLMP', 'HELD', 'HALT', 'SIDE']);
const EXEC_FAIL_CODES = new Set(['BAL', 'MINQ', 'PAIR', 'LEV', 'NET', 'BYBIT', 'BAD', 'PRICE']);
function execSeverity(r) {
  if (EXEC_QUIET_CODES.has(r.code)) return 'quiet';
  if (EXEC_WARN_CODES.has(r.code)) return 'warn';
  if (EXEC_FAIL_CODES.has(r.code)) return 'fail';
  return r.ok ? 'quiet' : 'fail'; // a code never seen before: a refusal is a failure, a success is routine
}
// Everything below ends up in the dashboard via innerHTML, so nothing reaches it with markup characters in it.
function cleanExecText(v, max) { return String(v == null ? '' : v).replace(/[<>&"'`\\\r\n]/g, ' ').trim().slice(0, max); }

// A report for an open that DID land on Bybit. If the trade log has no entry for it (the order call's own reply was lost, or
// the relay restarted in between), the report itself is enough to write the entry: nothing opened on Bybit stays invisible.
const EXEC_LANDED_CODES = new Set(['OK', 'DUP', 'PAPER', 'SCALED', 'LEVCLMP', 'NOTRL']);
// Opened (or refused) in a way the owner should hear about at once, not discover later.
const EXEC_ALERT_TEXT = {
  BAL: 'not enough free balance on the master account', MINQ: "the size was under Bybit's minimum", PAIR: 'the pair is not on Bybit',
  LEV: 'Bybit rejected the leverage', NET: "the relay could not reach Bybit", BYBIT: 'Bybit refused the order', BAD: 'the command was malformed',
  HELD: 'the master account already holds this pair', SIDE: 'the open position is on the other side',
  NOTRL: 'it opened but the trailing stop was NOT set',
};

let reconcileTimer = null;
// Records one execution report (dashboard row, trade-log healing, alerts). Used by POST /api/exec-report (the manager ESP32)
// and by the server's own trade execution (POST /api/trade). Returns false when the report has no id or kind.
function ingestExecReport(b) {
  if (!b || !b.id || !b.kind) return false;
  const rec = {
    id: cleanExecText(b.id, 20), bot: cleanExecText(b.bot || '?', 30), kind: cleanExecText(b.kind, 10),
    side: cleanExecText(b.side, 5), symbol: cleanExecText(b.symbol, 20), ok: b.ok === true,
    code: cleanExecText(b.code, 8), detail: cleanExecText(b.detail, 160), at: Date.now(),
  };
  const idx = execReports.findIndex(r => r.id === rec.id && r.bot === rec.bot);
  const isNew = idx < 0;
  if (idx >= 0) execReports[idx] = rec; else execReports.unshift(rec);
  if (execReports.length > MAX_EXEC_REPORTS) execReports.length = MAX_EXEC_REPORTS;
  saveExecReports();
  multiuser.recordExec(rec).catch(e => console.error('[multiuser] recordExec:', e.message));
  if (!rec.ok) console.error('[exec-report] FAILED', rec.kind, rec.symbol, rec.code, rec.detail);

  if (rec.kind === 'TRADE') {
    if (EXEC_LANDED_CODES.has(rec.code)) {
      const side = rec.side === 'BUY' ? 'Buy' : (rec.side === 'SELL' ? 'Sell' : '');
      if (side && rec.symbol) {
        const healed = logMasterOpen({ orderLinkId: 'ym-' + rec.id, symbol: rec.symbol, side, source: 'exec-report' });
        if (healed) console.warn('[sync] trade log had no entry for', rec.symbol, rec.id, '- written from the manager report');
      }
      // look at Bybit itself a few seconds later: positions are the source of truth, the log just follows them
      if (!reconcileTimer) { reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcileMasterPositions().catch(() => {}); }, 4000); if (reconcileTimer.unref) reconcileTimer.unref(); }
    }
    if (isNew && EXEC_ALERT_TEXT[rec.code]) {
      const who = rec.bot.replace('YM ORACLE ', 'Oracle ');
      const noUsers = rec.code !== 'NOTRL';
      sendOfflineAlertTelegram('⚠️ ' + who + ' ' + rec.symbol.replace('USDT', '') + ' ' + (rec.side === 'BUY' ? 'long' : 'short') + ': ' + EXEC_ALERT_TEXT[rec.code] + '.' + (noUsers ? ' This trade was not placed on the master account, so it was not copied to users.' : ''));
    }
  }
  return true;
}
app.post('/api/exec-report', requireDevice, (req, res) => {
  if (!ingestExecReport(req.body || {})) return res.status(400).json({ success: false, message: 'id and kind are required' });
  return res.status(200).json({ success: true });
});

// ---- MASTER SYNC (v1.6) -----------------------------------------------------------------------------------------------
// Bybit is the source of truth for what the master account holds. Every minute (while live) the open positions are compared
// with the trade log and any position the log does not know about is added, so a trade can never be open and invisible.
const syncStatus = { lastRunAt: 0, lastOkAt: 0, masterOpen: null, loggedOpen: null, recoveredTotal: 0, lastRecovered: null, staleOpen: 0, lastError: null };
let reconciling = false;
async function reconcileMasterPositions() {
  if (TRADE_MODE !== 'live' || !API_KEY || reconciling) return;
  reconciling = true;
  syncStatus.lastRunAt = Date.now();
  try {
    const open = [];
    let cursor;
    do {
      const r = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT', limit: 200, cursor });
      if (r.retCode !== 0) throw new Error('Bybit ' + r.retCode + ': ' + r.retMsg);
      for (const p of (r.result.list || [])) if (parseFloat(p.size) > 0) open.push(p);
      cursor = r.result.nextPageCursor || undefined;
    } while (cursor);
    const trades = readTradeLog();
    const logged = trades.filter(t => t.status === 'OPEN');
    for (const p of open) {
      if (logged.some(t => t.symbol === p.symbol && t.side === p.side)) continue;
      const pos0 = v => (v && Number(v) > 0 ? String(v) : null);
      const made = logMasterOpen({ symbol: p.symbol, side: p.side, qty: p.size, leverage: p.leverage, takeProfit: pos0(p.takeProfit), stopLoss: pos0(p.stopLoss), source: 'reconcile',
        openedAt: Number(p.createdTime) > 0 ? new Date(Number(p.createdTime)).toISOString() : null });
      if (made) { syncStatus.recoveredTotal++; syncStatus.lastRecovered = { at: Date.now(), symbol: p.symbol, side: p.side }; console.warn('[sync] recovered an unlogged master position:', p.symbol, p.side); }
    }
    const now = Date.now();
    syncStatus.staleOpen = logged.filter(t => !open.some(p => p.symbol === t.symbol && p.side === t.side) && now - new Date(t.openedAt || 0).getTime() > 120000).length;
    syncStatus.masterOpen = open.length;
    syncStatus.loggedOpen = readTradeLog().filter(t => t.status === 'OPEN').length;
    syncStatus.lastOkAt = Date.now();
    syncStatus.lastError = null;
  } catch (e) { syncStatus.lastError = String(e.message || e).slice(0, 160); }
  finally { reconciling = false; }
}
app.get('/api/sync-status', requireDashboardAuth, (req, res) => res.status(200).json({ success: true, mode: TRADE_MODE, ...syncStatus }));

app.get('/api/exec-reports', requireDashboardAuth, (req, res) => {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const reports = execReports.slice(0, 30).map(r => ({
    ...r, sev: execSeverity(r), text: EXEC_CODE_TEXT[r.code] || r.code || 'Unknown',
  }));
  const recent = reports.filter(r => r.at >= dayAgo);
  const nFail = recent.filter(r => r.sev === 'fail').length;
  const nWarn = recent.filter(r => r.sev === 'warn').length;
  return res.status(200).json({
    success: true, reports,
    // the dot beside Ping: the worst thing in the last 24h, whether or not the strip has been dismissed
    status24h: nFail ? 'red' : (nWarn ? 'amber' : 'green'),
    counts24h: { ok: recent.length - nFail - nWarn, warn: nWarn, failed: nFail },
  });
});

app.get('/api/trade-log', requireDashboardAuth, async (req, res) => {
  try {
    let trades = readTradeLog();

    try {
      const closedRes = await restClient.getClosedPnL({ category: 'linear', limit: 100 });
      if (closedRes.retCode === 0) {
        const closedList = closedRes.result.list || [];
        const clearedAt = readClearedAt();
        for (const closed of closedList) {
          const alreadyLogged = trades.some(t => t.bybitOrderId === closed.orderId);
          if (alreadyLogged) continue;
          if (clearedAt && parseInt(closed.updatedTime, 10) <= clearedAt) continue; // closed before the user pressed Clear -- stays hidden

          const marginUsed = parseFloat(closed.cumEntryValue) / parseFloat(closed.leverage || '1');
          const realizedPnl = parseFloat(closed.closedPnl);
          const roiPct = marginUsed > 0 ? (realizedPnl / marginUsed) * 100 : 0;

          const matchIdx = trades.findIndex(t => t.status === 'OPEN' && t.symbol === closed.symbol && t.side === closed.side);
          if (matchIdx !== -1) {
            trades[matchIdx] = {
              ...trades[matchIdx],
              bybitOrderId: closed.orderId,
              leverage: closed.leverage,
              status: 'CLOSED',
              closedAt: new Date(parseInt(closed.updatedTime, 10)).toISOString(),
              exitPrice: closed.avgExitPrice,
              realizedPnl: realizedPnl.toFixed(4),
              roiPct: roiPct.toFixed(2),
            };
          } else {
            trades.push({
              id: closed.orderId,
              bybitOrderId: closed.orderId,
              openedAt: null,
              symbol: closed.symbol,
              side: closed.side,
              qty: closed.qty,
              leverage: closed.leverage,
              takeProfit: null,
              stopLoss: null,
              mode: 'unknown',
              status: 'CLOSED',
              closedAt: new Date(parseInt(closed.updatedTime, 10)).toISOString(),
              exitPrice: closed.avgExitPrice,
              realizedPnl: realizedPnl.toFixed(4),
              roiPct: roiPct.toFixed(2),
              externalOrigin: true,
            });
          }
        }
        writeTradeLog(trades);
      }
    } catch (syncError) {
      console.error('[trade-log] Closed-PnL sync failed:', syncError.message);
    }

    trades.sort((a, b) => new Date(b.closedAt || b.openedAt) - new Date(a.closedAt || a.openedAt));
    return res.status(200).json({ success: true, count: trades.length, trades });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Clear trade log — REAL FEATURE ADDED at the user's explicit
// request. This only clears THIS relay's own local record. It does
// NOT and cannot erase Bybit's own actual trade history -- that's the
// real, permanent record of what happened to your account and stays
// exactly as it is. This just resets what the dashboard shows locally;
// the very next /api/trade-log read will re-sync from Bybit's
// closed-PnL history from scratch (any trade Bybit still remembers
// will reappear, since that data lives on their side, not this
// service's local file).
// 10. Status, halt, resume — REAL FEATURE ADDED at the user's explicit
// request, needed for the dashboard's Halt trading control to actually
// do something. Halting blocks NEW order/trading-stop submissions
// only -- it does not touch positions already open on Bybit.
// REAL FEATURE ADDED at the user's explicit request: Render's free tier spins this service down after ~15
// minutes with no incoming traffic, and the manager -- the one device that used to generate any regular traffic
// here at all -- is exactly the thing offline alerting needs to notice going quiet. If it disconnects, nothing
// else reaches this backend either, so it falls asleep, and the background check that would have caught it can't
// run while asleep. Deliberately NOT behind requireDashboardAuth: an external uptime pinger has no password and
// needs a plain, fast, always-answerable URL. Returns almost nothing on purpose -- no balance, no trade data,
// nothing worth protecting -- so there is no reason to authenticate it.
app.get('/api/health', (req, res) => {
  res.status(200).json({ ok: true, now: Date.now() });
});

app.get('/api/status', requireDashboardAuth, (req, res) => {
  res.status(200).json({ mode: TRADE_MODE, testnet: IS_TESTNET, demo: IS_DEMO, masterEnv: masterEnvName(), breaker: breakerStatus() });
});
app.post('/api/halt', requireDashboardAuth, (req, res) => {
  breakerTrip((req.body && req.body.reason) || 'manually halted via dashboard');
  res.status(200).json({ success: true, status: breakerStatus() });
});
app.post('/api/resume', requireDashboardAuth, (req, res) => {
  breakerReset();
  res.status(200).json({ success: true, status: breakerStatus() });
});

// REAL FEATURE ADDED at the user's explicit request: switching TO live
// requires the caller to send confirm:"LIVE" verbatim -- a real,
// deliberate step, not just a click. Switching to paper never needs
// this, since it's always the safe direction. Mismatched confirm text
// is rejected with 400, same status a validation failure gets
// elsewhere in this file.
app.post('/api/mode', requireDashboardAuth, (req, res) => {
  const { mode, confirm } = req.body || {};
  if (mode !== 'paper' && mode !== 'live') {
    return res.status(400).json({ success: false, message: 'mode must be "paper" or "live"' });
  }
  if (mode === 'live' && confirm !== 'LIVE') {
    return res.status(400).json({ success: false, message: 'Switching to live requires confirm:"LIVE"' });
  }
  setMode(mode);
  res.status(200).json({ success: true, mode: TRADE_MODE });
});

app.post('/api/clear-trade-log', requireDashboardAuth, (req, res) => {
  writeTradeLog([]);
  writeClearedAt(Date.now());
  return res.status(200).json({ success: true, message: 'Trade log cleared' });
});

// Global Exception Safety Net
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ---- SERVER-SIDE TRADE EXECUTION (POST /api/trade) -------------------------------------------------------------------------
// A bot sends ONE request with its decision; the server does what the manager ESP32 used to do with ~8 HTTPS calls (balance, held-pair
// check, instrument rules, leverage, quantity, order, wait for the position, trailing stop). See tradeexec.js. The manager path
// (/api/order etc.) is unchanged and keeps working, so bots can be moved over one at a time.
// A 200 answer is final for that id (ok:true/false + a code); a 5xx or a timeout means "ask again with the same id" (safe: ids are idempotent).
const tradeExec = require('./tradeexec').create({
  rest: () => restClient,
  mode: () => TRADE_MODE,
  halted: () => breakerIsTripped(),
  placeOrder: body => processOrder(body),
  fanOutLeverage: b => multiuser.fanOutLeverage(b),
  fanOutTradingStop: b => multiuser.fanOutTradingStop(b),
  report: rec => ingestExecReport(rec),
  log: (...a) => console.log(...a),
});
app.post('/api/trade', requireDevice, async (req, res) => {
  try {
    const r = await tradeExec.run(req.body);
    return res.status(r.http).json(r.body);
  } catch (error) {
    console.error('[trade]', error && error.message);
    return res.status(500).json({ success: false, error: 'trade execution failed, ask again with the same id' });
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// Never leak stack traces or internals to a client (Express's default error page does exactly that outside production).
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err && err.message);
  if (res.headersSent) return next(err);
  res.status(err && err.status && err.status < 500 ? err.status : 500).json({ success: false, message: 'Request error' });
});

app.listen(PORT, () => {
  if (!DASHBOARD_PASSWORD) console.warn('[security] WARNING: DASHBOARD_PASSWORD is not set -- the dashboard, halt and mode switches are open to anyone, and /admin is disabled.');
  if (!DEVICE_API_KEY) console.warn('[security] WARNING: DEVICE_API_KEY is not set -- anyone who finds this URL can place trades through /api/order' + (process.env.DATABASE_URL ? ', and with multi-user on that reaches EVERY user account.' : '.'));
  else if (DEVICE_KEY_MODE === 'warn') console.warn('[security] DEVICE_API_KEY set in WARN mode: requests without the key are logged but still accepted. Set DEVICE_KEY_MODE=enforce once your ESP32s send it.');
  console.log(`YM Oracle relay running on port ${PORT}`);
  const rt = setInterval(() => reconcileMasterPositions().catch(() => {}), 60000); if (rt.unref) rt.unref();
  setTimeout(() => reconcileMasterPositions().catch(() => {}), 15000).unref();
  console.log(`TRADE_MODE=${TRADE_MODE}${TRADE_MODE === 'paper' ? '  (no real orders will be submitted)' : ''}`);
  console.log(`Bybit endpoint: ${BYBIT_BASE_URL ? `EXPLICIT OVERRIDE (${BYBIT_BASE_URL})` : IS_DEMO ? 'DEMO TRADING (api-demo.bybit.com)' : IS_TESTNET ? 'TESTNET' : 'LIVE MAINNET'}`);
});
