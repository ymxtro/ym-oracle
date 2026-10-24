// Runs the REAL Trade Sentinel block cut out of multiuser.js against a stubbed Bybit and a recording database stub (no Postgres, no packages needed).
// Run: node tests/sentinel.server.test.js     (RELAY_DIR optional)
const fs = require('fs'), path = require('path'), assert = require('assert');
const R = process.env.RELAY_DIR || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'multiuser.js'), 'utf8');
const a = src.indexOf('  // ---------- Trade Sentinel ----------'), b = src.indexOf('  const PG_BAD_RISK');
assert(a > 0 && b > a, 'Sentinel block not found in multiuser.js');
const block = src.slice(a, b);
const SN = require(R + '/sentinel.js'), PG = require(R + '/profitguard.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);

const MIN = 60000, now0 = Date.now(), ENTRY_AT = now0 - 38.5 * MIN;
// a trap: 30 quiet bars before entry, 30 min of slow drift up to +0.45R, then a hard fall on heavy volume (R = 1: entry 100, stop 99)
const bar = (k, o, c, v = 100, w = 0.03) => ({ t: ENTRY_AT + k * MIN, o, c, h: Math.max(o, c) + w, l: Math.min(o, c) - w, v });
const all = []; for (let k = -30; k < 0; k++) all.push(bar(k, 100 + (k % 2) * 0.02, 100 - (k % 2) * 0.02));
for (let k = 0; k < 30; k++) all.push(bar(k, 100 + k * 0.015, 100 + (k + 1) * 0.015));
for (let k = 30; k < 38; k++) all.push(bar(k, 100.45 - (k - 30) * 0.2, 100.45 - (k - 29) * 0.2, 400, 0.05));
const toRows = bars => bars.slice().reverse().map(x => [String(x.t), String(x.o), String(x.h), String(x.l), String(x.c), String(x.v), '0']);   // Bybit sends newest first

function build() {
  const rec = { q: [], stops: [], fan: [], alerts: [], closedPnl: [] };
  const st = { positions: [], bars: all.slice(0, 66), failKline: false };   // bars up to k=35 (close 99.85)
  const restClient = {
    getKline: async ({ symbol }) => { if (st.failKline) throw new Error('boom'); return { retCode: 0, result: { list: toRows(symbol === 'BTCUSDT' ? all.slice(0, 40).map(x => ({ ...x, t: x.t + 30 * MIN })) : st.bars) } }; },
    setTradingStop: async b => { rec.stops.push(b); return { retCode: 0, result: {} }; },
    getClosedPnL: async () => ({ retCode: 0, result: { list: rec.closedPnl } }),
  };
  const deps = {
    SN, PG, snCfg: SN.normalize({ mode: 'shadow' }), pgCfg: PG.defaults(), snState: new Map(), pgState: new Map(), guardsMaster: true, restClient,
    q: async (text, params) => { rec.q.push({ text, params }); return { rows: [], rowCount: 0 }; },
    ready: Promise.resolve(), getMode: () => 'live', breakerIsTripped: () => false,
    listOpenPositions: async () => st.positions, getInstrument: async () => ({ tickSize: 0.01 }),
    pgLookup: async () => ({ bot: 'ORACLE I', sl: 99, eng: 'fast' }), deliverAlert: async t => { rec.alerts.push(t); return { ok: true }; },
    fanOutTradingStop: async b => { rec.fan.push(b); },
    stopWrite: async (side, b) => ({ res: await restClient.setTradingStop(b) }),   // v2.9.14: the real one reads the stop on Bybit first (covered by the integration suite)
  };
  const names = Object.keys(deps);
  const make = new Function(...names, `${block}\n return { snTick, snState, snRun, snView, snBars, snLog };`);
  const api = make(...names.map(k => deps[k]));
  const setMode = (m, extra) => { deps.snCfg = SN.normalize({ mode: m, ...(extra || {}) }); };
  // snCfg is read by the block through the closure parameter: expose a setter by re-making when needed
  return { api, rec, st, deps, remake: m => { deps.snCfg = SN.normalize({ mode: m }); return new Function(...names, `${block}\n return { snTick, snState, snRun, snView };`)(...names.map(k => deps[k])); } };
}
const pos = (mark, sl) => ({ symbol: 'ABCUSDT', side: 'Buy', avgPrice: '100', markPrice: String(mark), stopLoss: String(sl), size: '10', positionIdx: 0, createdTime: String(ENTRY_AT) });
const tick = async (api) => { api.snRun.busy = false; await api.snTick(); };

(async () => {
  // ---------- shadow ----------
  let T = build(); T.st.positions = [pos(99.85, 99)];
  await tick(T.api); await tick(T.api);
  let s = T.api.snState.get('ABCUSDT|Buy');
  assert(s && s.mem.state === 'alert' || s.mem.state === 'danger', 'a hard reversal after a slow drift should reach alert/danger, state: ' + (s && s.mem.state) + ' score ' + (s && s.score));
  assert(T.rec.stops.length === 0 && T.rec.fan.length === 0, 'shadow must not touch Bybit');
  assert(s.shadowSl > 0 && s.moves === 1, 'shadow records what it would do');
  ok('shadow: the reversal reaches ' + s.mem.state + ' (score ' + s.score + ', label ' + s.label + ') after 2 reads; it records a shadow stop ' + s.shadowSl + ' and sends nothing to Bybit');
  assert(T.rec.q.some(x => /INSERT INTO sentinel_log/.test(x.text) && x.params[4] === 'would_raise'), 'would_raise logged');
  assert(T.rec.alerts.length === 1 && /Shadow mode/.test(T.rec.alerts[0]), 'one alert, says nothing was changed');
  ok('shadow: one alert only, worded "nothing was changed"; the would-raise is logged');
  assert(T.rec.q.some(x => /INSERT INTO trade_path/.test(x.text)), 'path rows are written');
  ok('every tick path (mark, R, score, state) goes to trade_path');
  // the price touches the shadow stop
  T.st.positions = [pos(s.shadowSl - 0.05, 99)]; await tick(T.api);
  assert(T.rec.q.some(x => /INSERT INTO sentinel_log/.test(x.text) && x.params[4] === 'would_exit'));
  ok('shadow: the price touching the shadow stop is recorded as "would have exited here"');
  // the trade closes: scorecard row with the counterfactual
  T.rec.closedPnl.push({ symbol: 'ABCUSDT', avgExitPrice: '99', closedPnl: '-10', updatedTime: String(Date.now()) });
  T.st.positions = []; await tick(T.api);
  const sc = T.rec.q.find(x => /INSERT INTO sentinel_trades/.test(x.text));
  assert(sc, 'scorecard row'); assert.strictEqual(sc.params[0], 'ABCUSDT'); assert(sc.params[12] !== null, 'shadow exit R stored'); assert(Math.abs(sc.params[14] + 1) < 1e-6, 'real exit R = -1');
  ok('trade closed: scorecard stores max score, the shadow exit R (' + sc.params[12].toFixed(2) + ') next to the real exit R (' + sc.params[14].toFixed(2) + ')');

  // ---------- live ----------
  T = build(); T.st.positions = [pos(99.85, 99)];
  const live = T.remake('live');
  await tick(live); await tick(live);
  assert(T.rec.stops.length === 1, 'live moves the stop once, got ' + T.rec.stops.length);
  const stop = Number(T.rec.stops[0].stopLoss);
  assert(stop > 99 && stop < 99.85, 'tighter than the original stop and behind the price: ' + stop);
  assert(T.rec.fan.length === 1 && T.rec.fan[0].stopLoss === T.rec.stops[0].stopLoss, 'copies get the same stop');
  s = live.snState.get('ABCUSDT|Buy'); assert(s.floor === stop);
  ok('live: one stop move on Bybit (99 -> ' + stop + '), the same stop is sent to the copy users, and it becomes the floor');
  T.st.positions = [pos(99.85, stop)];                       // Bybit now reports the new stop
  await tick(live);
  assert.strictEqual(T.rec.stops.length, 1, 'no second move inside the pause between moves');
  ok('live: no second move inside the pause between moves');
  s.lastMoveAt = 0; s.moves = 3; T.st.positions = [pos(99.5, stop)]; await tick(live);
  assert.strictEqual(T.rec.stops.length, 1); ok('live: the per-trade move limit (3) is respected');
  s.moves = 1; s.lastMoveAt = 0; T.st.positions = [pos(99.85, 99.84)];     // a stop already tighter than anything it would set
  await tick(live); assert.strictEqual(T.rec.stops.length, 1); ok('live: never loosens - a stop already tighter is left alone');

  // ---------- fail-safe ----------
  T = build(); T.st.positions = [pos(99.85, 99)]; T.st.failKline = true;
  const l2 = T.remake('live'); await tick(l2); await tick(l2);
  assert.strictEqual(T.rec.stops.length, 0); assert(/no candles/.test(l2.snState.get('ABCUSDT|Buy').why));
  ok('candles unavailable: it does nothing and says why (never a guess)');
  T = build(); T.st.positions = [pos(99.85, 0)]; T.deps.pgLookup = async () => ({ bot: '', sl: 0, eng: null });
  const l3 = new Function(...Object.keys(T.deps), `${block}\n return { snTick, snState, snRun };`)(...Object.values(T.deps));
  T.deps.snCfg = SN.normalize({ mode: 'live' }); await tick(l3);
  assert.strictEqual(T.rec.stops.length, 0); ok('no original stop known: it does nothing');
  T = build(); T.st.positions = [pos(99.85, 99)]; T.deps.getMode = () => 'paper';
  const l4 = T.remake('live'); await tick(l4); assert.strictEqual(l4.snState.size, 0); assert(/paused/.test(l4.snRun.note));
  ok('relay not live (paper) or halted: paused, nothing watched');
  T = build(); T.st.bars = all.slice(0, 50); T.st.positions = [pos(100.3, 99)];   // candles and price agree: a steady drift up
  const l5 = T.remake('live'); await tick(l5); await tick(l5);
  assert.strictEqual(T.rec.stops.length, 0); ok('a calm trade near its entry: no stop is touched');
  console.log('sentinel server block: ' + n + ' checks passed');
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
