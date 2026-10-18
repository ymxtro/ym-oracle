// Unit checks for the live trade quality reading (livequality.js). Run: node tests/livequality.test.js
const assert = require('assert');
const Q = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/livequality.js' : '../livequality.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const base = { side: 'Buy', entry: 100, initialSl: 90, curSl: 90, mark: 100, peak: 100, tp: 130, atr: 2, btcPct: 0, recent: { adv: 0 } };
const A = o => Q.assess({ ...base, ...o });

assert.strictEqual(Q.assess({ side: 'Buy', entry: 0, mark: 1 }), null);
assert.strictEqual(A({ initialSl: 0, curSl: 0, atr: 0 }).band, 'unknown');
ok('no price or no way to measure the risk: no score, and it says so');

const flat = A({}); assert.strictEqual(flat.nowR, 0); assert.strictEqual(flat.parts.progress, 25); assert.strictEqual(flat.parts.protection, 25);
const win = A({ mark: 125, peak: 125, curSl: 112 });                   // 2.5R up, stop locks 1.2R
assert(win.score >= 70 && win.band === 'strong' && win.stopR > 1 && win.flags.some(f => /locked/.test(f)), JSON.stringify(win));
const losing = A({ mark: 91, peak: 101, curSl: 90, btcPct: -0.7, recent: { adv: 4 } });
assert(losing.score < 30 && losing.band === 'at risk' && losing.flags.some(f => /close to its stop/.test(f)), JSON.stringify(losing));
assert(win.score > flat.score && flat.score > losing.score);
ok('a trade 2.5R up with locked profit is strong; one at its stop with BTC against is at risk; flat sits between');

// shorts mirror longs
const sh = Q.assess({ side: 'Sell', entry: 100, initialSl: 110, curSl: 88, mark: 75, peak: 75, tp: 70, atr: 2, btcPct: 0, recent: { adv: 0 } });
assert(sh.nowR > 2.4 && sh.stopR > 1.1 && sh.band === 'strong');
ok('shorts are read the same way, mirrored');

// protection
assert.strictEqual(A({ curSl: 0 }).parts.protection, 0); assert(A({ curSl: 0 }).flags.includes('no stop on the position'));
assert(A({ curSl: 100.1, mark: 105, peak: 105 }).parts.protection > 55 && A({ curSl: 100.1, mark: 105, peak: 105 }).parts.protection < 70);
ok('protection: no stop is 0 and flagged, breakeven is about 60, more as profit is locked');

// giveback and missing readings
const gb = A({ mark: 108, peak: 130, curSl: 90 }); assert(gb.giveback > 0.7 && gb.flags.some(f => /gave back/.test(f)) && gb.parts.momentum < A({ mark: 130, peak: 130 }).parts.momentum - 30);
const nocandle = A({ atr: 0, recent: undefined, btcPct: NaN, mark: 105, peak: 105 });
assert(nocandle.score !== null && nocandle.flags.some(f => /market could not be read/.test(f)));
ok('profit given back drags momentum down and is flagged; unreadable parts are left out and named, not guessed');

// the risk basis fallback
const est = A({ initialSl: 0, curSl: 95, mark: 103, peak: 103 }); assert(est.risk === 5 && est.flags.some(f => /estimated/.test(f)));
ok('with no original stop the current stop is used as the risk basis, and the card says so');

// weights
assert.strictEqual(Object.values(Q.W).reduce((a, b) => a + b, 0), 100);
const bands = [[95, 'strong'], [70, 'strong'], [69, 'steady'], [50, 'steady'], [49, 'fragile'], [30, 'fragile'], [29, 'at risk'], [0, 'at risk']];
bands.forEach(([s, b]) => assert.strictEqual(Q.bandOf(s), b));
ok('weights sum to 100 and the band edges are 70 / 50 / 30');
console.log('PASS ' + n);
