// Boots the REAL server.js against a fake Bybit (a local HTTP server that can drop connections, lose replies and
// report positions) and checks that a trade can never be live on Bybit and invisible on the web.
// Run:  RELAY_DIR=/path/to/relay node tests/server.test.js
// Optional: TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres also runs the landing-page and change-the-master-key checks (they need Postgres).
const R = process.env.RELAY_DIR || '/home/claude/relay';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = m => console.log('  ok', ++n, m);

// ---------- fake Bybit ----------
const fake = {
  creates: [],            // every order/create that reached the "exchange" (body)
  seen: new Set(),        // orderLinkIds already accepted
  behaviour: {},          // orderLinkId -> 'lose-reply' | 'drop' | 'drop-always' | 'slow'
  attempts: {},           // orderLinkId -> attempts so far
  positions: [],
  positionsErr: false,
};
const fakeSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ retMsg: 'OK', retExtInfo: {}, time: Date.now(), ...o })); };
    fake.keysSeen = fake.keysSeen || []; fake.keysSeen.push(req.headers['x-bapi-api-key']);
    if (u.pathname === '/v5/account/wallet-balance' && req.headers['x-bapi-api-key'] === 'BADKEY') return send({ retCode: 10003, retMsg: 'API key is invalid', result: {} });
    if (u.pathname === '/v5/order/create') {
      const b = JSON.parse(body || '{}'); const link = b.orderLinkId;
      fake.attempts[link] = (fake.attempts[link] || 0) + 1;
      const mode = fake.behaviour[link];
      if (mode === 'drop-always' || (mode === 'drop' && fake.attempts[link] === 1)) return req.socket.destroy(); // connection dies BEFORE the order lands
      if (mode === 'slow') await sleep(400);
      if (fake.seen.has(link)) return send({ retCode: 110072, retMsg: 'duplicate orderLinkId', result: {} });
      fake.seen.add(link); fake.creates.push(b);
      if (mode === 'lose-reply' && fake.attempts[link] === 1) return req.socket.destroy(); // order LANDED, the reply never arrives
      return send({ retCode: 0, result: { orderId: 'oid-' + fake.creates.length, orderLinkId: link } });
    }
    if (u.pathname === '/v5/position/list') {
      if (fake.positionsErr) return send({ retCode: 10001, retMsg: 'fake outage', result: {} });
      return send({ retCode: 0, result: { list: fake.positions, nextPageCursor: '' } });
    }
    if (fake.sizing && u.pathname === '/v5/account/wallet-balance') return send({ retCode: 0, result: { list: [{ totalAvailableBalance: '1000', coin: [{ coin: 'USDT', equity: '1000', walletBalance: '1000' }] }] } });
    if (fake.sizing && u.pathname === '/v5/market/instruments-info') return send({ retCode: 0, result: { list: [{ status: 'Trading', lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001' } }] } });
    if (fake.sizing && u.pathname === '/v5/market/tickers') return send({ retCode: 0, result: { list: [{ lastPrice: '65000' }] } });
    if (u.pathname === '/v5/position/closed-pnl') return send({ retCode: 0, result: { list: [], nextPageCursor: '' } });
    if (u.pathname === '/v5/position/trading-stop') return send({ retCode: 0, result: {} });
    if (u.pathname === '/v5/position/set-leverage') return send({ retCode: 0, result: {} });
    return send({ retCode: 0, result: { list: [] } });
  });
});

// ---------- boot the real server ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-srv-'));
function boot(port, extra) {
  const env = {
    PATH: process.env.PATH, PORT: String(port), BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's', TRADE_MODE: 'live',
    BYBIT_BASE_URL: 'http://127.0.0.1:' + fakeSrv.address().port, DASHBOARD_PASSWORD: 'dash-pass',
    TRADE_LOG_PATH: path.join(tmp, 'p' + port + '-trades.jsonl'), MODE_FILE: path.join(tmp, 'p' + port + '-mode.json'),
    CIRCUIT_BREAKER_FILE: path.join(tmp, 'p' + port + '-halt'), EXEC_REPORTS_FILE: path.join(tmp, 'p' + port + '-exec.json'),
    TRADE_LOG_CLEARED_AT_FILE: path.join(tmp, 'p' + port + '-cleared.json'), ...(extra || {}),
  };
  const child = spawn('node', ['server.js'], { cwd: R, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  child.stdout.on('data', d => (child.out += d)); child.stderr.on('data', d => (child.out += d));
  return child;
}
const waitUp = async port => { for (let i = 0; i < 60; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return; } catch { /* not yet */ } await sleep(250); } throw new Error('server did not start'); };
const mk = port => ({
  post: async (p, body, hdr) => { const r = await fetch('http://127.0.0.1:' + port + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(hdr || {}) }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; },
  get: async (p, hdr) => { const r = await fetch('http://127.0.0.1:' + port + p, { headers: hdr || {} }); return { s: r.status, j: await r.json() }; },
});
const DASH = { 'X-Dashboard-Password': 'dash-pass' };
const order = (link, extra) => ({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.01', orderLinkId: link, ...(extra || {}) });

(async () => {
  await new Promise(r => fakeSrv.listen(0, r));
  const P1 = 40100 + Math.floor(Math.random() * 400), P2 = P1 + 500, P3 = P1 + 1000;
  const s1 = boot(P1); await waitUp(P1); const A = mk(P1);
  const trades = async () => (await A.get('/api/trade-log', DASH)).j.trades;
  const byLink = async l => (await trades()).filter(t => t.orderLinkId === l);

  const root = await A.get('/');
  assert(root.j.status === 'ok' && /YM Oracle/.test(root.j.message), 'branding on the root route');
  ok('server boots against the fake exchange and identifies itself as the YM Oracle relay');

  // 1. a retried order is processed once
  const r1 = await A.post('/api/order', order('ym-AAA1'));
  assert(r1.s === 200 && r1.j.retCode === 0 && !r1.j.replayed);
  const r1b = await A.post('/api/order', order('ym-AAA1'));
  assert(r1b.s === 200 && r1b.j.retCode === 0 && r1b.j.replayed === true);
  assert.strictEqual(fake.creates.filter(c => c.orderLinkId === 'ym-AAA1').length, 1, 'Bybit saw it once');
  assert.strictEqual((await byLink('ym-AAA1')).length, 1, 'logged once');
  ok('the same orderLinkId sent twice reaches Bybit once and is logged once; the retry gets the stored answer');

  // 2. two copies at the same moment still make one order
  fake.behaviour['ym-BBB2'] = 'slow';
  const [c1, c2] = await Promise.all([A.post('/api/order', order('ym-BBB2')), A.post('/api/order', order('ym-BBB2'))]);
  assert(c1.s === 200 && c2.s === 200 && c1.j.retCode === 0 && c2.j.retCode === 0);
  assert.strictEqual(fake.creates.filter(c => c.orderLinkId === 'ym-BBB2').length, 1);
  assert.strictEqual((await byLink('ym-BBB2')).length, 1);
  ok('two simultaneous requests for one orderLinkId: one order, both callers get an answer');

  // 3. THE incident shape: the order lands on Bybit but the reply is lost
  fake.behaviour['ym-LOST3'] = 'lose-reply';
  const l3 = await A.post('/api/order', order('ym-LOST3', { symbol: 'ETHUSDT' }));
  assert(l3.s === 200 && l3.j.retCode === 110072, 'the relay retried itself and Bybit said duplicate = it is there: ' + JSON.stringify(l3.j));
  const l3t = await byLink('ym-LOST3');
  assert(l3t.length === 1 && l3t[0].symbol === 'ETHUSDT' && l3t[0].status === 'OPEN' && l3t[0].source === 'order-dup', 'logged although the first reply was lost');
  assert.strictEqual(fake.creates.filter(c => c.orderLinkId === 'ym-LOST3').length, 1, 'never a second order');
  ok('order landed but the reply was lost: the retry sees "duplicate", which counts as placed, so the trade is on the web');

  // 4. connection dies before the order lands: retried once inside the relay
  fake.behaviour['ym-DROP4'] = 'drop';
  const d4 = await A.post('/api/order', order('ym-DROP4', { symbol: 'SOLUSDT' }));
  assert(d4.s === 200 && d4.j.retCode === 0);
  assert.strictEqual(fake.creates.filter(c => c.orderLinkId === 'ym-DROP4').length, 1); assert.strictEqual((await byLink('ym-DROP4')).length, 1);
  ok('connection dropped before the order landed: the relay retries and the order and the log entry both exist exactly once');

  // 5. Bybit unreachable for the whole call: manager is told (500), nothing is logged, a later retry works and is logged
  fake.behaviour['ym-FAIL5'] = 'drop-always';
  const f5 = await A.post('/api/order', order('ym-FAIL5', { symbol: 'XRPUSDT' }));
  assert.strictEqual(f5.s, 500); assert.strictEqual((await byLink('ym-FAIL5')).length, 0);
  fake.behaviour['ym-FAIL5'] = undefined;
  const f5b = await A.post('/api/order', order('ym-FAIL5', { symbol: 'XRPUSDT' }));
  assert(f5b.s === 200 && f5b.j.retCode === 0 && !f5b.j.replayed && (await byLink('ym-FAIL5')).length === 1);
  ok('a failed attempt is not remembered as done: the manager\'s later retry goes through and is logged');

  // 6. closes are orders too and must not be logged as new trades
  const before = (await trades()).length;
  await A.post('/api/order', order('ymc-CLOSE6', { reduceOnly: true, side: 'Sell' }));
  assert.strictEqual((await trades()).length, before);
  ok('a reduce-only close is not logged as an open trade');

  // 7. the manager's own report heals a missing log entry, and never duplicates one
  const rep = { id: 'ZZ9XYZ', bot: 'YM ORACLE II', kind: 'TRADE', side: 'BUY', symbol: 'ADAUSDT', ok: true, code: 'OK', detail: 'accepted' };
  assert.strictEqual((await A.post('/api/exec-report', rep)).s, 200);
  let hz = await byLink('ym-ZZ9XYZ'); assert(hz.length === 1 && hz[0].symbol === 'ADAUSDT' && hz[0].side === 'Buy' && hz[0].source === 'exec-report');
  await A.post('/api/exec-report', rep); assert.strictEqual((await byLink('ym-ZZ9XYZ')).length, 1);
  await A.post('/api/order', order('ym-AAA1')); await A.post('/api/exec-report', { ...rep, id: 'AAA1', symbol: 'BTCUSDT', bot: 'YM ORACLE I' });
  assert.strictEqual((await byLink('ym-AAA1')).length, 1, 'a report for a trade the order call already logged adds nothing');
  await A.post('/api/exec-report', { id: 'REF123', bot: 'YM ORACLE III', kind: 'TRADE', side: 'SELL', symbol: 'DOGEUSDT', ok: false, code: 'BAL', detail: 'low' });
  assert.strictEqual((await byLink('ym-REF123')).length, 0, 'a refused trade is never logged as open');
  assert.strictEqual((await A.post('/api/exec-report', { kind: 'TRADE' })).s, 400);
  ok('exec reports: write the missing entry for a trade that landed, never duplicate, never log a refusal as a trade');

  // 8. positions on Bybit that the log does not know are added
  fake.positions = [{ symbol: 'LINKUSDT', side: 'Sell', size: '12', leverage: '5', takeProfit: '0', stopLoss: '15.5', createdTime: '1790000000000' }];
  await A.post('/api/exec-report', { id: 'TRG001', bot: 'YM ORACLE I', kind: 'TRADE', side: 'BUY', symbol: 'LTCUSDT', ok: true, code: 'OK' }); // also schedules a look at Bybit
  await sleep(5500);
  const sy = (await A.get('/api/sync-status', DASH)).j;
  assert(sy.success && sy.masterOpen === 1 && sy.recoveredTotal >= 1 && sy.lastError === null && sy.lastOkAt > 0, JSON.stringify(sy));
  const rec = (await trades()).find(t => t.symbol === 'LINKUSDT');
  assert(rec && rec.side === 'Sell' && rec.status === 'OPEN' && rec.source === 'reconcile' && rec.stopLoss === '15.5' && rec.takeProfit === null && /^2026/.test(rec.openedAt), JSON.stringify(rec));
  const recN = (await trades()).filter(t => t.symbol === 'LINKUSDT').length;
  await A.post('/api/exec-report', { id: 'TRG002', bot: 'YM ORACLE I', kind: 'TRADE', side: 'BUY', symbol: 'LTCUSDT', ok: true, code: 'OK' }); await sleep(5500);
  assert.strictEqual((await trades()).filter(t => t.symbol === 'LINKUSDT').length, recN, 'a second look adds nothing');
  ok('Bybit is the source of truth: a position the log never heard of is added (with its real stop and time) and not added twice');

  fake.positionsErr = true;
  await A.post('/api/exec-report', { id: 'TRG003', bot: 'YM ORACLE I', kind: 'TRADE', side: 'BUY', symbol: 'LTCUSDT', ok: true, code: 'OK' }); await sleep(5500);
  const sy2 = (await A.get('/api/sync-status', DASH)).j; assert(/fake outage/.test(sy2.lastError || ''), JSON.stringify(sy2));
  assert.strictEqual((await A.get('/api/sync-status')).s, 401);
  fake.positionsErr = false;
  ok('when Bybit cannot be read the sync status says so instead of claiming everything is fine; the endpoint needs the dashboard password');

  // 8b. bot events: the web-ledger firmware posts here; it must answer 2xx (no multi-user database here, so events are accepted and dropped) and must never 404
  assert.strictEqual((await A.post('/api/bot-event', { v: 1, bot: 'YM ORACLE I', ev: 'open', k: 'BTCUSDT-1', sym: 'BTCUSDT', side: 'BUY', eng: 'fast', t: 1, rid: 'r1', relay: 'SENT' })).s, 200);
  assert.strictEqual((await A.post('/api/bot-event', { v: 1, bot: 'YM ORACLE I', ev: 'status', t: 1 })).s, 200);
  ok('/api/bot-event exists and accepts the bots\' reports');

  // 9. heartbeat: old firmware (name only), new beacon, junk
  assert.strictEqual((await A.post('/api/heartbeat', { name: 'YM ORACLE I' })).s, 200);
  assert.strictEqual((await A.post('/api/heartbeat', {})).s, 400);
  await A.post('/api/heartbeat', { name: '<img src=x onerror=1>' });
  assert.strictEqual((await A.post('/api/heartbeat', { name: 'YM ORACLE IV', uptimeMin: 72, freeHeap: 24144, resetReason: 'CRASH', build: 'final-8', relayOn: 1, relayMarginUsd: 100, swingRelayOn: 0 })).s, 200);
  assert.strictEqual((await A.post('/api/heartbeat', { name: 'YM ORACLE IV', uptimeMin: 'x"><b>', freeHeap: {}, resetReason: '<b>', build: 5, relayOn: 'maybe' })).s, 200);
  const fl = (await A.get('/api/fleet-status', DASH)).j;
  assert(fl.success && fl.bots.some(b => b.name === 'YM ORACLE IV'), 'bot IV is now part of the fleet list and the offline alerts');
  assert(!JSON.stringify(fl).includes('<'), 'no markup survives in a bot name');
  ok('heartbeats: name-only (old firmware), the new state beacon and junk are all handled; bot IV is tracked');

  s1.kill();

  // 10. the device key: with DEVICE_KEY_MODE=enforce a forged signal is refused
  const s2 = boot(P2, { DEVICE_API_KEY: 'device-secret-1', DEVICE_KEY_MODE: 'enforce' }); await waitUp(P2); const B = mk(P2);
  assert.strictEqual((await B.post('/api/order', order('ym-SEC1'))).s, 401);
  assert.strictEqual((await B.post('/api/order', order('ym-SEC1'), { 'X-Device-Key': 'wrong' })).s, 401);
  assert.strictEqual(fake.creates.filter(c => c.orderLinkId === 'ym-SEC1').length, 0, 'nothing reached Bybit');
  assert.strictEqual((await B.post('/api/order', order('ym-SEC1'), { 'X-Device-Key': 'device-secret-1' })).s, 200);
  for (const [p, body] of [['/api/heartbeat', { name: 'YM ORACLE I' }], ['/api/exec-report', { id: 'Q1', kind: 'TRADE' }], ['/api/trading-stop', { category: 'linear', symbol: 'BTCUSDT', stopLoss: '1' }], ['/api/set-leverage', { symbol: 'BTCUSDT', buyLeverage: 3, sellLeverage: 3 }], ['/api/ping-result', { pingId: 'x', name: 'YM ORACLE I', ms: 5 }], ['/api/bot-event', { v: 1, bot: 'YM ORACLE I', ev: 'status', t: 1 }]])
    assert.strictEqual((await B.post(p, body)).s, 401, p + ' refuses without the key');
  assert.strictEqual((await B.get('/api/ping-check')).s, 401);
  assert.strictEqual((await B.get('/api/ping-check', { 'X-Device-Key': 'device-secret-1' })).s, 200);
  assert.strictEqual((await B.get('/api/health')).s, 200);
  ok('device key (enforce mode): every bot-facing route refuses requests without it and nothing reaches Bybit; the health ping stays open');
  s2.kill();

  // 11. the landing page and changing the master key from the dashboard (needs the database)
  if (!process.env.TEST_DATABASE_URL) { ok('landing page and master-key checks skipped (set TEST_DATABASE_URL)'); console.log('\nALL ' + n + ' SERVER CHECKS PASSED'); fakeSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }
  const { Pool } = require(R + '/node_modules/pg');
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  await db.query(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`); await db.query(`DELETE FROM meta WHERE k='master_creds'`);
  const dbEnv = { DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL: 'false', KEY_ENCRYPTION_SECRET: require('crypto').randomBytes(32).toString('hex'), NODE_ENV: 'test', YM_TEST_BYBIT_URL: 'http://127.0.0.1:' + fakeSrv.address().port };
  let s3 = boot(P3, dbEnv); await waitUp(P3); let C = mk(P3);
  const rootHtml = await fetch('http://127.0.0.1:' + P3 + '/', { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  const rootTxt = await rootHtml.text();
  assert(rootHtml.status === 200 && /text\/html/.test(rootHtml.headers.get('content-type')) && /Trade signals/.test(rootTxt) && /Admin console/.test(rootTxt) && /\/join/.test(rootTxt), 'browsers get the landing page');
  const rootJson = await (await fetch('http://127.0.0.1:' + P3 + '/')).json();
  assert(rootJson.status === 'ok', 'health checks and curl still get the JSON status');
  assert.strictEqual((await fetch('http://127.0.0.1:' + P3 + '/home')).status, 200);
  ok('landing page: browsers get the hub, health checks still get JSON');

  // one sign-in: the admin console token also opens the trading routes; the old password header keeps working; strangers still get 401
  { const lg = await C.post('/api/admin/login', { password: 'dash-pass' }); assert(lg.j.success && lg.j.token, JSON.stringify(lg.j));
    const BEAR = { Authorization: 'Bearer ' + lg.j.token };
    for (const route of ['/api/status', '/api/master-key', '/api/fleet-status', '/api/sync-status']) {
      assert.strictEqual((await C.get(route, BEAR)).s, 200, route + ' with the console sign-in');
      assert.strictEqual((await C.get(route, DASH)).s, 200, route + ' with the old password');
      assert.strictEqual((await C.get(route)).s, 401, route + ' with nothing');
      assert.strictEqual((await C.get(route, { Authorization: 'Bearer wrong' })).s, 401, route + ' with a made-up token');
    }
    assert.strictEqual((await C.post('/api/halt', {}, BEAR)).s, 200); assert.strictEqual((await C.post('/api/resume', {}, BEAR)).s, 200);
    const red = await fetch('http://127.0.0.1:' + P3 + '/dashboard', { redirect: 'manual' });
    assert(red.status === 302 && /\/admin#trading$/.test(red.headers.get('location')), 'the old dashboard address leads to the console');
    assert.strictEqual((await fetch('http://127.0.0.1:' + P3 + '/dashboard/classic')).status, 200, 'the classic page is still there as a fallback');
    await C.post('/api/admin/logout', {}, BEAR); assert.strictEqual((await C.get('/api/status', BEAR)).s, 401, 'a signed-out token stops working');
    ok('one sign-in: the console token opens the trading routes (and stops after sign-out), the old password still works, strangers and made-up tokens get 401, /dashboard leads to the console'); }

  assert.strictEqual((await C.get('/api/master-key')).s, 401);
  const info0 = (await C.get('/api/master-key', DASH)).j;
  assert(info0.success && info0.source === 'render' && info0.hint === '••••k' && info0.canSave === true, JSON.stringify(info0));
  assert.strictEqual((await C.post('/api/master-key', { apiKey: 'x' }, DASH)).s, 400);
  const bad = await C.post('/api/master-key', { apiKey: 'BADKEY', apiSecret: 'sec', env: 'live' }, DASH);
  assert(bad.s === 400 && /rejected/i.test(bad.j.message), JSON.stringify(bad.j));
  assert.strictEqual((await C.get('/api/master-key', DASH)).j.source, 'render', 'a rejected key is never saved');
  fake.positions = [];
  const good = await C.post('/api/master-key', { apiKey: 'NEWKEY999', apiSecret: 'sec', env: 'demo' }, DASH);
  assert(good.s === 200 && good.j.hint === '••••Y999' && good.j.env === 'demo', JSON.stringify(good.j));
  const info1 = (await C.get('/api/master-key', DASH)).j; assert(info1.source === 'saved' && info1.env === 'demo');
  assert(!JSON.stringify(info1).includes('NEWKEY999') && !JSON.stringify(good.j).includes('NEWKEY999'), 'the full key is never sent back');
  const stored = (await db.query(`SELECT v FROM meta WHERE k='master_creds'`)).rows[0].v; assert(!stored.includes('NEWKEY999'), 'stored encrypted, not in plain text');
  fake.keysSeen = []; fake.creates.length = 0;
  assert.strictEqual((await C.post('/api/order', order('ym-KEYSWAP1'))).s, 200);
  assert(fake.keysSeen.includes('NEWKEY999') && !fake.keysSeen.includes('k'), 'the very next order is signed with the new key, no restart');
  ok('changing the master key: bad key refused and not saved, good key checked, stored encrypted, used immediately, never echoed back');

  // 11a. with the admin authenticator on, the password alone no longer opens the controls (only the signed-in console does); the manager still reads balance/positions with it
  { const P5 = P1 + 1700; const sec = require(R + '/security.js'); const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const s5 = boot(P5, { ...dbEnv, ADMIN_TOTP_SECRET: TOTP }); await waitUp(P5); const T5 = mk(P5);
    assert.strictEqual((await T5.get('/api/status', DASH)).s, 401, 'password alone is refused for the controls');
    assert.strictEqual((await T5.post('/api/halt', {}, DASH)).s, 401); assert.strictEqual((await T5.get('/api/master-key', DASH)).s, 401);
    assert((await T5.get('/api/balance', DASH)).s !== 401, 'the manager still gets past the password check for the balance');
    assert((await T5.get('/api/positions', DASH)).s !== 401); assert.strictEqual((await T5.get('/api/balance')).s, 401, 'but a stranger does not');
    const lg5 = await T5.post('/api/admin/login', { password: 'dash-pass', totp: sec.totpCode(TOTP) }); assert(lg5.j.success && lg5.j.token, JSON.stringify(lg5.j));
    const B5 = { Authorization: 'Bearer ' + lg5.j.token };
    assert.strictEqual((await T5.get('/api/status', B5)).s, 200); assert.strictEqual((await T5.get('/api/master-key', B5)).s, 200);
    ok('authenticator on: the password alone is refused for status/halt/master key, the console session works, the manager still reads balance and positions'); s5.kill(); }

  // 11c. THE WHOLE PIPELINE: bot -> Render -> Telegram, with the manager's order arriving at the real server and a fake Bybit/Telegram
  { const P6 = P1 + 1900; const tg = []; let tgFail = 0;
    const tgSrv = http.createServer((rq, rs) => { let d = ''; rq.on('data', c => d += c); rq.on('end', () => { if (tgFail > 0) { tgFail--; rs.statusCode = 500; return rs.end('{"ok":false}'); } try { tg.push(JSON.parse(d).text); } catch { tg.push('?'); } rs.setHeader('Content-Type', 'application/json'); rs.end('{"ok":true}'); }); });
    await new Promise(r => tgSrv.listen(0, r));
    const s6 = boot(P6, { ...dbEnv, DEVICE_API_KEY: 'devkey-123', DEVICE_KEY_MODE: 'enforce', ALERT_TELEGRAM_BOT_TOKEN: 'T0KEN', ALERT_TELEGRAM_CHAT_ID: '42',
      YM_TEST_ALERT_URL: 'http://127.0.0.1:' + tgSrv.address().port, YM_TEST_TIMERS: '1', ALERT_SWEEP_MS: '500', SIGNAL_ALARM_SECONDS: '3', TRADE_ALERT_HOLD_S: '2' });
    await db.query('TRUNCATE signals, bot_msgs'); await waitUp(P6); const E = mk(P6); await sleep(1200);
    const DK = { 'X-Device-Key': 'devkey-123' };
    const ev = (o) => E.post('/api/bot-event', { v: 1, bot: 'YM ORACLE 1', ...o }, DK);
    const waitFor = async (fn, ms) => { for (let i = 0; i < ms / 100; i++) { if (fn()) return true; await sleep(100); } return false; };
    const has = re => tg.filter(t => re.test(t));
    assert.strictEqual((await E.post('/api/bot-event', { v: 1, bot: 'x', ev: 'status' })).s, 401, 'no device key = refused in enforce mode');
    await ev({ ev: 'msg', k: 'm-a0', kind: 'zone', sym: 'BTCUSDT', text: 'ZONE-WARMUP' }); // this bot already sends detailed texts (new firmware)
    // (a) a normal trade from a new-firmware bot: ledger open + detailed entry text, the manager's order arrives, then the close and result text
    await ev({ ev: 'open', k: 'k-a1', sym: 'BTCUSDT', side: 'BUY', eng: 'fast', entry: 65000, sl: 64000, tp: 67000, lev: 10, m: 20, relay: 'SENT', rid: 'RIDA1', t: 1 });
    await ev({ ev: 'msg', k: 'm-a1', kind: 'entry', sym: 'BTCUSDT', text: 'ENTRY-DETAIL BTCUSDT long full text' });
    assert.strictEqual((await E.post('/api/order', order('ym-RIDA1'), DK)).s, 200, 'the manager order reaches Bybit through the relay');
    assert(fake.creates.some(c => c.orderLinkId === 'ym-RIDA1'));
    await ev({ ev: 'relay', k: 'k-a1', ok: true, code: '200', secs: 2, rid: 'RIDA1' });
    assert(await waitFor(() => has(/ENTRY-DETAIL/).length >= 1, 4000), 'detailed entry text delivered');
    await sleep(3500);
    assert.strictEqual(has(/ENTRY-DETAIL/).length, 1, 'detail delivered exactly once');
    assert.strictEqual(has(/BTC.*opened/).length, 0, 'no duplicate short alert when the detailed one arrived: ' + JSON.stringify(tg));
    assert.strictEqual(has(/🚨/).length, 0, 'no alarm: the order arrived');
    await ev({ ev: 'close', k: 'k-a1', sym: 'BTCUSDT', side: 'BUY', won: true, exit: 67000, pct: 3.1, relayed: true, why: 'TP' });
    await ev({ ev: 'msg', k: 'm-a2', kind: 'result', sym: 'BTCUSDT', text: 'RESULT-DETAIL BTCUSDT win' });
    assert(await waitFor(() => has(/RESULT-DETAIL/).length >= 1, 4000)); await sleep(3000);
    assert.strictEqual(has(/RESULT-DETAIL/).length, 1); assert.strictEqual(has(/BTC.*closed/i).length, 0, 'no duplicate short close alert: ' + JSON.stringify(tg));
    // re-sending the same keys (the bot retrying) changes nothing
    await ev({ ev: 'msg', k: 'm-a1', kind: 'entry', sym: 'BTCUSDT', text: 'ENTRY-DETAIL BTCUSDT long full text' }); await sleep(1500);
    assert.strictEqual(has(/ENTRY-DETAIL/).length, 1, 'a retried message is not delivered twice');
    ok('pipeline: bot open+detail, manager order, close+result -> exactly one Telegram each, no duplicate short alerts, no false alarm, retries are idempotent');
    // (b) the bot says SENT but the order never arrives -> the 🚨 alarm
    tg.length = 0;
    await ev({ ev: 'open', k: 'k-b1', sym: 'ETHUSDT', side: 'SELL', eng: 'swing', entry: 3000, sl: 3100, tp: 2800, lev: 5, m: 20, relay: 'SENT', rid: 'RIDB1', t: 2 });
    assert(await waitFor(() => has(/🚨/).length >= 1, 9000), 'lost order raises the alarm: ' + JSON.stringify(tg));
    await sleep(2500); assert.strictEqual(has(/🚨/).length, 1, 'alarm sent once');
    ok('pipeline: a trade the bot says it sent that never reaches the relay raises exactly one 🚨 alarm');
    // (c) an old-firmware / no-detail bot: the short ledger alert is the safety net (after the hold)
    tg.length = 0;
    await ev({ ev: 'msg', k: 'm-c0', kind: 'zone', sym: 'SOLUSDT', text: 'ZONE-TEXT' }); // marks this bot as "new firmware"
    await ev({ ev: 'open', k: 'k-c1', sym: 'SOLUSDT', side: 'BUY', eng: 'fast', entry: 150, sl: 145, tp: 160, lev: 5, m: 20, relay: 'SENT', rid: 'RIDC1', t: 3 });
    await E.post('/api/order', order('ym-RIDC1', { symbol: 'SOLUSDT' }), DK);
    assert(await waitFor(() => has(/SOL.*opened/).length >= 1, 8000), 'safety-net alert after the hold: ' + JSON.stringify(tg));
    await sleep(1500); assert.strictEqual(has(/SOL.*opened/).length, 1);
    ok('pipeline: if the bot never sends its detailed text, the short alert still goes out after the hold (never silent)');
    // (d) Telegram outage: the message is kept and delivered once it is back
    tg.length = 0; tgFail = 3;
    await ev({ ev: 'msg', k: 'm-d1', kind: 'mgmt', sym: 'XRPUSDT', text: 'MGMT-AFTER-OUTAGE' });
    assert(await waitFor(() => has(/MGMT-AFTER-OUTAGE/).length >= 1, 25000), 'delivered after Telegram recovered: tg=' + JSON.stringify(tg));
    await sleep(2500); assert.strictEqual(has(/MGMT-AFTER-OUTAGE/).length, 1, 'delivered once');
    ok('pipeline: Telegram down for a few attempts -> the bot message is stored, retried and delivered exactly once');
    // (e) test alert from the bot button
    tg.length = 0; const ta = await ev({ ev: 'test' }); assert.strictEqual(ta.s, 200); assert(await waitFor(() => has(/Test alert/).length >= 1, 3000));
    assert.strictEqual((await ev({ ev: 'test' })).s, 429, 'test button is rate limited');
    ok('pipeline: the bot test button reaches Telegram and is rate-limited');
    s6.kill(); tgSrv.close(); }

  // 11b. master sizing end to end (MASTER_FOLLOWS_PLAN): the order that reaches Bybit carries the plan's quantity, closes are untouched
  { const P4 = P1 + 1500; fake.sizing = true; fake.positions = [{ symbol: 'BTCUSDT', side: '', size: '0', leverage: '10' }];
    const s4 = boot(P4, { ...dbEnv, MASTER_FOLLOWS_PLAN: 'true' }); await waitUp(P4); const D4 = mk(P4); await sleep(800);
    assert.strictEqual((await D4.post('/api/order', order('ym-PLAN1', { qty: '0.001' }))).s, 200);
    const made = fake.creates.find(c => c.orderLinkId === 'ym-PLAN1'); assert(made && made.qty === '0.03', 'master order resized to the plan: ' + JSON.stringify(made)); // 20% of $1,000 = $200 x 10 / 65000
    assert.strictEqual((await D4.post('/api/order', order('ym-PLAN2', { qty: '0.5', reduceOnly: true, side: 'Sell' }))).s, 200);
    assert.strictEqual(fake.creates.find(c => c.orderLinkId === 'ym-PLAN2').qty, '0.5', 'a close is never resized');
    s4.kill(); fake.sizing = false; fake.positions = [];
    ok('master sizing end to end: with MASTER_FOLLOWS_PLAN the master order carries the plan quantity (0.03), a close keeps its own'); }

  s3.kill(); await sleep(400); s3 = boot(P3, dbEnv); await waitUp(P3); C = mk(P3); await sleep(600);
  const info2 = (await C.get('/api/master-key', DASH)).j; assert(info2.source === 'saved' && info2.hint === '••••Y999', 'survives a restart: ' + JSON.stringify(info2));
  fake.keysSeen = []; assert.strictEqual((await C.post('/api/order', order('ym-KEYSWAP2'))).s, 200); assert(fake.keysSeen.includes('NEWKEY999'));
  ok('the saved key survives a restart and is used for orders');

  fake.positions = [{ symbol: 'BTCUSDT', side: 'Buy', size: '0.1', avgPrice: '1', markPrice: '1', unrealisedPnl: '0', leverage: '5', positionValue: '1' }];
  const need = await C.post('/api/master-key', { apiKey: 'OTHERKEY1', apiSecret: 'sec', env: 'live' }, DASH);
  assert(need.s === 409 && need.j.needConfirm && need.j.open === 1, JSON.stringify(need.j));
  assert.strictEqual((await C.get('/api/master-key', DASH)).j.hint, '••••Y999', 'not switched until confirmed');
  const conf = await C.post('/api/master-key', { apiKey: 'OTHERKEY1', apiSecret: 'sec', env: 'live', confirmOpen: true }, DASH);
  assert(conf.s === 200 && conf.j.env === 'live');
  fake.positions = [];
  ok('switching to a different account while trades are open asks for confirmation first');

  const rs = await C.post('/api/master-key/reset', {}, DASH);
  assert(rs.s === 200 && rs.j.hint === '••••k', JSON.stringify(rs.j));
  assert.strictEqual((await C.get('/api/master-key', DASH)).j.source, 'render');
  assert.strictEqual((await db.query(`SELECT 1 FROM meta WHERE k='master_creds'`)).rowCount, 0, 'saved key removed');
  fake.keysSeen = []; assert.strictEqual((await C.post('/api/order', order('ym-KEYSWAP3'))).s, 200); assert(fake.keysSeen.includes('k'), 'back on the Render key');
  ok('reset puts the Render settings back and deletes the saved key');
  s3.kill(); await db.end();

  console.log('\nALL ' + n + ' SERVER CHECKS PASSED');
  fakeSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e); process.exit(1); });
