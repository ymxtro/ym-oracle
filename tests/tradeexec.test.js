// Checks for the server-side trade execution (tradeexec.js). Run: node tests/tradeexec.test.js
const assert = require('assert');
const T = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/tradeexec.js' : '../tradeexec.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);

// A pretend Bybit that remembers positions and every call made to it.
function world(o) {
  o = Object.assign({ available: 1000, price: 100, qtyStep: 0.1, minQty: 0.1, minNotional: 5, maxLev: 50, status: 'Trading', mode: 'live', halted: false, latency: 0 }, o || {});
  const w = { calls: [], positions: {}, orders: [], stops: [], leverage: [], reports: [], fan: { lev: 0, stop: 0 }, o };
  const lat = () => new Promise(r => setTimeout(r, o.latency));
  const rest = {
    getWalletBalance: async () => { w.calls.push('balance'); await lat(); if (o.failBalance) throw new Error('boom'); return { retCode: 0, result: { list: [{ totalAvailableBalance: String(o.available), coin: [{ coin: 'USDT', equity: '1000' }] }] } }; },
    getPositionInfo: async ({ symbol }) => { w.calls.push('positions'); await lat(); if (o.failPositions) throw new Error('boom'); const p = w.positions[symbol]; return { retCode: 0, result: { list: p ? [{ symbol, side: p.side, size: p.size, markPrice: String(o.price) }] : [] } }; },
    getInstrumentsInfo: async ({ symbol }) => { w.calls.push('instrument'); await lat(); if (o.unlisted) return { retCode: 0, result: { list: [] } }; return { retCode: 0, result: { list: [{ status: o.status, lotSizeFilter: { qtyStep: String(o.qtyStep), minOrderQty: String(o.minQty), minNotionalValue: String(o.minNotional) }, leverageFilter: { maxLeverage: String(o.maxLev) } }] } }; },
    getTickers: async () => { w.calls.push('price'); await lat(); return { retCode: 0, result: { list: [{ lastPrice: String(o.price) }] } }; },
    setLeverage: async b => { w.calls.push('leverage'); await lat(); w.leverage.push(b); return o.levReply || { retCode: 0 }; },
    setTradingStop: async b => { w.calls.push('stop'); await lat(); w.stops.push(b); if (o.stopFails) throw new Error('net'); return o.stopReply || { retCode: 0 }; },
  };
  let t = 1_000_000;
  const ex = T.create({
    rest: () => rest, mode: () => o.mode, halted: () => o.halted, now: () => (t += 1), sleep: () => Promise.resolve(),
    placeOrder: async (b, opts) => {
      w.calls.push('order'); w.optsSeen = (w.optsSeen || []).concat([opts]); await lat(); w.orders.push(b);
      if (o.orderThrows) { if (o.orderStillLands) w.positions[b.symbol] = { side: b.side, size: b.qty }; throw new Error('socket hang up'); }
      if (o.orderReply) return o.orderReply;
      if (o.mode === 'paper') return { paper: true, retCode: 0 };
      if (b.reduceOnly) delete w.positions[b.symbol]; else w.positions[b.symbol] = { side: b.side, size: b.qty };
      return { retCode: 0, result: {} };
    },
    fanOutLeverage: () => { w.fan.lev++; }, fanOutTradingStop: () => { w.fan.stop++; },
    guardClamp: o.guardClamp,
    report: r => w.reports.push(r),
  });
  w.run = b => ex.run(b);
  return w;
}
const open = (x) => Object.assign({ kind: 'open', id: 'T0001', bot: 'YM ORACLE I', side: 'BUY', symbol: 'SOLUSDT', usdMargin: 20, leverage: 5, tp: '110', sl: '95', trailActivePrice: '104', trailPct: 1.5 }, x || {});

(async () => {
  // ---- happy path
  let w = world(); let r = await w.run(open());
  assert.strictEqual(r.http, 200); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.code, 'OK');
  assert.strictEqual(w.orders.length, 1); const ord = w.orders[0];
  assert.strictEqual(ord.orderLinkId, 'ym-T0001'); assert.strictEqual(ord.side, 'Buy'); assert.strictEqual(ord.takeProfit, '110'); assert.strictEqual(ord.stopLoss, '95');
  assert.strictEqual(ord.qty, '1.0', '$20 x 5 = $100 position at $100 = 1.0 (step 0.1)');
  assert.strictEqual(w.leverage[0].buyLeverage, '5');
  assert.strictEqual(w.stops.length, 1); assert.strictEqual(w.stops[0].trailingStop, '1.5000'); assert.strictEqual(w.stops[0].activePrice, '104');
  assert.strictEqual(w.reports.length, 1); assert.strictEqual(w.reports[0].kind, 'TRADE'); assert.strictEqual(w.reports[0].code, 'OK'); assert.strictEqual(w.reports[0].bot, 'YM ORACLE I');
  assert(r.body.ms.total >= 0 && 'read' in r.body.ms && 'order' in r.body.ms && 'trail' in r.body.ms);
  ok('open: reads, sets leverage, sizes the quantity, places the order, sets the trailing stop, reports to the dashboard, and returns per-stage timings');

  // ---- the four reads run together, then leverage, then the order (three Bybit steps, not eight)
  w = world(); await w.run(open({ trailPct: 0 }));
  const first4 = w.calls.slice(0, 4).sort().join(); assert.strictEqual(first4, 'balance,instrument,positions,price');
  assert.deepStrictEqual(w.calls.slice(4), ['leverage', 'order']);
  ok('the balance, position, instrument and price reads are started together; then leverage; then the order');

  // ---- idempotent: a retransmit never makes a second order
  w = world(); await w.run(open()); const again = await w.run(open());
  assert.strictEqual(again.body.replayed, true); assert.strictEqual(w.orders.length, 1); assert.strictEqual(w.reports.length, 1);
  w = world({ latency: 5 }); const [a, b] = await Promise.all([w.run(open()), w.run(open())]);
  assert.strictEqual(w.orders.length, 1); assert(a.body.replayed || b.body.replayed);
  ok('a retransmitted id (even one arriving while the first is still running) gets the same answer and never a second order');

  // ---- two bots, same pair, same moment: only one opens
  w = world({ latency: 3 }); const [x, y] = await Promise.all([w.run(open({ id: 'TA' })), w.run(open({ id: 'TB', bot: 'YM ORACLE II' }))]);
  assert.strictEqual(w.orders.length, 1); assert.deepStrictEqual([x.body.code, y.body.code].sort(), ['HELD', 'OK']);
  ok('two bots signalling the same pair at once: one opens, the other is refused as HELD (the per-symbol lock replaces the manager\'s one-at-a-time)');
  w = world({ latency: 3 }); await Promise.all([w.run(open({ id: 'TA', symbol: 'SOLUSDT', trailPct: 0 })), w.run(open({ id: 'TB', symbol: 'ETHUSDT', trailPct: 0 }))]);
  assert.strictEqual(w.orders.length, 2); ok('different pairs do not wait for each other');

  // ---- refusals
  w = world(); w.positions.SOLUSDT = { side: 'Sell', size: '2' }; r = await w.run(open());
  assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.code, 'HELD'); assert.strictEqual(w.orders.length, 0);
  w = world({ failPositions: true }); r = await w.run(open()); assert.strictEqual(r.body.code, 'NET'); assert.strictEqual(w.orders.length, 0);
  ok('a pair already held is refused (HELD); if positions cannot be read the trade is refused (NET), never guessed');
  w = world({ available: 15 }); r = await w.run(open({ usdMargin: 20 }));
  assert.strictEqual(r.body.code, 'SCALED'); assert.strictEqual(r.body.ok, true); assert.strictEqual(w.leverage[0].buyLeverage, '5');
  assert.strictEqual(w.orders[0].qty, '0.7', '$15 x 0.97 = $14.55 margin x 5 = $72.75 / $100 -> 0.7');
  w = world({ available: 8 }); r = await w.run(open({ usdMargin: 20 })); assert.strictEqual(r.body.code, 'BAL'); assert.strictEqual(w.orders.length, 0);
  ok('low balance: opens smaller (SCALED) down to half of what was asked; below half it is refused (BAL)');
  w = world({ maxLev: 3 }); r = await w.run(open({ trailPct: 0 })); assert.strictEqual(r.body.code, 'LEVCLMP'); assert.strictEqual(w.leverage[0].buyLeverage, '3'); assert.strictEqual(w.orders[0].qty, '0.6');
  ok('leverage above the pair\'s cap is clamped (LEVCLMP) and the size is worked out at the clamped leverage');
  w = world({ price: 100, minNotional: 50 }); r = await w.run(open({ usdMargin: 5, leverage: 5, trailPct: 0 })); assert.strictEqual(r.body.code, 'MINQ'); assert.strictEqual(w.orders.length, 0);
  w = world({ unlisted: true }); r = await w.run(open()); assert.strictEqual(r.body.code, 'PAIR'); assert.strictEqual(w.orders.length, 0);
  w = world({ status: 'Settling' }); r = await w.run(open()); assert.strictEqual(r.body.code, 'PAIR');
  w = world({ levReply: { retCode: 10001, retMsg: 'leverage not modified invalid' } }); r = await w.run(open()); assert.strictEqual(r.body.code, 'LEV'); assert.strictEqual(w.orders.length, 0);
  w = world({ levReply: { retCode: 110043, retMsg: 'leverage not modified' } }); r = await w.run(open({ trailPct: 0 })); assert.strictEqual(r.body.code, 'OK');
  ok('too small (MINQ), not listed or not trading (PAIR), leverage refused (LEV, no order placed); "leverage already set" is fine');
  w = world({ orderReply: { retCode: 110007, retMsg: 'ab not enough for new order' } }); r = await w.run(open()); assert.strictEqual(r.body.code, 'BAL'); assert.strictEqual(w.stops.length, 0);
  w = world({ orderReply: { retCode: 110072, retMsg: 'OrderLinkedID is duplicate' } }); r = await w.run(open({ trailPct: 0 })); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.code, 'DUP');
  ok('Bybit\'s own refusals keep the manager\'s codes (BAL / BYBIT / ...); a duplicate order id counts as placed (DUP)');
  w = world({ qtyStep: 10, minQty: 10, price: 0.05 }); r = await w.run(open({ usdMargin: 20, leverage: 5, trailPct: 0 })); assert.strictEqual(w.orders[0].qty, '2000', 'step 10: 100/0.05 = 2000');
  w = world({ qtyStep: 0.001, minQty: 0.001, price: 3000 }); await w.run(open({ usdMargin: 20, leverage: 5, trailPct: 0, symbol: 'ETHUSDT' })); assert.strictEqual(w.orders[0].qty, '0.033');
  ok('quantity is rounded DOWN to a multiple of the pair\'s step (step 10, step 0.001)');

  // ---- halted / paper / bad input
  w = world({ halted: true }); r = await w.run(open()); assert.strictEqual(r.body.code, 'HALT'); assert.strictEqual(w.calls.length, 0);
  ok('halted: nothing touches Bybit; the dashboard gets HALT');
  w = world({ mode: 'paper' }); r = await w.run(open()); assert.strictEqual(r.body.code, 'PAPER'); assert.strictEqual(r.body.ok, true); assert.strictEqual(w.stops.length, 0); assert.strictEqual(w.leverage.length, 0);
  ok('paper mode: the order goes through the paper path, nothing is sent to Bybit, no trailing stop');
  w = world(); for (const bad of [{ side: 'HOLD' }, { symbol: '' }, { usdMargin: -5 }, { leverage: 0 }, { tp: 'abc' }, { trailPct: 99 }, { id: 'a b!' }, { kind: 'nuke' }]) {
    const rr = await w.run(open(bad)); assert.strictEqual(rr.http, 400, JSON.stringify(bad)); assert.strictEqual(rr.body.code, 'BAD');
  }
  assert.strictEqual(w.orders.length, 0); assert.strictEqual((await w.run(null)).http, 400);
  assert(w.reports.some(x => x.code === 'BAD'), 'a malformed command that still has an id is shown on the dashboard');
  ok('malformed requests are refused with 400 BAD and never reach Bybit');

  // ---- lost replies
  w = world({ orderThrows: true, orderStillLands: true }); r = await w.run(open({ trailPct: 0 }));
  assert.strictEqual(r.body.ok, true); assert(/confirmed on Bybit/.test(r.body.detail));
  w = world({ orderThrows: true }); r = await w.run(open({ trailPct: 0 })); assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.code, 'NET');
  ok('order reply lost: Bybit is asked whether it landed; yes = success, no = NET failure');
  w = world({ orderThrows: true }); await w.run(open({ trailPct: 0 })); const retryAfterNet = await w.run(open({ trailPct: 0 }));
  assert.strictEqual(retryAfterNet.body.replayed, true);
  w = world({ failBalance: true }); r = await w.run(open()); assert.strictEqual(r.body.code, 'NET'); w.o.failBalance = false; r = await w.run(open());
  assert.strictEqual(r.body.code, 'OK'); assert(!r.body.replayed); assert.strictEqual(w.orders.length, 1);
  ok('a failure BEFORE any order was tried can be retried with the same id; once an order was tried the answer is final for that id');

  // ---- trailing stop
  w = world({ stopFails: true }); r = await w.run(open());
  assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.code, 'NOTRL'); assert.strictEqual(w.stops.length, 3);
  ok('trailing stop fails: the trade is still reported as opened but with NOTRL (so you are alerted), after three tries');
  w = world({ price: 0.00001, qtyStep: 1, minQty: 1, minNotional: 0 }); r = await w.run(open({ usdMargin: 5, leverage: 2 })); assert.strictEqual(r.body.code, 'NOTRL'); assert(/rounds to zero/.test(r.body.detail));
  ok('a trail distance that would round to 0.0000 is not sent (NOTRL with a reason) instead of a stop Bybit would reject');
  w = world(); await w.run(open({ trailPct: 0, trailActivePrice: '' })); assert.strictEqual(w.stops.length, 0);
  ok('no trail asked = no trailing call');
  w = world(); await w.run(open()); assert.strictEqual(w.fan.lev, 1); assert.strictEqual(w.fan.stop, 1);
  ok('leverage and trailing stop are also copied to the users\' accounts (fire and forget)');

  // ---- close
  w = world(); w.positions.SOLUSDT = { side: 'Buy', size: '1.5' };
  r = await w.run({ kind: 'close', id: 'C0001', bot: 'YM ORACLE I', side: 'BUY', symbol: 'SOLUSDT' });
  assert.strictEqual(r.body.ok, true); assert.strictEqual(w.orders[0].side, 'Sell'); assert.strictEqual(w.orders[0].qty, '1.5'); assert.strictEqual(w.orders[0].reduceOnly, true); assert.strictEqual(w.orders[0].orderLinkId, 'ymc-C0001');
  assert.strictEqual(w.reports[0].kind, 'CLOSE');
  r = await w.run({ kind: 'close', id: 'C0002', side: 'BUY', symbol: 'SOLUSDT' }); assert.strictEqual(r.body.code, 'NOPOS'); assert.strictEqual(r.body.ok, true);
  w = world(); w.positions.SOLUSDT = { side: 'Sell', size: '1' }; r = await w.run({ kind: 'close', id: 'C0003', side: 'BUY', symbol: 'SOLUSDT' });
  assert.strictEqual(r.body.code, 'SIDE'); assert.strictEqual(r.body.ok, false); assert.strictEqual(w.orders.length, 0);
  w = world({ orderThrows: true }); w.positions.SOLUSDT = { side: 'Buy', size: '1' }; w.o.orderThrows = true;
  r = await w.run({ kind: 'close', id: 'C0004', side: 'BUY', symbol: 'SOLUSDT' }); assert.strictEqual(r.body.code, 'NET');
  ok('close: reduce-only order for the held size; already flat = fine (NOPOS); the position is on the other side = left alone (SIDE)');

  // ---- stop / target update
  w = world(); w.positions.SOLUSDT = { side: 'Buy', size: '1' };
  r = await w.run({ kind: 'sltp', id: 'S0001', side: 'BUY', symbol: 'SOLUSDT', tp: '120', sl: '98' });
  assert.strictEqual(r.body.ok, true); assert.deepStrictEqual(w.stops[0], { category: 'linear', symbol: 'SOLUSDT', takeProfit: '120', stopLoss: '98' }); assert.strictEqual(w.reports[0].kind, 'SLTP');
  r = await w.run({ kind: 'sltp', id: 'S0002', side: 'SELL', symbol: 'SOLUSDT', sl: '98' }); assert.strictEqual(r.body.code, 'SIDE');
  r = await w.run({ kind: 'sltp', id: 'S0003', side: 'BUY', symbol: 'ETHUSDT', sl: '98' }); assert.strictEqual(r.body.code, 'NOPOS'); assert.strictEqual(r.body.ok, false);
  r = await w.run({ kind: 'sltp', id: 'S0004', side: 'BUY', symbol: 'SOLUSDT' }); assert.strictEqual(r.http, 400);
  ok('stop/target update: only on a held position on the right side; needs at least one of tp / sl');
  // Profit Guard: a looser stop from a bot is held at the guard's floor, on this route too (and a guard that throws never blocks the update)
  w = world({ guardClamp: x => (x.stopLoss !== undefined && Number(x.stopLoss) < 110 ? { ...x, stopLoss: '110' } : x) }); w.positions.SOLUSDT = { side: 'Buy', size: '1' };
  r = await w.run({ kind: 'sltp', id: 'G0001', side: 'BUY', symbol: 'SOLUSDT', tp: '130', sl: '98' });
  assert.strictEqual(r.body.ok, true); assert.deepStrictEqual(w.stops[0], { category: 'linear', symbol: 'SOLUSDT', takeProfit: '130', stopLoss: '110' });
  r = await w.run({ kind: 'sltp', id: 'G0002', side: 'BUY', symbol: 'SOLUSDT', sl: '115' }); assert.strictEqual(w.stops[1].stopLoss, '115');
  w = world({ guardClamp: () => { throw new Error('boom'); } }); w.positions.SOLUSDT = { side: 'Buy', size: '1' };
  r = await w.run({ kind: 'sltp', id: 'G0003', side: 'BUY', symbol: 'SOLUSDT', sl: '98' }); assert.strictEqual(r.body.ok, true); assert.strictEqual(w.stops[0].stopLoss, '98');
  ok('profit guard hook: a looser stop is held at the floor on the web route too, a tighter one passes, and a failing guard never blocks the update');

  // ---- helpers
  assert.strictEqual(T.decimalsOf(0.1), 1); assert.strictEqual(T.decimalsOf(1), 0); assert.strictEqual(T.decimalsOf('0.001'), 3); assert.strictEqual(T.decimalsOf(1e-7), 7); assert.strictEqual(T.decimalsOf(10), 0);
  assert.strictEqual(T.classify({ retCode: 10001, retMsg: 'Invalid symbol' }).code, 'PAIR'); assert.strictEqual(T.classify({ retCode: 10001, retMsg: 'order value below min' }).code, 'MINQ'); assert.strictEqual(T.classify({ retCode: 34040 }).ok, true);
  ok('step-precision and Bybit-reply classification helpers');

  // ---- v2.9.8: a master-only trade (the relay's own re-entry) never touches users
  w = world(); r = await w.run(open({ id: 'MO0001', masterOnly: true, trailPct: 1.5 }));
  assert.strictEqual(r.body.ok, true); assert.strictEqual(w.fan.lev, 0, 'no leverage change on users\' accounts'); assert.strictEqual(w.fan.stop, 0, 'no stop copied to users');
  assert.deepStrictEqual(w.optsSeen, [{ masterOnly: true }], 'the order pipeline is told to skip copies and plan sizing');
  w = world(); await w.run(open({ id: 'MO0002' }));
  assert.strictEqual(w.fan.lev, 1); assert.strictEqual(w.fan.stop, 1); assert.deepStrictEqual(w.optsSeen, [{ masterOnly: false }], 'a normal bot trade still fans out');
  ok('masterOnly: leverage, stops and the order skip every user account; a normal trade is unchanged');

  console.log('\nALL ' + n + ' TRADE EXECUTION CHECKS PASSED');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
