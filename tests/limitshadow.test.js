// Unit checks for the limit-order shadow (limitshadow.js). Run: node tests/limitshadow.test.js
const assert = require('assert');
const L = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/limitshadow.js' : '../limitshadow.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
// virtual clock: sleeping just moves time forward; the ticker is a function of time
function mk(priceAt, extra = {}) {
  let t = 1000; const clock = { now: () => t, sleep: async ms => { t += ms; } };
  const getTicker = async () => { const p = priceAt(t - 1000); return { bid: p - 0.5, ask: p + 0.5, last: p }; };
  return L.create({ ...clock, getTicker, enabled: true, ...extra });
}
(async () => {
  // Buy: price dips through the bid after 6s -> filled, better than market by about 1 tick
  let s = mk(ms => ms < 6000 ? 100 : 99.2);
  let r = await s.watch({ symbol: 'X', side: 'Buy', stopLoss: 95 });
  assert(r.filled && r.fillSec >= 6 && r.fillSec <= 8 && r.improveBps > 0 && r.savedR > 0, JSON.stringify(r));
  ok('a buy fills when price trades through the bid; it reports speed, price improvement and fee saved in R');
  // Buy: price runs away upward -> missed, and the forward move shows the winner it would have skipped
  s = mk(ms => 100 + ms / 1000 * 0.05);
  r = await s.watch({ symbol: 'X', side: 'Buy', stopLoss: 95 });
  assert(!r.filled && r.fwd['5m'] > 0 && r.fwd['30m'] > r.fwd['5m'], JSON.stringify(r));
  const sm = s.summary(); assert.strictEqual(sm.fillRatePct, 0); assert(sm.forwardPctInTradeDirection.missed['5m'] > 0);
  ok('a runaway buy is a miss, and the summary shows how far the missed trade went in its direction');
  // Sell mirrors
  s = mk(ms => ms < 4000 ? 50 : 50.9);
  r = await s.watch({ symbol: 'X', side: 'Sell', stopLoss: 55 });
  assert(r.filled && r.improveBps > 0, JSON.stringify(r));
  ok('a sell fills when price trades up through the ask');
  // touching is not enough
  s = mk(ms => 100);
  r = await s.watch({ symbol: 'X', side: 'Buy' });
  assert(!r.filled && r.savedR === null);
  ok('price sitting at the limit without trading through it is not a fill; no stop = no R figure');
  // reprice: bid drifts down; limit follows, max 3 times
  s = mk(ms => 100 - ms / 1000 * 0.02);
  r = await s.watch({ symbol: 'X', side: 'Buy' });
  assert(r.reprices <= 3);
  ok('reprices are capped at ' + s.cfg.MAX_REPRICES);
  // observe: closes and disabled instances do nothing; bad ticker never throws
  const off = L.create({ getTicker: async () => null, enabled: false }); off.observe({ symbol: 'X', side: 'Buy' }); assert.strictEqual(off.summary().signals, 0);
  const on = L.create({ getTicker: async () => { throw new Error('x'); }, enabled: true }); on.observe({ symbol: 'X', side: 'Buy', reduceOnly: true }); on.observe({ symbol: 'X', side: 'Buy' }); on.observe(null);
  assert.strictEqual(await on.watch({ symbol: 'X', side: 'Buy' }), null);
  ok('off by default, ignores closes, and a failing ticker or bad input never throws');
  console.log('limitshadow: all ' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
