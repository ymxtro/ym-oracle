'use strict';
const S = require('../scalpmodel');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const OLD = { trail: false, stallMin: 0 };   // the v2.9.15 exit rules
const P = (arr) => arr.map(([m, p]) => ({ t: m * 60000, p }));

// normalize clamps
const n = S.normalize({ targetFloorPct: 0.01, leverage: 99, confirmPct: 'x' });
ok(n.targetFloorPct === 0.2 && n.leverage === 10 && n.confirmPct === 0.25, 'normalize clamps and defaults');
ok(S.normalize({ targetFloorPct: 2, targetCapPct: 1 }).targetCapPct === 2, 'cap never below floor');
ok(Math.abs(S.costPct(S.normalize({})) - 0.16) < 1e-9, 'cost 0.16');

// target from winners
ok(S.targetPct([1, 2], {}).source === 'fallback', 'few winners -> fallback');
const t1 = S.targetPct([1, 1.2, 1.5, 2, 2.5, 3, 4, 5], {});
ok(t1.source === 'wins' && t1.median === 2.25 && t1.pct === 1.35, 'target = 0.6 x median, got ' + JSON.stringify(t1));
ok(S.targetPct([9, 9, 9, 9, 9, 9, 9, 9], {}).pct === 1.5, 'cap applied');
ok(S.targetPct([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], {}).pct === 0.5, 'floor applied');
ok(S.targetPct([-1, 0, 'a', 1, 1, 1, 1, 1, 1, 1, 1], {}).n === 8, 'bad values ignored');

// simulate long: confirm at +0.25%, then target
let r = S.simulate(P([[0, 100], [1, 100.1], [2, 100.3], [3, 100.6], [4, 101.2]]), 'Buy', 100, OLD, { target: 0.8 });
ok(r.entered && r.entryPx === 100.3 && r.exit === 'target' && r.grossPct === 0.8 && r.netPct === 0.64, 'long target hit ' + JSON.stringify(r));
// never confirms
r = S.simulate(P([[0, 100], [5, 100.1], [11, 101]]), 'Buy', 100, OLD, { target: 0.8 });
ok(!r.entered && r.reason === 'no confirmation', 'no confirmation inside window');
// confirm only after window -> still not entered
r = S.simulate(P([[0, 100], [12, 100.5]]), 'Buy', 100, OLD, { target: 0.8 });
ok(!r.entered, 'late confirmation ignored');
// short side mirrors
r = S.simulate(P([[0, 100], [2, 99.7], [3, 99.0]]), 'Sell', 100, OLD, { target: 0.6 });
ok(r.entered && r.exit === 'target' && r.grossPct === 0.6, 'short target');
// stop: enter at 100.3, falls beyond stop (0.8)
r = S.simulate(P([[0, 100], [2, 100.3], [3, 99.4]]), 'Buy', 100, OLD, { target: 0.8 });
ok(r.exit === 'stop' && r.grossPct < -0.8 && r.netPct < r.grossPct, 'stop uses sampled price and pays costs ' + JSON.stringify(r));
// breakeven: reaches half target then returns
r = S.simulate(P([[0, 100], [2, 100.3], [3, 100.75], [4, 100.2]]), 'Buy', 100, OLD, { target: 0.8 });
ok(r.exit === 'breakeven' && r.netPct < 0 && r.netPct > -0.3, 'breakeven exit costs only fees ' + JSON.stringify(r));
// time stop
r = S.simulate(P([[0, 100], [2, 100.3], [10, 100.4], [23, 100.45]]), 'Buy', 100, OLD, { target: 0.8 });
ok(r.exit === 'time' && r.heldMin >= 20, 'time stop');
// path ends
r = S.simulate(P([[0, 100], [2, 100.3], [4, 100.4]]), 'Buy', 100, OLD, { target: 0.8 });
ok(r.exit === 'end', 'path ended');
// instant
r = S.simulate(P([[0, 100], [1, 100.9]]), 'Buy', 100, { ...OLD, instant: true }, { target: 0.8 });
ok(r.entered && r.entryPx === 100 && r.exit === 'target', 'instant enters at the call price');
ok(!S.simulate([], 'Buy', 100, {}, {}).entered && !S.simulate(P([[0, 1]]), 'Buy', 0, {}, {}).entered, 'empty and bad input');

// usd
ok(S.usdOf(0.64, { leverage: 5 }, 1000) === 32, 'usd = 0.64% x 1000 x 5 = 32');

// summarize + verdict
const tr = []; for (let i = 0; i < 60; i++) tr.push({ netPct: i % 3 ? 0.4 : -0.2, exit: 'x', ts: i });
const sm = S.summarize(tr);
ok(sm.n === 60 && sm.avgNet > 0.15 && sm.halves[0] > 0 && sm.halves[1] > 0, 'summary halves ' + JSON.stringify(sm));
ok(S.verdict(sm).ready === true, 'verdict ready');
ok(S.verdict(S.summarize(tr.slice(0, 10))).ready === false, 'verdict needs trades');
ok(S.verdict(S.summarize(tr.map(x => ({ ...x, netPct: x.netPct * 0.1 })))).ready === false, 'verdict needs edge');
ok(S.summarize([]).n === 0, 'empty summary');

// lab
const rows = []; for (let i = 0; i < 40; i++) rows.push({ side: 'Buy', signalPx: 100, ts: i, path: P([[0, 100], [1, 100.3], [3, 101.0]]) });
const L = S.lab(rows, {});
ok(L.length === 108 && L[0].avgNet > 0 && L[0].robust, 'lab grid ' + L.length + ' best ' + JSON.stringify(L[0]));
const L2 = S.lab(rows.map(r => ({ ...r, path: P([[0, 100], [1, 99.9], [3, 99.5]]) })), {});
ok(L2.every(x => x.entered === 0 && !x.robust), 'lab: no confirmation -> no entries');


// ---- v2.9.16 ----
// leverage from risk
let lv = S.leverageFor(0.8, {}); ok(lv.lev === 5 && lv.limitedBy === 'risk' && lv.riskPctOfMargin === 4, '0.8% stop -> 5x ' + JSON.stringify(lv));
lv = S.leverageFor(0.4, {}); ok(lv.lev === 10 && lv.limitedBy === 'risk', '0.4% stop -> 10x');
lv = S.leverageFor(2, {}); ok(lv.lev === 2, '2% stop -> 2x');
lv = S.leverageFor(0.2, {}); ok(lv.lev === 10 && lv.limitedBy === 'maxLev', '0.2% stop would be 20x -> capped at 10x');
lv = S.leverageFor(1.2, { riskPct: 20, maxLev: 10, liqMult: 10 }); ok(lv.limitedBy === 'liquidation' && lv.lev === 8, 'liquidation distance can lower it ' + JSON.stringify(lv));
lv = S.leverageFor(50, {}); ok(lv.lev === 1, 'never below 1x');
ok(S.leverageFor(1.3, {}).lev === 3 && S.leverageFor(1.3, { riskPct: 6.5 }).lev === 5, 'rounds down to 0.1 and follows the risk setting');
ok(S.usdOf(0.5, {}, 1000, 8) === 40, 'usd uses the per-trade leverage');

// trailing: after the target the trade continues, then leaves on a pull-back; never below 85% of the target
let r2 = S.simulate(P([[0, 100], [2, 100.3], [3, 101.2], [4, 101.9], [5, 101.4]]), 'Buy', 100, { stallMin: 0 }, { target: 0.8 });
ok(r2.exit === 'trail' && r2.grossPct > 1.0, 'trail lets a runner run past the target ' + JSON.stringify(r2));
r2 = S.simulate(P([[0, 100], [2, 100.3], [3, 101.15], [4, 100.95]]), 'Buy', 100, { stallMin: 0 }, { target: 0.8 });
ok(r2.exit === 'trail' && r2.grossPct >= 0.64, 'a pull-back right after the target leaves near the target ' + JSON.stringify(r2));
r2 = S.simulate(P([[0, 100], [2, 100.3], [3, 101.2], [30, 101.25]]), 'Buy', 100, { stallMin: 0, timeStopMin: 20 }, { target: 0.8 });
ok(r2.exit === 'time', 'time limit still applies while trailing');
// stall: profit made, then no new best for 5 minutes
r2 = S.simulate(P([[0, 100], [2, 100.3], [3, 100.6], [9, 100.58]]), 'Buy', 100, {}, { target: 0.8 });
ok(r2.exit === 'stall' && r2.grossPct > 0.2, 'stall exit takes the profit when price stops making new highs ' + JSON.stringify(r2));
r2 = S.simulate(P([[0, 100], [2, 100.3], [9, 100.31]]), 'Buy', 100, {}, { target: 0.8 });
ok(r2.exit !== 'stall', 'no stall exit when the gain would not cover the cost');

// best target from a group
const mk = (n, peak) => Array.from({ length: n }, (_, i) => ({ side: 'Buy', signalPx: 100, ts: i, path: P([[0, 100], [1, 100.3], [3, 100 + peak], [4, 100 + peak - 0.05]]) }));
let bt = S.bestTarget(mk(5, 1.0), OLD); ok(bt.source === 'default' && bt.pct === 0.8, 'too few rows -> default');
bt = S.bestTarget(Array.from({ length: 20 }, (_, i) => ({ side: 'Buy', signalPx: 100, ts: i, path: P([[0, 100], [1, 100.3], [3, 100.92], [6, 100.3]]) })), { ...OLD, fallbackTargetPct: 1.0 }); ok(bt.source === 'group' && bt.pct === 0.6 && !bt.skip, 'a coin that only reaches ~0.6% gets a 0.6% target ' + JSON.stringify(bt));
bt = S.bestTarget(mk(20, 1.45), OLD); ok(bt.pct >= 1.0 && !bt.skip, 'a coin that runs gets a bigger target ' + JSON.stringify(bt));
const losing = Array.from({ length: 20 }, (_, i) => ({ side: 'Buy', signalPx: 100, ts: i, path: P([[0, 100], [1, 100.3], [3, 99.0]]) }));
bt = S.bestTarget(losing, OLD); ok(bt.skip === true && /money/.test(bt.why), 'a group where nothing pays is flagged to skip ' + JSON.stringify(bt));

// gates
ok(S.gateCheck({ spreadPct: 0.2 }, 3, 'FAST', {}) === 'wide spread', 'wide spread skipped');
ok(S.gateCheck({ turnoverUsd: 1e6 }, 3, 'FAST', {}) === 'thin coin', 'thin coin skipped');
ok(S.gateCheck({}, 3, 'NORMAL', {}) === null, 'class gate is off by default');
ok(S.gateCheck({}, 3, 'NORMAL', { onlyFast: true }) === 'not FAST', 'class gate when on');
ok(S.gateCheck({ movedAtr: 4 }, 3, 'FAST', { maxMovedAtr: 3 }) === 'already moved', 'moved gate when on');
ok(S.gateCheck({}, 8, 'FAST', { fastConfirmMin: 5 }) === 'slow confirmation' && S.gateCheck({}, 4, 'FAST', { fastConfirmMin: 5 }) === null, 'fast confirmation gate');
ok(S.gateCheck({ spreadPct: null, turnoverUsd: undefined }, null, null, {}) === null, 'unknown values never block');

// portfolio
const H = 3600000, T0 = Date.UTC(2026, 9, 24, 8, 0, 0);
const pf = S.portfolio([0, 1, 2, 3, 4].map(i => ({ startMs: T0 + i * 60000, endMs: T0 + 30 * 60000, side: 'Buy', usd: 5 })), { maxSameSide: 3 });
ok(pf.accepted.length === 3 && pf.skipped.crowd === 2, 'at most 3 open in one direction ' + JSON.stringify(pf.skipped));
const pf2 = S.portfolio([{ startMs: T0, endMs: T0 + 600000, side: 'Buy', usd: -150 }, { startMs: T0 + 700000, endMs: T0 + 900000, side: 'Sell', usd: -100 }, { startMs: T0 + 1000000, endMs: T0 + 1100000, side: 'Buy', usd: 50 }, { startMs: T0 + 24 * H, endMs: T0 + 24 * H + 1, side: 'Buy', usd: 10 }], { dailyLossUsd: 200 });
ok(pf2.accepted.length === 3 && pf2.skipped.dayloss === 1, 'the lane stops for the day after the loss limit; a new day starts fresh ' + JSON.stringify(pf2.skipped));
const pf3 = S.portfolio([{ startMs: T0, endMs: T0 + 1000, side: 'Buy', usd: 1 }, { startMs: T0 + 2000, endMs: T0 + 3000, side: 'Buy', usd: 1 }], { maxSameSide: 1 });
ok(pf3.accepted.length === 2, 'a finished trade no longer counts as open');

// walk-forward
const wfRows = []; for (let i = 0; i < 60; i++) wfRows.push({ side: 'Buy', signalPx: 100, ts: i, path: P([[0, 100], [1, 100.3], [3, 101.0], [8, 101.1]]) });
let wf = S.walkForward(wfRows, { fallbackTargetPct: 0.5 }); ok(wf.train && wf.validate.n >= 10, 'walk-forward runs ' + JSON.stringify(wf).slice(0, 200));
ok(S.walkForward(wfRows.slice(0, 10), {}).suggest === null && /at least 40/.test(S.walkForward(wfRows.slice(0, 10), {}).why), 'too few calls -> no suggestion');
const flip = wfRows.map((r, i) => i < 42 ? r : { ...r, path: P([[0, 100], [1, 100.3], [3, 99.0]]) });
wf = S.walkForward(flip, {}); ok(wf.suggest === null && /noise|lose/.test(wf.why), 'rules that win early but lose later are rejected ' + wf.why);

console.log('scalpmodel: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
