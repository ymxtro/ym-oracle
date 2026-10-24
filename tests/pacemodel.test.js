'use strict';
const assert = require('assert');
const PM = require('../pacemodel.js');
let n = 0; const ok = m => console.log('  ok ' + (++n) + ' ' + m);
const cfg = PM.normalize(null);
assert.strictEqual(cfg.mode, 'shadow'); ok('default is shadow');
assert.strictEqual(PM.normalize({ mode: 'x', fastAt: 10, slowAt: 90 }).fastAt, 62); ok('bad mode and crossed thresholds fall back to the defaults');
// bars: hourly bars with a range of `rng` (fraction of price) around `p`; 1-minute bars with range r1
const hour = (p, rng, n = 40, drift = 0) => Array.from({ length: n }, (_, i) => { const c = p * (1 + drift * (i - n + 1)); return { t: i * 3600000, o: c, h: c * (1 + rng / 2), l: c * (1 - rng / 2), c, v: 100 }; });
const mins = (p, rng, vol, n = 60) => Array.from({ length: n }, (_, i) => ({ t: i * 60000, o: p, h: p * (1 + rng / 2), l: p * (1 - rng / 2), c: p, v: i >= n - 15 ? vol : 10 }));
// WLFI-like short: entry 0.05386, stop 0.05499 (2.1%), hourly range ~0.8%, brisk minutes, volume up, early
const wl = PM.features({ side: 'Sell', entry: 0.05386, sl: 0.05499, bars1h: hour(0.0539, 0.008, 40, 0.0004), bars1m: mins(0.0539, 0.0012, 25), btcPct: -0.5 });
assert(wl.stopAtr > 2 && wl.stopAtr < 3.2, wl.stopAtr); assert(wl.volRatio >= 2, wl.volRatio); assert(wl.btcDir >= 0.3, wl.btcDir);
let sc = PM.score(wl, cfg); assert.strictEqual(sc.klass, 'FAST', JSON.stringify(sc)); assert(sc.hours < 8, sc.hours); ok('a tight stop, brisk minutes, volume and BTC behind it: FAST with a short estimate');
// PTB-like short: stop 16.6% away, already fell a lot
const pt = PM.features({ side: 'Sell', entry: 0.0002608, sl: 0.000304, bars1h: hour(0.00026, 0.01, 40, -0.01), bars1m: mins(0.00026, 0.002, 10), btcPct: 0 });
assert(pt.stopPct > 16); sc = PM.score(pt, cfg); assert.strictEqual(sc.klass, 'SLOW'); assert(sc.hard && /days/.test(sc.why[0]), sc.why[0]); ok('a stop 16% away is SLOW whatever else looks good (hard rule)');
assert(pt.movedAtr > 2, pt.movedAtr); ok('the move already made in the trade direction is measured (a fall counts for a short)');
// MUBARAK-like: stop 3%, quiet
const mu = PM.features({ side: 'Sell', entry: 0.052491, sl: 0.054045, bars1h: hour(0.0525, 0.006, 40, 0), bars1m: mins(0.0525, 0.0004, 8), btcPct: 0.1 });
sc = PM.score(mu, cfg); assert.notStrictEqual(sc.klass, 'FAST', JSON.stringify(sc)); ok('a quiet pair with a 3% stop is not called FAST (' + sc.klass + ', ' + sc.score + ')');
// long side: direction handling
const lg = PM.features({ side: 'Buy', entry: 100, sl: 98, bars1h: hour(100, 0.01, 40, 0.002), bars1m: mins(100, 0.001, 10), btcPct: 0.4 });
assert(lg.movedAtr > 0 && lg.btcDir > 0); const lg2 = PM.features({ side: 'Buy', entry: 100, sl: 98, bars1h: hour(100, 0.01, 40, -0.002), bars1m: mins(100, 0.001, 10), btcPct: 0.4 }); assert(lg2.movedAtr < 0); ok('long: a rise is progress, a fall is not');
assert.strictEqual(PM.features({ side: 'Buy', entry: 100, sl: 101, bars1h: [], bars1m: [] }), null); assert.strictEqual(PM.features({ side: 'Sell', entry: 100, sl: 0 }), null); ok('a stop on the wrong side or missing gives no reading');
const bare = PM.features({ side: 'Sell', entry: 100, sl: 112, bars1h: [], bars1m: [] }); sc = PM.score(bare, cfg); assert.strictEqual(sc.klass, 'SLOW'); ok('with no candles at all, a 12% stop is still SLOW');
assert(/Pace +FAST/.test(PM.lineOf({ klass: 'FAST', hours: 1.3, score: 80 })) && PM.lineOf(null) === ''); assert.strictEqual(PM.hoursText(0.5), '30 min'); assert.strictEqual(PM.hoursText(96), '4 days'); ok('the alert line and the hours text read cleanly');
// proof after entry
assert.strictEqual(PM.proof({ elapsedMin: 20, peakR: 0.45 }, cfg).state, 'fast'); assert.strictEqual(PM.proof({ elapsedMin: 20, peakR: 0.05 }, cfg).state, 'pending');
assert.strictEqual(PM.proof({ elapsedMin: 50, peakR: 0.05 }, cfg).state, 'slow'); assert.strictEqual(PM.proof({ elapsedMin: 50, peakR: 0.2 }, cfg).state, 'pending');
assert.strictEqual(PM.proof({ elapsedMin: 130, peakR: 0.3 }, cfg).state, 'slow'); assert.strictEqual(PM.proof({ elapsedMin: 45, peakR: 0.35 }, cfg).state, 'normal'); ok('proof: fast by 30 min, flat by 45 min is slow, slow again at 2 h under 0.4R, in between waits');
// labels
assert.strictEqual(PM.label({ t05Min: 20, t10Min: 90, lifeMin: 200, closed: true }, cfg), 'FAST');
assert.strictEqual(PM.label({ t05Min: null, t10Min: null, lifeMin: 500, closed: false }, cfg), 'SLOW');
assert.strictEqual(PM.label({ t05Min: 200, t10Min: 400, lifeMin: 600, closed: true }, cfg), 'NORMAL');
assert.strictEqual(PM.label({ t05Min: null, t10Min: null, lifeMin: 60, closed: true }, cfg), 'UNCLEAR');
assert.strictEqual(PM.label({ t05Min: null, t10Min: null, lifeMin: 60, closed: false }, cfg), 'OPEN'); ok('labels: FAST (+1R within 3 h), SLOW (no +0.5R in 6 h), NORMAL, UNCLEAR when it closed early, OPEN while it runs');
const t = PM.timesFromPath([{ min: 0, peakR: 0 }, { min: 10, peakR: 0.3 }, { min: 25, peakR: 0.6 }, { min: 80, peakR: 1.2 }], cfg); assert.deepStrictEqual(t, { t05Min: 25, t10Min: 80 }); ok('times to +0.5R and +1R come from the recorded path');
// reports
const rows = [{ stopPct: 2, label: 'FAST', klass: 'FAST', features: { stopPct: 2, stopAtr: 2 } }, { stopPct: 2.5, label: 'FAST', klass: 'NORMAL', features: { stopPct: 2.5, stopAtr: 3 } }, { stopPct: 12, label: 'SLOW', klass: 'SLOW', features: { stopPct: 12, stopAtr: 12 } }, { stopPct: 4, label: 'UNCLEAR', klass: 'NORMAL' }];
const b = PM.buckets(rows); assert.strictEqual(b[0].fast, 2); assert.strictEqual(b[3].slow, 1); assert.strictEqual(b[1].unclear, 1); assert.strictEqual(b[0].fastShare, 100); ok('history report: trades split by stop distance');
const s = PM.separation(rows).find(x => x.feature === 'stopPct'); assert(s.fastMedian <= 2.5 && s.slowMedian === 12); ok('separation report: medians for the FAST and SLOW groups');
const a = PM.accuracy(rows); assert.strictEqual(a.FAST.FAST, 1); assert.strictEqual(a.NORMAL.FAST, 1); assert.strictEqual(a.NORMAL.n, 1); ok('accuracy report: signal-time class against the earned label');
// observed durations
const obs = []; for (let i = 0; i < 10; i++) obs.push({ stopPct: 2, stopAtr: 2.5, t10Min: 60 + i * 10, lifeMin: 200 + i * 10, closed: true });
for (let i = 0; i < 4; i++) obs.push({ stopPct: 2, stopAtr: 2.5, t10Min: null, lifeMin: 400, closed: true });
for (let i = 0; i < 9; i++) obs.push({ stopPct: 12, stopAtr: 11, t10Min: null, lifeMin: 1500, closed: true });
const cal = PM.calibrate(obs); const g = cal.byAtr.find(x => x.name === '2-3 ranges'); assert.strictEqual(g.n, 14); assert.strictEqual(g.reached, 10); assert.strictEqual(g.reachShare, 71); assert(g.t10.p25 < g.t10.med && g.t10.med < g.t10.p75 && g.t10.med === 105, JSON.stringify(g.t10)); ok('calibration: observed time to +1R per group, with the 25th to 75th percentile range and how many got there');
let est = PM.estimate({ stopAtr: 2.5, stopPct: 2 }, cal, { hours: 3, klass: 'FAST', score: 70 }); assert.strictEqual(est.source, 'observed'); assert.strictEqual(est.n, 14);
est = PM.estimate({ stopAtr: 11, stopPct: 12 }, cal, { hours: 99, klass: 'SLOW', score: 10 }); assert.strictEqual(est.source, 'formula', 'nine trades but none reached +1R: nothing to quote, so the formula stands'); ok('estimate: a group needs 8 similar trades and 3 that reached +1R, otherwise the formula is kept');
est = PM.estimate({ stopPct: 2 }, cal, null); assert.strictEqual(est.source, 'observed'); ok('estimate: falls back to the stop-% groups when there is no hourly-range reading');
const l1 = PM.lineOfEst({ klass: 'FAST', score: 70, hours: 3 }, PM.estimate({ stopAtr: 2.5 }, cal, null)); assert(/Like it +\+1R usually in 1\.4 h to 2\.1 h \(10 of 14 similar/.test(l1) && /usually done in/.test(l1), l1);
const l2 = PM.lineOfEst({ klass: 'SLOW', score: 10, hours: 99 }, { source: 'formula', hours: 99 }); assert(/rough guess/.test(l2), l2); assert.strictEqual(PM.lineOfEst(null, null), ''); ok('the alert line quotes the observed range with its sample size, or says "rough guess"');
console.log('\nALL ' + n + ' PACE MODEL CHECKS PASSED');
