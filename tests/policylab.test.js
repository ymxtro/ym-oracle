// Unit checks for the policy lab (policylab.js). Run: node tests/policylab.test.js
const assert = require('assert');
const PL = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/policylab.js' : '../policylab.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const T0 = Date.parse('2026-10-20T10:00:00Z');
// a path: list of [minutes, nowR, peakR]
const path = (sym, pts, t0 = T0) => pts.map(([m, nr, pr]) => ({ at: t0 + m * 60000, symbol: sym, side: 'Sell', now_r: nr, peak_r: pr }));

// grouping: two trades on the same coin more than 30 minutes apart are two trades; a stub of under 3 minutes is dropped
const rows = [...path('AAA', [[0, 0, 0], [1, 0.2, 0.2], [5, 0.5, 0.5]]), ...path('AAA', [[100, 0, 0], [105, -0.5, 0]]), ...path('BBB', [[0, 0, 0], [1, 0, 0]])];
assert.strictEqual(PL.groupPaths(rows).length, 2); ok('paths are split into trades by gaps and tiny stubs are dropped');

// ladder: a trade that runs to 1.2R then falls back to 0.3R
const run = [[0, 0, 0], [10, 0.5, 0.5], [20, 1.2, 1.2], [30, 0.9, 1.2], [40, 0.3, 1.2]];
const tr = PL.groupPaths(path('X', run));
assert.strictEqual(PL.replayLadder(tr, 0.7, 0.5).total, 0.6, 'stop at 50% of 1.2R = 0.6R, hit on the way down');
assert.strictEqual(PL.replayLadder(tr, 1.5, 0.5).total, 0.3, 'never armed: the real result stands');
assert.strictEqual(PL.replayLadder(tr, 0.7, 0).total, 0.3, 'breakeven only: never touched, so the real result stands');
ok('ladder replay: stop at the kept share of the peak, breakeven floor, unarmed trades keep their real result');

// a path that goes straight down: the original stop caps it at -1R
const dive = PL.groupPaths(path('Y', [[0, 0, 0], [5, -0.5, 0], [10, -1.3, 0], [20, -1.4, 0]]));
assert.strictEqual(PL.replayLadder(dive, 0.7, 0.5).total, -1); ok('original stop caps a loss at -1R in the replay');

// loss-cut: after 0 minutes, never +0.15R, down 0.5R -> cut at -0.5R instead of the real -1.4R
const lc = PL.replayLossCut(dive, 0, 0.15, 0.5); assert.strictEqual(lc.total, -0.5); assert.strictEqual(lc.cut, 1); assert(Math.abs(lc.saved - 0.9) < 1e-9);
const lw = PL.groupPaths(path('Z', [[0, 0, 0], [5, -0.6, 0], [10, 0.4, 0.4], [20, 0.8, 0.8]]));
const lcw = PL.replayLossCut(lw, 0, 0.15, 0.5); assert.strictEqual(lcw.total, -0.5); assert(Math.abs(lcw.hurt - 1.3) < 1e-9, 'a trade that would have recovered is counted as hurt');
ok('loss-cut replay: saves what it cuts early, and counts the trades it would have wrongly cut');

// report shape and the printed limits
const rep = PL.report(path('X', run).concat(path('Y', [[0, 0, 0], [5, -0.5, 0], [10, -1, 0], [20, -1, 0]], T0 + 6 * 3600000)));
assert.strictEqual(rep.trades, 2); assert.strictEqual(rep.neverMoved.n, 1); assert.strictEqual(rep.moved.n, 1); assert(rep.caveats.length === 3 && rep.ladder.length === 5 && rep.lossCut.length === 24 && rep.bestLadder);
assert.deepStrictEqual(PL.report([]).trades, 0); assert.deepStrictEqual(PL.report(null).trades, 0);
ok('report: never-moved vs moved, a ladder grid, a loss-cut grid, the limits stated; empty input is fine');

// attribution (short: entry 2.044, original stop 2.1369, risk 0.0929)
const a = { side: 'Sell', entry: 2.044, initialSl: 2.1369, guardFloor: 2.02, sentinelFloor: 2.042 };
assert.strictEqual(PL.attributeExit({ ...a, exit: 2.0202 }), 'GUARD_STOP');
assert.strictEqual(PL.attributeExit({ ...a, exit: 2.0425 }), 'SENTINEL_STOP');
assert.strictEqual(PL.attributeExit({ ...a, exit: 2.137 }), 'ORIGINAL_SL');
assert.strictEqual(PL.attributeExit({ ...a, exit: 1.95 }), 'OTHER');
assert.strictEqual(PL.attributeExit({ ...a, exit: 2.0 , botStop: 2.001 }), 'BOT_STOP');
assert.strictEqual(PL.attributeExit({ ...a, exit: 0 }), 'UNKNOWN'); assert.strictEqual(PL.attributeExit({ side: 'Sell', entry: 2, initialSl: 2, exit: 1.9 }), 'UNKNOWN');
ok('exit attribution: nearest stop within 0.12R of the exit price; otherwise other; unknown without an exit or a risk');
console.log('\nALL ' + n + ' CHECKS PASSED');
