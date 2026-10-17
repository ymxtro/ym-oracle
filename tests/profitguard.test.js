// Unit checks for the Profit Guard decision logic (profitguard.js). Run: node tests/profitguard.test.js
const assert = require('assert');
const G = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/profitguard.js' : '../profitguard.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const cfg = G.normalize({ mode: 'live' });
const sw = cfg.swing, fast = cfg.fast;
const L = (o) => G.decide({ side: 'Buy', entry: 100, initialSl: 90, curSl: 90, mark: 100, peak: 100, tick: 0.01, profile: sw, cfg, ...o });
const S = (o) => G.decide({ side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 100, peak: 100, tick: 0.01, profile: sw, cfg, ...o });

// defaults and cleaning
assert.strictEqual(G.defaults().mode, 'off');
assert.strictEqual(G.normalize(null).mode, 'off'); assert.strictEqual(G.normalize({ mode: 'bogus' }).mode, 'off');
assert.strictEqual(G.normalize({ mode: 'shadow' }).mode, 'shadow');
ok('off by default; garbage falls back safely');
const c2 = G.normalize({ pollSec: 1, minGapPct: 99, swing: { beR: 0, ladder: [[4, 0.5], [2, 0.8], [9, 0.3], ['x', 1], [1, 5]] } });
assert.strictEqual(c2.pollSec, 5); assert.strictEqual(c2.minGapPct, 0.25); assert.strictEqual(c2.swing.beR, 1);
assert.deepStrictEqual(c2.swing.ladder, [[2, 0.8], [4, 0.8], [9, 0.8]]);
ok('limits enforced, ladder sorted, a higher rung never keeps less than a lower one');

// not yet
assert.strictEqual(L({ peak: 100 }).action, 'none');
assert.strictEqual(L({ peak: 105, mark: 105 }).action, 'none');          // 0.5R, below the 1R start
ok('no action before the trade has earned 1R');

// breakeven at 1R
let d = L({ peak: 110, mark: 110 });
assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.label, 'breakeven'); assert.strictEqual(d.newSl, 100.1);
ok('1R reached: stop to breakeven plus a small fee cushion');

// ladder: swing 8R peak +80 -> keep 65% -> 152 ; example from the plan
d = L({ peak: 180, mark: 178, initialSl: 90 }); // risk 10, peak dist 80 = 8R
assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.newSl, 152); assert.strictEqual(d.keepFrac, 0.65);
ok('8R peak: keeps 65% of the best profit');
d = L({ peak: 130, mark: 129 }); // 3R -> 35% rung (2R) -> 110.5
assert.strictEqual(d.newSl, 110.5); assert.strictEqual(d.keepFrac, 0.35);
d = L({ peak: 150, mark: 149 }); // 5R -> 55% rung -> 127.5
assert.strictEqual(d.newSl, 127.5);
ok('3R and 5R peaks land on the right rungs');

// never loosens, never repeats
assert.strictEqual(L({ peak: 150, mark: 149, curSl: 130 }).action, 'none');
assert.strictEqual(L({ peak: 150, mark: 149, curSl: 127.5 }).action, 'none');
assert.strictEqual(L({ peak: 150, mark: 149, curSl: 127.45 }).action, 'none');   // gain smaller than the minimum step
ok('tighten only: a stop that is already as good is left alone');

// held back from the price
d = L({ peak: 150, mark: 127.6, curSl: 90 });   // target 127.5 but price 127.6: needs the 0.25% gap
assert.strictEqual(d.action, 'raise'); assert(d.newSl <= 127.6 * (1 - 0.0025) + 1e-9, 'gap'); assert(/held back/.test(d.label));
ok('the stop is held back from the current price by the minimum gap');

// shorts mirror longs
d = S({ peak: 20, mark: 22 });                 // peak price 20 = 8R below entry 100 (risk 10)
assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.newSl, 48); assert.strictEqual(d.keepFrac, 0.65);
assert.strictEqual(S({ peak: 90, mark: 91, curSl: 100.3 }).action, 'none');          // 1R: BE target 99.9, but cur 100.3 is within the minimum step? 99.9 <= 100.3-1
d = S({ peak: 90, mark: 91, curSl: 110 }); assert.strictEqual(d.newSl, 99.9);
ok('shorts work the same way, mirrored');

// bad inputs
assert.strictEqual(L({ initialSl: 0 }).action, 'none');
assert.strictEqual(L({ initialSl: 105 }).action, 'none');                    // "original stop" on the profit side
assert.strictEqual(L({ mark: 0 }).action, 'none');
ok('no usable original stop or price: does nothing');

// peak tracking
assert.strictEqual(G.updatePeak(100, 'Buy', 105, 100), 105); assert.strictEqual(G.updatePeak(105, 'Buy', 101, 100), 105);
assert.strictEqual(G.updatePeak(100, 'Sell', 95, 100), 95); assert.strictEqual(G.updatePeak(95, 'Sell', 99, 100), 95);
assert.strictEqual(G.updatePeak(0, 'Buy', 0, 100), 100);
ok('peak only moves in the trade\'s favour');

// clamp: a bot must never undo the guard
assert.strictEqual(G.clampStop('Buy', 120, 130), 130); assert.strictEqual(G.clampStop('Buy', 135, 130), null);
assert.strictEqual(G.clampStop('Sell', 80, 70), 70); assert.strictEqual(G.clampStop('Sell', 60, 70), null);
assert.strictEqual(G.clampStop('Buy', 0, 130), 130); assert.strictEqual(G.clampStop('Buy', '', 130), 130);
assert.strictEqual(G.clampStop('Buy', 90, 0), null);
ok('a bot\'s looser stop is held at the guard\'s floor; a tighter one passes; removing the stop is refused');

// swing bot detection
assert.deepStrictEqual(cfg.swingBots, [], 'no bot is special by default');
assert.strictEqual(G.profileOf(cfg, 'swing', 'YM ORACLE I'), 'swing'); assert.strictEqual(G.profileOf(cfg, 'fast', 'YM ORACLE IV'), 'fast');
assert.strictEqual(G.profileOf(cfg, null, 'YM ORACLE IV'), 'fast'); assert.strictEqual(G.profileOf(cfg, undefined, ''), 'fast');
assert.strictEqual(G.profileOf(G.normalize({ swingBots: ['ym oracle iii'] }), null, 'YM ORACLE III'), 'swing', 'the optional name list only matters when a signal has no engine tag');
assert.strictEqual(G.profileOf(G.normalize({ swingBots: ['ym oracle iii'] }), 'fast', 'YM ORACLE III'), 'fast');
ok('the profile comes from the trade\'s own engine tag (fast or swing), whichever bot sent it; no bot is special');
// ---- v2.7.0 ----
// per-profile mode: the overall Off is a master switch
const em = (o, p) => G.effMode(G.normalize(o), p);
assert.strictEqual(em({ mode: 'off', swing: { mode: 'live' } }, 'swing'), 'off');
assert.strictEqual(em({ mode: 'live' }, 'fast'), 'live'); assert.strictEqual(em({ mode: 'live', fast: { mode: 'shadow' } }, 'fast'), 'shadow');
assert.strictEqual(em({ mode: 'shadow', swing: { mode: 'live' } }, 'swing'), 'live'); assert.strictEqual(em({ mode: 'shadow', swing: { mode: 'live' } }, 'fast'), 'shadow');
assert.strictEqual(G.normalize({ mode: 'live', fast: { mode: 'weird' } }).fast.mode, 'inherit');
ok('modes: overall Off is a master; a profile follows it or has its own; garbage falls back to follow');

// scale-out settings and maths
assert.strictEqual(G.defaults().swing.scale.on, false);
assert.deepStrictEqual(G.normalize({ swing: { scale: { on: true, steps: [[3, 0.25], [6, 0.25]] } } }).swing.scale, { on: true, steps: [[3, 0.25], [6, 0.25]] });
assert.deepStrictEqual(G.normalize({ swing: { scale: { on: true, steps: [[3, 0.5], [6, 0.5]] } } }).swing.scale.steps, [[3, 0.25]], 'more than 70% off in total falls back: a runner always stays');
assert.deepStrictEqual(G.normalize({ swing: { scale: { steps: [[3, 0.9], [0.1, 0.2]] } } }).swing.scale.steps, []);
assert.strictEqual(G.scaleDue([[2, 0.25], [4, 0.25]], 1.9, []), -1); assert.strictEqual(G.scaleDue([[2, 0.25], [4, 0.25]], 2.5, []), 0);
assert.strictEqual(G.scaleDue([[2, 0.25], [4, 0.25]], 5, [0]), 1); assert.strictEqual(G.scaleDue([[2, 0.25]], 9, [0]), -1);
assert.strictEqual(G.sliceQty(0.1, 0.25, 0.01, 0.01), 0.02); assert.strictEqual(G.sliceQty(0.02, 0.25, 0.01, 0.01), null);
assert.strictEqual(G.sliceQty(0.03, 0.5, 0.01, 0.01), 0.01); assert.strictEqual(G.sliceQty(0.02, 1, 0.01, 0.01), null, 'must leave something tradable behind');
assert.strictEqual(G.sliceQty(1.5, 0.3, 0.1, 0.1), 0.4); assert.strictEqual(G.sliceQty(0, 0.3, 0.1, 0.1), null);
ok('scale-out: off by default, never more than 70% in total, each step once, quantity rounded down and only if both the slice and the runner stay tradable');

// re-entry recorder
const rc = G.defaults().reentry, T0 = 1_000_000;
const W = () => ({ side: 'Buy', exit: 150, peak: 200, risk: 10, extreme: 150, cand: null, expiresAt: T0 + 3600000 });
let w = W(), r = G.reentryStep(w, 140, T0, rc); assert(!r.events.length && !r.finished);
r = G.reentryStep(w, 150, T0, rc); assert(!r.events.length, 'a pullback is not a resumption');
r = G.reentryStep(w, 180, T0, rc); assert.strictEqual(r.events[0].type, 'would_reenter'); assert.strictEqual(r.events[0].stop, 140);
r = G.reentryStep(w, 220, T0, rc); assert(!r.finished && !r.events.length);            // 1R so far (risk = 180-140)
r = G.reentryStep(w, 260, T0, rc); assert.strictEqual(r.events[0].r, 2); assert(r.finished);
w = W(); G.reentryStep(w, 140, T0, rc); G.reentryStep(w, 180, T0, rc);
r = G.reentryStep(w, 139, T0, rc); assert.strictEqual(r.events[0].r, -1); assert(r.finished);
w = W(); G.reentryStep(w, 140, T0, rc); G.reentryStep(w, 180, T0, rc);
r = G.reentryStep(w, 190, T0 + 7200000, rc); assert.strictEqual(r.events[0].type, 'reentry_result'); assert.strictEqual(r.events[0].why, 'window ended'); assert(r.finished);
w = W(); r = G.reentryStep(w, 145, T0 + 7200000, rc); assert.strictEqual(r.events[0].type, 'no_reentry'); assert(r.finished);
w = { ...W(), exit: 198, extreme: 198 }; r = G.reentryStep(w, 199, T0, rc); assert(!r.events.length, 'a pullback smaller than the minimum is ignored');
const ws = { side: 'Sell', exit: 50, peak: 0, risk: 10, extreme: 50, cand: null, expiresAt: T0 + 1e6 };   // a short that fell from 100 to 0, bounced then resumes down
G.reentryStep(ws, 60, T0, rc); r = G.reentryStep(ws, 30, T0, rc); assert.strictEqual(r.events[0].type, 'would_reenter'); assert.strictEqual(r.events[0].stop, 60);
ok('re-entry recorder: needs a real pullback, fires on the resume, ends on +target / stop / window, works for shorts');

// ---- smart layer (final-17c) ----
assert.strictEqual(G.normalize({}).smart.tune.mode, 'suggest'); assert.strictEqual(G.normalize({ smart: { tune: { mode: 'bogus', step: 9 } } }).smart.tune.mode, 'suggest'); assert.strictEqual(G.normalize({ smart: { tune: { step: 9 } } }).smart.tune.step, 0.05);
assert.strictEqual(G.normalize({ smart: { noise: { on: false } } }).smart.noise.on, false);
ok('smart settings: sensible defaults, junk falls back, can be switched off');
// breathing room: swing trade, peak 130 (3R), price pulled back to 118, so this trade has wobbled 12. Plain rule keeps 35% of 30 -> 110.5.
const wob = G.updatePull(0, 'Buy', 130, 118);                                  // this trade dipped 12 below its best
assert.strictEqual(wob, 12); assert.strictEqual(G.updatePull(wob, 'Buy', 130, 125), 12); assert.strictEqual(G.updatePull(0, 'Sell', 70, 82), 12);
const nz = G.noiseOf(cfg, wob); assert.deepStrictEqual(nz, { noisePrice: 12, noiseCapR: 1.5 }); assert.deepStrictEqual(G.noiseOf(G.normalize({ smart: { noise: { on: false } } }), wob), {});
let d0 = L({ peak: 130, mark: 118, curSl: 90 }); assert(d0.action === 'raise' && Math.abs(d0.newSl - 110.5) < 0.011, 'plain: ' + d0.newSl);
let dn = L({ peak: 130, mark: 118, curSl: 90, smart: nz }); assert(dn.action === 'raise' && Math.abs(dn.newSl - 106) < 0.011 && /breathing room/.test(dn.label), 'held 12 below the price: ' + dn.newSl + ' ' + dn.label);
let dn2 = L({ peak: 130, mark: 118, curSl: 90, smart: { noisePrice: 500, noiseCapR: 1.5 } }); assert(Math.abs(dn2.newSl - 103) < 0.011, 'wobble capped at 1.5R (15): ' + dn2.newSl);
assert.strictEqual(L({ peak: 130, mark: 118, curSl: 108, smart: nz }).action, 'none');                    // already tighter than what breathing room allows: left alone, never loosened
let ds = S({ peak: 70, mark: 82, curSl: 110, smart: G.noiseOf(cfg, G.updatePull(0, 'Sell', 70, 82)) }); assert(ds.action === 'raise' && Math.abs(ds.newSl - 94) < 0.011, 'short: ' + ds.newSl);
ok('breathing room: a stop is held at least the trade\'s own largest pullback (capped at 1.5R) from the price; works for shorts; never loosens');
// stall tightening
const T1 = 1e12, fm = 30 * 60000;
assert.strictEqual(G.stallExtra(cfg, 'fast', T1 + fm - 1, T1), 0); assert.strictEqual(G.stallExtra(cfg, 'fast', T1 + fm, T1), 0.10); assert.strictEqual(G.stallExtra(cfg, 'fast', T1 + 9 * fm, T1), 0.20);
assert.strictEqual(G.stallExtra(cfg, 'swing', T1 + fm, T1), 0); assert.strictEqual(G.stallExtra(cfg, 'swing', T1 + 360 * 60000, T1), 0.10);
assert.strictEqual(G.stallExtra(G.normalize({ smart: { stall: { on: false } } }), 'fast', T1 + 9 * fm, T1), 0); assert.strictEqual(G.stallExtra(cfg, 'fast', T1 + 9 * fm, 0), 0);
let dst0 = L({ peak: 115, mark: 114, curSl: 90 }), dst1 = L({ peak: 115, mark: 114, curSl: 90, smart: { stallExtra: 0.10 } });   // 1.5R: between breakeven and the first swing rung
assert(Math.abs(dst0.newSl - 100.1) < 0.011); assert(/stalled/.test(dst1.label) && Math.abs(dst1.newSl - 101.5) < 0.011, 'a stalled trade at 1.5R locks 10% of its best: ' + dst1.newSl);
let dst2 = L({ peak: 130, mark: 129, curSl: 90, smart: { stallExtra: 0.10 } }); assert(Math.abs(dst2.newSl - 113.5) < 0.011, 'rung 35% + 10 pts = 45% of 30 = 13.5 above entry: ' + dst2.newSl);
ok('stall tightening: nothing until a full period passes with no new best, then +10 pts per period up to +20; off switch works; never past 90% kept');
// tuning
const mk = (n, giveback, peakR) => Array.from({ length: n }, () => ({ peak_pct: 10, exit_pct: 10 - giveback, giveback_pct: giveback, peak_r: peakR }));
let t0 = G.suggestTuning(cfg, 'swing', mk(5, 7, 3), null); assert.strictEqual(t0.ready, false); assert(/more closed/.test(t0.reasons[0]));
let t1 = G.suggestTuning(cfg, 'swing', mk(25, 7, 3), null); assert(t1.ready && t1.action === 'tighten' && t1.changes.length === 3 && Math.abs(t1.next[0][1] - 0.40) < 1e-9 && Math.abs(t1.next[2][1] - 0.70) < 1e-9, JSON.stringify(t1));
let t2 = G.suggestTuning(cfg, 'swing', mk(25, 3.5, 3), null); assert.strictEqual(t2.action, 'hold');
let t3 = G.suggestTuning(cfg, 'swing', mk(25, 1, 3), { done: 12, wins: 9, avg_r: 0.8 }); assert.strictEqual(t3.action, 'loosen'); assert(Math.abs(t3.next[0][1] - 0.30) < 1e-9);
assert.strictEqual(G.suggestTuning(cfg, 'swing', mk(25, 1, 3), { done: 12, wins: 3, avg_r: -0.2 }).action, 'hold');
assert.strictEqual(G.suggestTuning(cfg, 'swing', mk(25, 7, 1.2), null).ready, false);                                    // trades that never reached the first step do not count
const capped = G.normalize({ swing: { ladder: [[2, 0.84], [4, 0.85], [8, 0.85]] } }); let t4 = G.suggestTuning(capped, 'swing', mk(25, 7, 3), null); assert(t4.next.every(x => x[1] <= 0.85) && t4.changes.length === 1);
const tl = G.normalize({ smart: { tune: { lastAtN: { swing: 20 } } } }); assert.strictEqual(G.suggestTuning(tl, 'swing', mk(25, 7, 3), null).since, 5);
ok('tuning: waits for enough live trades, tightens when profit is handed back, loosens only when re-entries show the guard left too early, stays within 15-85%, keeps rungs in order');
console.log('PASS ' + n);
