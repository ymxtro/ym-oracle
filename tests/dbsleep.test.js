// Proves the relay lets the database sleep: with nothing going on the sweeps send (almost) no queries, a bot event wakes them,
// and DB_SLEEP=off brings back the old always-querying behaviour. Counts real committed transactions on a dedicated Postgres database.
// Run: TEST_DATABASE_URL=postgres://user:pw@host:port/emptydb node tests/dbsleep.test.js   (RELAY_DIR optional)
const path = require('path'), assert = require('assert'), { spawn } = require('child_process'), fs = require('fs'), os = require('os');
const R = process.env.RELAY_DIR || path.join(__dirname, '..');
if (!process.env.TEST_DATABASE_URL) { console.log('dbsleep: skipped (set TEST_DATABASE_URL to an empty database)'); process.exit(0); }
const { Pool } = require(R + '/node_modules/pg');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = []; const killAll = () => kids.forEach(k => { try { k.kill(); } catch { /* gone */ } });
process.on('exit', killAll);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsleep-'));
let n = 0; const ok = m => console.log('  ok', ++n, m);

function boot(port, extra) {
  const env = { PATH: process.env.PATH, PORT: String(port), BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's', TRADE_MODE: 'paper', DASHBOARD_PASSWORD: 'dash-pass',
    DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL: 'false', KEY_ENCRYPTION_SECRET: require('crypto').randomBytes(32).toString('hex'),
    NODE_ENV: 'test', YM_TEST_TIMERS: '1', ALERT_SWEEP_MS: '300', ALERT_TELEGRAM_BOT_TOKEN: 'T', ALERT_TELEGRAM_CHAT_ID: '1',
    TRADE_LOG_PATH: path.join(tmp, 't' + port), MODE_FILE: path.join(tmp, 'm' + port), CIRCUIT_BREAKER_FILE: path.join(tmp, 'h' + port),
    EXEC_REPORTS_FILE: path.join(tmp, 'e' + port), TRADE_LOG_CLEARED_AT_FILE: path.join(tmp, 'c' + port), ...(extra || {}) };
  const k = spawn(process.execPath, ['server.js'], { cwd: R, env, stdio: 'ignore' }); kids.push(k); return k;
}
const waitUp = async port => { for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return; } catch { /* not yet */ } await sleep(250); } throw new Error('server did not start'); };

(async () => {
  const mon = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false, max: 1 });
  const dbname = (await mon.query('SELECT current_database() AS d')).rows[0].d;
  const commits = async () => Number((await mon.query('SELECT xact_commit AS c FROM pg_stat_database WHERE datname=$1', [dbname])).rows[0].c);
  const measure = async ms => { await commits(); const a = await commits(); await sleep(ms); const b = await commits(); return b - a - 1; };   // minus the monitor's own commit
  const post = (port, body) => fetch('http://127.0.0.1:' + port + '/api/bot-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // A. sleep on (default), and told that it starts idle: nothing to do means (almost) no queries
  let s1 = boot(3911, { DB_SLEEP_BOOT_MIN: '0' }); await waitUp(3911); await sleep(24000);   // the one-time start-up jobs run at 15-20 s; the idle count starts after them
  const idle = await measure(6000);
  assert(idle <= 4, 'idle relay sent ' + idle + ' transactions in 6 s (with sweeps every 0.3 s it would be 100+)');
  ok('sleep on: an idle relay sends almost no queries (' + idle + ' in 6 s with the sweeps set to run every 0.3 s)');

  // A2. the bots' 10-minute status reports must not wake the database: they are held in memory
  for (const bot of ['YM ORACLE I', 'YM ORACLE II', 'YM ORACLE III']) assert.strictEqual((await post(3911, { v: 1, bot, ev: 'status', build: 'x', open: 0 })).status, 200);
  const st = await measure(3000);
  assert(st <= 2, 'status reports sent ' + st + ' transactions');
  assert.strictEqual(Number((await mon.query(`SELECT COUNT(*) AS c FROM bot_status`)).rows[0].c), 0, 'status was written while idle');
  ok('status reports while idle: nothing written, the database stays asleep (' + st + ' transactions in 3 s)');

  // B. an alert from a bot is real work: the sweeps run again and the held status reports are saved
  const r = await post(3911, { v: 1, bot: 'YM ORACLE I', ev: 'msg', k: 'dbsleepk1', kind: 'ops', text: 'test' }); assert.strictEqual(r.status, 200);
  await sleep(1500);
  assert.strictEqual(Number((await mon.query(`SELECT COUNT(*) AS c FROM bot_status`)).rows[0].c), 3, 'held status reports were not saved when work started');
  const busy = await measure(4000);
  assert(busy >= 10, 'after a bot event the sweeps only sent ' + busy);
  ok('an alert wakes the sweeps (' + busy + ' transactions in 4 s afterwards) and the 3 held status reports are saved');
  s1.kill(); await sleep(800);

  // C. DB_SLEEP=off: the old behaviour (always querying)
  let s2 = boot(3912, { DB_SLEEP: 'off', DB_SLEEP_BOOT_MIN: '0' }); await waitUp(3912); await sleep(5000);
  const always = await measure(4000);
  assert(always >= 10, 'DB_SLEEP=off sent only ' + always);
  ok('DB_SLEEP=off puts the old always-querying behaviour back (' + always + ' transactions in 4 s)');
  s2.kill();

  await mon.end(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL ' + n + ' DB SLEEP CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
