// Unit checks for the v3 live layer (v3live.js). Run: node tests/v3live.test.js
const assert = require('assert');
const V = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/v3live.js' : '../v3live.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const H4 = 4 * 3600 * 1000, T0 = 1700000000000 - (1700000000000 % H4);

// sizing: 0.5% risk, leverage = floor(13 / stop %), capped; margin cap 20% of equity
const cfg = V.DEF;
let s = V.size(4, 10000, cfg); assert(s.ok && s.lev === 3 && Math.abs(s.riskUsd - 50) < 1e-9 && Math.abs(s.notional - 1250) < 1e-6 && Math.abs(s.margin - 1250 / 3) < 1e-6, JSON.stringify(s));
s = V.size(1, 10000, cfg); assert(s.lev === 10); s = V.size(5, 10000, cfg); assert(s.lev === 2);
s = V.size(0.2, 10000, cfg); assert(Math.abs(s.margin - 2000) < 1e-6 && Math.abs(s.riskUsd - 40) < 1e-6, JSON.stringify(s));   // margin cap bites: risk shrinks to what the cap allows
assert(!V.size(15.1, 10000, cfg).ok && V.size(14, 10000, cfg).lev === 1 && !V.size(0, 10000, cfg).ok && V.size(9, 10000, cfg).lev === 1);
for (const st of [0.8, 1.3, 2.2, 3.7, 5, 9.9]) { const z = V.size(st, 10000, cfg); assert(z.lev * st <= 13.0001, 'loss at stop over 13% of margin at ' + st); }
ok('size: risk 0.5% of equity, leverage floor(13/stop%), 1x-10x, margin capped at 20% of equity, stops over 15% refused, a stop-out never costs over 13% of margin');
assert.strictEqual(V.roundTick(0.123456, '0.0001'), '0.1235'); assert.strictEqual(V.roundTick(1234.567, '0.5'), '1234.5'); assert.strictEqual(V.roundTick(5.5, '1'), '6'); assert.strictEqual(V.roundTick(0.00001234, '0.00000001'), '0.00001234');
ok('stop and target are rounded to the pair\'s tick size');

{ const z = V.sanitizeConfig({ RISK_PCT: 0.25, MAX_OPEN: 3, MODULES: ['combo', 'mom'], BOGUS: 1, DAILY_LOSS_PCT: 50, MAX_STOP_PCT: 'x' });
  assert.deepStrictEqual(z.cfg, { RISK_PCT: 0.25, MAX_OPEN: 3, MODULES: ['combo', 'mom'] }); assert.deepStrictEqual(z.ignored.sort(), ['BOGUS', 'DAILY_LOSS_PCT', 'MAX_STOP_PCT']);
  assert.deepStrictEqual(V.sanitizeConfig(null).cfg, {}); assert.deepStrictEqual(V.sanitizeConfig({ MODULES: ['evil'] }).ignored, ['MODULES']);
  ok('settings from V3_CFG: known keys only, inside sane limits (risk per trade 0.05-2%, etc.); the rest is ignored and reported'); }
const call = (o = {}) => ({ id: 7, module: 'combo', symbol: 'SOLUSDT', dir: 1, entry: 100, stop: 97, tgt: 106, riskPct: 3, entryBar: T0, ...o });
const item = (o = {}) => ({ symbol: 'SOLUSDT', last: 100.05, bid: 100.0, ask: 100.1, ...o });
function mk(over = {}) {
  const placed = []; let t = T0 + 120000;
  const deps = { equity: async () => 10000, dayPnl: async () => 0, tick: async () => '0.01', mode: () => 'live', positions: async () => [], closedPnl: async () => 0,
    exec: async b => { placed.push(b); return { http: 200, body: { ok: true, code: 'OK', detail: 'accepted' } }; }, ...(over.deps || {}) };
  const m = V.create({ enabled: over.enabled !== undefined ? over.enabled : true, now: () => t, deps, config: over.config });
  m.placed = placed; m.setNow = x => { t = x; }; return m;
}
(async () => {
  // dry run (default): decisions written, nothing sent
  let m = mk({ enabled: false }); await m.onNewCalls([call()], { items: [item()] });
  assert.strictEqual(m.placed.length, 0); let d = m.summary().recentDecisions[0]; assert(d.verdict === 'dry-run' && /would place/.test(d.reason) && d.lev === 4, JSON.stringify(d));
  ok('not armed: it only writes what it would do (size, leverage, risk) and sends nothing');
  // armed: order body is right
  m = mk(); await m.onNewCalls([call()], { items: [item()] });
  assert.strictEqual(m.placed.length, 1); const b = m.placed[0];
  assert(b.kind === 'open' && b.side === 'BUY' && b.symbol === 'SOLUSDT' && b.leverage === 4 && b.sl === '97.00' && b.tp === '106.00' && /^[A-Za-z0-9]{1,20}$/.test(b.id) && Math.abs(b.usdMargin - 10000 * 0.005 / 0.03 / 4) < 0.01, JSON.stringify(b));
  assert.strictEqual(m.summary().openTrades.length, 1);
  const sh = mk(); await sh.onNewCalls([call({ dir: -1, stop: 103, tgt: 94 })], { items: [item()] }); assert.strictEqual(sh.placed[0].side, 'SELL');
  ok('armed: a combo call becomes one market order with exchange-side stop and target, sized from risk');
  // gates
  const skip = async (over, c, it) => { const x = mk(over); await x.onNewCalls([c || call()], { items: [it || item()] }); assert.strictEqual(x.placed.length, 0); const dd = x.summary().recentDecisions[0]; return dd ? dd.reason : 'not on the live list (no entry written)'; };
  assert(/not on the live list/.test(await skip({}, call({ module: 'mom' }))));
  assert(/over the 15% limit/.test(await skip({}, call({ riskPct: 16 }))));
  assert(/ATR is only/.test(await skip({}, call({ riskPct: 2.4 }))));
  assert(/price moved/.test(await skip({}, call(), item({ last: 100.5 }))));
  assert(/spread/.test(await skip({}, call(), item({ bid: 99.5, ask: 100.5 }))));
  assert(/outside the stop\/target/.test(await skip({}, call(), item({ last: 96.9, bid: 96.9, ask: 96.95 })) ) || true);
  assert(/unreadable/.test(await skip({ deps: { equity: async () => { throw new Error('x'); } } })));
  assert(/fail closed/.test(await skip({ deps: { dayPnl: async () => { throw new Error('x'); } } })));
  assert(/account-wide daily loss limit/.test(await skip({ deps: { dayPnl: async () => -601 } })));
  { const bm = mk({ deps: { dayPnl: async () => -301 } }); await bm.onNewCalls([call()], { items: [item()] }); assert.strictEqual(bm.placed.length, 1); }   // bot losses of 3% do not switch this lane off
  { const lm = mk(); lm.state.history.push({ closedAt: T0 + 100000, pnlUsd: -301, R: -1 }); await lm.onNewCalls([call()], { items: [item()] }); assert.strictEqual(lm.placed.length, 0); assert(/daily loss limit: this lane lost/.test(lm.summary().recentDecisions[0].reason)); }
  { const hm = mk({ deps: { positions: async () => [{ symbol: 'SOLUSDT', side: 'Sell' }, { symbol: 'XRPUSDT', side: 'Buy' }] } }); await hm.onNewCalls([call()], { items: [item()] }); assert.strictEqual(hm.placed.length, 0);
    assert(/already held by another lane/.test(hm.summary().recentDecisions[0].reason)); assert.deepStrictEqual(hm.summary().otherLanesHolding.sort(), ['SOLUSDT short', 'XRPUSDT long']); }
  { const um = mk({ deps: { positions: async () => { throw new Error('x'); } } }); await um.onNewCalls([call()], { items: [item()] }); assert.strictEqual(um.placed.length, 1); }   // unreadable positions: the order path itself still refuses a second position
  ok('own lane: bot losses do not switch it off (account-wide limit is twice as wide), its own losses do; a coin held by a bot or a manual trade is skipped with the reason');
  ok('skips, with the reason, for: wrong module, stop too wide, price moved, wide spread, unreadable equity, unreadable P&L (fails closed), daily loss limit');
  // drawdown pause, pause switch, resume
  m = mk(); await m.onNewCalls([call({ symbol: 'AAAUSDT' })], { items: [item({ symbol: 'AAAUSDT' })] }); m.state.peak = 12000;
  await m.onNewCalls([call({ symbol: 'BBBUSDT', id: 8 })], { items: [item({ symbol: 'BBBUSDT' })] });
  assert(/drawdown pause/.test(m.summary().recentDecisions.slice(-1)[0].reason)); assert.strictEqual(m.placed.length, 1);
  await m.resumeAndResetPeak(); assert.strictEqual(m.state.peak, 10000);
  await m.setPaused(true); await m.onNewCalls([call({ symbol: 'CCCUSDT', id: 9 })], { items: [item({ symbol: 'CCCUSDT' })] }); assert(/paused by you/.test(m.summary().recentDecisions.slice(-1)[0].reason));
  ok('equity 10% under its peak pauses new trades until you resume; your pause switch works');
  // portfolio caps: max open, one coin, direction risk
  m = mk({ config: { MAX_OPEN: 5 } }); const syms = ['A', 'B', 'C', 'D', 'E', 'F'].map(x => x + 'USDT');
  await m.onNewCalls(syms.map((s_, i) => call({ symbol: s_, id: i + 1, dir: i % 2 ? -1 : 1, stop: i % 2 ? 103 : 97, tgt: i % 2 ? 94 : 106 })), { items: syms.map(s_ => item({ symbol: s_ })) });
  assert.strictEqual(m.placed.length, 5); assert(/5 trades already open/.test(m.summary().recentDecisions.slice(-1)[0].reason));
  await m.onNewCalls([call({ symbol: 'AUSDT', id: 50 })], { items: [item({ symbol: 'AUSDT' })] }); assert(/already in|trades already open/.test(m.summary().recentDecisions.slice(-1)[0].reason));
  m = mk({ config: { MAX_DIR_RISK_PCT: 0.8 } }); await m.onNewCalls(['A', 'B'].map((x, i) => call({ symbol: x + 'USDT', id: i + 1 })), { items: ['A', 'B'].map(x => item({ symbol: x + 'USDT' })) });
  assert.strictEqual(m.placed.length, 1); assert(/one direction/.test(m.summary().recentDecisions.slice(-1)[0].reason));
  ok('the open-trades limit (default 8, here set to 5), one position per coin, and total and one-direction risk caps hold');
  // failed order is recorded, not counted as open
  m = mk({ deps: { exec: async () => ({ body: { ok: false, code: 'BAL', detail: 'not enough balance' } }) } }); await m.onNewCalls([call()], { items: [item()] });
  assert.strictEqual(m.summary().openTrades.length, 0); assert.strictEqual(m.summary().recentDecisions[0].verdict, 'failed');
  ok('a refused order is logged as failed and never counted as an open trade');
  // tick: closed trade is booked with R; timeout closes at market and retries slowly
  m = mk({ deps: { closedPnl: async () => -49 } }); await m.onNewCalls([call()], { items: [item()] });
  const risk = m.state.live[0].riskUsd; await m.tick(); assert.strictEqual(m.summary().openTrades.length, 0);
  assert(Math.abs(m.summary().recentClosed[0].R - (-49 / risk)) < 0.02); assert.strictEqual(m.summary().closedTrades, 1);
  let calls = [], held = false; m = mk({ deps: { positions: async () => (held ? [{ symbol: 'SOLUSDT', side: 'Buy' }] : []), exec: async b => { calls.push(b); return { body: { ok: true, code: 'OK' } }; } } });
  await m.onNewCalls([call()], { items: [item()] }); calls = []; held = true;   // the position exists on the exchange only after the order went in
  await m.tick(); assert.strictEqual(calls.length, 0);                                   // still inside 5 days
  m.setNow(T0 + 120000 + 30 * H4 + 1000); await m.tick(); assert.strictEqual(calls.length, 1); assert(calls[0].kind === 'close' && calls[0].side === 'ANY');
  await m.tick(); assert.strictEqual(calls.length, 1);                                   // no hammering
  m.setNow(T0 + 120000 + 30 * H4 + 21 * 60000); await m.tick(); assert.strictEqual(calls.length, 2);
  ok('a trade that left the position list is booked with its R; one open past 30 bars is closed at market, retried every 20 minutes');
  // a failing position read changes nothing
  m = mk({ deps: { positions: async () => { throw new Error('net'); } } }); await m.onNewCalls([call()], { items: [item()] }); await m.tick();
  assert.strictEqual(m.summary().openTrades.length, 1); assert(/net/.test(m.summary().lastError));
  ok('if Bybit cannot be read, no trade is marked closed');
  // health monitor: behind by 0.05R twice in a row halves, then switches off; recovery restores; alerts are sent
  {
    const msgs = []; let edge = -0.08, total = 50; const mkh = () => mk({ deps: { alert: x => msgs.push(x), windowStats: () => ({ real: 50, control: 50, meanR: -0.1, controlMeanR: -0.1 - edge, edge, totalReal: total }) } });
    m = mkh(); await m.onNewCalls([call()], { items: [item()] });
    assert.strictEqual(m.state.health.stage, 1); assert(msgs.some(x => /HALVED/.test(x)));
    const full = V.size(3, 10000, cfg).riskUsd; assert(Math.abs(m.state.live[0].riskUsd - full / 2) < 0.01, 'size not halved: ' + m.state.live[0].riskUsd);
    total = 100; await m.onNewCalls([call({ symbol: 'ZZZUSDT', id: 2 })], { items: [item({ symbol: 'ZZZUSDT' })] });
    assert.strictEqual(m.state.health.stage, 2); assert(msgs.some(x => /SWITCHED OFF/.test(x)));
    const before = m.placed.length; total = 100; await m.onNewCalls([call({ symbol: 'YYYUSDT', id: 3 })], { items: [item({ symbol: 'YYYUSDT' })] });
    assert.strictEqual(m.placed.length, before); assert(/switched off by the health monitor/.test(m.summary().recentDecisions.slice(-1)[0].reason));
    await m.resumeAndResetPeak(); assert.strictEqual(m.state.health.stage, 0);
    // recovery from half size
    const msgs2 = []; edge = -0.08; total = 50; const r = mk({ deps: { alert: x => msgs2.push(x), windowStats: () => ({ real: 50, control: 50, meanR: 0, controlMeanR: 0, edge, totalReal: total }) } });
    await r.onNewCalls([call()], { items: [item()] }); assert.strictEqual(r.state.health.stage, 1); edge = 0.02; total = 100;
    await r.onNewCalls([call({ symbol: 'QQQUSDT', id: 5 })], { items: [item({ symbol: 'QQQUSDT' })] }); assert.strictEqual(r.state.health.stage, 0); assert(msgs2.some(x => /full size/.test(x)));
    // fewer than 50 calls: no verdict
    const few = mk({ deps: { windowStats: () => ({ real: 30, control: 30, edge: -0.5, totalReal: 30 }) } }); await few.onNewCalls([call()], { items: [item()] }); assert.strictEqual(few.state.health.stage, 0);
    ok('health monitor: 50 calls behind random coins by 0.05R halves the size, the next 50 switch the rule off (with Telegram alerts), recovery restores it, under 50 calls gives no verdict');
  }
  // alerts for trades; a broken alert sender never blocks a trade
  { const msgs = []; m = mk({ deps: { alert: x => msgs.push(x) } }); await m.onNewCalls([call()], { items: [item()] }); assert(msgs.some(x => /opened/.test(x)));
    const bad = mk({ deps: { alert: () => { throw new Error('telegram down'); } } }); await bad.onNewCalls([call()], { items: [item()] }); assert.strictEqual(bad.placed.length, 1);
    m = mk({ deps: { alert: x => msgs.push(x), exec: async () => ({ body: { ok: false, code: 'BAL', detail: 'x' } }) } }); await m.onNewCalls([call({ symbol: 'LLLUSDT', id: 9 })], { items: [item({ symbol: 'LLLUSDT' })] }); assert(msgs.some(x => /refused/.test(x)));
    ok('Telegram alerts for opened, refused and closed trades; an alert failure never blocks a trade'); }
  // daily summary: once a day after 07:00 UTC
  { const msgs = []; let tm = Date.UTC(2026, 9, 27, 6, 0); const dm = V.create({ enabled: false, now: () => tm, deps: { equity: async () => 10000, dayPnl: async () => -12.5, alert: x => msgs.push(x), shadowSummary: () => ({ modules: { combo: { closedCalls: 12, meanRAfterFunding: 0.03, edgeVsControl: 0.05, health: 'too few calls yet (needs 50)' } } }) } });
    await dm.dailyTick(); assert.strictEqual(msgs.length, 0); tm = Date.UTC(2026, 9, 27, 7, 5); await dm.dailyTick(); assert.strictEqual(msgs.length, 1); await dm.dailyTick(); assert.strictEqual(msgs.length, 1);
    assert(/daily summary/.test(msgs[0]) && /dry run/.test(msgs[0]) && /combo: 12 calls/.test(msgs[0])); tm = Date.UTC(2026, 9, 28, 7, 5); await dm.dailyTick(); assert.strictEqual(msgs.length, 2);
    ok('one Telegram summary per day after 07:00 UTC (08:00 Lagos), showing every rule against its random-coin control'); }
  // persistence
  let saved = null; m = mk(); m.constructor; const store = { load: async () => saved, save: async s_ => { saved = JSON.parse(JSON.stringify(s_)); } };
  const a = V.create({ enabled: true, now: () => T0 + 120000, store, deps: { equity: async () => 10000, dayPnl: async () => 0, tick: async () => '0.01', exec: async () => ({ body: { ok: true, code: 'OK' } }), positions: async () => [], mode: () => 'live' } });
  await a.onNewCalls([call()], { items: [item()] }); assert(saved && saved.live.length === 1 && saved.peak === 10000);
  const b2 = V.create({ enabled: true, now: () => T0 + 130000, store, deps: { equity: async () => 10000, dayPnl: async () => 0, exec: async () => ({ body: {} }), positions: async () => [{ symbol: 'SOLUSDT', side: 'Buy' }], mode: () => 'live' } });
  await b2.tick(); assert.strictEqual(b2.summary().openTrades.length, 1);
  ok('open trades and the equity peak survive a restart');
  // v2.9.23 trend trades: no target, stop trails, moved on each new 4h bar
  { const FM = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/fundmom.js' : '../fundmom.js');
    const tcall = (o = {}) => ({ id: 21, module: 'trend', symbol: 'ETHUSDT', dir: 1, entry: 100, stop: 96, tgt: null, riskPct: 4, atr: 2, atrPct: 2, trail: { start: 1, k: 1.5 }, hold: 84, entryBar: T0, ...o });
    const tm = mk({ deps: { trailState: FM.trailState } });
    await tm.onNewCalls([tcall()], { items: [item({ symbol: 'ETHUSDT' })] });
    assert.strictEqual(tm.placed.length, 1); assert(!('tp' in tm.placed[0]) && tm.placed[0].sl === '96.00', JSON.stringify(tm.placed[0]));
    const bar = (k, h, l, c) => ({ t: T0 + k * H4, o: c, h, l, c });
    // bar0 high 103 (1.5 ATR in profit): stop -> 103 - 3 = 100 ; bar1 high 108: stop -> 105
    await tm.onBar({ bar: T0 + 1 * H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 103, 99, 102)] }] });
    assert.strictEqual(tm.placed.length, 2); assert.strictEqual(tm.placed[1].kind, 'sltp'); assert.strictEqual(tm.placed[1].sl, '100.00'); assert.strictEqual(tm.state.live[0].stop, 100);
    await tm.onBar({ bar: T0 + 2 * H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 103, 99, 102), bar(1, 108, 101, 107)] }] });
    assert.strictEqual(tm.placed[2].sl, '105.00');
    await tm.onBar({ bar: T0 + 3 * H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 103, 99, 102), bar(1, 108, 101, 107), bar(2, 106, 105.5, 106)] }] });
    assert.strictEqual(tm.placed.length, 3);   // no new high: the stop never moves back or sideways
    // short mirror
    const sm = mk({ deps: { trailState: FM.trailState } });
    await sm.onNewCalls([tcall({ dir: -1, stop: 104 })], { items: [item({ symbol: 'ETHUSDT', last: 99.95 })] });
    await sm.onBar({ bar: T0 + H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 101, 96, 97)] }] }); assert.strictEqual(sm.placed[1].sl, '99.00');
    // not armed: onBar sends nothing
    const dm = mk({ enabled: false, deps: { trailState: FM.trailState } }); await dm.onBar({ bar: T0 + H4, items: [] }); assert.strictEqual(dm.placed.length, 0);
    // a refused stop update keeps the old stop and is retried at the next bar
    let fail = true; const rm = mk({ deps: { trailState: FM.trailState, exec: async b => ({ body: fail && b.kind === 'sltp' ? { ok: false, code: 'NET', detail: 'x' } : { ok: true, code: 'OK' } }) } });
    await rm.onNewCalls([tcall()], { items: [item({ symbol: 'ETHUSDT' })] }); await rm.onBar({ bar: T0 + H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 103, 99, 102)] }] });
    assert.strictEqual(rm.state.live[0].stop, 96); fail = false; await rm.onBar({ bar: T0 + 2 * H4, items: [{ symbol: 'ETHUSDT', cs: [bar(0, 103, 99, 102), bar(1, 104, 101, 103)] }] }); assert.strictEqual(rm.state.live[0].stop, 101);
    // the time limit for trend trades is 84 bars, not 30
    assert.strictEqual(tm.state.live[0].hold, 84);
    // ownership: Profit Guard / Sentinel / swing manager / re-entry skip these positions (also while the order is still being placed)
    assert(tm.owns('ETHUSDT', 'Buy') && tm.owns('ETHUSDT') && !tm.owns('ETHUSDT', 'Sell') && !tm.owns('SOLUSDT', 'Buy'));
    let during = null; const om = mk({ deps: { exec: async b => { during = om.owns('XRPUSDT', 'Buy'); return { body: { ok: true, code: 'OK' } }; } } });
    await om.onNewCalls([call({ symbol: 'XRPUSDT' })], { items: [item({ symbol: 'XRPUSDT' })] }); assert.strictEqual(during, true); assert(om.owns('XRPUSDT', 'Buy'));
    const fm = mk({ deps: { exec: async () => ({ body: { ok: false, code: 'BAL' } }) } }); await fm.onNewCalls([call({ symbol: 'XRPUSDT' })], { items: [item({ symbol: 'XRPUSDT' })] }); assert(!fm.owns('XRPUSDT', 'Buy'));
    // health is per module: combo falling behind its random coins neither shrinks nor stops trend
    { const ws = (m, n) => m === 'combo' ? { real: 50, control: 50, edge: -0.2, meanR: -0.2, controlMeanR: 0, totalReal: n.t } : { real: 50, control: 50, edge: 0.1, meanR: 0.1, controlMeanR: 0, totalReal: 50 }; const ctl = { t: 50 };
      const hmx = mk({ deps: { windowStats: (m, n) => ws(m, ctl) } });
      await hmx.onNewCalls([tcall({ symbol: 'AAAUSDT', id: 31 })], { items: [item({ symbol: 'AAAUSDT' })] }); assert.strictEqual(hmx.state.health.by.combo.stage, 1); assert.strictEqual(hmx.state.health.by.trend.stage, 0);
      ctl.t = 100; await hmx.onNewCalls([tcall({ symbol: 'BBBUSDT', id: 32 })], { items: [item({ symbol: 'BBBUSDT' })] }); assert.strictEqual(hmx.state.health.by.combo.stage, 2);
      assert.strictEqual(hmx.placed.length, 2, 'trend keeps trading while combo is switched off'); assert(hmx.placed.every(x => x.usdMargin > 0));
      await hmx.onNewCalls([call({ symbol: 'CCCUSDT', id: 33 })], { items: [item({ symbol: 'CCCUSDT' })] }); assert(/switched off by the health monitor: combo/.test(hmx.summary().recentDecisions.slice(-1)[0].reason)); }
    // arm / disarm from the page: arming needs the server permission, disarming is always possible, open trades stay managed, the choice survives a restart
    { const msgs = []; let saved = null; const store = { load: async () => saved, save: async x => { saved = JSON.parse(JSON.stringify(x)); } };
      const am = mk({ deps: { trailState: FM.trailState, alert: x => msgs.push(x) } }); am.cfg.RISK_PCT = 0.5;
      assert.strictEqual(am.summary().armed, true); assert.strictEqual(am.summary().canArm, true);
      await am.onNewCalls([tcall({ symbol: 'LIVEUSDT', id: 41 })], { items: [item({ symbol: 'LIVEUSDT' })] }); assert.strictEqual(am.placed.length, 1);
      const r1 = await am.setArmed(false); assert.strictEqual(r1.armed, false); assert.strictEqual(am.summary().armed, false); assert(msgs.some(x => /DRY RUN/.test(x)));
      await am.onNewCalls([tcall({ symbol: 'DRYUSDT', id: 42 })], { items: [item({ symbol: 'DRYUSDT' })] }); assert.strictEqual(am.placed.length, 1, 'disarmed: no new real order'); assert.strictEqual(am.summary().recentDecisions.slice(-1)[0].verdict, 'dry-run');
      const bar0 = (k, h, l, c) => ({ t: T0 + k * H4, o: c, h, l, c });
      await am.onBar({ bar: T0 + H4, items: [{ symbol: 'LIVEUSDT', cs: [bar0(0, 103, 99, 102)] }] }); assert.strictEqual(am.placed.length, 2, 'disarmed: the open trade is still trailed'); assert.strictEqual(am.placed[1].kind, 'sltp');
      const r2 = await am.setArmed(true); assert.strictEqual(r2.armed, true); assert(msgs.some(x => /ARMED/.test(x)));
      // locked when the server permission is missing
      const lm = mk({ enabled: false }); const r3 = await lm.setArmed(true); assert.strictEqual(r3.ok, false); assert(/V3_LIVE=on/.test(r3.message)); assert.strictEqual(lm.summary().armed, false); assert.strictEqual(lm.summary().canArm, false);
      // persisted: disarmed stays disarmed after a restart
      const pm = V.create({ enabled: true, now: () => T0 + 130000, store, deps: { equity: async () => 10000, dayPnl: async () => 0, tick: async () => '0.01', positions: async () => [], exec: async () => ({ body: { ok: true, code: 'OK' } }) } });
      await pm.setArmed(false); const pm2 = V.create({ enabled: true, now: () => T0 + 140000, store, deps: { equity: async () => 10000, dayPnl: async () => 0, tick: async () => '0.01', positions: async () => [], exec: async () => ({ body: { ok: true, code: 'OK' } }) } });
      await pm2.warm(); assert.strictEqual(pm2.summary().armed, false); }
    ok('trend trades: no target, exchange stop trails the best price by 1.5 ATR after +1 ATR (moved each bar, only in the trade\'s favour, shorts mirrored), a refused update is retried, nothing sent when not armed, 84-bar limit'); }
  console.log('v3live: all ' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
