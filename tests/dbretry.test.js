// The database being down at start-up must not poison the relay: logins answer 503 "not reachable" (not a bare 500), and the relay recovers BY ITSELF
// when the database comes back. Needs Postgres: TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres  (default). Run: node tests/dbretry.test.js
const R = process.env.RELAY_DIR || '/home/claude/relay';
const assert = require('assert'), net = require('net'), os = require('os'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const real = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/postgres');
let n = 0; const ok = m => console.log('  ok', ++n, m);
(async () => {
  const PROXY = 41900 + Math.floor(Math.random() * 90), PORT = PROXY + 100, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-dbr-'));
  const env = { PATH: process.env.PATH, PORT: String(PORT), BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's', TRADE_MODE: 'paper', BYBIT_BASE_URL: 'http://127.0.0.1:1', DASHBOARD_PASSWORD: 'dash-pass',
    DATABASE_URL: 'postgres://postgres@127.0.0.1:' + PROXY + '/postgres', DATABASE_SSL: 'false', KEY_ENCRYPTION_SECRET: require('crypto').randomBytes(32).toString('hex'),
    TRADE_LOG_PATH: path.join(tmp, 't.jsonl'), MODE_FILE: path.join(tmp, 'm.json'), CIRCUIT_BREAKER_FILE: path.join(tmp, 'h'), EXEC_REPORTS_FILE: path.join(tmp, 'e.json'), TRADE_LOG_CLEARED_AT_FILE: path.join(tmp, 'c.json') };
  const child = spawn('node', ['server.js'], { cwd: R, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const login = async () => { const r = await fetch('http://127.0.0.1:' + PORT + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'dash-pass' }) }); return { s: r.status, j: await r.json() }; };
  for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok) break; } catch { /* not yet */ } await sleep(250); }
  const t0 = Date.now(); const down = await login();
  if (down.s !== 503) console.log(out.slice(-1500)); assert.strictEqual(down.s, 503, JSON.stringify(down)); assert(down.j.dbDown && /not reachable/.test(down.j.message)); assert(Date.now() - t0 < 15000, 'fails fast, does not hang');
  ok('database down at start-up: login answers 503 "database not reachable" quickly');
  // the database "comes back": a proxy to the real one starts listening
  const srv = net.createServer(c => { const u = net.connect(+real.port, real.hostname); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); });
  await new Promise(r => srv.listen(PROXY, '127.0.0.1', r));
  let up = null; for (let i = 0; i < 40 && !(up && up.s === 200); i++) { await sleep(1500); up = await login().catch(() => null); }
  assert(up && up.s === 200 && up.j.success && up.j.token, 'recovered by itself: ' + JSON.stringify(up));
  assert(/schema setup FAILED \(try 1, retrying\)/.test(out) && /Database schema ready\. \(after \d+ tries\)/.test(out), 'logged the retries');
  ok('database back: the relay recovers by itself (no restart) and the admin can log in');
  child.kill(); srv.close();
  console.log('ALL ' + n + ' DATABASE RETRY CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
