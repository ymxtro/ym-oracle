// End-to-end test of multiuser.js + security.js against a REAL local Postgres, with Bybit and Telegram stubbed.
const R = process.env.RELAY_DIR || '/home/claude/relay';
process.env.DATABASE_URL = 'postgres://postgres@localhost:54329/postgres';
process.env.DATABASE_SSL = 'false';
process.env.KEY_ENCRYPTION_SECRET = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.DASHBOARD_PASSWORD = 'admin-pass-123';
process.env.ALERT_TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
process.env.ALERT_TELEGRAM_CHAT_ID = '9001';
process.env.MAX_USER_LEVERAGE = '10';

const assert = require('assert');
const sec = require(R + '/security.js');
const state = { submits: [], stops: [], levs: [], positions: {}, equity: { ADMINK: 1000, KEYA: 500, KEYB: 200 }, submitRet: {}, closedPnl: {}, funding: {}, fillPrice: '65065' };

class Stub {
  constructor(o) { this.k = o.key; this.o = o; (state.ctor = state.ctor || []).push({ k: o.key, demo: !!o.demoTrading, testnet: !!o.testnet }); }
  async getQueryApiKey() {
    if (this.k === 'WDKEY') return { retCode: 0, result: { readOnly: 0, permissions: { ContractTrade: ['Order'], Wallet: ['AccountTransfer', 'Withdraw'] }, ips: '1.2.3.4' } };
    if (this.k === 'ROKEY') return { retCode: 0, result: { readOnly: 1, permissions: { ContractTrade: [], Wallet: [] }, ips: '*' } };
    return { retCode: 0, result: { readOnly: 0, permissions: { ContractTrade: ['Order', 'Position'], Wallet: ['AccountTransfer'] }, ips: '1.2.3.4' } };
  }
  async getWalletBalance() {
    if (state.failAdmin && this.k === 'ADMINK') throw new Error('socket hang up');
    const e = state.equity[this.k];
    if (e === undefined) return { retCode: 10003, retMsg: 'API key is invalid' };
    return { retCode: 0, result: { list: [{ totalAvailableBalance: String(e), coin: [{ coin: 'USDT', equity: String(e), walletBalance: String(e) }] }] } };
  }
  async getPositionInfo({ symbol }) {
    if (symbol) { const p = state.positions[this.k + ':' + symbol]; return { retCode: 0, result: { list: [p ? { symbol, leverage: '10', positionIdx: 0, ...p } : { symbol, size: '0', side: '', leverage: '10', positionIdx: 0 }] } }; }
    const list = Object.keys(state.positions).filter(x => x.startsWith(this.k + ':')).map(x => ({ symbol: x.split(':')[1], leverage: '10', positionIdx: 0, ...state.positions[x] }));
    return { retCode: 0, result: { list, nextPageCursor: '' } };
  }
  async cancelAllOrders() { state.cancels = (state.cancels || 0) + 1; return { retCode: 0 }; }
  async getInstrumentsInfo() { return { retCode: 0, result: { list: [{ status: 'Trading', lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01' } }] } }; }
  async getTickers({ symbol } = {}) { return { retCode: 0, result: { list: [{ lastPrice: String((state.tickers || {})[symbol] || 65000) }] } }; }
  async getHistoricOrders({ orderLinkId }) { if (state.orderReadFails) throw new Error('timeout'); const o = (state.orders || {})[orderLinkId]; if (o) return { retCode: 0, result: { list: o.active ? [] : [o] } }; if (orderLinkId && /^u\d+-pend/.test(orderLinkId)) return { retCode: 0, result: { list: [] } }; return { retCode: 0, result: { list: [{ avgPrice: state.fillPrice }] } }; }
  async getActiveOrders({ orderLinkId }) { if (state.orderReadFails) throw new Error('timeout'); const o = (state.orders || {})[orderLinkId]; return { retCode: 0, result: { list: o && o.active ? [o] : [] } }; }
  async submitOrder(b) {
    if (state.submitThrow > 0) { state.submitThrow--; state.submitThrown = (state.submitThrown || 0) + 1; throw new Error('socket hang up'); }
    state.submits.push({ k: this.k, body: b }); (state.submitEnv = state.submitEnv || []).push({ k: this.k, demo: !!this.o.demoTrading });
    if (state.submitRet[this.k]) return state.submitRet[this.k];
    if (!b.reduceOnly) state.positions[this.k + ':' + b.symbol] = { side: b.side, size: b.qty };
    else delete state.positions[this.k + ':' + b.symbol];
    return { retCode: 0, result: { orderId: 'oid-' + state.submits.length } };
  }
  async setTradingStop(b) { state.stops.push({ k: this.k, b }); return { retCode: 0 }; }
  async setLeverage(b) { state.levs.push({ k: this.k, b }); return { retCode: 0 }; }
  async getClosedPnL() { return { retCode: 0, result: { list: state.closedPnl[this.k] || [], nextPageCursor: '' } }; }
  async getTransactionLog() { return { retCode: 0, result: { list: state.funding[this.k] || [], nextPageCursor: '' } }; }
}
const resolved = require.resolve('bybit-api', { paths: [R] });
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { RestClientV5: Stub } };

// Telegram stub (everything else goes to the real fetch, i.e. our local server)
const realFetch = global.fetch;
const tg = { sent: [], docs: [], updates: [] };
global.fetch = async (url, opts) => {
  if (String(url).includes('api.telegram.org')) {
    const method = String(url).split('/').pop();
    const ok = (result) => ({ json: async () => ({ ok: true, result }) });
    if (method === 'sendMessage') { tg.sent.push(JSON.parse(opts.body)); return ok({}); }
    if (method === 'sendDocument') { const fd = opts.body; tg.docs.push({ chat: fd.get('chat_id'), name: fd.get('document').name, text: await fd.get('document').text() }); return ok({}); }
    if (method === 'getUpdates') { const u = tg.updates; tg.updates = []; return ok(u); }
    return ok({});
  }
  return realFetch(url, opts);
};

const SYNC = { mode: 'live', lastOkAt: Date.now() - 30000, lastRunAt: Date.now() - 30000, masterOpen: 2, loggedOpen: 2, recoveredTotal: 1, lastRecovered: { at: Date.now() - 3600000, symbol: 'ETHUSDT', side: 'Buy' }, staleOpen: 0, lastError: null };
const FLEET = { last: { 'YM ORACLE I': Date.now() - 5000, 'YM ORACLE II': Date.now() - 900000 }, info: { 'YM ORACLE I': { uptimeMin: 5, freeHeap: 28588, resetReason: 'POWER_ON', build: 'final-7', relayOn: false, relayMarginUsd: 100 } }, offlineMs: 120000 };
const express = require(R + '/node_modules/express');
const app = express(); app.use(express.json());
let mode = 'live', halted = false; const alerts = [], tradeAlerts = [], tradeOpts = []; let deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' };
const arMod = require(R + '/alertroute.js'); const arState = { cfg: arMod.defaults() }; const alertRouterState = () => arState;
const mu = require(R + '/multiuser.js').init({
  app, restClient: new Stub({ key: 'ADMINK' }), getMode: () => mode, breakerIsTripped: () => halted,
  getSecurityInfo: () => ({ deviceKeySet: false, deviceKeyMode: 'warn', deviceKeyMisses: 0 }),
  sendAlert: t => alerts.push(t), deliverAlert: async (t, o) => { tradeAlerts.push(t); tradeOpts.push(o || {}); return deliverResult; },
  alertRouter: { state: arState, route: arMod, envChats: () => ({ groupChat: '-100500', dmChat: '900' }), tokenSet: () => true }, baseOpts: {},
  getFleet: () => FLEET,
  getMasterSync: () => SYNC,
  getExecReports: () => [],
});
assert(mu.enabled, 'multiuser should be enabled');


// stand-ins for the trading routes in server.js, guarded the same way (an admin console token is enough)
let tMode = 'paper', tHalt = false; const tCalls = [];
const tGuard = async (req, res, next) => { const m = /^Bearer (.+)$/.exec(req.get('Authorization') || ''); if (m && await mu.verifyAdminToken(m[1])) return next(); res.status(401).json({ success: false, message: 'Unauthorized' }); };
app.get('/api/status', tGuard, (req, res) => res.json({ success: true, mode: tMode, breaker: { tripped: tHalt } }));
app.get('/api/balance', tGuard, (req, res) => res.json({ success: true, balance: 1234.5, available: 1000 }));
app.get('/api/positions', tGuard, (req, res) => res.json({ success: true, positions: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0.01', leverage: '5', entryPrice: '65000', markPrice: '65500', positionValue: '655', unrealisedPnl: '5' }] }));
app.get('/api/trade-log', tGuard, (req, res) => res.json({ success: true, trades: [{ status: 'CLOSED', symbol: 'ETHUSDT', side: 'Sell', realizedPnl: '12.5', roiPct: '4.2', closedAt: new Date(Date.now() - 3600000).toISOString() }, { status: 'CLOSED', symbol: 'SOLUSDT', side: 'Buy', realizedPnl: '-3', roiPct: '-1', closedAt: new Date(Date.now() - 7200000).toISOString() }] }));
app.get('/api/sync-status', tGuard, (req, res) => res.json({ success: true, mode: tMode, lastOkAt: Date.now() - 5000, masterOpen: 1, staleOpen: 0 }));
app.get('/api/exec-reports', tGuard, (req, res) => res.json({ success: true, reports: [{ at: Date.now() - 60000, sev: 'fail', kind: 'TRADE', symbol: 'XRPUSDT', side: 'BUY', text: 'Bybit refused it', detail: 'insufficient balance' }] }));
app.post('/api/mode', tGuard, (req, res) => { tCalls.push(['mode', req.body]); tMode = req.body.mode; res.json({ success: true, mode: tMode }); });
app.post('/api/halt', tGuard, (req, res) => { tCalls.push(['halt']); tHalt = true; res.json({ success: true }); });
app.post('/api/resume', tGuard, (req, res) => { tCalls.push(['resume']); tHalt = false; res.json({ success: true }); });
app.get('/api/master-key', tGuard, (req, res) => res.json({ success: true, hint: '…AB12', hasKey: true, env: 'live', source: 'env', canSave: true }));
app.post('/api/master-key', tGuard, (req, res) => { tCalls.push(['key', req.body]); res.json({ success: true, hint: '…ZZ99', env: req.body.env, equity: 50 }); });
app.post('/api/ping-fleet', tGuard, (req, res) => res.json({ success: true, pingId: 'p1' }));
app.get('/api/ping-status/:id', tGuard, (req, res) => res.json({ success: true, results: { 'YM ORACLE I': { ms: 120 }, 'YM ORACLE II': { timeout: true }, 'YM ORACLE III': { ms: 300 }, 'YM ORACLE IV': { ms: 90 } } }));
const srv = app.listen(0);
const base = 'http://127.0.0.1:' + srv.address().port;
let ipn = 10;
const call = async (p, method, body, hdr) => {
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.' + Math.floor(++ipn / 250) + '.' + (ipn % 250), ...(hdr || {}) };
  const r = await realFetch(base + p, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json(), h: r.headers };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = (m) => console.log('  ok', ++n, m);

(async () => {
  await sleep(800);
  const { Pool } = require(R + '/node_modules/pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  await db.query('TRUNCATE users, invites, audit_log, admin_sessions, meta, plan_versions, pnl_ledger_old, funding_ledger_old, master_log, signals, bot_status, bot_msgs RESTART IDENTITY CASCADE');

  // ---------- pure bits ----------
  const T = mu._test;
  const k = Buffer.from(process.env.KEY_ENCRYPTION_SECRET, 'hex');
  assert.strictEqual(T.decrypt(T.encrypt('secret-xyz', k), k), 'secret-xyz');
  assert.throws(() => { const e = T.encrypt('a', k).split('.'); e[2] = Buffer.from('zz').toString('base64'); T.decrypt(e.join('.'), k); });
  ok('AES-GCM roundtrip + tamper detection');
  assert.deepStrictEqual(T.scaleQty({ adminQty: 0.1, adminEquity: 1000, userEquity: 500, mult: 1, qtyStep: 0.01, minQty: 0.01, maxRatio: 10 }), { qty: 0.05, code: 'OK', capped: false });
  assert.strictEqual(T.scaleQty({ adminQty: 0.1, adminEquity: 1000, userEquity: 5, mult: 1, qtyStep: 0.01, minQty: 0.01, maxRatio: 10 }).code, 'MINQ');
  ok('size scaling');
  assert.strictEqual(sec.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082'); // RFC 6238 test vector
  ok('TOTP matches the RFC 6238 test vector');
  assert(T.sanitizeOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.1', evil: 'x', apiKey: 'steal' }) && !('evil' in T.sanitizeOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.1', evil: 'x' })));
  for (const bad of [{ symbol: 'BTCUSDT', side: 'Buy', qty: '-1' }, { symbol: 'btc;drop', side: 'Buy', qty: '1' }, { symbol: 'BTCUSDT', side: 'Hold', qty: '1' }, { symbol: 'BTCUSDT', side: 'Buy', qty: 'abc' }, { symbol: 'BTCUSDT', side: 'Buy', qty: '1', orderType: 'Conditional' }, null, 'x'])
    assert.strictEqual(T.sanitizeOrder(bad), null, JSON.stringify(bad));
  assert.strictEqual(T.sanitizeLeverage({ symbol: 'BTCUSDT', buyLeverage: 50, sellLeverage: 50 }, 10).buyLeverage, '10');
  assert.strictEqual(T.sanitizeLeverage({ symbol: 'BTCUSDT', buyLeverage: 500, sellLeverage: 5 }, 0), null);
  assert.strictEqual(T.csvCell('-30.5000'), '-30.5000'); assert.strictEqual(T.csvCell('=cmd|x'), "'=cmd|x");
  ok('order/leverage sanitising: junk rejected, unknown fields stripped, leverage capped, CSV formula guard keeps negatives');

  // ---------- admin login ----------
  const pageA = await realFetch(base + '/admin');
  assert(/frame-ancestors 'none'/.test(pageA.headers.get('content-security-policy')) && pageA.headers.get('x-frame-options') === 'DENY' && /max-age/.test(pageA.headers.get('strict-transport-security')));
  ok('/admin page ships CSP, X-Frame-Options and HSTS headers');
  assert.strictEqual((await call('/api/admin/users')).s, 401);
  assert.strictEqual((await call('/api/admin/users', 'GET', null, { 'X-Dashboard-Password': 'admin-pass-123' })).s, 401);
  assert.strictEqual((await call('/api/admin/login', 'POST', { password: 'wrong' })).s, 401);
  const lg0 = await call('/api/admin/login', 'POST', { password: 'admin-pass-123' }); assert(lg0.j.token);
  const admin = { Authorization: 'Bearer ' + lg0.j.token };
  await call('/api/admin/plan', 'POST', T.PLAN_DEFAULT, admin); // a plan left in memory from an earlier run must not leak into this one
  assert.strictEqual((await call('/api/admin/users', 'GET', null, admin)).s, 200);
  ok('admin needs a session login (old password header no longer works on admin routes)');
  process.env.ADMIN_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const need = await call('/api/admin/login', 'POST', { password: 'admin-pass-123' }); assert(need.j.needTotp && !need.j.token);
  assert.strictEqual((await call('/api/admin/login', 'POST', { password: 'admin-pass-123', totp: '000000' })).s, 401);
  const goodCode = sec.totpCode(process.env.ADMIN_TOTP_SECRET);
  const lg1 = await call('/api/admin/login', 'POST', { password: 'admin-pass-123', totp: goodCode }); assert(lg1.j.token);
  assert.strictEqual((await call('/api/admin/login', 'POST', { password: 'admin-pass-123', totp: goodCode })).s, 401); // replayed code
  delete process.env.ADMIN_TOTP_SECRET;
  ok('admin 2FA: code required when configured, wrong code rejected, replayed code rejected');
  const ipHdr = { 'X-Forwarded-For': '9.9.9.9' };
  let last;
  for (let i = 0; i < 9; i++) last = await call('/api/admin/login', 'POST', { password: 'nope' + i }, ipHdr);
  assert.strictEqual(last.s, 429);
  assert.strictEqual((await call('/api/admin/login', 'POST', { password: 'admin-pass-123' }, ipHdr)).s, 429);
  ok('admin brute force: locked out after 8 tries, even the right password is refused while locked');
  const savedPw = process.env.DASHBOARD_PASSWORD; delete process.env.DASHBOARD_PASSWORD;
  assert.strictEqual((await call('/api/admin/login', 'POST', { password: '' })).s, 503);
  assert.strictEqual((await call('/api/admin/users', 'GET', null, admin)).s, 503);
  process.env.DASHBOARD_PASSWORD = savedPw;
  ok('with no DASHBOARD_PASSWORD set, admin refuses to work at all (never "open by default")');

  // ---------- signup / auth ----------
  const inv = (await call('/api/admin/invites', 'POST', { count: 4 }, admin)).j.codes;
  const su = (o) => call('/api/auth/signup', 'POST', { username: 'alice', password: 'correct-horse-9', inviteCode: inv[0], apiKey: 'KEYA', apiSecret: 'sec', ...o });
  assert.strictEqual((await su({ inviteCode: 'NOPE' })).s, 400);
  const w = await su({ apiKey: 'WDKEY' }); assert.strictEqual(w.s, 400); assert(/withdraw/i.test(w.j.message));
  assert.strictEqual((await su({ apiKey: 'ROKEY' })).s, 400);
  assert.strictEqual((await su({ password: 'short' })).s, 400);
  assert.strictEqual((await su({ apiKey: 'BADKEY' })).s, 400);
  const a = await su({}); assert.strictEqual(a.s, 200);
  const b = await call('/api/auth/signup', 'POST', { username: 'bob', password: 'another-pass-10', inviteCode: inv[1], apiKey: 'KEYB', apiSecret: 'sec', sizePct: 30, confirmHigh: true });
  assert.strictEqual(b.s, 200);
  assert.strictEqual((await su({ apiKey: 'KEYB' })).s, 400);
  ok('signup rules (invite single-use, withdrawal/read-only/dead keys rejected, duplicates rejected)');
  const raw = (await db.query('SELECT key_enc FROM users WHERE username=$1', ['alice'])).rows[0].key_enc;
  assert(!raw.includes('KEYA') && !Buffer.from(raw.split('.')[2], 'base64').toString().includes('KEYA'));
  ok('API key stored encrypted');
  const lgA = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' });
  const hA = { Authorization: 'Bearer ' + lgA.j.token };
  assert.strictEqual((await call('/api/me', 'GET', null, hA)).j.username, 'alice');

  // ---------- copy trading ----------
  await mu.fanOutLeverage({ symbol: 'BTCUSDT', buyLeverage: 50, sellLeverage: 50 });
  assert(state.levs.length === 2 && state.levs.every(l => l.b.buyLeverage === '10'));
  ok('leverage forwarded to users but capped at MAX_USER_LEVERAGE');
  await mu.fanOutOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.10', takeProfit: '70000', stopLoss: '60000', evil: 'injected', apiKey: 'steal' });
  const sA = state.submits.find(s => s.k === 'KEYA'), sB = state.submits.find(s => s.k === 'KEYB');
  assert.strictEqual(sA.body.qty, '0.01'); assert.strictEqual(sB.body.qty, '0.01'); // alice 20% of $500 = $100 -> 0.0153 -> 0.01; bob 30% of $200 = $60 -> 0.0092, rounded up to the 0.01 minimum
  assert(!('evil' in sA.body) && !('apiKey' in sA.body)); assert(sA.body.orderLinkId.length <= 36);
  ok('users sized by their own equity; unknown/injected fields never reach their orders');
  const before = state.submits.length;
  delete state.positions['KEYA:BTCUSDT']; delete state.positions['KEYB:BTCUSDT'];
  await mu.fanOutOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.10', takeProfit: '70000', stopLoss: '60000' });
  assert.strictEqual(state.submits.length, before);
  ok('retransmitted signal does not double-trade');
  await mu.fanOutOrder({ symbol: 'BTCUSDT; DROP', side: 'Buy', qty: '1' }); assert.strictEqual(state.submits.length, before);
  ok('invalid signal is dropped before it reaches any user');

  // slippage (reference 65000, fill 65065 on a Buy = +10 bp)
  await sleep(3600);
  const slip = (await db.query(`SELECT slippage_bps FROM order_log WHERE kind='ORDER' AND slippage_bps IS NOT NULL LIMIT 1`)).rows[0];
  assert(slip && Math.abs(Number(slip.slippage_bps) - 10) < 0.01, 'slippage ' + JSON.stringify(slip));
  ok('slippage recorded against the market price at signal time (+10 bp)');

  // pause: opens blocked, closes allowed
  await call('/api/me/pause', 'POST', { paused: true }, hA);
  const b3 = state.submits.length;
  state.positions['KEYA:SOLUSDT'] = { side: 'Buy', size: '3.5' };
  await mu.fanOutOrder({ category: 'linear', symbol: 'XRPUSDT', side: 'Buy', qty: '10' });
  assert(!state.submits.slice(b3).some(s => s.k === 'KEYA'));
  await mu.fanOutOrder({ category: 'linear', symbol: 'SOLUSDT', side: 'Sell', qty: '999', reduceOnly: true });
  const cl = state.submits.slice(b3).find(s => s.k === 'KEYA' && s.body.reduceOnly); assert(cl && cl.body.qty === '3.5');
  await call('/api/me/pause', 'POST', { paused: false }, hA);
  ok('pause stops opens only; closes use the user\'s own position size');
  state.positions['KEYB:BTCUSDT'] = { side: 'Buy', size: '0.02' };
  await mu.fanOutTradingStop({ symbol: 'BTCUSDT', stopLoss: '61000', positionIdx: 0, hax: 'x' });
  assert(state.stops.length === 1 && state.stops[0].k === 'KEYB' && !('hax' in state.stops[0].b));
  await mu.fanOutTradingStop({ symbol: 'BTCUSDT', positionIdx: 0 }); assert.strictEqual(state.stops.length, 1);
  ok('stop updates: only users holding the pair, fields whitelisted, empty updates ignored');

  // ---------- master plan: autopilot vs manual ----------
  for (const kk of Object.keys(state.positions)) delete state.positions[kk];
  const uid = (await db.query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;
  const lastLog = async (id, kind) => (await db.query(`SELECT code, ok, detail FROM order_log WHERE user_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 1`, [id, kind || 'ORDER'])).rows[0];
  let uq = 0; const sig = (extra) => ({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: String(1 + (++uq) / 100), ...(extra || {}) });
  const aSubmits = (from) => state.submits.slice(from).filter(x => x.k === 'KEYA');
  const bSubmits = (from) => state.submits.slice(from).filter(x => x.k === 'KEYB');
  const clearPos = () => { for (const kk of Object.keys(state.positions)) delete state.positions[kk]; };
  const setPlan = (b) => call('/api/admin/plan', 'POST', b, admin);
  const setLim = (b) => call('/api/me/limits', 'POST', b, hA);
  const setAdmin = (id, b) => call('/api/admin/users/' + id, 'POST', b, admin);
  const meA = async () => (await call('/api/me', 'GET', null, hA)).j;

  // pure sizing (Standard v1): size = the user's own balance x percent (or a fixed amount), capped, rounded down; floor rule; leverage never touched
  const sz = { mode: 'fixed', sizeUsd: 20, leverage: 10, price: 65000, qtyStep: 0.001, minQty: 0.001, available: 500, userEquity: 500 };
  const z1 = T.sizeForUser(sz); assert(z1.code === 'OK' && z1.qty === 0.003 && z1.marginUsd < 20 && !z1.floored);
  assert.strictEqual(T.sizeForUser({ ...sz, sizeUsd: 1 }).code, 'MINQ');                       // $1 is far below the $6.50 minimum: skipped
  const zf = T.sizeForUser({ ...sz, sizeUsd: 5 }); assert(zf.code === 'OK' && zf.qty === 0.001 && zf.floored);   // $5 vs $6.50 needed (1.3x): rounded UP to the minimum
  const zf2 = T.sizeForUser({ ...sz, userEquity: 15, available: 15, sizeUsd: 5 }); assert.strictEqual(zf2.code, 'MINQ'); // $6.50 would be 43% of a $15 balance: refused
  assert(/smallest order/.test(T.sizeForUser({ ...sz, sizeUsd: 1, qtyStep: 0.01, minQty: 0.01 }).detail) && /\$65\.00/.test(T.sizeForUser({ ...sz, sizeUsd: 1, qtyStep: 0.01, minQty: 0.01 }).detail));
  assert.strictEqual(T.sizeForUser({ ...sz, sizeUsd: 900 }).code, 'BAL');
  assert(/free money/.test(T.sizeForUser({ ...sz, sizeUsd: 900 }).detail));
  assert.strictEqual(T.sizeForUser({ ...sz, sizeUsd: 400, maxTradeUsd: 100 }).qty, 0.015);        // the per-trade ceiling
  assert.strictEqual(T.sizeForUser({ ...sz, mode: 'percent', sizePct: 10, sizeUsd: null }).qty, 0.007);
  assert.strictEqual(T.sizeForUser({ ...sz, price: null }).code, 'NET');
  assert.strictEqual(T.sizeForUser({ ...sz, userEquity: 0 }).code, 'BAL');
  const zm = T.sizeForUser({ mode: 'match', mult: 2, userEquity: 500, available: 500, qtyStep: 0.001, minQty: 0.001, leverage: 10, price: 65000 }); // retired mode still resolves safely: 10% x 2 = 20%
  assert.strictEqual(zm.qty, 0.015);
  assert.strictEqual(T.minPositive(0, null, 10, 5), 5); assert.strictEqual(T.minPositive(0, undefined), 0);
  ok('sizing maths: % of own balance, fixed USD, per-trade cap, floor rule (rounds up to the minimum only when close and safe), plain explanations, retired "match" still safe');

  // everybody has their own settings from day one (no autopilot / manual switch)
  const hBob = { Authorization: 'Bearer ' + (await call('/api/auth/login', 'POST', { username: 'bob', password: 'another-pass-10' })).j.token };
  let me0 = await meA(); assert(me0.control === 'manual' && me0.limits.sizeMode === 'percent' && me0.limits.sizePct === 20 && me0.notice === null);
  assert.deepStrictEqual([me0.rails.maxOpenTrades, me0.rails.dailyLossPct, me0.rails.drawdownStopPct, me0.rails.maxTradeUsd], [3, 10, 30, 500]);
  const meB0 = (await call('/api/me', 'GET', null, hBob)).j; assert(meB0.limits.sizePct === 30);   // bob picked 30% when he signed up
  assert.strictEqual((await call('/api/me/mode', 'POST', { mode: 'manual', password: 'x', ack: true }, hA)).s, 200); // retired switch: harmless
  assert.strictEqual((await call('/api/me/reset-defaults', 'POST', null, hA)).s, 200);
  ok('Standard v1 defaults: every account starts at the plan\'s 20% (or what it picked at sign-up) with the three safety rails; the old mode switch is a harmless no-op');

  // master plan validation
  assert.strictEqual((await call('/api/admin/plan', 'POST', { sizeMode: 'fixed' }, hA)).s, 401); // a user token is not an admin session
  assert.strictEqual((await setPlan({ sizeMode: 'fixed' })).s, 400); // needs an amount
  assert.strictEqual((await setPlan({ sizeMode: 'match' })).s, 400); // retired
  assert.strictEqual((await setPlan({ sizeMode: 'weird' })).s, 400);
  assert.strictEqual((await setPlan({ direction: 'sideways' })).s, 400);
  assert.strictEqual((await setPlan({ maxOpenTrades: 0 })).s, 400);
  assert.strictEqual((await setPlan({ maxOpenTrades: 6 })).s, 400);    // admin maximum is 5
  assert.strictEqual((await setPlan({ symbols: ['BTC;drop'] })).s, 400);
  assert.strictEqual((await setPlan({ drawdownStopPct: 99 })).s, 400);
  assert.strictEqual((await setPlan({ dailyLossPct: 0.5 })).s, 400);
  assert.strictEqual((await setPlan({ dailyLossPct: 80 })).s, 400);
  assert.strictEqual((await setPlan({ maxTradeUsd: -5 })).s, 400);
  assert.strictEqual((await setPlan({ maxLeverage: 200 })).s, 400);    // leverage is no longer a plan setting: nothing to change
  assert.strictEqual((await setPlan({})).s, 400);
  assert.strictEqual((await setPlan({ allowManual: 'yes' })).s, 400);
  ok('master plan validation: retired match mode, bad mode / direction / counts (max 5) / coins / percentages / empty change are refused');

  // a user's own trade size
  assert.strictEqual((await setLim({ direction: 'long' })).s, 400);
  assert.strictEqual((await setLim({ symbols: ['ETH'] })).s, 400);
  assert.strictEqual((await setLim({ maxOpenTrades: 1 })).s, 400);
  assert.strictEqual((await setLim({ maxLeverage: 3 })).s, 400);     // leverage is the signal's, nobody can change it
  assert.strictEqual((await setLim({ drawdownStopPct: 5 })).s, 400);
  assert.strictEqual((await setLim({ sizeMode: 'match' })).s, 400);
  assert.strictEqual((await setLim({ sizeMode: 'fixed', sizeUsd: 0 })).s, 400);
  assert.strictEqual((await setLim({ sizeMode: 'weird' })).s, 400);
  assert.strictEqual((await setLim({ sizePct: 31 })).s, 400);        // above the 30% ceiling
  assert.strictEqual((await setLim({})).s, 400);
  const hi = await setLim({ sizePct: 25 }); assert(hi.s === 400 && hi.j.needConfirm === true); // 20-30% needs the user to confirm
  assert.strictEqual((await setLim({ sizePct: 25, confirmHigh: true })).s, 200);
  assert.strictEqual((await setLim({ sizePct: 20 })).s, 200);
  assert.strictEqual((await setLim({ sizeMode: 'fixed', sizeUsd: 200 })).s, 200);
  me0 = await meA(); assert(me0.limits.sizeMode === 'fixed' && me0.limits.sizeUsd === 200 && me0.limits.sizePct === null);
  let m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0)[0].body.qty, '0.03'); // alice: $200 x 10x / 65000 = 0.0307 -> 0.03
  assert.strictEqual(bSubmits(m0)[0].body.qty, '0.01'); // bob: 30% of $200 = $60 -> 0.0092, rounded UP to the 0.01 minimum ($65 needed: 1.08x his amount, 32% of his balance)
  clearPos();
  ok('users set their own size (percent up to 30%, 20-30% needs confirmation, fixed USD); nobody can touch leverage, coins, direction or open-trade limits');

  // below the exchange minimum: refused with a plain explanation (and the rounding-up floor does not apply when it would be too big a share)
  await setLim({ sizeMode: 'fixed', sizeUsd: 20 }); m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0); const mq = await lastLog(uid); assert(mq.code === 'MINQ' && /smallest order/.test(mq.detail) && /\$65\.00/.test(mq.detail));
  clearPos();
  await setLim({ sizeMode: 'percent', sizePct: 10 }); m0 = state.submits.length; await mu.fanOutOrder(sig()); // 10% of $500 = $50 -> needs $65 (1.3x) -> rounded up to 0.01
  assert.strictEqual(aSubmits(m0)[0].body.qty, '0.01'); clearPos();
  ok('amount far below the exchange minimum is skipped with a plain explanation; a close one is rounded up to the minimum');

  // percent
  await setLim({ sizePct: 20, sizeMode: 'percent' });
  await db.query('UPDATE users SET last_equity=500 WHERE id=$1', [uid]);
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0)[0].body.qty, '0.01'); // 20% of $500 = $100 x 10 / 65000 = 0.0153 -> 0.01
  clearPos();
  ok('% of balance sizes from each user\'s own equity');

  // coins / direction / max-open / stops come from the plan
  await setPlan({ direction: 'long' }); m0 = state.submits.length;
  await mu.fanOutOrder(sig({ side: 'Sell' }));
  assert.strictEqual(aSubmits(m0).length, 0); assert.strictEqual((await lastLog(uid)).code, 'FILT');
  await mu.fanOutOrder(sig({ side: 'Buy' })); assert.strictEqual(aSubmits(m0).length, 1);
  clearPos();
  await setPlan({ direction: 'both', symbols: ['ETH'] }); m0 = state.submits.length;
  assert.deepStrictEqual((await meA()).plan.symbols, ['ETHUSDT']);
  await mu.fanOutOrder(sig({ symbol: 'BTCUSDT' })); assert.strictEqual(aSubmits(m0).length, 0);
  await mu.fanOutOrder(sig({ symbol: 'ETHUSDT' })); assert.strictEqual(aSubmits(m0).length, 1);
  clearPos(); await setPlan({ symbols: null });
  ok('direction filter and coin list come from the plan and skip other trades quietly');

  // max open trades (standard: 3)
  assert.strictEqual((await meA()).plan.maxOpenTrades, 3);
  state.positions['KEYA:SOLUSDT'] = { side: 'Buy', size: '3' }; state.positions['KEYA:XRPUSDT'] = { side: 'Buy', size: '3' }; state.positions['KEYA:DOGEUSDT'] = { side: 'Buy', size: '3' }; m0 = state.submits.length;
  await mu.fanOutOrder(sig()); assert.strictEqual(aSubmits(m0).length, 0); const mx = await lastLog(uid); assert(mx.code === 'MAXT' && /limit is 3/.test(mx.detail));
  delete state.positions['KEYA:DOGEUSDT']; await mu.fanOutOrder(sig()); assert.strictEqual(aSubmits(m0).length, 1);
  clearPos(); await setPlan({ maxOpenTrades: 1 }); state.positions['KEYA:SOLUSDT'] = { side: 'Buy', size: '3' };
  await mu.fanOutOrder(sig()); assert.strictEqual((await lastLog(uid)).code, 'MAXT');
  clearPos(); await setPlan({ maxOpenTrades: 3 });
  ok('max open trades (standard 3): blocks a new trade once the limit is reached, allows it when a slot is free');

  // leverage is exactly what the signal says (no plan cap; the optional env cap in this test is MAX_USER_LEVERAGE=10)
  let l0 = state.levs.length;
  await mu.fanOutLeverage({ symbol: 'BTCUSDT', buyLeverage: 8, sellLeverage: 8 });
  const lv = state.levs.slice(l0); assert(lv.length >= 2 && lv.every(x => x.b.buyLeverage === '8'));
  ok('leverage forwarded to every account exactly as the signal sets it');

  // daily profit target
  await setPlan({ dailyProfitTargetUsd: 25 });
  await db.query(`INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,closed_pnl,closed_at) VALUES($1,'win1','X','Sell',1,30,now())`, [uid]);
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0); const pt = await lastLog(uid); assert(pt.code === 'HALT' && /profit target/.test(pt.detail));
  await db.query(`DELETE FROM pnl_ledger WHERE order_id='win1'`); await setPlan({ dailyProfitTargetUsd: null });
  clearPos();
  ok('daily profit target stops new trades for the day');

  // drawdown stop (standard: 30% below the highest balance)
  assert.strictEqual((await meA()).plan.drawdownStopPct, 30);
  await db.query('UPDATE users SET equity_peak=1000 WHERE id=$1', [uid]);   // $500 is 50% below $1000
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0);
  assert.strictEqual((await meA()).paused, true); assert(/Drawdown stop/.test((await lastLog(uid)).detail));
  await call('/api/me/pause', 'POST', { paused: false }, hA);
  assert.strictEqual((await db.query('SELECT equity_peak FROM users WHERE id=$1', [uid])).rows[0].equity_peak, null);
  await db.query('UPDATE users SET equity_peak=900 WHERE id=$1', [uid]);
  await setPlan({ drawdownStopPct: 10 }); // changing the rule restarts everyone's measurement
  assert.strictEqual((await db.query('SELECT equity_peak FROM users WHERE id=$1', [uid])).rows[0].equity_peak, null);
  await setPlan({ drawdownStopPct: 30 });
  clearPos();
  ok('drawdown stop (standard 30%): pauses a user whose balance falls too far below its peak; resume or a rule change restarts the measurement');

  // daily loss limit: 10% of the balance the day started with (standard), plus the optional USD limits
  assert.strictEqual((await meA()).plan.dailyLossPct, 10);
  const bobId0 = (await db.query(`SELECT id FROM users WHERE username='bob'`)).rows[0].id;
  await db.query(`INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,closed_pnl,closed_at) VALUES($1,'al0','X','Sell',1,-30,now())`, [uid]);   // -$30 of ~$530 start: 5.7%, under 10%
  m0 = state.submits.length; await mu.fanOutOrder(sig()); assert.strictEqual(aSubmits(m0).length, 1); clearPos();
  await db.query(`UPDATE pnl_ledger SET closed_pnl=-60 WHERE order_id='al0'`);                                                                       // -$60 of ~$560: 10.7%
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0); const dl = await lastLog(uid); assert(dl.code === 'HALT' && /Daily loss limit reached/.test(dl.detail) && /10%/.test(dl.detail));
  await db.query(`DELETE FROM pnl_ledger WHERE order_id='al0'`); clearPos();
  await setPlan({ dailyLossLimitUsd: 40 });
  await db.query(`INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,closed_pnl,closed_at) VALUES($1,'bl1','X','Sell',1,-45,now())`, [bobId0]);  // bob: -$45 is 18% of his balance AND over $40
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(bSubmits(m0).length, 0); assert.strictEqual((await lastLog(bobId0)).code, 'HALT');
  clearPos();
  assert.strictEqual((await setLim({ dailyLossLimitUsd: 30 })).s, 200);
  await db.query(`INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,closed_pnl,closed_at) VALUES($1,'al1','X','Sell',1,-35,now())`, [uid]);
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0); assert.strictEqual((await lastLog(uid)).code, 'HALT');
  await db.query(`DELETE FROM pnl_ledger WHERE order_id IN ('bl1','al1')`); await setPlan({ dailyLossLimitUsd: null }); await setLim({ dailyLossLimitUsd: null });
  clearPos();
  ok('daily loss limit: 10% of the starting balance (standard), and the optional USD limits still apply');

  // restore: puts the user's size back to the plan's standard
  await setLim({ sizeMode: 'fixed', sizeUsd: 77, dailyLossLimitUsd: 12 });
  await call('/api/me/pause', 'POST', { paused: true }, hA);
  assert.strictEqual((await call('/api/me/reset-defaults', 'POST', null, hA)).s, 200);
  let cur = await meA();
  assert(cur.limits.sizeMode === 'percent' && cur.limits.sizePct === 20 && cur.limits.sizeUsd === null && cur.limits.dailyLossLimitUsd === null);
  assert.strictEqual(cur.paused, true); // restoring never quietly restarts trading
  assert(cur.hasKey && cur.keyStatus === 'ok');
  assert((await call('/api/admin/audit?limit=100', 'GET', null, admin)).j.rows.some(r => r.action === 'limits_reset'));
  await call('/api/me/pause', 'POST', { paused: false }, hA);
  ok('restore: the user\'s size goes back to the standard 20%; it never quietly restarts trading');

  // per-user ceilings set by the admin
  assert.strictEqual((await setAdmin(uid, { maxTradeUsd: 200, maxLeverage: 5 })).s, 200);
  await setLim({ sizeMode: 'fixed', sizeUsd: 150 }); m0 = state.submits.length; await mu.fanOutOrder(sig()); // $150 at the admin's 5x leverage ceiling = 0.0115 -> 0.01
  const ceilQty = aSubmits(m0)[0].body.qty; assert(Number(ceilQty) <= 0.01 && Number(ceilQty) > 0, 'ceil qty ' + ceilQty);
  clearPos();
  l0 = state.levs.length; await mu.fanOutLeverage({ symbol: 'BTCUSDT', buyLeverage: 8, sellLeverage: 8 });
  const lv2 = state.levs.slice(l0); assert.strictEqual(lv2.find(x => x.k === 'KEYA').b.buyLeverage, '5'); assert.strictEqual(lv2.find(x => x.k === 'KEYB').b.buyLeverage, '8');
  assert.strictEqual((await setLim({ sizeMode: 'fixed', sizeUsd: 350 })).s, 400); // above the $200 ceiling
  assert.strictEqual((await setLim({ sizeMode: 'fixed', sizeUsd: 80 })).s, 200);
  await setAdmin(uid, { maxTradeUsd: 50 });
  assert.strictEqual((await meA()).limits.sizeUsd, 50); // a lower ceiling pulls the user's amount down
  await setAdmin(uid, { maxTradeUsd: null, maxLeverage: null });
  me0 = await meA(); assert(me0.limits.ceilings.maxTradeUsd === 500 && me0.limits.ceilings.maxLeverage === 10); // the plan's $500 cap and the env cap remain
  await call('/api/me/reset-defaults', 'POST', null, hA);
  ok('admin per-user ceilings (optional, off by default): cap amount and leverage, block anything above, pull values down, can be removed');

  // the $500 per-trade cap in the plan
  await db.query('UPDATE users SET last_equity=5000 WHERE id=$1', [uid]);
  state.equity.KEYA = 5000; await setLim({ sizeMode: 'percent', sizePct: 20 });   // 20% of $5,000 = $1,000, capped to $500 -> 500 x 10 / 65000 = 0.0769
  m0 = state.submits.length; await mu.fanOutOrder(sig()); assert.strictEqual(aSubmits(m0)[0].body.qty, '0.07'); clearPos();
  state.equity.KEYA = 500; await db.query('UPDATE users SET last_equity=500 WHERE id=$1', [uid]);
  ok('the $500 per-trade cap holds for large accounts');

  // close all (user)
  state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' }; state.positions['KEYA:ETHUSDT'] = { side: 'Sell', size: '2' }; m0 = state.submits.length;
  assert.strictEqual((await call('/api/me/close-all', 'POST', {}, hA)).s, 400);
  const ca = await call('/api/me/close-all', 'POST', { confirm: true }, hA);
  assert(ca.s === 200 && ca.j.closed === 2 && ca.j.failed === 0);
  const closes = aSubmits(m0); assert(closes.length === 2 && closes.every(x => x.body.reduceOnly === true));
  assert.strictEqual(closes.find(x => x.body.symbol === 'BTCUSDT').body.side, 'Sell'); assert.strictEqual(closes.find(x => x.body.symbol === 'ETHUSDT').body.side, 'Buy');
  assert(!state.positions['KEYA:BTCUSDT'] && !state.positions['KEYA:ETHUSDT'] && state.cancels >= 1);
  assert.strictEqual((await meA()).paused, false);
  state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' };
  const pc = await call('/api/me/pause', 'POST', { paused: true, closeAll: true }, hA);
  assert(pc.j.closed.closed === 1 && !state.positions['KEYA:BTCUSDT'] && (await meA()).paused === true);
  await call('/api/me/pause', 'POST', { paused: false }, hA);
  ok('close-all: needs confirmation, closes every position on the right side, does not pause; "pause and close" does both');

  // admin: pause all / close all
  const pa = await call('/api/admin/pause-all', 'POST', { paused: true }, admin); assert(pa.j.pausedAll === true);
  assert.strictEqual((await call('/api/admin/users', 'GET', null, admin)).j.pausedAll, true);
  assert.strictEqual((await meA()).globalPause, true);
  m0 = state.submits.length; await mu.fanOutOrder(sig()); assert.strictEqual(state.submits.length, m0);
  state.positions['KEYA:SOLUSDT'] = { side: 'Buy', size: '3' };
  await mu.fanOutOrder({ symbol: 'SOLUSDT', side: 'Sell', qty: '3', reduceOnly: true }); assert(aSubmits(m0).some(x => x.body.reduceOnly));
  await call('/api/admin/pause-all', 'POST', { paused: false }, admin);
  await mu.fanOutOrder(sig()); assert(state.submits.length > m0 + 1);
  clearPos();
  ok('admin pause-all: no user gets new trades, closes still go through, resume restores copying');
  state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' }; state.positions['KEYB:BTCUSDT'] = { side: 'Buy', size: '0.02' };
  assert.strictEqual((await call('/api/admin/close-all', 'POST', {}, admin)).s, 400);
  assert.strictEqual((await call('/api/admin/close-all', 'POST', { confirm: 'CLOSE' })).s, 401);
  const cav = await call('/api/admin/close-all', 'POST', { confirm: 'CLOSE' }, admin);
  assert(cav.s === 200 && cav.j.closed === 2 && !state.positions['KEYA:BTCUSDT'] && !state.positions['KEYB:BTCUSDT']);
  ok('admin close-all: needs the word CLOSE and an admin session, closes every user\'s open trades');
  clearPos();

  // ---------- plan history, preview, restore ----------
  const hist = async () => (await call('/api/admin/plan/history', 'GET', null, admin)).j;
  let H = await hist(); assert(H.success && H.versions.length >= 10 && H.versions[0].live === true && H.live === H.versions[0].id);
  assert(H.versions.filter(v => /→/.test(v.summary)).length >= 8 && H.versions.every(v => v.plan && v.changedBy));
  assert.strictEqual((await call('/api/admin/plan/history', 'GET', null, hA)).s, 401);
  // every order log row carries the plan version that was live when it was made
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual((await db.query(`SELECT plan_version FROM order_log WHERE user_id=$1 AND kind='ORDER' ORDER BY id DESC LIMIT 1`, [uid])).rows[0].plan_version, H.live); clearPos();
  // preview changes nothing
  const live0 = JSON.stringify((await call('/api/admin/plan', 'GET', null, admin)).j.plan);
  const pv = await call('/api/admin/plan/preview', 'POST', { maxOpenTrades: 2, direction: 'long' }, admin);
  assert(pv.s === 200 && pv.j.changes.length === 2 && /max open trades 3 → 2/.test(pv.j.changes[0].text + pv.j.changes[1].text) && pv.j.accounts === 2);
  assert.strictEqual(JSON.stringify((await call('/api/admin/plan', 'GET', null, admin)).j.plan), live0); assert.strictEqual((await hist()).versions.length, H.versions.length);
  assert.strictEqual((await call('/api/admin/plan/preview', 'POST', { direction: 'sideways' }, admin)).s, 400);
  assert.strictEqual((await call('/api/admin/plan/preview', 'POST', { direction: 'both' }, admin)).j.unchanged, true);
  ok('plan history: every save is a version with a readable summary, orders are stamped with the version, preview shows the effect and saves nothing');

  // restore
  const vBefore = H.live;
  const sv = await setPlan({ sizeMode: 'fixed', sizeUsd: 120, maxOpenTrades: 2 }); assert(sv.j.version > vBefore && sv.j.changes.length === 3);
  assert.strictEqual((await call('/api/admin/plan/restore', 'POST', { id: sv.j.version }, admin)).s, 400); // already live
  assert.strictEqual((await call('/api/admin/plan/restore', 'POST', { id: 999999 }, admin)).s, 404);
  assert.strictEqual((await call('/api/admin/plan/restore', 'POST', { id: vBefore }, hA)).s, 401);
  const rs2 = await call('/api/admin/plan/restore', 'POST', { id: vBefore }, admin); assert(rs2.s === 200 && rs2.j.version > sv.j.version);
  const planNow = (await call('/api/admin/plan', 'GET', null, admin)).j.plan; assert(planNow.sizeMode === 'percent' && planNow.sizeUsd === null && planNow.maxOpenTrades === 3);
  H = await hist(); assert(H.versions[0].restoredFrom === vBefore && /^Restored version/.test(H.versions[0].summary) && H.versions[0].live && !H.versions[1].live);
  assert((await call('/api/admin/audit?limit=100', 'GET', null, admin)).j.rows.some(r => r.action === 'plan_restored'));
  ok('restore: an old version becomes the live plan as a NEW version (history is never rewritten), live version refused, unknown id 404, admin only');

  // ---------- dry run ----------
  assert.strictEqual((await call('/api/admin/dry-run', 'POST', {}, admin)).s, 400);
  assert.strictEqual((await call('/api/admin/dry-run', 'POST', { enabled: true }, hA)).s, 401);
  assert((await call('/api/admin/dry-run', 'POST', { enabled: true }, admin)).j.dryAll === true);
  assert.strictEqual((await call('/api/admin/users', 'GET', null, admin)).j.dryAll, true);
  assert.strictEqual((await meA()).dry, true);
  const dsig = sig(); m0 = state.submits.length; l0 = state.levs.length; const s0 = state.stops.length;
  await mu.fanOutOrder(dsig); await mu.fanOutOrder(dsig); // the same signal twice (a retransmit)
  assert.strictEqual(state.submits.length, m0); // nothing sent to Bybit
  const dr = (await db.query(`SELECT u.username, o.qty, o.detail, o.ok, o.code, o.order_link_id FROM order_log o JOIN users u ON u.id=o.user_id WHERE o.code='DRY' ORDER BY o.id DESC LIMIT 6`)).rows;
  assert(dr.length === 2 && dr.every(x => x.ok && /^Dry run: would buy [\d.]+ BTC/.test(x.detail) && Number(x.qty) > 0 && /^dry-/.test(x.order_link_id))); // two users, once each
  await mu.fanOutLeverage({ symbol: 'BTCUSDT', buyLeverage: 5, sellLeverage: 5 }); assert.strictEqual(state.levs.length, l0);
  state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' };
  await mu.fanOutTradingStop({ symbol: 'BTCUSDT', positionIdx: 0, stopLoss: '60000' }); assert.strictEqual(state.stops.length, s0);
  await mu.fanOutOrder({ symbol: 'BTCUSDT', side: 'Sell', qty: '0.05', reduceOnly: true }); assert(aSubmits(m0).some(x => x.body.reduceOnly)); // closes always go through
  clearPos();
  const sumr = (await call('/api/admin/orders/summary?hours=24', 'GET', null, admin)).j; assert(sumr.users.find(x => x.username === 'alice').codes.DRY >= 1);
  const dro = (await call('/api/admin/orders?dry=1&limit=50', 'GET', null, admin)).j.rows; assert(dro.length >= 2 && dro.every(x => x.code === 'DRY'));
  assert((await call('/api/admin/orders?user=bob&dry=1', 'GET', null, admin)).j.rows.every(x => x.username === 'bob'));
  ok('dry run: users get the full filter/limit/sizing treatment and a "would buy" log line, nothing is sent (orders, leverage, stops), closes still go through, retransmits log once');
  // dry run still honours the rules
  await setPlan({ direction: 'long' }); m0 = state.submits.length; await mu.fanOutOrder(sig({ side: 'Sell' }));
  assert.strictEqual((await lastLog(uid)).code, 'FILT'); await setPlan({ direction: 'both' });
  assert((await call('/api/admin/dry-run', 'POST', { enabled: false }, admin)).j.dryAll === false);
  // per-user dry run: alice simulated, bob live
  assert.strictEqual((await setAdmin(uid, { dryRun: true })).s, 200);
  assert.strictEqual((await meA()).dry, true);
  m0 = state.submits.length; await mu.fanOutOrder(sig());
  assert.strictEqual(aSubmits(m0).length, 0); assert.strictEqual((await lastLog(uid)).code, 'DRY'); assert.strictEqual(bSubmits(m0).length, 1);
  assert.strictEqual((await call('/api/admin/users', 'GET', null, admin)).j.users.find(x => x.username === 'alice').dryRun, true);
  await setAdmin(uid, { dryRun: false }); clearPos();
  m0 = state.submits.length; await mu.fanOutOrder(sig()); assert.strictEqual(aSubmits(m0).length, 1); clearPos();
  ok('per-user dry run: one account simulated while the rest trade live; switching it off resumes real orders');

  // ---------- overview + needs-attention ----------
  const bobId1 = (await db.query(`SELECT id FROM users WHERE username='bob'`)).rows[0].id;
  await setAdmin(bobId1, { paused: true });
  await db.query(`INSERT INTO order_log(user_id,kind,symbol,side,code,ok,detail) VALUES($1,'ORDER','BTCUSDT','Buy','NET',false,'boom'),($1,'ORDER','BTCUSDT','Buy','NET',false,'boom'),($1,'ORDER','BTCUSDT','Buy','NET',false,'boom')`, [uid]);
  await db.query(`INSERT INTO users(username,pass_hash,active,created_at) VALUES('ghost','x',true,now() - interval '3 days')`);
  const ov = await call('/api/admin/overview', 'GET', null, admin); assert(ov.s === 200 && ov.j.success);
  const T2 = ov.j.tiles; assert(T2.users === 3 && T2.trading === 2 && T2.autopilot === 2 && T2.manual === 0 && T2.paused === 1 && T2.ordersDry24h >= 3 && T2.ordersFailed24h >= 3 && T2.ordersPlaced24h >= 1);
  assert(Number.isFinite(T2.pnlToday) && Number.isFinite(T2.pnl7d) && Number.isFinite(T2.equity) && ov.j.planVersion === (await hist()).live);
  const kinds = ov.j.attention.map(x => x.kind + ':' + x.username); assert(kinds.includes('paused:bob') && kinds.includes('failing:alice') && kinds.includes('nokey:ghost'), JSON.stringify(kinds));
  assert(ov.j.attention[0].severity === 'high' && ov.j.attention[ov.j.attention.length - 1].severity === 'low'); // most urgent first
  assert.strictEqual((await call('/api/admin/overview', 'GET', null, hA)).s, 401);
  await setAdmin(bobId1, { paused: false }); await db.query(`DELETE FROM users WHERE username='ghost'`); await db.query(`DELETE FROM order_log WHERE code='NET' AND detail='boom'`);
  assert(!(await call('/api/admin/overview', 'GET', null, admin)).j.attention.some(x => x.kind === 'paused'));
  ok('overview: tiles add up, the needs-attention list finds paused / failing / no-key accounts, most urgent first, clears when fixed, admin only');

  // ---------- telegram link + alerts ----------
  const link = await call('/api/me/telegram/link', 'POST', null, hA); assert(/^[0-9A-F]{8}$/.test(link.j.code));
  tg.updates = [{ update_id: 7, message: { chat: { id: 555, type: 'private' }, text: '/start ' + link.j.code } }, { update_id: 8, message: { chat: { id: 777, type: 'private' }, text: '/start DEADBEEF' } }];
  await T.tgPollOnce();
  assert((await call('/api/me', 'GET', null, hA)).j.telegram.linked === true);
  assert(tg.sent.some(m => m.chat_id === '555' || m.chat_id === 555));
  assert(tg.sent.some(m => (m.chat_id === 777) && /isn't valid/.test(m.text)));
  ok('Telegram linking: right code links the chat, wrong code is refused');
  delete state.positions['KEYA:ADAUSDT']; tg.sent.length = 0;
  await mu.fanOutOrder({ symbol: 'ADAUSDT', side: 'Buy', qty: '100' }); await sleep(300);
  assert(tg.sent.some(m => String(m.chat_id) === '555' && /Opened ADA long/.test(m.text)));
  state.closedPnl.KEYA = [{ orderId: 'f1', symbol: 'ADAUSDT', side: 'Sell', qty: '5', avgEntryPrice: '1', avgExitPrice: '1.1', closedPnl: '4.2', openFee: '0.1', closeFee: '0.1', leverage: '5', updatedTime: String(Date.now() - 60000) }];
  await mu.syncAll(); await sleep(300);
  assert(tg.sent.some(m => String(m.chat_id) === '555' && /Closed ADA: \+\$4\.20/.test(m.text)));
  ok('user gets Telegram alerts for opens and for closed-trade profit/loss');
  state.closedPnl.KEYA = [];

  // ---------- ledger, funding, deposits ----------
  const now = Date.now();
  state.closedPnl.KEYA = [{ orderId: 'c1', symbol: 'BTCUSDT', side: 'Sell', qty: '0.05', avgEntryPrice: '65000', avgExitPrice: '66000', closedPnl: '50.25', openFee: '1', closeFee: '1', leverage: '5', updatedTime: String(now - 1000) },
    { orderId: 'c2', symbol: 'ETHUSDT', side: 'Sell', qty: '1', avgEntryPrice: '3000', avgExitPrice: '2950', closedPnl: '-20', openFee: '0.5', closeFee: '0.5', leverage: '5', updatedTime: String(now - 500) },
    { orderId: 'f1', symbol: 'ADAUSDT', side: 'Sell', qty: '5', avgEntryPrice: '1', avgExitPrice: '1.1', closedPnl: '4.2', openFee: '0.1', closeFee: '0.1', leverage: '5', updatedTime: String(now - 60000) }];
  state.closedPnl.KEYB = [{ orderId: 'c3', symbol: 'BTCUSDT', side: 'Sell', qty: '0.02', avgEntryPrice: '65000', avgExitPrice: '64000', closedPnl: '-30', openFee: '0.4', closeFee: '0.4', leverage: '5', updatedTime: String(now - 800) }];
  state.funding.KEYA = [{ symbol: 'BTCUSDT', transactionTime: String(now - 5000), type: 'SETTLEMENT', change: '-0.5' }, { symbol: 'BTCUSDT', transactionTime: String(now - 4000), type: 'SETTLEMENT', change: '0.2' }];
  await mu.syncAll(); await mu.syncAll();
  const me = (await call('/api/me', 'GET', null, hA)).j;
  assert.strictEqual(me.trades, 3); assert(Math.abs(me.pnl - 34.45) < 1e-9); assert(Math.abs(me.funding + 0.3) < 1e-9);
  const ad = (await call('/api/admin/users', 'GET', null, admin)).j;
  const ua0 = ad.users.find(u => u.username === 'alice');
  assert(Math.abs(ua0.net - 34.15) < 1e-9 && ua0.estNetDeposits !== null && ua0.avgSlippageBps !== null);
  ok('ledger + funding fees sync once (no dupes), net = trade PnL + funding, slippage and est. deposits reported');
  const csv = await realFetch(base + '/api/admin/export.csv', { headers: admin }); const csvText = await csv.text();
  assert(csv.status === 200 && /^username,kind,at,symbol/.test(csvText) && /alice,FUNDING/.test(csvText) && /,-30\.0*,|,-30,/.test(csvText.replace(/\.0+/g, '')) && !/'-30/.test(csvText));
  assert.strictEqual((await realFetch(base + '/api/admin/export.csv')).status, 401);
  ok('CSV export: trades + funding, negatives intact, admin only');
  const bk = await T.runBackupIfDue(true); assert(bk.sent && tg.docs.length === 1 && tg.docs[0].chat === '9001' && /ym-ledger-\d{4}-\d\d-\d\d\.csv/.test(tg.docs[0].name) && /alice/.test(tg.docs[0].text));
  assert.strictEqual((await T.runBackupIfDue(false)).sent, false);
  ok('daily backup goes to the admin Telegram chat, and is not re-sent until due');

  // ---------- user lockout, admin reset, forced change ----------
  const bobL = () => call('/api/auth/login', 'POST', { username: 'bob', password: 'wrong-pass-xx' });
  for (let i = 0; i < 5; i++) assert.strictEqual((await bobL()).s, 401);
  assert.strictEqual((await call('/api/auth/login', 'POST', { username: 'bob', password: 'another-pass-10' })).s, 429);
  ok('account locks after 5 wrong passwords (right password refused while locked)');
  const bobId = ad.users.find(u => u.username === 'bob').id;
  const rs = await call('/api/admin/users/' + bobId + '/reset-password', 'POST', null, admin); assert(rs.j.tempPassword && rs.j.tempPassword.length >= 10);
  const lb = await call('/api/auth/login', 'POST', { username: 'bob', password: rs.j.tempPassword });
  assert(lb.j.success && lb.j.mustChangePassword); const hB = { Authorization: 'Bearer ' + lb.j.token };
  assert.strictEqual((await call('/api/me/limits', 'POST', { sizeMult: 0.5 }, hB)).s, 403);
  assert.strictEqual((await call('/api/me/password', 'POST', { current: rs.j.tempPassword, next: 'brand-new-pass-1' }, hB)).s, 200);
  assert.strictEqual((await call('/api/me/limits', 'POST', { sizePct: 30, confirmHigh: true }, hB)).s, 200); // password change worked, settings reachable again
  assert.strictEqual((await call('/api/auth/login', 'POST', { username: 'bob', password: rs.j.tempPassword })).s, 401);
  ok('admin reset: unlocks, temp password works once, other actions blocked until a new password is chosen, old one dead');
  const l1 = await call('/api/auth/login', 'POST', { username: 'bob', password: 'brand-new-pass-1' });
  const l2 = await call('/api/auth/login', 'POST', { username: 'bob', password: 'brand-new-pass-1' });
  await call('/api/me/password', 'POST', { current: 'brand-new-pass-1', next: 'third-pass-for-bob' }, { Authorization: 'Bearer ' + l1.j.token });
  assert.strictEqual((await call('/api/me', 'GET', null, { Authorization: 'Bearer ' + l2.j.token })).s, 401);
  assert.strictEqual((await call('/api/me', 'GET', null, { Authorization: 'Bearer ' + l1.j.token })).s, 200);
  ok('changing password signs out every other device');

  // ---------- user 2FA ----------
  const set = await call('/api/me/2fa/setup', 'POST', null, hA); assert(/^[A-Z2-7]{32}$/.test(set.j.secret) && /^otpauth:\/\//.test(set.j.uri));
  assert.strictEqual((await call('/api/me/2fa/enable', 'POST', { code: '123456' }, hA)).s, 400);
  assert.strictEqual((await call('/api/me/2fa/enable', 'POST', { code: sec.totpCode(set.j.secret) }, hA)).s, 200);
  const noCode = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' }); assert(noCode.j.needTotp && !noCode.j.token);
  const wrong = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9', totp: '000000' }); assert.strictEqual(wrong.s, 401);
  const nextCode = sec.totpCode(set.j.secret, Date.now() + 30000);
  const okL = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9', totp: nextCode }); assert(okL.j.token);
  assert.strictEqual((await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9', totp: nextCode })).s, 401);
  assert.strictEqual((await call('/api/auth/login', 'POST', { username: 'alice', password: 'nope-nope-nope', totp: nextCode })).s, 401);
  const encStored = (await db.query('SELECT totp_secret_enc FROM users WHERE username=$1', ['alice'])).rows[0].totp_secret_enc; assert(!encStored.includes(set.j.secret));
  await call('/api/admin/users/' + (ad.users.find(u => u.username === 'alice').id) + '/disable-2fa', 'POST', null, admin);
  assert((await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' })).j.success);
  ok('user 2FA: setup/enable, login needs the code, wrong/replayed code refused, secret stored encrypted, admin can switch it off');

  // ---------- share link ----------
  const getShare = async (t) => { const r = await realFetch(base + '/api/share/' + t); return { s: r.status, h: r.headers, text: await r.text() }; };
  assert.strictEqual((await getShare('x'.repeat(24))).s, 404);
  const hA2 = { Authorization: 'Bearer ' + (await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' })).j.token };
  const en = (await call('/api/me/share', 'POST', { enabled: true }, hA2)).j; assert(en.success);
  const sh = await getShare(en.token); const shj = JSON.parse(sh.text);
  assert(sh.s === 200 && shj.username === 'alice' && shj.balance === null && Math.abs(shj.funding + 0.3) < 1e-9 && Math.abs(shj.pnl - 34.15) < 1e-9);
  for (const leak of ['KEYA', 'key_enc', 'pass_hash', 'totp', '65000', 'keyError', 'share_token', 'tg_chat']) assert(!sh.text.includes(leak), 'leaked ' + leak);
  assert(/noindex/.test(sh.h.get('x-robots-tag')));
  await call('/api/me/share', 'POST', { showBalance: true }, hA2); assert((JSON.parse((await getShare(en.token)).text)).balance === 500);
  const reg = (await call('/api/me/share', 'POST', { regenerate: true }, hA2)).j; assert.strictEqual((await getShare(en.token)).s, 404); assert.strictEqual((await getShare(reg.token)).s, 200);
  const pg = await realFetch(base + '/s/' + reg.token); assert(pg.status === 200 && /frame-ancestors/.test(pg.headers.get('content-security-policy')));
  await call('/api/me/share', 'POST', { enabled: false }, hA2); assert.strictEqual((await getShare(reg.token)).status || (await getShare(reg.token)).s, 404);
  ok('share link: opt-in, funding included, nothing sensitive leaks, balance opt-in, regenerate/off kill old links, page has CSP');

  // ---------- remaining safety ----------
  const bobTok = { Authorization: 'Bearer ' + (await call('/api/auth/login', 'POST', { username: 'bob', password: 'third-pass-for-bob' })).j.token };
  await call('/api/me/remove-key', 'POST', null, bobTok);
  const ad2 = (await call('/api/admin/users', 'GET', null, admin)).j; const bob = ad2.users.find(u => u.username === 'bob');
  assert(bob.keyStatus === 'removed' && Math.abs(bob.pnl + 30) < 1e-9);
  ok('removing the key stops trading but keeps the ledger');
  state.submitRet.KEYA = { retCode: 10003, retMsg: 'API key is invalid' }; delete state.positions['KEYA:LTCUSDT'];
  tg.sent.length = 0;
  await mu.fanOutOrder({ symbol: 'LTCUSDT', side: 'Buy', qty: '2' }); await sleep(200);
  const ua = (await call('/api/admin/users', 'GET', null, admin)).j.users.find(u => u.username === 'alice');
  assert(ua.keyStatus === 'error' && alerts.some(t => /alice/.test(t)) && tg.sent.some(m => String(m.chat_id) === '555' && /API key stopped/.test(m.text)));
  delete state.submitRet.KEYA;
  ok('revoked key: flagged, admin alerted, user alerted on Telegram');
  await call('/api/admin/users/' + ua.id, 'POST', { clearKeyError: true }, admin); await call('/api/admin/plan', 'POST', { dailyLossLimitUsd: 10 }, admin);
  await db.query(`INSERT INTO pnl_ledger(user_id,order_id,symbol,side,qty,closed_pnl,closed_at) VALUES($1,'loss1','X','Sell',1,-50,now())`, [ua.id]);
  const b6 = state.submits.length; delete state.positions['KEYA:AVAXUSDT'];
  await mu.fanOutOrder({ symbol: 'AVAXUSDT', side: 'Buy', qty: '2' }); assert(!state.submits.slice(b6).some(s => s.k === 'KEYA'));
  ok('daily loss limit blocks new trades');

  const sc = (await call('/api/admin/security', 'GET', null, admin)).j; assert(sc.success && sc.checks.find(c => c.id === 'device_key').ok === false && sc.checks.find(c => c.id === 'dash_pw').ok === true);
  const au = (await call('/api/admin/audit?limit=200', 'GET', null, admin)).j.rows.map(r => r.action);
  for (const need of ['signup', 'admin_login', 'admin_login_failed', 'password_reset', 'login_locked', '2fa_enabled', 'share_link_changed', 'csv_export', 'key_removed']) assert(au.includes(need), 'missing audit: ' + need);
  ok('security checklist reports gaps; audit log recorded signups, logins, lockouts, resets, 2FA, exports, key removal');


  // ---------- v1.5 console additions: open trades, result curve, bots, signal feed, per-user close-all ----------
  const A2 = hA2;
  const meNow = (await call('/api/me', 'GET', null, A2)).j;
  assert(meNow.lossLimit === 10 && meNow.todayPnl <= -10, 'me exposes the loss limit in force and today\'s result (limit reached)');
  clearPos();
  state.positions['KEYA:BTCUSDT'] = { side: 'Sell', size: '0.05', avgPrice: '60000', markPrice: '59000', unrealisedPnl: '50', stopLoss: '61000', takeProfit: '0' };
  assert.strictEqual((await call('/api/me/open')).s, 401);
  const op = (await call('/api/me/open', 'GET', null, A2)).j;
  assert(op.success && op.open.length === 1 && op.open[0].symbol === 'BTCUSDT' && op.open[0].side === 'SHORT' && op.open[0].pnl === 50 && op.open[0].leverage === 10 && op.open[0].stop === 61000 && op.open[0].target === null);
  state.positions['KEYA:BTCUSDT'].unrealisedPnl = '75';
  assert.strictEqual((await call('/api/me/open', 'GET', null, A2)).j.open[0].pnl, 50, 'cached for 10 seconds');
  state.positions['KEYA:SOLUSDT'] = { side: 'Buy', size: '2' };
  const odd = (await call('/api/me/open', 'GET', null, A2)).j; assert(odd.open.length === 1, 'still cached');
  delete state.positions['KEYA:SOLUSDT'];
  state.equity.KEYC = 100;
  const invC = (await call('/api/admin/invites', 'POST', { count: 1 }, admin)).j.codes[0];
  const carol = await call('/api/auth/signup', 'POST', { username: 'carol', password: 'carol-pass-1234', inviteCode: invC, apiKey: 'KEYC', apiSecret: 'sec' }); assert(carol.j.success, 'carol signs up');
  const hC = { Authorization: 'Bearer ' + carol.j.token };
  await call('/api/me/remove-key', 'POST', {}, hC);
  const opB = await call('/api/me/open', 'GET', null, hC); assert(opB.s === 200 && opB.j.success && opB.j.open.length === 0, 'a user with no key has no open trades');
  ok('user open trades: live positions mapped (side, pnl, leverage, stop/target), cached, empty without a key, login required');

  const sr = (await call('/api/me/series?days=7', 'GET', null, A2)).j;
  assert(sr.success && sr.points.length === 7 && sr.points.every((p, i, a) => i === 0 || p.day > a[i - 1].day));
  const sumDb = Number((await db.query(`SELECT COALESCE((SELECT SUM(closed_pnl) FROM pnl_ledger WHERE user_id=$1 AND closed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days'),0) + COALESCE((SELECT SUM(amount) FROM funding_ledger WHERE user_id=$1 AND at >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days'),0) AS s`, [(await db.query("SELECT id FROM users WHERE username='alice'")).rows[0].id])).rows[0].s);
  assert(Math.abs(sr.points[6].net - sumDb) < 0.011, 'last point equals the net result in the window');
  assert((await call('/api/me/series?days=999999', 'GET', null, A2)).j.points.length === 365);
  assert.strictEqual((await call('/api/me/series?days=7')).s, 401);
  const asr = await call('/api/admin/series?days=30', 'GET', null, admin); assert(asr.j.success && asr.j.points.length === 30);
  assert.strictEqual((await call('/api/admin/series?days=30')).s, 401);
  ok('result curve: one point per day, ends at the real net result, days capped, user and admin versions need a login');

  const bots = await call('/api/admin/bots', 'GET', null, admin);
  const b1 = bots.j.bots.find(b => b.name === 'YM ORACLE I'), b2 = bots.j.bots.find(b => b.name === 'YM ORACLE II');
  assert(bots.j.success && b1.online === true && b1.uptimeMin === 5 && b1.freeHeap === 28588 && b1.resetReason === 'POWER_ON' && b1.build === 'final-7');
  assert(b2.online === false && b2.uptimeMin === null && b2.freeHeap === null && b2.resetReason === null, 'older firmware (name only) still shows up, offline after the threshold');
  assert.strictEqual((await call('/api/admin/bots')).s, 401);
  ok('bots: online/offline from heartbeats, optional uptime, memory, restart reason and build, admin only');

  const sg = (await call('/api/admin/signals?limit=5&hours=48', 'GET', null, admin)).j;
  assert(sg.success && sg.signals.length > 0 && sg.signals.length <= 5);
  assert(sg.signals.every(x => ['LONG', 'SHORT'].includes(x.side) && x.total >= 1 && x.placed + x.dry + x.skipped + x.failed <= x.total && x.at));
  assert(sg.signals.some(x => x.placed > 0), 'at least one signal was copied');
  assert.strictEqual((await call('/api/admin/signals')).s, 401);
  ok('signal feed: one row per signal with copied / dry / skipped / failed counts, newest first, admin only');

  const aid = (await db.query("SELECT id FROM users WHERE username='alice'")).rows[0].id, bid = (await db.query("SELECT id FROM users WHERE username='bob'")).rows[0].id;
  state.positions['KEYA:ETHUSDT'] = { side: 'Buy', size: '1' };
  assert.strictEqual((await call('/api/admin/users/' + aid + '/close-all', 'POST', {}, admin)).s, 400);
  assert.strictEqual((await call('/api/admin/users/' + aid + '/close-all', 'POST', { confirm: 'CLOSE' })).s, 401);
  assert.strictEqual((await call('/api/admin/users/' + bid + '/close-all', 'POST', { confirm: 'CLOSE' }, admin)).s, 404);
  const cu = await call('/api/admin/users/' + aid + '/close-all', 'POST', { confirm: 'CLOSE' }, admin);
  assert(cu.s === 200 && cu.j.closed === 2 && !state.positions['KEYA:ETHUSDT'] && !state.positions['KEYA:BTCUSDT']);
  assert((await call('/api/admin/audit?limit=50', 'GET', null, admin)).j.rows.some(r => r.action === 'close_all_user' && r.target === String(aid)));
  clearPos();
  ok('admin close-all for ONE user: needs CLOSE and an admin session, 404 without a key, closes that account only, audited');


  // ---------- v1.6: keeping everything in step (interrupted orders, flaky Bybit reads, master journal) ----------
  const planSnap = (await call('/api/admin/plan', 'GET', null, admin)).j.plan, usersSnap = (await db.query('SELECT id, paused, dry_run, key_status, key_error FROM users')).rows;
  await call('/api/admin/plan', 'POST', T.PLAN_DEFAULT, admin); await call('/api/admin/pause-all', 'POST', { paused: false }, admin); await call('/api/admin/dry-run', 'POST', { enabled: false }, admin);
  await db.query("UPDATE users SET paused=false, dry_run=false, key_status='ok', key_error=NULL"); clearPos();

  // 1. a copy that was claimed but never finished (relay restarted mid-order) is settled from what Bybit really has
  const mkPend = async (uid, link, ageSec, sym) => (await db.query(`INSERT INTO order_log(user_id,kind,order_link_id,symbol,side,qty,code,ok,detail,created_at) VALUES($1,'ORDER',$2,$3,'Buy',1,'PENDING',false,'Sending', now() - ($4 || ' seconds')::interval) RETURNING id`, [uid, link, sym || 'BTCUSDT', String(ageSec)])).rows[0].id;
  state.orders = { 'u1-pend-filled': { orderStatus: 'Filled', orderId: 'OID-F' }, 'u1-pend-rej': { orderStatus: 'Rejected', orderId: 'OID-R' }, 'u1-pend-live': { orderStatus: 'New', orderId: 'OID-N', active: true } };
  const pF = await mkPend(aid, 'u1-pend-filled', 300), pR = await mkPend(aid, 'u1-pend-rej', 300), pL = await mkPend(aid, 'u1-pend-live', 300), pG = await mkPend(aid, 'u1-pend-gone', 300), pY = await mkPend(aid, 'u1-pend-young', 10);
  const tgBefore = tg.sent.length;
  state.orderReadFails = true; let st0 = await T.settlePending(); state.orderReadFails = false;
  assert.strictEqual(st0.settled, 0); assert((await db.query("SELECT COUNT(*) AS n FROM order_log WHERE code='PENDING'")).rows[0].n >= 4, 'Bybit unreachable: rows stay PENDING to be looked at again');
  const st1 = await T.settlePending(); assert.strictEqual(st1.settled, 4);
  const rowOf = async id => (await db.query('SELECT code, ok, detail, bybit_order_id FROM order_log WHERE id=$1', [id])).rows[0];
  const rF = await rowOf(pF), rR = await rowOf(pR), rL = await rowOf(pL), rG = await rowOf(pG), rY = await rowOf(pY);
  assert(rF.code === 'OK' && rF.ok === true && rF.bybit_order_id === 'OID-F');
  assert(rL.code === 'OK' && rL.ok === true && rL.bybit_order_id === 'OID-N', 'an order still resting on Bybit counts as placed');
  assert(rR.code === 'BYBIT' && rR.ok === false && /Rejected/.test(rR.detail));
  assert(rG.code === 'NET' && rG.ok === false && /not retried/.test(rG.detail) && !state.submits.some(s => s.body.orderLinkId === 'u1-pend-gone'), 'an order that never reached Bybit is reported, never re-sent late');
  assert.strictEqual(rY.code, 'PENDING', 'a row under 60 seconds old is still in flight and is left alone');
  assert(tg.sent.length > tgBefore, 'the user is told about the one that was lost');
  await db.query('DELETE FROM order_log WHERE id=$1', [pY]);
  ok('interrupted orders: settled from Bybit by orderLinkId (filled/resting = placed, rejected = failed, never-arrived = failed and NOT re-sent), young rows left alone, unreadable Bybit leaves them for the next round');

  // 2. a flaky read of the master account no longer fails every user's copy
  const sigK = () => sig({ symbol: 'ETHUSDT' });
  state.failAdmin = true; T.ageAdminEquity(120000); let w0 = state.submits.length;
  await mu.fanOutOrder(sigK());
  assert(aSubmits(w0).length === 1, 'Bybit unreadable for the master but a recent balance is known: users are still copied');
  clearPos(); T.ageAdminEquity(20 * 60000, true); w0 = state.submits.length;
  await mu.fanOutOrder(sigK());
  assert.strictEqual(state.submits.length, w0); assert.strictEqual((await lastLog(aid)).code, 'NET', 'no usable balance at all: a clear failure is logged, not a silent gap');
  state.failAdmin = false; clearPos();
  ok('master equity: retried, a recent value is used if Bybit stays down, and only with nothing usable does it log a failure');
  let calls = 0; const rr = await T.withRetry(async () => { if (++calls < 3) throw new Error('x'); return 'done'; }, 3); assert(rr === 'done' && calls === 3);
  ok('retry helper: succeeds on the third try');

  // 3. a dropped connection on a user's own order is retried with the same orderLinkId
  state.equity.ADMINK = 1000; T.ageAdminEquity(120000, true); w0 = state.submits.length; state.submitThrow = 2; state.submitThrown = 0;
  await mu.fanOutOrder(sig({ symbol: 'SOLUSDT' }));
  const mine = state.submits.slice(w0).filter(x => x.k === 'KEYA');
  assert.strictEqual(state.submitThrown, 2); assert(mine.length === 1 && mine[0].body.orderLinkId, 'the order went through on the third try');
  assert.strictEqual((await lastLog(aid)).code, 'OK'); clearPos(); state.submitThrow = 0;
  ok('user orders: dropped connection retried (same orderLinkId, so a duplicate can never happen), ends as placed');

  // 4. master journal + attention list
  await mu.recordExec({ id: 'AAA111', bot: 'YM ORACLE II', kind: 'TRADE', side: 'BUY', symbol: 'ZECUSDT', ok: true, code: 'OK', detail: 'accepted' });
  await mu.recordExec({ id: 'BBB222', bot: 'YM ORACLE III', kind: 'TRADE', side: 'SELL', symbol: 'PEPEUSDT', ok: false, code: 'BAL', detail: 'wanted $100 margin, only $12 free' });
  await mu.recordExec({ id: 'CCC333', bot: 'YM ORACLE I', kind: 'TRADE', side: 'BUY', symbol: 'ASTERUSDT', ok: true, code: 'NOTRL', detail: 'trailing stop refused' });
  await mu.recordExec({ id: 'BBB222', bot: 'YM ORACLE III', kind: 'TRADE', side: 'SELL', symbol: 'PEPEUSDT', ok: false, code: 'BAL', detail: 'wanted $100 margin, only $12 free' }); // a resend must not duplicate
  const mst = await call('/api/admin/master', 'GET', null, admin);
  assert(mst.j.success && mst.j.counts.ok === 1 && mst.j.counts.warn === 1 && mst.j.counts.fail === 1, JSON.stringify(mst.j.counts));
  assert(mst.j.reports.length === 3 && mst.j.reports.find(r => r.id === 'BBB222').sev === 'fail' && /free balance/.test(mst.j.reports.find(r => r.id === 'BBB222').text));
  assert(mst.j.sync.masterOpen === 2 && mst.j.sync.loggedOpen === 2 && mst.j.sync.recoveredTotal === 1 && mst.j.sync.lastOkAt);
  assert.strictEqual((await call('/api/admin/master')).s, 401);
  const ov2 = (await call('/api/admin/overview', 'GET', null, admin)).j;
  const sysItems = ov2.attention.filter(a => a.userId === null);
  assert(sysItems.some(a => a.kind === 'master' && /refused/.test(a.text) && /PEPE/.test(a.text)), 'refused master trade is on the attention list');
  assert(sysItems.some(a => a.kind === 'master' && /trailing stop/.test(a.text)));
  assert(sysItems.some(a => a.kind === 'relay' && a.username === 'Oracle I' && /OFF/.test(a.text)), 'a bot with its relay switch off is on the attention list');
  assert(sysItems.some(a => a.kind === 'sync' && /ETH/.test(a.text) && /added automatically/.test(a.text)));
  const bots2 = (await call('/api/admin/bots', 'GET', null, admin)).j.bots; assert(bots2.find(b => b.name === 'YM ORACLE I').relayOn === false && bots2.find(b => b.name === 'YM ORACLE I').relayMarginUsd === 100 && bots2.find(b => b.name === 'YM ORACLE II').relayOn === null);
  ok('master journal: results stored once per signal, counted by severity, refusals / missing trailing stops / relay switched off / auto-recovered positions all reach the attention list, admin only');
  await call('/api/admin/plan', 'POST', planSnap, admin); for (const r of usersSnap) await db.query('UPDATE users SET paused=$2, dry_run=$3, key_status=$4, key_error=$5 WHERE id=$1', [r.id, r.paused, r.dry_run, r.key_status, r.key_error]); clearPos(); state.orders = {};

  // ---------- the two pages, driven in a headless DOM against this same running backend ----------
  if (process.env.JSDOM_DIR) {
    const { JSDOM, VirtualConsole } = require(process.env.JSDOM_DIR + '/node_modules/jsdom');
    const errs = [];
    let ipx = 0;
    const open = async (p, store, key, token) => {
      const html = await (await realFetch(base + p)).text();
      const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push(p + ': ' + (e.detail || e.message || e))); vc.on('error', e => errs.push(p + ' console.error: ' + e));
      const dom = new JSDOM(html, { url: base + p, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
        w.fetch = (u, o) => { o = o || {}; return realFetch(new URL(u, base), { ...o, headers: { ...(o.headers || {}), 'X-Forwarded-For': '10.77.' + (++ipx % 250) + '.' + (Math.floor(ipx / 250) + 1) } }); };
        w.scrollTo = () => {}; if (token) w[store].setItem(key, token);
      } });
      return dom.window;
    };
    const q1 = (w, s) => w.document.querySelector(s), qa = (w, s) => Array.from(w.document.querySelectorAll(s));
    const click = (w, el) => { assert(el, 'element to click exists'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
    const setVal = (w, el, v, ev) => { el.value = v; el.dispatchEvent(new w.Event(ev || 'input', { bubbles: true })); };
    const holdOn = async (w, el, ms) => { el.dispatchEvent(new w.Event('pointerdown', { bubbles: true, cancelable: true })); await sleep(ms); el.dispatchEvent(new w.Event('pointerup', { bubbles: true })); };
    const apiMe = async () => (await call('/api/me', 'GET', null, A2)).j;
    const apiUsers = async () => (await call('/api/admin/users', 'GET', null, admin)).j;

    // ===== admin console =====
    const aw = await open('/admin', 'sessionStorage', 'ym_admin_token', admin.Authorization.replace('Bearer ', '')); await sleep(1500);
    const body = () => q1(aw, '#body').textContent;
    assert(!q1(aw, '#app').hidden && q1(aw, '#login').hidden, 'signed-in admin sees the console');
    assert(/LIVE|DRY RUN|PAUSED/.test(q1(aw, '#stateTxt').textContent));
    assert(/Signal bots/.test(body()) && /YM ORACLE I/.test(body()) && /28\.6 KB free/.test(body()) && /POWER_ON/.test(body()) && /Offline/.test(body()), 'bots card');
    assert(/Live signals/.test(body()) && /Needs attention/.test(body()) && /Net result, all users/.test(body()));
    assert(/Master account/.test(body()) && /In step with Bybit: 2 open trade/.test(body()) && /Refused|Not enough free balance/.test(body()) && /Relay OFF/.test(body()) && /Bybit Relay switch is OFF/.test(body()), 'master card, relay chip and system attention items render');
    assert(qa(aw, '[data-period]').length === 3);
    click(aw, q1(aw, '[data-period="90"]')); await sleep(500); assert(q1(aw, '[data-period="90"]').getAttribute('aria-pressed') === 'true');
    ok('admin page: signs in from a stored token, overview shows net result, live signals, attention list and the signal bots with memory and restart reason');

    click(aw, q1(aw, '[data-tab="users"]')); await sleep(600);
    const us = (await apiUsers()).users, rows = qa(aw, 'tbody tr[data-open]');
    assert(rows.length === us.length && us.length >= 3, 'one row per user');
    const aliceRow = qa(aw, 'tbody tr[data-open]').find(r => /alice/.test(r.textContent)); assert(aliceRow);
    setVal(aw, q1(aw, '#uq'), 'ali'); await sleep(200); assert(qa(aw, 'tbody tr[data-open]').length === 1, 'search filters the table'); setVal(aw, q1(aw, '#uq'), ''); await sleep(100);
    click(aw, qa(aw, 'tbody tr[data-open]').find(r => /alice/.test(r.textContent))); await sleep(200);
    assert(!q1(aw, '#drawer').hidden && /alice/.test(q1(aw, '#drawerPanel').textContent) && /Average slippage/.test(q1(aw, '#drawerPanel').textContent));
    setVal(aw, q1(aw, '#d-loss'), '25'); click(aw, q1(aw, '[data-uact="limits"]')); await sleep(700);
    assert((await apiUsers()).users.find(u => u.username === 'alice').dailyLossLimitUsd === 25, 'drawer saves a per-user limit');
    const dryBox = q1(aw, '[data-udry]'); dryBox.checked = true; dryBox.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(700);
    assert((await apiUsers()).users.find(u => u.username === 'alice').dryRun === true, 'per-user dry run from the drawer');
    q1(aw, '[data-udry]').checked = false; q1(aw, '[data-udry]').dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(600);
    state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' };
    await holdOn(aw, q1(aw, '[data-hold="closeUser"]'), 1500); await sleep(900);
    assert(!state.positions['KEYA:BTCUSDT'], 'press-and-hold closes that user\'s trades');
    click(aw, q1(aw, '[data-act="closeDrawer"]')); assert(q1(aw, '#drawer').hidden);
    ok('admin page: users table, search, drawer details, per-user limits and dry run save, hold-to-close really closes the trades');

    await call('/api/admin/profit-guard', 'POST', { mode: 'off', fast: { mode: 'inherit' }, swing: { mode: 'inherit', scale: { on: false } } }, admin);   // a failed earlier run may have left it on
    click(aw, q1(aw, '[data-tab="plan"]')); await sleep(800);
    assert(q1(aw, '#p-open') && q1(aw, '#p-lossp') && q1(aw, '#p-pct') && q1(aw, '#review') && /Version history/.test(body()) && /Exactly what each signal says/.test(body()) && /\$500 account/.test(q1(aw, '#planPreviewCard').textContent), 'new plan page');
    assert(/No changes|This is what every account follows/.test(q1(aw, '#review').textContent));
    setVal(aw, q1(aw, '#p-open'), '4'); await sleep(900);
    assert(/max open trades/i.test(q1(aw, '#review').textContent) && !q1(aw, '[data-act="applyPlan"]').disabled, 'live review shows the change and enables Apply');
    setVal(aw, q1(aw, '#p-pct'), '10'); await sleep(200); assert(/\$50 margin/.test(q1(aw, '#planPreviewCard').textContent), 'preview follows the percent');
    setVal(aw, q1(aw, '#p-pct'), '20'); await sleep(900);
    click(aw, q1(aw, '[data-act="applyPlan"]')); await sleep(900);
    assert((await call('/api/admin/plan', 'GET', null, admin)).j.plan.maxOpenTrades === 4, 'applying saves the plan');
    await call('/api/admin/plan', 'POST', { maxOpenTrades: 3 }, admin);
    ok('admin page: plan form fills from the live plan, review panel previews changes without saving, Apply saves a new version');

    assert(q1(aw, '#pgcard') && /Profit Guard/.test(q1(aw, '#pgcard').textContent) && /OFF/.test(q1(aw, '#pgcard').textContent) && q1(aw, '#pg-swing-be'), 'the Profit Guard card shows, off by default');
    click(aw, q1(aw, '#pgcard [data-v="shadow"]')); await sleep(900);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.mode === 'shadow' && /SHADOW/.test(q1(aw, '#pgcard').textContent));
    click(aw, q1(aw, '#pgcard [data-v="live"]')); await sleep(300);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.mode === 'shadow' && /Confirm/.test(q1(aw, '#pgcard').textContent) && q1(aw, '#pgcard [data-act="pgConfirm"]'), 'the first tap on Live only asks');
    click(aw, q1(aw, '#pgcard [data-act="pgConfirm"]')); await sleep(900);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.mode === 'live', 'the second tap goes live');
    setVal(aw, q1(aw, '#pg-swing-k0'), '40'); click(aw, q1(aw, '#pgcard [data-act="pgSave"]')); await sleep(900);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.swing.ladder[0][1] === 0.4, 'the ladder is saved from the card');
    click(aw, q1(aw, '#pgcard [data-act="pgProf"][data-p="fast"][data-v="shadow"]')); await sleep(900);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.fast.mode === 'shadow', 'a profile can be set on its own');
    assert(q1(aw, '#pg-fast-son') && q1(aw, '#pg-re-on') && /Scorecard/.test(q1(aw, '#pgcard').textContent) && /Re-entry recorder/.test(q1(aw, '#pgcard').textContent), 'scale-out, re-entry and scorecard sections are on the card');
    q1(aw, '#pg-swing-son').checked = true; click(aw, q1(aw, '#pgcard [data-act="pgSave"]')); await sleep(700);
    assert(/Confirm/.test(q1(aw, '#pgcard').textContent) && (await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.swing.scale.on === false, 'turning on real slice-closing asks first');
    click(aw, q1(aw, '#pgcard [data-act="pgCancel"]')); await sleep(300);
    click(aw, q1(aw, '#pgcard [data-v="off"]')); await sleep(900);
    assert((await call('/api/admin/profit-guard', 'GET', null, admin)).j.cfg.mode === 'off');
    await call('/api/admin/profit-guard', 'POST', { mode: 'off', fast: { mode: 'inherit' }, swing: { mode: 'inherit', scale: { on: false }, ladder: [[2, 0.35], [4, 0.55], [8, 0.65]] } }, admin);
    ok('admin page: Profit Guard card: Off / Shadow / Live with a confirm step, per-profile modes, scale-out and re-entry settings, scorecard');

    const sw = q1(aw, '#swDry'); click(aw, q1(aw, '#statePill')); sw.checked = true; sw.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(900);
    assert((await apiUsers()).dryAll === true && /DRY RUN/.test(q1(aw, '#stateTxt').textContent) && /Dry run is on/.test(q1(aw, '#notice').textContent), 'dry run switch');
    sw.checked = false; sw.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(700); assert((await apiUsers()).dryAll === false);
    const sp = q1(aw, '#swPause'); sp.checked = true; sp.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(800);
    assert((await apiUsers()).pausedAll === true && /PAUSED/.test(q1(aw, '#stateTxt').textContent));
    assert((await apiMe()).globalPause === true, 'users see the admin pause');
    sp.checked = false; sp.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(700); assert((await apiUsers()).pausedAll === false);
    ok('admin page: header pill and controls panel switch dry run and pause for everyone, banners follow');

    click(aw, q1(aw, '[data-tab="activity"]')); await sleep(900);
    assert(/Orders sent to users/.test(body()) && /Audit log/.test(body()) && qa(aw, '.sig').length > 3);
    click(aw, q1(aw, '[data-of="failed"]')); await sleep(600); assert(q1(aw, '[data-of="failed"]').getAttribute('aria-pressed') === 'true');
    click(aw, q1(aw, '[data-tab="payments"]')); await sleep(200); assert(/Free during the promo/.test(body()));
    ok('admin page: activity feed with failed filter, audit log, payments placeholder');


    // ===== one console: Trading, Bots & alerts, Settings, and the one-sign-in rule =====
    assert.strictEqual((await realFetch(base + '/api/status')).status, 401, 'trading routes refuse a stranger');
    assert.strictEqual((await realFetch(base + '/api/status', { headers: { Authorization: 'Bearer nonsense' } })).status, 401);
    assert.strictEqual((await realFetch(base + '/api/status', { headers: { Authorization: admin.Authorization } })).status, 200, 'the admin session works on the trading routes');
    assert(qa(aw, '#nav [data-tab]').length === 8 && ['overview', 'trading', 'bots', 'users', 'plan', 'activity', 'payments', 'settings'].every(k => q1(aw, '#nav [data-tab="' + k + '"]')), 'side menu has every section');
    click(aw, q1(aw, '[data-tab="trading"]')); await sleep(900);
    assert(/\$1,234\.50/.test(body()) && /Open positions/.test(body()) && /BTC/.test(body()) && /LONG/.test(body()) && /Recent trades/.test(body()) && /ETH/.test(body()) && /Win rate/.test(body()) && /50%/.test(body()), 'trading: balance, position, trades, win rate');
    assert(/XRP/.test(body()) && /insufficient balance/.test(body()), 'trading: order alert');
    assert(/Paper: nothing is sent/.test(body()) && q1(aw, '[data-act="modePaper"]').getAttribute('aria-pressed') === 'true', 'trading: starts in paper mode');
    click(aw, q1(aw, '[data-act="modeLive"]')); await sleep(100);
    assert(q1(aw, '#liveGo').disabled === true, 'going live needs the word LIVE'); click(aw, q1(aw, '#liveGo')); assert(!tCalls.some(c => c[0] === 'mode'));
    setVal(aw, q1(aw, '#live-in'), 'LIVE'); assert(q1(aw, '#liveGo').disabled === false); click(aw, q1(aw, '#liveGo')); await sleep(700);
    assert(tCalls.some(c => c[0] === 'mode' && c[1].mode === 'live' && c[1].confirm === 'LIVE') && q1(aw, '[data-act="modeLive"]').getAttribute('aria-pressed') === 'true', 'live mode switched on after typing LIVE'); assert(/In step with Bybit/.test(body()), 'trading: sync line');
    await holdOn(aw, q1(aw, '[data-hold="halt"]'), 1400); await sleep(700);
    assert(tCalls.some(c => c[0] === 'halt') && /Resume trading/.test(body()), 'holding the button halts trading');
    click(aw, q1(aw, '[data-act="resume"]')); await sleep(600); assert(tCalls.some(c => c[0] === 'resume') && !/Resume trading/.test(body()));
    click(aw, q1(aw, '[data-act="dismissExec"]')); await sleep(100); assert(/All clear\. Every order went through/.test(body()), 'alerts can be dismissed');
    ok('console Trading: balance, positions, trades and sync from the same sign-in; paper/live (LIVE typed), hold-to-halt, resume, dismiss alerts');

    click(aw, q1(aw, '[data-tab="bots"]')); await sleep(900);
    assert(/Signal bots/.test(body()) && /Ping all bots/.test(body()) && /Telegram alert control/.test(body()) && /Where each alert goes/.test(body()) && /Recent alerts from the bots/.test(body()), 'bots tab');
    // the alert control panel: a route change from the page is saved, Dev mode from the page switches the mode and shows the banner
    { const sel = q1(aw, 'select[data-arcat="updates"]'); assert(sel, 'per-category select is here'); sel.value = 'dm'; sel.dispatchEvent(new aw.Event('change', { bubbles: true })); await sleep(700);
      assert.strictEqual(alertRouterState().cfg.routes.updates, 'dm', 'the route change was saved'); click(aw, q1(aw, '[data-act="arMode"][data-v="dev"]')); await sleep(800);
      assert.strictEqual(alertRouterState().cfg.mode, 'dev'); assert(/DEV · group silent/.test(body()), 'the page shows Dev mode'); click(aw, q1(aw, '[data-act="arMode"][data-v="live"]')); await sleep(800); assert.strictEqual(alertRouterState().cfg.mode, 'live'); alertRouterState().cfg = arMod.defaults(); await db.query(`DELETE FROM meta WHERE k='alert_routes'`); } click(aw, q1(aw, '[data-act="ping"]')); await sleep(2300);
    assert(/120 ms/.test(body()) && /Timeout/.test(body()) && /90 ms/.test(body()), 'ping results'); assert(q1(aw, '[data-act="testAlert"]'), 'test alert button is here too');
    click(aw, q1(aw, '[data-act="testAlert"]')); await sleep(600); assert(tradeAlerts.some(t => /admin page/.test(t)), 'the test button reaches the alert sender');
    ok('console Bots & alerts: bot cards, ping all bots with timings, test alert');

    click(aw, q1(aw, '[data-tab="settings"]')); await sleep(900);
    assert(/master Bybit key/.test(body()) && /\u2026AB12/.test(body()) && /Security checklist/.test(body()) && /Classic dashboard/.test(body()) && /Data tools/.test(body()), 'settings tab');
    click(aw, q1(aw, '[data-act="mkToggle"]')); await sleep(100); setVal(aw, q1(aw, '#mk-key'), 'KEY123'); setVal(aw, q1(aw, '#mk-sec'), 'SEC456');
    click(aw, q1(aw, '[data-act="mkEnv"][data-v="demo"]')); await sleep(50); assert(q1(aw, '#mk-key').value === 'KEY123', 'typed values survive a redraw');
    click(aw, q1(aw, '[data-act="mkSave"]')); await sleep(700);
    assert(tCalls.some(c => c[0] === 'key' && c[1].apiKey === 'KEY123' && c[1].apiSecret === 'SEC456' && c[1].env === 'demo') && /Saved\. Now trading with/.test(body()), 'master key saved from the console');
    ok('console Settings: master key check-and-save with Live/Demo, security checklist, data tools, links to the other pages');

    // the old address now leads here
    const dres = await realFetch(base + '/dashboard', { redirect: 'manual' }); void dres;

    // ===== user app =====
    const uw = await open('/join', 'localStorage', 'ym_user_token', hA2.Authorization.replace('Bearer ', '')); await sleep(1500);
    const page = () => q1(uw, '#page').textContent;
    assert(!q1(uw, '#appView').hidden && q1(uw, '#authView').hidden && /alice/.test(page()));
    assert(/YOUR TRADE SIZE/.test(page()) && /Open now/.test(page()) && /Net result/.test(page()) && !/Take manual control/.test(page()) && !/AUTOPILOT/.test(page()) && /Safety rails for everyone/.test(page()));
    assert(/of \$\d+ lost|Up \+\$/.test(page()), 'loss limit meter');
    assert(qa(uw, '#nav button').length === 3);
    click(uw, q1(uw, '[data-period="7"]')); await sleep(500); assert(q1(uw, '[data-period="7"]').getAttribute('aria-pressed') === 'true');
    ok('user app: home shows result, trade-size card with the safety rails, loss-limit meter and open trades (no autopilot/manual switch)');

    assert(q1(uw, '#limPct') && q1(uw, '#limPct').value === '20' && /Each trade would use about/.test(q1(uw, '#amtHint').textContent), 'standard 20% with a live preview');
    click(uw, q1(uw, '[data-preset="10"]')); assert(q1(uw, '#limPct').value === '10' && q1(uw, '[data-preset="10"]').getAttribute('aria-pressed') === 'true');
    setVal(uw, q1(uw, '#limLoss'), '4');
    click(uw, q1(uw, '[data-act="saveLimits"]')); await sleep(900);
    { const L = (await apiMe()).limits; assert(Number(L.dailyLossLimitUsd) === 4 && L.sizePct === 10 && L.sizeMode === 'percent', 'settings save'); }
    setVal(uw, q1(uw, '#limPct'), '25'); assert(!q1(uw, '#highWarn').hidden, 'warning appears above 20%');
    click(uw, q1(uw, '[data-act="saveLimits"]')); await sleep(900); assert((await apiMe()).limits.sizePct === 10, 'not saved without confirmation');
    q1(uw, '#limConfirm').checked = true; q1(uw, '#limConfirm').dispatchEvent(new uw.Event('change', { bubbles: true }));
    click(uw, q1(uw, '[data-act="saveLimits"]')); await sleep(900); assert((await apiMe()).limits.sizePct === 25, 'saved after confirming');
    click(uw, q1(uw, '[data-sm="fixed"]')); setVal(uw, q1(uw, '#limUsd'), '30'); click(uw, q1(uw, '[data-act="saveLimits"]')); await sleep(900);
    { const L = (await apiMe()).limits; assert(L.sizeMode === 'fixed' && L.sizeUsd === 30 && L.sizePct === null, 'fixed amount saves'); }
    const rb = q1(uw, '[data-act="restorePlan"]'); click(uw, rb); assert((await apiMe()).limits.sizeMode === 'fixed', 'first tap only arms'); click(uw, q1(uw, '[data-act="restorePlan"]')); await sleep(900);
    { const L = (await apiMe()).limits; assert(L.sizeMode === 'percent' && L.sizePct === 20 && L.dailyLossLimitUsd === null, 'second tap restores the standard ' + JSON.stringify(L)); }
    ok('user app: presets and custom percent with a live preview, warning + confirmation above 20%, fixed amount, two-tap back to the standard');

    click(uw, q1(uw, '[data-ut="trades"]')); await sleep(300); assert(/Closed trades/.test(page()) && qa(uw, '.tr').length > 0);
    click(uw, q1(uw, '[data-ut="settings"]')); await sleep(300);
    assert(/Account health/.test(page()) && qa(uw, 'details.acc').length === 5 && /Two-factor login/.test(page()) && /Public monitoring link/.test(page()));
    const ss = q1(uw, '#swShare'); ss.checked = true; ss.dispatchEvent(new uw.Event('change', { bubbles: true })); await sleep(900);
    assert((await apiMe()).shareToken && q1(uw, '#shUrl') && /\/s\//.test(q1(uw, '#shUrl').value), 'public link switch');
    click(uw, q1(uw, '[data-ut="home"]')); await sleep(200);
    const pz = q1(uw, '#swPause'); pz.checked = true; pz.dispatchEvent(new uw.Event('change', { bubbles: true })); await sleep(900);
    assert((await apiMe()).paused === true, 'pause switch'); q1(uw, '#swPause').checked = false; q1(uw, '#swPause').dispatchEvent(new uw.Event('change', { bubbles: true })); await sleep(900); assert((await apiMe()).paused === false);
    state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.05' };
    await holdOn(uw, q1(uw, '[data-hold="closeMine"]'), 1600); await sleep(1200); assert(!state.positions['KEYA:BTCUSDT'], 'hold closes my trades');
    ok('user app: trades list, settings rows, public link switch, pause switch, hold-to-close really closes trades');

    const nw = await open('/join'); await sleep(700);
    assert(!q1(nw, '#authView').hidden && q1(nw, '#appView').hidden && /Create your account/.test(q1(nw, '#signupBox').textContent));
    click(nw, q1(nw, '[data-sunext="1"]')); assert(/Enter your invite code/.test(q1(nw, '#suMsg').textContent), 'step 1 validates');
    setVal(nw, q1(nw, '#su1'), 'INV-1'); setVal(nw, q1(nw, '#su2'), 'newbie'); setVal(nw, q1(nw, '#su3'), 'short'); click(nw, q1(nw, '[data-sunext="1"]')); assert(/10 characters/.test(q1(nw, '#suMsg').textContent));
    setVal(nw, q1(nw, '#su3'), 'long-enough-pw-1'); click(nw, q1(nw, '[data-sunext="1"]')); assert(/trade-only key/.test(q1(nw, '#signupBox').textContent) && /Withdrawals/.test(q1(nw, '#signupBox').textContent));
    click(nw, q1(nw, '[data-sunext="2"]')); click(nw, q1(nw, '[data-sunext="3"]')); assert(/both the API key and the secret/.test(q1(nw, '#suMsg').textContent), 'step 3 validates');
    setVal(nw, q1(nw, '#su4'), 'BADKEY'); setVal(nw, q1(nw, '#su5'), 'x'); click(nw, q1(nw, '[data-sunext="3"]'));
    assert(/Choose how much each trade uses/.test(q1(nw, '#signupBox').textContent) && /\$500 account, 20%/.test(q1(nw, '#suPrev').textContent), 'step 4 shows the standard 20% with an example');
    click(nw, q1(nw, '[data-supct="10"]')); assert(/\$500 account, 10%/.test(q1(nw, '#suPrev').textContent));
    setVal(nw, q1(nw, '#su6'), '25'); assert(!q1(nw, '#suHigh').hidden, 'warning above 20%');
    click(nw, q1(nw, '#suGo')); assert(/confirm you want more than 20%/.test(q1(nw, '#suMsg').textContent));
    setVal(nw, q1(nw, '#su6'), '15'); click(nw, q1(nw, '#suGo')); assert(/understand the risk/.test(q1(nw, '#suMsg').textContent), 'risk box required');
    q1(nw, '#suAck').checked = true; q1(nw, '#suAck').dispatchEvent(new nw.Event('change', { bubbles: true })); click(nw, q1(nw, '#suGo')); await sleep(900);
    assert(/invite|code|Invalid|valid/i.test(q1(nw, '#suMsg').textContent), 'server message is shown on a failed signup: ' + q1(nw, '#suMsg').textContent);
    click(nw, q1(nw, '[data-sunext="2"]')); click(nw, q1(nw, '[data-sunext="1"]')); click(nw, q1(nw, '[data-sunext="0"]')); assert(q1(nw, '#su2').value === 'newbie', 'values kept when going back');
    click(nw, q1(nw, '#tabLogin')); assert(!q1(nw, '#loginBox').hidden);
    ok('sign-up: four steps (account, key setup, key, trade size + risk), validation before moving on, server errors shown, entered values kept; log-in tab');

    click(nw, q1(nw, '#tabSignup') || q1(nw, '#tabLogin')); 
    if (q1(nw, '#tabSignup')) click(nw, q1(nw, '#tabSignup'));
    setVal(nw, q1(nw, '#su1'), 'INV-1'); setVal(nw, q1(nw, '#su2'), 'newbie'); setVal(nw, q1(nw, '#su3'), 'long-enough-pw-1'); click(nw, q1(nw, '[data-sunext="1"]'));
    assert(q1(nw, '[data-suenv="live"]').getAttribute('aria-pressed') === 'true' && /trade-only key/.test(q1(nw, '#signupBox').textContent), 'live is the default');
    click(nw, q1(nw, '[data-suenv="demo"]'));
    assert(q1(nw, '[data-suenv="demo"]').getAttribute('aria-pressed') === 'true' && /Demo Trading/.test(q1(nw, '#signupBox').textContent) && /practice money/.test(q1(nw, '#signupBox').textContent), 'demo explains how to make a demo key');
    click(nw, q1(nw, '[data-sunext="2"]')); assert(/demo key/.test(q1(nw, '#signupBox').textContent), 'step 3 says demo key');
    ok('sign-up page: Live or Demo choice, with the right instructions for each');

    assert.deepStrictEqual(errs, [], 'no script errors in either page: ' + errs.join(' | '));
    ok('no script errors were raised by either page during all of the above');
  } else ok('page checks skipped (set JSDOM_DIR to a folder with jsdom installed)');

  // ---------- per-user environment: demo keys and live keys side by side (v1.7) ----------
  {
    state.equity.KEYD = 50000; state.equity.KEYD2 = 800; state.equity.KEYE = 300;
    const invD = (await call('/api/admin/invites', 'POST', { count: 2 }, admin)).j.codes;
    const pnlBefore = Number((await call('/api/admin/overview', 'GET', null, admin)).j.tiles.pnlToday);
    const dave = await call('/api/auth/signup', 'POST', { username: 'dave', password: 'dave-pass-12345', inviteCode: invD[0], apiKey: 'KEYD', apiSecret: 'sec', env: 'demo' });
    assert(dave.j.success, 'demo signup: ' + JSON.stringify(dave.j));
    const erin = await call('/api/auth/signup', 'POST', { username: 'erin', password: 'erin-pass-12345', inviteCode: invD[1], apiKey: 'KEYE', apiSecret: 'sec' });
    assert(erin.j.success, 'default signup is live');
    assert(state.ctor.some(c => c.k === 'KEYD' && c.demo === true), 'the demo key is checked against Bybit DEMO');
    assert(state.ctor.filter(c => c.k === 'KEYE').every(c => c.demo === false), 'the live key is checked against live');
    const meD = (await call('/api/me', 'GET', null, { Authorization: 'Bearer ' + dave.j.token })).j, meE = (await call('/api/me', 'GET', null, { Authorization: 'Bearer ' + erin.j.token })).j;
    assert(meD.env === 'demo' && meE.env === 'live');
    ok('sign-up with a demo key or a live key: each is validated against its own Bybit environment and remembered');

    const sub0 = state.submits.length; state.submitEnv = [];
    await mu.fanOutOrder({ symbol: 'ETHUSDT', side: 'Buy', qty: '0.50' }); await sleep(400);
    assert(state.submitEnv.some(x => x.k === 'KEYD' && x.demo === true), 'demo user order goes to the demo server');
    assert(state.submitEnv.some(x => x.k === 'KEYE' && x.demo === false), 'live user order goes to the live server');
    assert(state.submits.length > sub0);
    ok('one signal reaches a demo user on Bybit demo and a live user on Bybit live');

    state.closedPnl.KEYD = [{ orderId: 'd1', symbol: 'ETHUSDT', side: 'Sell', qty: '5', avgEntryPrice: '1', avgExitPrice: '2', closedPnl: '500', openFee: '0.1', closeFee: '0.1', leverage: '5', updatedTime: String(Date.now() - 60000) }];
    await mu.syncAll(); await sleep(300);
    const dRows = (await db.query(`SELECT COUNT(*)::int AS n FROM pnl_ledger l JOIN users u ON u.id=l.user_id WHERE u.username='dave'`)).rows[0].n;
    assert.strictEqual(dRows, 1, 'demo trade lands in the demo user ledger');
    const ovD = (await call('/api/admin/overview', 'GET', null, admin)).j.tiles;
    assert(ovD.demoUsers >= 1, 'overview counts demo users');
    assert(!(ovD.pnlToday >= pnlBefore + 499), 'a demo profit is NOT added to the real-money totals');
    const au = (await call('/api/admin/users', 'GET', null, admin)).j.users;
    assert.strictEqual(au.find(u => u.username === 'dave').env, 'demo'); assert.strictEqual(au.find(u => u.username === 'erin').env, 'live');
    ok('admin: demo users are labelled, and demo profit never inflates the real-money totals');

    const hD = { Authorization: 'Bearer ' + dave.j.token };
    assert.strictEqual((await call('/api/me/key', 'POST', { apiKey: 'KEYD2', apiSecret: 'sec', env: 'live' })).s, 401, 'needs a login');
    const sw = await call('/api/me/key', 'POST', { apiKey: 'KEYD2', apiSecret: 'sec', env: 'live' }, hD);
    assert(sw.j.success && sw.j.switched && sw.j.pausedForSwitch && sw.j.env === 'live', JSON.stringify(sw.j));
    assert(state.ctor.some(c => c.k === 'KEYD2' && c.demo === false), 'the new key was checked against live');
    const meD2 = (await call('/api/me', 'GET', null, hD)).j;
    assert(meD2.env === 'live' && meD2.paused === true && meD2.pnl === 0 && meD2.trades === 0, 'live numbers start clean and trading starts paused: ' + JSON.stringify({ e: meD2.env, p: meD2.paused, pnl: meD2.pnl }));
    const old = (await db.query(`SELECT env, closed_pnl FROM pnl_ledger_old o JOIN users u ON u.id=o.user_id WHERE u.username='dave'`)).rows;
    assert(old.length === 1 && old[0].env === 'demo' && Number(old[0].closed_pnl) === 500, 'the demo result is filed away, not deleted');
    ok('moving from a demo key to a live key: history filed away (not deleted), live numbers start clean, trading paused until the user resumes');

    const same = await call('/api/me/key', 'POST', { apiKey: 'KEYE', apiSecret: 'sec' }, hD);
    assert(same.s === 400 && /already registered/.test(same.j.message), 'another user\'s key is still refused');
    assert.strictEqual(JSON.stringify(T.envOpts('demo')), '{"demoTrading":true}');
    // the master's own settings must never decide a user's environment (the real deployment has BYBIT_BASE_URL set)
    const demoMaster = { baseUrl: 'https://api-demo.bybit.com', demoTrading: true, recv_window: 7000 };
    assert.deepStrictEqual(T.envOptsFor(demoMaster, 'live'), { recv_window: 7000 });
    assert.deepStrictEqual(T.envOptsFor(demoMaster, 'demo'), { recv_window: 7000, demoTrading: true });
    assert.strictEqual(T.defaultEnvFor({ baseUrl: 'https://api-demo.bybit.com' }), 'demo');
    assert.strictEqual(T.defaultEnvFor({ demoTrading: true }), 'demo');
    assert.strictEqual(T.defaultEnvFor({ baseUrl: 'https://api.bybit.com' }), 'live');
    assert.strictEqual(T.defaultEnvFor({}), 'live');
    ok('a key that belongs to another user is still refused; demo options are exactly {demoTrading:true}');
  }

  // ---------- Standard v1 migration of an existing (pre-v1) database ----------
  {
    const mk = async (name, cols) => (await db.query(`INSERT INTO users(username,pass_hash,${Object.keys(cols).join(',')}) VALUES($1,'x',${Object.keys(cols).map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`, [name, ...Object.values(cols)])).rows[0].id;
    const m1 = await mk('mig_auto', { control_mode: 'auto', size_mode: 'match', size_mult: 1 });
    const m2 = await mk('mig_manual_small', { control_mode: 'manual', size_mode: 'match', size_mult: 0.5 });
    const m3 = await mk('mig_manual_big', { control_mode: 'manual', size_mode: 'match', size_mult: 5 });
    const m4 = await mk('mig_fixed', { control_mode: 'manual', size_mode: 'fixed', size_usd: 40, daily_loss_limit_usd: 15 });
    await mu._test.rerunStdMigration({ sizeMode: 'match', sizeMult: 2, maxOpenTrades: 2, dailyLossLimitUsd: 99, allowManual: true });
    const row = async id => (await db.query('SELECT size_mode,size_pct,size_usd,notice,daily_loss_limit_usd FROM users WHERE id=$1', [id])).rows[0];
    let r1 = await row(m1), r2 = await row(m2), r3 = await row(m3), r4 = await row(m4);
    assert(r1.size_mode === 'percent' && Number(r1.size_pct) === 20 && /20%/.test(r1.notice) && /copied the master/.test(r1.notice), 'autopilot match user: plan multiplier 2 -> 10% x 2 = 20%, with a notice');
    assert(r2.size_mode === 'percent' && Number(r2.size_pct) === 5 && r2.notice, 'manual match user: 10% x 0.5 = 5%');
    assert(r3.size_mode === 'percent' && Number(r3.size_pct) === 30, 'a big multiplier is clamped to the 30% ceiling');
    assert(r4.size_mode === 'fixed' && Number(r4.size_usd) === 40 && r4.notice === null && Number(r4.daily_loss_limit_usd) === 15, 'a fixed-amount user keeps exactly their amount and limit, no notice');
    const planA = mu._test.getPlan(); assert(planA.sizeMode === 'percent' && planA.sizePct === 20 && planA.maxOpenTrades === 2 && planA.dailyLossLimitUsd === 99 && planA.drawdownStopPct === 30 && planA.dailyLossPct === 10, 'plan moves to the Standard; rails the admin had set are kept, empty ones get the Standard');
    const meM = (await call('/api/admin/users', 'GET', null, admin)).j.users.find(u => u.username === 'mig_manual_big'); assert(meM.sizeMode === 'percent' && meM.sizePct === 30);
    // runs once only
    await db.query(`UPDATE users SET size_pct=7 WHERE id=$1`, [m1]); await mu._test.migrateOnce({ sizeMode: 'match', sizeMult: 9 });
    assert.strictEqual(Number((await row(m1)).size_pct), 7, 'the migration does not run twice');
    // a plan that was already fixed USD keeps its amount for the users who followed it
    const m5 = await mk('mig_plan_fixed', { control_mode: 'auto', size_mode: 'match' });
    await mu._test.rerunStdMigration({ sizeMode: 'fixed', sizeUsd: 75, allowManual: true });
    const r5 = await row(m5); assert(r5.size_mode === 'fixed' && Number(r5.size_usd) === 75 && r5.notice === null, 'users that followed a fixed-USD plan keep $75');
    assert(mu._test.getPlan().sizeMode === 'fixed');
    // a fresh install ends on the Standard plan
    await mu._test.rerunStdMigration(null); const pf = mu._test.getPlan(); assert(pf.sizeMode === 'percent' && pf.sizePct === 20 && pf.maxOpenTrades === 3);
    // a user's page shows the notice until dismissed
    const lg = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' }).then(r => r.j.token ? r : null);
    await db.query(`UPDATE users SET notice='Your trade size changed.' WHERE username='alice'`);
    const lg2 = await call('/api/auth/login', 'POST', { username: 'alice', password: 'correct-horse-9' }); const hN = { Authorization: 'Bearer ' + lg2.j.token };
    assert.strictEqual((await call('/api/me', 'GET', null, hN)).j.notice, 'Your trade size changed.');
    await call('/api/me/notice/dismiss', 'POST', null, hN); assert.strictEqual((await call('/api/me', 'GET', null, hN)).j.notice, null);
    await db.query(`DELETE FROM users WHERE username LIKE 'mig_%'`);
    ok('Standard v1 migration: "match" users become 10% x multiplier (clamped, with a notice), fixed users untouched, plan moves to the Standard keeping the admin\'s rails, runs once, notice can be dismissed');
  }

  // ---------- sign-up: starting size and live minimum ----------
  {
    state.equity.KEYLOW = 30; state.equity.KEYOK = 80; state.equity.KEYDEMOLOW = 20;
    const invs = (await call('/api/admin/invites', 'POST', { count: 6 }, admin)).j.codes;
    const sg = (o, i) => call('/api/auth/signup', 'POST', { username: 'sg' + i, password: 'signup-pass-123', inviteCode: invs[i], apiKey: 'KEYOK', apiSecret: 'sec', ...o });
    const low = await sg({ apiKey: 'KEYLOW' }, 0); assert(low.s === 400 && /at least \$50/.test(low.j.message), 'a live account under $50 is turned away with a plain message');
    const dlow = await sg({ apiKey: 'KEYDEMOLOW', env: 'demo' }, 0); assert(dlow.j.success, 'demo accounts have no minimum');
    assert((await sg({ sizePct: 31 }, 1)).s === 400);
    const hi = await sg({ sizePct: 25 }, 1); assert(hi.s === 400 && hi.j.needConfirm === true);
    const okp = await sg({ sizePct: 25, confirmHigh: true, riskAck: true }, 1); assert(okp.j.success);
    const row = (await db.query(`SELECT size_mode,size_pct,risk_ack_at FROM users WHERE username='sg1'`)).rows[0]; assert(row.size_mode === 'percent' && Number(row.size_pct) === 25 && row.risk_ack_at, 'the starting size and the risk acknowledgement are stored');
    state.equity.KEYOK2 = 90; const def = await sg({ apiKey: 'KEYOK2' }, 2); assert(def.j.success);
    const dr = (await db.query(`SELECT size_mode,size_pct FROM users WHERE username='sg2'`)).rows[0]; assert(dr.size_mode === 'percent' && Number(dr.size_pct) === 20, 'no choice made = the plan\'s standard 20%');
    ok('sign-up: starting size (1-30%, >20% needs confirmation) and risk acknowledgement are saved; live accounts under $50 are refused, demo has no minimum, default is the Standard 20%');
  }

  // ---------- Phase 2: signal ledger, bot events, "never arrived" alarm, user activity ----------
  {
    const ev = (o) => mu.recordBotEvent({ v: 1, bot: 'YM ORACLE II', ...o });
    const sigRows = async () => (await db.query(`SELECT * FROM signals ORDER BY opened_at`)).rows;
    await db.query('DELETE FROM signals');
    // events are idempotent on the bot's key and tolerate arriving out of order
    const openEv = { ev: 'open', k: 'BTCUSDT-1000', sym: 'BTCUSDT', side: 'BUY', eng: 'fast', t: 1000, entry: 65000, sl: 64000, tp: 67000, lev: 10, m: 100, relay: 'SENT', why: '', rid: 'ok1' };
    assert.strictEqual((await ev(openEv)).status, 200); assert.strictEqual((await ev(openEv)).status, 200); assert.strictEqual((await ev({ ...openEv, entry: 1 })).status, 200);
    let rows = await sigRows(); assert(rows.length === 1 && Number(rows[0].entry) === 65000 && rows[0].relay_flag === 'SENT' && rows[0].rid === 'ok1', 'a retransmit never makes a second row or changes the first');
    await ev({ ev: 'relay', k: 'BTCUSDT-1000', sym: 'BTCUSDT', side: 'BUY', eng: 'fast', t: 1001, rid: 'ok1', ok: true, code: 'OK', secs: 4 });
    await ev({ ev: 'close', k: 'ETHUSDT-5', sym: 'ETHUSDT', side: 'SELL', eng: 'swing', t: 1002, won: true, exit: 3000, pct: 2.5, relayed: true, why: 'TP' });   // close before its open: row is created anyway
    rows = await sigRows(); assert(rows.length === 2 && rows.find(r => r.k === 'BTCUSDT-1000').relay_ok === true && rows.find(r => r.k === 'ETHUSDT-5').won === true);
    assert.strictEqual((await ev({ ev: 'status', t: 5, build: 'final-7', up: 12, heap: 1000, open: 1, cfg: { relay: 1 }, relayq: { pending: 0 } })).status, 200);
    assert.strictEqual((await db.query(`SELECT COUNT(*)::int AS n FROM bot_status`)).rows[0].n, 1);
    for (const bad of [{ ...openEv, v: 2 }, { ev: 'nope', k: 'x' }, { ...openEv, k: 'bad key!' }, { ...openEv, sym: 'btc;drop' }, { ev: 'open' }]) assert.strictEqual((await mu.recordBotEvent({ bot: 'B', ...bad })).status, 400, JSON.stringify(bad));
    assert.strictEqual((await mu.recordBotEvent(null)).status, 400); assert.strictEqual((await mu.recordBotEvent({ v: 1, ev: 'status' })).status, 400);
    ok('bot events: open / relay / close / status stored once per key, retransmits and out-of-order events are safe, junk is refused with 4xx (so the bot stops resending it)');

    // the alarm: the bot says SENT, a minute passes, no order reaches the relay
    alerts.length = 0;
    await ev({ ...openEv, k: 'LOST-1', rid: 'lost1' });                                 // never arrives
    await ev({ ...openEv, k: 'GOOD-1', rid: 'good1' });                                 // arrives
    await ev({ ...openEv, k: 'SKIP-1', rid: 'skip1', relay: 'NOT_SENT' });             // the bot chose not to relay
    await ev({ ...openEv, k: 'YOUNG-1', rid: 'young1' });                               // too recent to judge
    await db.query(`UPDATE signals SET opened_at = now() - interval '3 minutes' WHERE k IN ('LOST-1','GOOD-1','SKIP-1')`);
    for (const kk of Object.keys(state.positions)) delete state.positions[kk];
    const erinTok = (await call('/api/auth/login', 'POST', { username: 'erin', password: 'erin-pass-12345' })).j.token, hE = { Authorization: 'Bearer ' + erinTok };
    const eId = (await db.query(`SELECT id FROM users WHERE username='erin'`)).rows[0].id;
    await db.query(`UPDATE users SET paused=FALSE, key_status='ok' WHERE id=$1`, [eId]);
    state.equity.KEYE = 300; await db.query(`UPDATE users SET size_mode='percent', size_pct=20, size_usd=NULL WHERE id=$1`, [eId]);
    const s0 = state.submits.length;
    await mu.fanOutOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.1', stopLoss: '64000', takeProfit: '67000', orderLinkId: 'ym-good1' });
    await sleep(100);
    assert(state.submits.slice(s0).some(x => x.k === 'KEYE'), 'erin was copied: ' + JSON.stringify((await db.query('SELECT code,detail FROM order_log WHERE user_id=$1 ORDER BY id DESC LIMIT 2', [eId])).rows));
    const n = await mu._test.checkSignalAlarms();
    assert.strictEqual(n, 1, 'exactly one signal is alarmed'); assert(alerts.length === 1 && /Oracle II/.test(alerts[0]) && /no order has reached the relay/.test(alerts[0]), alerts.join('|'));
    assert.strictEqual(await mu._test.checkSignalAlarms(), 0); assert.strictEqual(alerts.length, 1, 'one alert per signal');
    // a late report of a trade whose order already arrived is not an alarm
    const s1 = state.submits.length; for (const kk of Object.keys(state.positions)) delete state.positions[kk];
    await mu.fanOutOrder({ category: 'linear', symbol: 'ETHUSDT', side: 'Buy', orderType: 'Market', qty: '1', orderLinkId: 'ym-late1' });
    await ev({ ...openEv, k: 'LATE-1', rid: 'late1', sym: 'ETHUSDT' }); await db.query(`UPDATE signals SET opened_at = now() - interval '5 minutes' WHERE k='LATE-1'`);
    assert.strictEqual(await mu._test.checkSignalAlarms(), 0);
    // the manager's own report for a signal also counts as "arrived"
    await ev({ ...openEv, k: 'EXEC-1', rid: 'exec1' }); await db.query(`UPDATE signals SET opened_at = now() - interval '5 minutes' WHERE k='EXEC-1'`);
    await mu.recordExec({ id: 'exec1', bot: 'YM ORACLE II', kind: 'TRADE', symbol: 'BTCUSDT', side: 'BUY', ok: true, code: 'OK', detail: '' });
    assert.strictEqual(await mu._test.checkSignalAlarms(), 0);
    ok('alarm: a bot-reported trade that never reaches the relay raises one alert; arrived, not-relayed, young, late-reported and manager-confirmed signals do not');

    // trade alerts pushed from the relay: one on open, one on close, each once; retried when delivery fails; test event; kill switch
    await sleep(150); await db.query(`UPDATE signals SET alert_open_at=now(), alert_close_at=now()`);   // set aside the signals made by the earlier steps
    tradeAlerts.length = 0;
    await ev({ ...openEv, k: 'ALR-1', rid: 'alr1', sym: 'SOLUSDT', side: 'SELL', entry: 150.5, sl: 155, tp: 140, lev: 5, m: 100 });
    await sleep(150);
    assert(tradeAlerts.length === 1 && /Oracle II SOL SHORT/.test(tradeAlerts[0]) && /opened/.test(tradeAlerts[0]) && /150.5/.test(tradeAlerts[0]), tradeAlerts.join('|'));
    await ev({ ...openEv, k: 'ALR-1', rid: 'alr1', sym: 'SOLUSDT', side: 'SELL' }); await sleep(100);
    assert.strictEqual(tradeAlerts.length, 1, 'a retransmitted open does not alert twice');
    await ev({ ev: 'close', k: 'ALR-1', sym: 'SOLUSDT', side: 'SELL', eng: 'fast', won: true, exit: 141, pct: 6.1, relayed: true, why: 'TP hit' }); await sleep(150);
    assert(tradeAlerts.length === 2 && /WIN \+6.10%/.test(tradeAlerts[1]) && /TP hit/.test(tradeAlerts[1]), tradeAlerts.join('|'));
    await ev({ ev: 'close', k: 'ALR-1', sym: 'SOLUSDT', side: 'SELL', won: true }); await sleep(100);
    assert.strictEqual(tradeAlerts.length, 2, 'a retransmitted close does not alert twice');
    await ev({ ...openEv, k: 'ALR-2', rid: 'alr2', relay: 'NOT_SENT' }); await sleep(150);
    assert(/did NOT send/.test(tradeAlerts[2]), 'a trade the bot kept to itself says so');
    // delivery fails -> given back, retried by the sweep, and gives up after 8 tries
    deliverResult = { ok: false, configured: true, telegram: 'failed (500)', email: 'off' };
    await ev({ ...openEv, k: 'ALR-3', rid: 'alr3', sym: 'ETHUSDT' }); await sleep(150);
    let r3 = (await db.query(`SELECT alert_open_at, alert_tries FROM signals WHERE k='ALR-3'`)).rows[0];
    assert(r3.alert_open_at === null && r3.alert_tries === 1, JSON.stringify(r3));
    deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' };
    const before = tradeAlerts.length; await mu._test.pushSignalAlerts();
    assert.strictEqual(tradeAlerts.length, before + 1, 'the sweep re-sent it'); await mu._test.pushSignalAlerts(); assert.strictEqual(tradeAlerts.length, before + 1);
    // nothing configured: no spinning, tries not used up
    deliverResult = { ok: false, configured: false }; await ev({ ...openEv, k: 'ALR-4', rid: 'alr4' }); await sleep(100);
    assert.strictEqual((await db.query(`SELECT alert_tries FROM signals WHERE k='ALR-4'`)).rows[0].alert_tries, 0);
    deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' }; await mu._test.pushSignalAlerts();
    assert(/Oracle II/.test(tradeAlerts[tradeAlerts.length - 1]), 'sent once something is configured');
    // old signals are never replayed
    await db.query(`INSERT INTO signals(k,bot,symbol,side,relay_flag,opened_at) VALUES('OLD-1','YM ORACLE II','BTCUSDT','BUY','SENT', now() - interval '5 hours')`);
    const nb = tradeAlerts.length; await mu._test.pushSignalAlerts(); assert.strictEqual(tradeAlerts.length, nb);
    // test event from a bot, admin test button, kill switch
    const t0 = tradeAlerts.length; const te = await mu.recordBotEvent({ v: 1, bot: 'YM ORACLE III', ev: 'test' });
    assert(te.status === 200 && te.message === 'delivered' && /Test alert from Oracle III/.test(tradeAlerts[t0]));
    const ta = (await call('/api/admin/test-alert', 'POST', {}, admin)).j; assert(ta.success && ta.configured && ta.telegram === 'sent' && ta.tradeAlerts === true);
    assert.strictEqual((await call('/api/admin/test-alert', 'POST', {})).s, 401, 'test button needs the admin login');
    process.env.TRADE_ALERTS = 'off'; const k0 = tradeAlerts.length; await ev({ ...openEv, k: 'ALR-5', rid: 'alr5' }); await sleep(100); await mu._test.pushSignalAlerts();
    assert.strictEqual(tradeAlerts.length, k0, 'TRADE_ALERTS=off silences trade alerts'); delete process.env.TRADE_ALERTS;
    ok('trade alerts from the relay: one per open and per close, retransmits silent, failed delivery retried, nothing replayed, bot test event + admin test button work, kill switch');

    // alerts the bot composes itself (ev "msg"): stored, delivered once with formatting, retried; the short ledger alert steps aside when the detailed text arrives
    { const B4 = 'YM ORACLE IV', ev4 = o => mu.recordBotEvent({ v: 1, bot: B4, ...o }), live = () => tradeAlerts.length;
      await sleep(150); await db.query(`UPDATE signals SET alert_open_at=now(), alert_close_at=now() WHERE alert_open_at IS NULL OR alert_close_at IS NULL`); await db.query(`UPDATE bot_msgs SET sent_at=now() WHERE sent_at IS NULL`);
      tradeAlerts.length = 0; tradeOpts.length = 0; deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' };
      assert.strictEqual((await ev4({ ev: 'msg', k: 'm-IV-1', text: '<b>YM ORACLE IV</b> zone found\nBTCUSDT', kind: 'zone', priv: true })).status, 200); await sleep(150);
      assert(tradeAlerts.length === 1 && /zone found/.test(tradeAlerts[0]) && tradeOpts[0].html === true && tradeOpts[0].priv === true && tradeOpts[0].email === false, JSON.stringify(tradeOpts));
      await ev4({ ev: 'msg', k: 'm-IV-1', text: '<b>again</b>', kind: 'zone' }); await sleep(100); assert.strictEqual(tradeAlerts.length, 1, 'a resent message is not delivered twice');
      for (const bad of [{ ev: 'msg', k: 'bad key!', text: 'x' }, { ev: 'msg', k: 'm-IV-2', text: '   ' }, { ev: 'msg', text: 'x' }]) assert.strictEqual((await ev4(bad)).status, 400, JSON.stringify(bad));
      await ev4({ ev: 'msg', k: 'm-IV-3', text: 'Daily summary 5 wins', kind: 'daily' }); await sleep(120); assert(tradeOpts[tradeOpts.length - 1].email === true, 'the daily summary asks for email too');
      // failure is kept and retried, and the bot is not asked to resend
      deliverResult = { ok: false, configured: true, telegram: 'failed (500)', email: 'off' }; const n0 = live();
      assert.strictEqual((await ev4({ ev: 'msg', k: 'm-IV-4', text: 'mgmt: SL moved', kind: 'mgmt' })).status, 200); await sleep(120);
      let mrow = (await db.query(`SELECT sent_at, tries FROM bot_msgs WHERE k='m-IV-4'`)).rows[0]; assert(mrow.sent_at === null && mrow.tries === 1, JSON.stringify(mrow));
      deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' }; await mu._test.alertSweep(); await mu._test.alertSweep();
      assert.strictEqual(live(), n0 + 2, 'delivered on retry, and only once'); assert((await db.query(`SELECT sent_at FROM bot_msgs WHERE k='m-IV-4'`)).rows[0].sent_at);
      // the short ledger alert: waits for the detailed text, then steps aside; if the detail never comes, it goes out after the hold
      const n1 = live();
      await ev4({ ev: 'open', k: 'SOLUSDT-900', sym: 'SOLUSDT', side: 'BUY', eng: 'fast', t: 900, entry: 150, sl: 145, tp: 160, lev: 5, m: 100, relay: 'SENT', rid: 'iv900' }); await sleep(150);
      assert.strictEqual(live(), n1, 'a new-firmware bot: the short alert is held back for now: ' + tradeAlerts.slice(n1).join('|'));
      await ev4({ ev: 'msg', k: 'm-IV-5', text: '<b>YM ORACLE IV</b> LONG <b>SOLUSDT</b> Entry $150', kind: 'entry', sym: 'SOLUSDT' }); await sleep(250);
      assert.strictEqual(live(), n1 + 1, 'the detailed entry text went out; the short one was dropped'); assert(/Entry \$150/.test(tradeAlerts[n1]));
      assert((await db.query(`SELECT alert_open_at FROM signals WHERE k='SOLUSDT-900'`)).rows[0].alert_open_at, 'marked as handled');
      await mu._test.pushSignalAlerts(); assert.strictEqual(live(), n1 + 1);
      const n2 = live(); await ev4({ ev: 'open', k: 'ADAUSDT-901', sym: 'ADAUSDT', side: 'SELL', eng: 'fast', t: 901, entry: 0.5, sl: 0.52, tp: 0.45, lev: 5, m: 100, relay: 'SENT', rid: 'iv901' }); await sleep(150);
      await mu._test.pushSignalAlerts(); assert.strictEqual(live(), n2, 'still inside the hold');
      process.env.TRADE_ALERT_HOLD_S = '0'; await mu._test.pushSignalAlerts(); delete process.env.TRADE_ALERT_HOLD_S;
      assert(live() === n2 + 1 && /Oracle IV ADA SHORT/.test(tradeAlerts[n2]), 'no detail came: the short alert is the safety net');
      // a close: the bot's result text also replaces the short close alert
      await ev4({ ev: 'close', k: 'SOLUSDT-900', sym: 'SOLUSDT', side: 'BUY', won: true, exit: 160, pct: 6, relayed: true, why: 'TP' }); await sleep(100);
      const n3 = live(); await ev4({ ev: 'msg', k: 'm-IV-6', text: 'RESULT SOLUSDT win', kind: 'result', sym: 'SOLUSDT' }); await sleep(250);
      assert.strictEqual(live(), n3 + 1, 'only the detailed result went out'); assert(/RESULT SOLUSDT/.test(tradeAlerts[n3]));
      const al = (await call('/api/admin/alerts', 'GET', null, admin)).j; assert(al.success && al.alerts.length >= 5 && al.alerts[0].sent === true && !/</.test(al.alerts[0].text) && al.undelivered === 0, JSON.stringify(al));
      assert.strictEqual((await call('/api/admin/alerts')).s, 401);
      // abuse guard: a flood of alerts or tests from one URL-knowing stranger is capped (429 = the bot keeps it and retries later)
      assert.strictEqual((await mu.recordBotEvent({ v: 1, bot: 'YM ORACLE III', ev: 'test' })).status, 429, 'tests are one at a time');
      deliverResult = { ok: true, configured: true, telegram: 'sent', email: 'off' }; let got429 = 0;
      for (let i = 0; i < 45; i++) { const r = await mu.recordBotEvent({ v: 1, bot: 'SPAMMER', ev: 'msg', k: 'spam-' + i, text: 'hello ' + i }); if (r.status === 429) got429++; }
      assert(got429 >= 5 && (await db.query(`SELECT COUNT(*)::int AS n FROM bot_msgs WHERE bot='SPAMMER'`)).rows[0].n === 40, 'at most 40 alerts per bot per 10 minutes: ' + got429);
      assert.strictEqual((await mu.recordBotEvent({ v: 1, bot: 'YM ORACLE IV', ev: 'msg', k: 'm-IV-after', text: 'still fine for a well-behaved bot' })).status, 200);
      await db.query(`DELETE FROM bot_msgs WHERE bot='SPAMMER'`);
      ok('bot-composed alerts: stored and delivered once with formatting (private chat and daily-email flags honoured), failures retried, resends ignored, and the short ledger alert steps aside for the detailed text (or goes out as the safety net after the hold)'); }

    // admin ledger: signal first, with the copies underneath
    const led = (await call('/api/admin/signal-ledger?hours=48', 'GET', null, admin)).j;
    assert(led.success && led.signals.length >= 5 && led.bots.length === 1 && led.bots[0].build === 'final-7');
    const good = led.signals.find(x => x.key === 'GOOD-1'), lost = led.signals.find(x => x.key === 'LOST-1'), notSent = led.signals.find(x => x.key === 'SKIP-1');
    assert(good.reached && good.state === 'ok' && good.copied >= 1 && good.symbol === 'BTCUSDT' && good.side === 'LONG', JSON.stringify(good));
    assert(lost.state === 'bad' && /Never reached/.test(lost.text) && !lost.reached); assert(notSent.state === 'info');
    assert.strictEqual((await call('/api/admin/signal-ledger', 'GET', null, hE)).s, 401);
    ok('admin signal ledger: one row per bot signal with reached / not reached, the bot\'s own words and how many users were copied; admin only');

    // the user's own activity, with the loss-at-stop estimate
    const act = (await call('/api/me/activity', 'GET', null, hE)).j;
    assert(act.success && act.items.length >= 1);
    const cp = act.items.find(x => x.outcome === 'copied' && x.symbol === 'BTCUSDT');
    assert(cp && cp.riskUsd > 0 && cp.riskPct > 0, 'copied trades carry the loss if the stop is hit: ' + JSON.stringify(cp));   // qty 0.01 x (65000-64000) = $10
    assert.strictEqual(cp.riskUsd, 10);
    await db.query(`UPDATE users SET size_mode='fixed', size_usd=5, size_pct=NULL WHERE id=$1`, [eId]);   // far below the minimum order
    for (const kk of Object.keys(state.positions)) delete state.positions[kk];
    await mu.fanOutOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.1', stopLoss: '64000', orderLinkId: 'ym-tiny1' });
    const act2 = (await call('/api/me/activity', 'GET', null, hE)).j; const sk = act2.items[0];
    assert(sk.outcome === 'skipped' && /smallest order/.test(sk.text), 'a skipped trade says why in plain words: ' + JSON.stringify(sk));
    assert.strictEqual((await call('/api/me/activity', 'GET', null)).s, 401);
    await db.query(`UPDATE users SET size_mode='percent', size_pct=20, size_usd=NULL WHERE id=$1`, [eId]);
    ok('user activity: every signal is copied or not copied with a plain reason, copied trades show the loss if the stop is hit, login required');
  }

  // ---------- Phase 3: the master account can follow the same sizing rule (off by default) ----------
  {
    const ord = { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001', orderLinkId: 'ym-m1' };
    delete process.env.MASTER_FOLLOWS_PLAN;
    assert.strictEqual(await mu.sizeMasterOrder(ord), null, 'off by default: the manager\'s quantity is used untouched');
    assert.strictEqual((await call('/api/admin/plan', 'GET', null, admin)).j.masterFollowsPlan, false);
    process.env.MASTER_FOLLOWS_PLAN = 'true';
    assert.strictEqual((await call('/api/admin/plan', 'GET', null, admin)).j.masterFollowsPlan, true);
    for (const kk of Object.keys(state.positions)) delete state.positions[kk];
    mu._test.ageAdminEquity(0, true);
    const z = await mu.sizeMasterOrder(ord);        // master equity 1000: 20% = $200 at the pair's 10x -> 0.0307 -> 0.03
    assert(z && z.qty === 0.03 && z.leverage === 10 && z.from === 0.001, JSON.stringify(z));
    state.equity.ADMINK = 10000; const big = await mu.sizeMasterOrder(ord); assert.strictEqual(big.qty, 0.07);   // 20% = $2,000 but no trade uses more than $500
    state.equity.ADMINK = 1000;
    assert.strictEqual(await mu.sizeMasterOrder({ ...ord, reduceOnly: true }), null, 'closes are never resized');
    state.positions['ADMINK:BTCUSDT'] = { side: 'Buy', size: '0.05' }; assert.strictEqual(await mu.sizeMasterOrder(ord), null, 'already holding the pair: left to the normal rules'); delete state.positions['ADMINK:BTCUSDT'];
    state.equity.ADMINK = 20; const tiny = await mu.sizeMasterOrder(ord); assert(tiny && tiny.skipped === 'MINQ' && !tiny.qty, 'cannot size: reported so the relay falls back to the manager quantity'); state.equity.ADMINK = 1000;
    mode = 'paper'; assert.strictEqual(await mu.sizeMasterOrder(ord), null, 'paper mode: untouched'); mode = 'live';
    delete process.env.MASTER_FOLLOWS_PLAN;
    ok('master sizing (MASTER_FOLLOWS_PLAN): off by default; on, the master uses the same rule (20% of its balance, $500 cap, pair leverage); closes, held pairs, paper mode and unsizable orders are left to the manager');
  }

  // ---------- Profit Guard: raises stops toward profit only, shadow first, clamps looser bot stops ----------
  {
    await db.query('TRUNCATE profit_guard_log, pg_trades'); await db.query(`DELETE FROM meta WHERE k IN ('profit_guard','profit_guard_state','profit_guard_watch')`);
    mu._test.pgWatch.clear(); mu._test.pgClosing.length = 0; state.closedPnl.ADMINK = []; state.tickers = { BTCUSDT: 125, ETHUSDT: 2000 };
    for (const kk of Object.keys(state.positions)) delete state.positions[kk];
    mu._test.pgState.clear(); mode = 'live'; halted = false; await call('/api/admin/profit-guard', 'POST', { mode: 'off' }, admin);   // a failed earlier run may have left it on
    await db.query(`INSERT INTO signals(k,bot,symbol,side,eng,entry,sl) VALUES('pgsig','YM ORACLE I','BTCUSDT','BUY','swing',100,90) ON CONFLICT (k) DO NOTHING`);
    const P = (mark, sl) => { state.positions['ADMINK:BTCUSDT'] = { side: 'Buy', size: '0.1', avgPrice: '100', markPrice: String(mark), stopLoss: String(sl) }; };
    const G = () => call('/api/admin/profit-guard', 'GET', null, admin);
    const masterStops = () => state.stops.filter(x => x.k === 'ADMINK');
    const logs = async (ev) => (await db.query(`SELECT * FROM profit_guard_log WHERE event=$1 ORDER BY id`, [ev])).rows;
    assert.strictEqual((await G()).j.cfg.mode, 'off');
    P(150, 90); let s0 = state.stops.length; await mu._test.pgTick(); assert.strictEqual(state.stops.length, s0); assert.strictEqual(mu._test.pgState.size, 0);
    assert.strictEqual((await call('/api/admin/profit-guard', 'GET')).s, 401);
    assert.strictEqual((await call('/api/admin/profit-guard', 'POST', { mode: 'turbo' }, admin)).s, 400);
    assert.strictEqual((await call('/api/admin/profit-guard', 'POST', { mode: 'live' }, admin)).s, 400, 'going live needs the confirm');
    ok('profit guard: off by default and does nothing; settings need admin and a confirm to go live');

    assert((await call('/api/admin/profit-guard', 'POST', { mode: 'shadow' }, admin)).j.cfg.mode === 'shadow');
    s0 = state.stops.length; P(150, 90); await mu._test.pgTick();
    assert.strictEqual(state.stops.length, s0, 'shadow never touches a stop');
    let wr = await logs('would_raise'); assert.strictEqual(wr.length, 1); assert.strictEqual(Number(wr[0].new_sl), 127.5); assert.strictEqual(wr[0].profile, 'swing');
    await mu._test.pgTick(); assert.strictEqual((await logs('would_raise')).length, 1, 'the same decision is not logged again');
    P(120, 90); await mu._test.pgTick(); assert.strictEqual((await logs('would_exit')).length, 1, 'price fell to the guard\'s stop: recorded as a would-be exit');
    state.closedPnl.ADMINK = [{ symbol: 'BTCUSDT', avgExitPrice: '125', closedPnl: '2.5', updatedTime: String(Date.now()) }];
    delete state.positions['ADMINK:BTCUSDT']; await mu._test.pgTick(); assert.strictEqual((await logs('closed')).length, 1); assert.strictEqual(mu._test.pgState.size, 0);
    ok('profit guard shadow: logs the stop it would set and the exit it would have made, touches nothing real, forgets a closed trade');

    assert((await call('/api/admin/profit-guard', 'POST', { mode: 'live', confirm: 'LIVE' }, admin)).j.cfg.mode === 'live');
    state.positions['KEYB:BTCUSDT'] = { side: 'Buy', size: '0.02', avgPrice: '100' };
    tradeAlerts.length = 0; s0 = state.stops.length; P(150, 90); await mu._test.pgTick(); await sleep(400);
    assert.deepStrictEqual(masterStops().slice(-1)[0].b.stopLoss, '127.5');
    assert(state.stops.slice(s0).every(x => x.b.stopLoss === '127.5' && x.b.symbol === 'BTCUSDT'), 'master and copies get the same stop');
    assert((await logs('raised')).length === 1 && tradeAlerts.some(t => /Profit locked: BTC long/.test(t)));
    const n1 = state.stops.length; P(150, 127.5); await mu._test.pgTick(); await sleep(100); assert.strictEqual(state.stops.length, n1, 'already tight: nothing more is sent');
    ok('profit guard live: raises the master stop and the copies\' stops once, tells you, and does not repeat');

    assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', stopLoss: '95', takeProfit: '300' }).stopLoss, '127.5');
    assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', stopLoss: '0' }).stopLoss, '127.5');
    assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', stopLoss: '140' }).stopLoss, '140');
    assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', takeProfit: '300' }).stopLoss, undefined);
    assert.strictEqual(mu.guardClamp({ symbol: 'ETHUSDT', stopLoss: '1' }).stopLoss, '1');
    await sleep(300); assert((await logs('held')).length >= 2);
    ok('profit guard: a bot\'s looser stop (or a stop removal) is held at the floor; a tighter stop, TP-only updates and other pairs pass untouched');

    P(200, 127.5); await mu._test.pgTick(); assert.strictEqual(masterStops().slice(-1)[0].b.stopLoss, '165');   // 10R: keep 65% of the +100 peak
    P(180, 165); await mu._test.pgTick(); assert.strictEqual(masterStops().slice(-1)[0].b.stopLoss, '165', 'a pullback never lowers it');
    ok('profit guard: the floor follows new highs and never drops on a pullback');

    halted = true; const n2 = state.stops.length; P(260, 165); await mu._test.pgTick(); assert.strictEqual(state.stops.length, n2, 'halted: it does nothing');
    halted = false; mode = 'paper'; P(260, 165); await mu._test.pgTick(); assert.strictEqual(state.stops.length, n2, 'paper mode: it does nothing'); mode = 'live';
    state.submitRet = {};
    const saved = (await db.query(`SELECT v FROM meta WHERE k='profit_guard_state'`)).rows[0]; assert(saved && /BTCUSDT\|Buy/.test(saved.v), 'peaks and floors are saved');
    ok('profit guard: stays out when trading is halted or in paper mode; its state is saved for restarts');

    assert((await call('/api/admin/profit-guard', 'POST', { mode: 'off' }, admin)).j.cfg.mode === 'off');
    assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', stopLoss: '95' }).stopLoss, '95', 'off: no clamping');
    for (const kk of Object.keys(state.positions)) delete state.positions[kk]; mu._test.pgState.clear();
    await db.query(`DELETE FROM meta WHERE k IN ('profit_guard','profit_guard_state')`);
    ok('profit guard: switching it off removes all of its influence');

    // ---------- v2.7.0: per-profile modes, scorecard, re-entry recorder, scale-out ----------
    {
      mu._test.pgState.clear(); mu._test.pgWatch.clear(); mu._test.pgClosing.length = 0; state.closedPnl.ADMINK = []; state.tickers = { BTCUSDT: 125, ETHUSDT: 2000 };
      await db.query('TRUNCATE profit_guard_log, pg_trades');
      await db.query(`INSERT INTO signals(k,bot,symbol,side,eng,entry,sl) VALUES('pgsig2','YM ORACLE IV','ETHUSDT','BUY','fast',100,90) ON CONFLICT (k) DO NOTHING`);
      const PB = (mark, sl, size) => { state.positions['ADMINK:BTCUSDT'] = { side: 'Buy', size: String(size || 0.1), avgPrice: '100', markPrice: String(mark), stopLoss: String(sl) }; };
      const PE = (mark, sl) => { state.positions['ADMINK:ETHUSDT'] = { side: 'Buy', size: '1', avgPrice: '100', markPrice: String(mark), stopLoss: String(sl) }; };
      const P2 = () => call('/api/admin/profit-guard', 'POST', {}, admin);
      // a profile can have its own mode; going live for any profile needs the confirm
      assert.strictEqual((await call('/api/admin/profit-guard', 'POST', { mode: 'shadow', swing: { mode: 'live' } }, admin)).s, 400);
      const sm = await call('/api/admin/profit-guard', 'POST', { mode: 'shadow', swing: { mode: 'live' }, confirm: 'LIVE' }, admin);
      assert(sm.j.success && sm.j.cfg.swing.mode === 'live' && sm.j.cfg.fast.mode === 'inherit');
      let s0 = state.stops.length; PB(150, 90); PE(150, 90); await mu._test.pgTick(); await sleep(300);
      assert(masterStops().slice(s0 ? 0 : 0).some(x => x.b.symbol === 'BTCUSDT' && x.b.stopLoss === '127.5'), 'swing (live) moved its real stop');
      assert(!state.stops.some(x => x.b.symbol === 'ETHUSDT'), 'fast (shadow) touched nothing');
      assert((await logs('would_raise')).some(x => x.symbol === 'ETHUSDT' && x.profile === 'fast'), 'fast recorded what it would do');
      assert.strictEqual(mu.guardClamp({ symbol: 'ETHUSDT', stopLoss: '95' }).stopLoss, '95', 'only a LIVE profile clamps');
      assert.strictEqual(mu.guardClamp({ symbol: 'BTCUSDT', stopLoss: '95' }).stopLoss, '127.5');
      assert.strictEqual((await call('/api/admin/profit-guard', 'POST', { mode: 'off' }, admin)).j.cfg.mode, 'off');
      ok('profit guard: fast and swing each have their own mode (here swing live, fast shadow); the overall Off is a master switch; going live needs the confirm');

      // scorecard: a closed trade is stored with Bybit's own exit and how much it gave back
      await call('/api/admin/profit-guard', 'POST', { mode: 'shadow', swing: { mode: 'live' }, confirm: 'LIVE' }, admin);
      state.closedPnl.ADMINK = [{ symbol: 'BTCUSDT', avgExitPrice: '130', closedPnl: '3', updatedTime: String(Date.now()) }];
      delete state.positions['ADMINK:BTCUSDT']; delete state.positions['ADMINK:ETHUSDT'];
      await mu._test.pgTick();
      const tr = (await db.query(`SELECT * FROM pg_trades WHERE symbol='BTCUSDT' ORDER BY id DESC LIMIT 1`)).rows[0];
      assert(tr && tr.profile === 'swing' && tr.mode === 'live' && Number(tr.peak_pct) === 50 && Number(tr.exit_pct) === 30 && Number(tr.giveback_pct) === 20 && Number(tr.peak_r) === 5 && Number(tr.exit_r) === 3, JSON.stringify(tr));
      assert.strictEqual((await db.query(`SELECT 1 FROM pg_trades WHERE symbol='ETHUSDT'`)).rows.length, 0, 'it waits for Bybit\'s record first');
      for (let i = 0; i < 7; i++) await mu._test.pgTick();
      const eth = (await db.query(`SELECT * FROM pg_trades WHERE symbol='ETHUSDT'`)).rows[0]; assert(eth && eth.exit_price === null && eth.mode === 'shadow', 'an exit Bybit has not reported is kept as unknown, not guessed');
      assert.strictEqual(mu._test.pgClosing.length, 0);
      const sc = (await call('/api/admin/profit-guard', 'GET', null, admin)).j.scorecard;
      assert(sc.recent.length >= 2 && sc.summary.some(x => x.profile === 'swing' && Number(x.giveback) === 20), JSON.stringify(sc.summary));
      ok('profit guard scorecard: each closed trade is stored with its best point, its real exit and how much it gave back; an unknown exit stays unknown');

      // re-entry recorder: pulled back, resumed, +2R (recording only; nothing is ordered)
      assert(mu._test.pgWatch.has('BTCUSDT|Buy'), 'a winner that closed is being watched');
      const sub0 = state.submits.length;
      state.tickers.BTCUSDT = 120; await mu._test.pgTick(); assert.strictEqual((await logs('would_reenter')).length, 0);
      state.tickers.BTCUSDT = 135; await mu._test.pgTick();
      const wr = await logs('would_reenter'); assert.strictEqual(wr.length, 1); assert.strictEqual(Number(wr[0].mark), 135); assert.strictEqual(Number(wr[0].new_sl), 120);
      state.tickers.BTCUSDT = 170; await mu._test.pgTick();
      const rr = await logs('reentry_result'); assert(rr.length === 1 && Number(rr[0].result_r) === 2, JSON.stringify(rr));
      assert(!mu._test.pgWatch.has('BTCUSDT|Buy'), 'finished watches are removed');
      assert.strictEqual(state.submits.length, sub0, 'the recorder never places an order');
      const rsum = (await call('/api/admin/profit-guard', 'GET', null, admin)).j.scorecard.reentry; assert(rsum.spotted === 1 && rsum.done === 1 && rsum.wins === 1);
      ok('profit guard re-entry recorder: notes a pullback-and-resume entry and its outcome, shows it in the summary, and never trades');

      // scale-out
      await call('/api/admin/profit-guard', 'POST', { mode: 'shadow', swing: { mode: 'shadow', scale: { on: true, steps: [[3, 0.25]] } } }, admin);
      PB(135, 90); await mu._test.pgTick(); await sleep(150);
      assert((await logs('would_scale')).length === 1 && state.submits.length === sub0, 'shadow only records');
      state.positions['KEYA:BTCUSDT'] = { side: 'Buy', size: '0.4' };
      assert.strictEqual((await call('/api/admin/profit-guard', 'POST', { swing: { mode: 'live', scale: { on: true } } }, admin)).s, 400, 'live scale-out needs the confirm');
      await call('/api/admin/profit-guard', 'POST', { mode: 'live', confirm: 'LIVE', swing: { mode: 'live' } }, admin);
      mu._test.pgState.clear(); PB(135, 90, 0.1); await mu._test.pgTick(); await sleep(500);
      const so = state.submits.slice(sub0).filter(x => x.body.reduceOnly);
      const mo = so.find(x => x.k === 'ADMINK'); assert(mo && mo.body.qty === '0.02' && mo.body.side === 'Sell', JSON.stringify(so.map(x => [x.k, x.body.qty])));
      const uo = so.find(x => x.k === 'KEYA'); assert(uo && uo.body.qty === '0.1', 'a copy closes the same SHARE of its own position (25% of 0.4)');
      assert((await logs('scaled')).length === 1 && tradeAlerts.some(t => /Profit banked: BTC long 25%/.test(t)));
      const sub1 = state.submits.length; PB(140, 90, 0.08); await mu._test.pgTick(); await sleep(150);
      assert.strictEqual(state.submits.slice(sub0).filter(x => x.body.reduceOnly).length, so.length, 'each step is taken once');
      const fit = await mu.guardFitClose({ symbol: 'BTCUSDT', side: 'Sell', reduceOnly: true, qty: '0.1' }); assert.strictEqual(fit.qty, '0.08', 'the bot\'s later full close is fitted to what is left');
      assert.strictEqual((await mu.guardFitClose({ symbol: 'ETHUSDT', side: 'Sell', reduceOnly: true, qty: '0.1' })).qty, '0.1');
      assert.strictEqual((await mu.guardFitClose({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.1' })).qty, '0.1', 'opens are never touched');
      ok('profit guard scale-out: shadow records, live closes a slice on the master and the same share on each copy, once per step, and a later full close is fitted to what is left');

      // no bot is special: the profile follows the trade's own engine tag
      await call('/api/admin/profit-guard', 'POST', { mode: 'shadow', fast: { mode: 'inherit' }, swing: { mode: 'inherit', scale: { on: false } } }, admin);
      await db.query(`INSERT INTO signals(k,bot,symbol,side,eng,entry,sl) VALUES('pgsig3','YM ORACLE IV','SOLUSDT','BUY','fast',100,90),('pgsig4','YM ORACLE II','XRPUSDT','SELL','swing',100,110) ON CONFLICT (k) DO NOTHING`);
      mu._test.pgState.clear();
      state.positions['ADMINK:SOLUSDT'] = { side: 'Buy', size: '1', avgPrice: '100', markPrice: '101', stopLoss: '90' };
      state.positions['ADMINK:XRPUSDT'] = { side: 'Sell', size: '1', avgPrice: '100', markPrice: '99', stopLoss: '110' };
      await mu._test.pgTick();
      assert.strictEqual(mu._test.pgState.get('SOLUSDT|Buy').profile, 'fast', 'Oracle IV\'s own fast trade follows the fast profile');
      assert.strictEqual(mu._test.pgState.get('XRPUSDT|Sell').profile, 'swing', 'a swing trade from Oracle II follows the swing profile');
      ok('profit guard: the profile comes from the trade\'s engine tag, not from which bot sent it');
      await call('/api/admin/profit-guard', 'POST', { mode: 'off' }, admin);
      for (const kk of Object.keys(state.positions)) delete state.positions[kk]; mu._test.pgState.clear(); mu._test.pgWatch.clear(); mu._test.pgClosing.length = 0; state.tickers = {}; state.closedPnl.ADMINK = [];
      await db.query(`DELETE FROM meta WHERE k IN ('profit_guard','profit_guard_state','profit_guard_watch')`);
      await call('/api/admin/profit-guard', 'POST', { mode: 'off', swing: { mode: 'inherit', scale: { on: false } }, fast: { mode: 'inherit' } }, admin);
    }
  }

  const fs = require('fs'); for (const f of ['admin', 'join', 'share']) assert(fs.existsSync(R + '/public/' + f + '.html'));
  console.log('\nALL ' + n + ' CHECKS PASSED');
  srv.close(); await db.end(); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e); process.exit(1); });
