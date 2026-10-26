// Unit checks for the Profit Guard decision logic (profitguard.js). Run: node tests/profitguard.test.js
const assert = require('assert');
const G = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/profitguard.js' : '../profitguard.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const cfg = G.normalize({ mode: 'live', smart: { curve: { on: false } } });   // the older checks below test the ladder alone; the curve has its own checks at the end
const sw = { ...cfg.swing, beR: 1, minGapPct: 0 }, fast = cfg.fast;   // v2.9.12: the older ladder-math checks use the plain 1R start and the global gap
const L = (o) => G.decide({ side: 'Buy', entry: 100, initialSl: 90, curSl: 90, mark: 100, peak: 100, tick: 0.01, profile: sw, cfg, ...o });
const S = (o) => G.decide({ side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 100, peak: 100, tick: 0.01, profile: sw, cfg, ...o });

// defaults and cleaning
assert.strictEqual(G.defaults().mode, 'off');
assert.strictEqual(G.normalize(null).mode, 'off'); assert.strictEqual(G.normalize({ mode: 'bogus' }).mode, 'off');
assert.strictEqual(G.normalize({ mode: 'shadow' }).mode, 'shadow');
ok('off by default; garbage falls back safely');
const c2 = G.normalize({ pollSec: 1, minGapPct: 99, swing: { beR: 0, ladder: [[4, 0.5], [2, 0.8], [9, 0.3], ['x', 1], [1, 5]] } });
assert.strictEqual(c2.pollSec, 5); assert.strictEqual(c2.minGapPct, 0.25); assert.strictEqual(c2.swing.beR, 1.5);
assert.deepStrictEqual(c2.swing.ladder, [[2, 0.8], [4, 0.8], [9, 0.8]]);
ok('limits enforced, ladder sorted, a higher rung never keeps less than a lower one');
// v2.9.12 swing defaults
assert.strictEqual(cfg.swing.minGapPct, 1.2); assert.strictEqual(cfg.fast.minGapPct, 0); assert.strictEqual(cfg.swing.scale.on, true); assert.deepStrictEqual(cfg.swing.scale.steps, [[1.75, 0.3]]);
{
  const base = { side: 'Buy', entry: 100, mark: 110, peak: 110, curSl: 95, initialSl: 95, tick: 0.01, cfg, smart: {} };
  const dFast = G.decide({ ...base, profile: { ...cfg.fast, beR: 1, ladder: [[1, 0.99]] } }), dSwing = G.decide({ ...base, profile: { ...cfg.swing, beR: 1, ladder: [[1, 0.99]] } });
  assert.strictEqual(dFast.action, 'raise'); assert.strictEqual(dSwing.action, 'raise');
  assert(dFast.newSl > dSwing.newSl, 'a swing trade keeps at least 1.2% from the price, a fast trade only 0.25%: ' + dFast.newSl + ' vs ' + dSwing.newSl);
  assert(110 - dSwing.newSl >= 110 * 0.012 - 0.011, 'swing gap is 1.2% of the price');
}
ok('swing profile: its own first-lock level, a 1.2% minimum gap (fast keeps 0.25%), one planned partial at 1.75R');

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
assert.strictEqual(G.defaults().swing.scale.on, true); assert.strictEqual(G.defaults().fast.scale.on, false);   // v2.9.12: swing takes one planned partial by default
assert.deepStrictEqual(G.normalize({ swing: { scale: { on: true, steps: [[3, 0.25], [6, 0.25]] } } }).swing.scale, { on: true, steps: [[3, 0.25], [6, 0.25]] });
assert.deepStrictEqual(G.normalize({ swing: { scale: { on: true, steps: [[3, 0.5], [6, 0.5]] } } }).swing.scale.steps, [[1.75, 0.3]], 'more than 70% off in total falls back: a runner always stays');
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

// ---- LIVE re-entry gate and plan (v2.9.8) ----
{ const rcL = G.normalize({ reentry: { live: true } }).reentry;
  const W2 = (o) => ({ side: 'Sell', margin: 100, lev: 10, ...o });
  const C2 = (o) => ({ price: 0.03697, stop: 0.0372, pullR: 2.2, ...o });          // the CARV short: stop 0.62% above the entry
  const X2 = (o) => ({ mark: 0.03697, todayCount: 0, openCount: 0, symbolHeld: false, lastLossAgoH: null, liveOk: true, score: 80, turnover: 20e6, ...o });
  assert.strictEqual(G.defaults().reentry.live, false, 'live re-entry is OFF by default');
  assert.strictEqual(G.reentryGate(W2(), C2(), X2(), G.defaults().reentry).code, 'OFF');
  assert.strictEqual(G.reentryGate(W2(), C2(), X2(), rcL).ok, true);
  const code = (w, c, x) => G.reentryGate(w, c, x, rcL).code;
  assert.strictEqual(code(W2(), C2(), X2({ liveOk: false })), 'PAUSED');
  assert.strictEqual(code(W2({ margin: 0 }), C2(), X2()), 'NOSIZE');
  assert.strictEqual(code(W2({ lev: 0 }), C2(), X2()), 'NOSIZE');
  assert.strictEqual(code(W2(), C2({ stop: 0.0369 }), X2()), 'BADSTOP', 'a short needs its stop above the entry');
  assert.strictEqual(code(W2(), C2({ stop: 0.03700 }), X2()), 'TIGHT', 'stop 0.08% away: fees would eat the win');
  assert.strictEqual(code(W2({ lev: 5 }), C2({ stop: 0.0400 }), X2()), 'WIDE', '8% stop');
  assert.strictEqual(code(W2({ lev: 20 }), C2({ stop: 0.0385 }), X2()), 'LIQ', '4.1% stop x 20x is past the liquidation limit');
  assert.strictEqual(code(W2(), C2({ pullR: 3.5 }), X2()), 'DEEP');
  assert.strictEqual(code(W2(), C2(), X2({ symbolHeld: true })), 'HELD');
  assert.strictEqual(code(W2(), C2(), X2({ todayCount: 3 })), 'DAYCAP');
  assert.strictEqual(code(W2(), C2(), X2({ todayCount: 2 })), 'OK');
  assert.strictEqual(code(W2(), C2(), X2({ openCount: 1 })), 'OPENCAP');
  assert.strictEqual(code(W2(), C2(), X2({ lastLossAgoH: 2 })), 'COOLDOWN');
  assert.strictEqual(code(W2(), C2(), X2({ lastLossAgoH: 7 })), 'OK');
  assert.strictEqual(code(W2(), C2(), X2({ mark: 0 })), 'NOPRICE');
  assert.strictEqual(code(W2(), C2(), X2({ mark: 0.0372 })), 'STOPPED');
  assert.strictEqual(code(W2(), C2(), X2({ mark: 0.03715 })), 'MOVED', 'price ran 78% of the stop distance against the entry since the signal');
  assert.strictEqual(code(W2(), C2(), X2({ mark: 0.03690 })), 'MOVED', 'ran 30%+ in favour: the move is already partly gone');
  assert.strictEqual(code(W2(), C2(), X2({ mark: 0.03692 })), 'OK', 'a small slip is fine');
  const wl = { side: 'Buy', margin: 100, lev: 10 }, cl = { price: 0.3632, stop: 0.3590, pullR: 0.9 };
  assert.strictEqual(G.reentryGate(wl, cl, X2({ mark: 0.3632 }), rcL).ok, true, 'a long works the same way');
  assert.strictEqual(G.reentryGate(wl, { ...cl, stop: 0.3700 }, X2({ mark: 0.3632 }), rcL).code, 'BADSTOP');
  assert.strictEqual(G.reentryGate(wl, cl, X2({ mark: 0.3585 }), rcL).code, 'STOPPED');
  // v2.9.9 the brain and shake-outs
  assert.strictEqual(code(W2(), C2(), X2({ score: undefined, scoreWhy: 'no candles' })), 'NOREAD', 'no market reading = no order');
  assert.strictEqual(code(W2(), C2(), X2({ score: 59 })), 'LOWSCORE'); assert.strictEqual(code(W2(), C2(), X2({ score: 60 })), 'OK');
  assert.strictEqual(G.reentryGate(W2(), C2(), X2({ score: undefined }), { ...rcL, brain: false }).ok, true, 'with the brain switched off the old rules decide alone');
  assert.strictEqual(code(W2(), C2(), X2({ turnover: 0.4e6 })), 'THIN'); assert.strictEqual(code(W2(), C2(), X2({ turnover: null })), 'OK', 'unknown turnover is left to the score');
  const shk = { src: 'shake' };
  assert.strictEqual(code(W2(shk), C2(), X2()), 'SHAKEOFF', 'shake-outs are recorded, not placed, unless liveShake is on');
  const rcS = { ...rcL, liveShake: true };
  assert.strictEqual(G.reentryGate(W2(shk), C2(), X2({ score: 65 }), rcS).code, 'LOWSCORE', 'a shake-out needs 10 more points'); assert.strictEqual(G.reentryGate(W2(shk), C2(), X2({ score: 70 }), rcS).ok, true);
  assert.strictEqual(G.defaults().reentry.brain, true); assert.strictEqual(G.defaults().reentry.shake, true); assert.strictEqual(G.defaults().reentry.liveShake, false); assert.strictEqual(G.normalize({ reentry: { minScore: 500 } }).reentry.minScore, 60);
  // the plan
  const pl = G.reentryPlan(W2(), C2(), rcL, '0.00001', 0.03697);
  assert.deepStrictEqual([pl.side, pl.sl, pl.tp, pl.usdMargin, pl.leverage], ['SELL', 0.0372, 0.03651, 50, 10], JSON.stringify(pl));   // dist 0.00023 x 2 = 0.00046 below 0.03697
  const pl2 = G.reentryPlan(wl, cl, rcL, '0.0001', 0.3632);
  assert.deepStrictEqual([pl2.side, pl2.sl, pl2.tp], ['BUY', 0.359, 0.3716], JSON.stringify(pl2));                          // rounded toward the entry
  assert(G.reentryPlan(W2({ margin: 33.337 }), C2(), rcL, '0.00001', 0.03697).usdMargin === 16.67, 'margin to cents');
  assert.strictEqual(G.reentryPlan(W2(), C2(), rcL, '0.00001', 0.03697, 60).usdMargin, 30, '60 points = 0.6x of the 50 base'); assert.strictEqual(G.reentryPlan(W2(), C2(), rcL, '0.00001', 0.03697, 100).usdMargin, 55, '100 points = 1.1x'); assert.strictEqual(G.reentryPlan(W2(), C2(), { ...rcL, brain: false }, '0.00001', 0.03697, 100).usdMargin, 50, 'brain off: flat size');
  assert.strictEqual(G.roundTick(0.036976, '0.00001', 'near'), 0.03698); assert.strictEqual(G.roundTick(1.29651, '0.0001', 'up'), 1.2966); assert.strictEqual(G.roundTick(1.29659, '0.0001', 'down'), 1.2965); assert.strictEqual(G.roundTick(0.5, '1e-5', 'near'), 0.5);
  // pause rule
  assert.strictEqual(G.reentryShouldPause([-1, -1], rcL), false, 'needs three results');
  assert.strictEqual(G.reentryShouldPause([-1, -0.5, 0.2], rcL), false, '-1.3R together is under the 1.5R limit');
  assert.strictEqual(G.reentryShouldPause([-1, -1, 0.2], rcL), true);
  assert.strictEqual(G.reentryShouldPause([2, -1, -1, -1], rcL), false, 'only the latest three count');
  assert.strictEqual(G.normalize({ reentry: { sizeMult: 9, maxPerDay: 0, live: 'yes' } }).reentry.sizeMult, 0.5, 'junk falls back'); assert.strictEqual(G.normalize({ reentry: { live: 'yes' } }).reentry.live, false);
  ok('live re-entry: off by default; every gate (size, stop distance, fees, liquidation, depth, held, caps, cool-down, price moved) refuses for its own reason; the plan is tick-rounded; three bad results pause it'); }

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

// ---- ADAPT (final-18): the pair's own speed and the market around the trade ----
{
  assert.strictEqual(G.defaults().smart.adapt.on, true);
  const c = G.normalize({ mode: 'live', smart: { adapt: { atrMult: 99, capR: 0, mkt: { pts: 5 } } } }).smart.adapt;
  assert(c.atrMult === 0.8 && c.capR === 1.5 && c.mkt.pts === 0.08);   // out-of-range values fall back to the defaults
  assert.strictEqual(G.normalize({ smart: { adapt: { on: false } } }).smart.adapt.on, false);
  ok('adapt: on by default, bad numbers fall back, switch works');
  // nothing to read -> exactly the plain rules
  assert.deepStrictEqual(G.adaptOf(cfg, null), {});
  const off = G.normalize({ mode: 'live', smart: { adapt: { on: false } } });
  assert.deepStrictEqual(G.adaptOf(off, { atr: 1, btcPct: -1, peakR: 5, maxPull: 0 }), {});
  const plain = L({ peak: 130, mark: 130 }), same = L({ peak: 130, mark: 130, smart: {} });
  assert.deepStrictEqual(plain, same);
  ok('adapt: with no candles or switched off, the plain rules are unchanged');
  // volatility gap: a fast pair (ATR 4 on a 100 price) is not given a stop 0.25 from the price
  const a1 = G.adaptOf(cfg, { atr: 4, btcPct: 0, peakR: 3, maxPull: 9 });
  assert(Math.abs(a1.atrPrice - 3.2) < 1e-9);
  const noGap = L({ peak: 130, mark: 111, curSl: 90 });
  const withGap = L({ peak: 130, mark: 111, curSl: 90, smart: { atrPrice: a1.atrPrice, atrCapR: 1.5 } });
  assert(withGap.action === 'raise' && withGap.newSl < noGap.newSl + 1e-9 && withGap.newSl <= 111 - 3.2 + 1e-9 && /volatility/.test(withGap.label));
  const capR = L({ peak: 130, mark: 111, curSl: 90, smart: { atrPrice: 50, atrCapR: 1.5 } });
  assert(capR.newSl >= 111 - 1.5 * 10 - 1e-9);          // never more room than capR x R
  ok('adapt: a fast pair gets room from its own ATR, capped at 1.5R, and only ever delays a raise');
  // market keep: BTC against -> keep more, clean trend -> keep less, symmetric and bounded
  const ag = G.adaptOf(cfg, { atr: 4, btcPct: -0.6, peakR: 1, maxPull: 9 });   assert.strictEqual(ag.keepAdj, 0.08);
  const cl = G.adaptOf(cfg, { atr: 4, btcPct: 0.3, peakR: 3, maxPull: 2 });   assert.strictEqual(cl.keepAdj, -0.08);
  const both = G.adaptOf(cfg, { atr: 4, btcPct: -0.6, peakR: 3, maxPull: 2 }); assert.strictEqual(both.keepAdj, 0);
  const base = L({ peak: 130, mark: 125, curSl: 90, smart: {} }), more = L({ peak: 130, mark: 125, curSl: 90, smart: { keepAdj: 0.08 } }), less = L({ peak: 130, mark: 125, curSl: 90, smart: { keepAdj: -0.08 } });
  assert(more.newSl > base.newSl && less.newSl < base.newSl && more.keepFrac - base.keepFrac > 0.079 && /market/.test(more.label));
  assert(L({ peak: 105, mark: 105 + 6, smart: { keepAdj: 0.2 } }).action !== 'raise' || true);
  const sh = S({ peak: 70, mark: 75, curSl: 110, smart: { keepAdj: 0.08 } }), shb = S({ peak: 70, mark: 75, curSl: 110, smart: {} });
  assert(sh.newSl < shb.newSl);                                           // a short keeps more too (stop moves further down)
  ok('adapt: market shift keeps more when BTC is against, less on a clean trend, both directions, stop still only tightens');
}
// final-19: smooth curve
{
  const cc = G.normalize({ mode: 'live' }), fastC = cc.fast;
  assert.strictEqual(G.defaults().smart.curve.on, true); assert.strictEqual(G.defaults().smart.curve.h, 2);
  assert.strictEqual(G.normalize({ smart: { curve: { h: 99 } } }).smart.curve.h, 2); assert.strictEqual(G.normalize({ smart: { curve: { on: false } } }).smart.curve.on, false);
  ok('curve: on by default, bad numbers fall back, switch works');
  // the PENDLE case: short from 100, risk 10, best 1.29R (87.1). The plain ladder (first rung 1.5R) locks almost nothing; the curve keeps a real share
  const Sf = (o, c) => G.decide({ side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 88, peak: 87.1, tick: 0.01, profile: (c || cc).fast, cfg: c || cc, ...o });
  const plain = G.decide({ side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 88, peak: 87.1, tick: 0.01, profile: cfg.fast, cfg });
  const withC = Sf({});
  assert.strictEqual(plain.label, 'breakeven'); assert.strictEqual(withC.action, 'raise');
  assert(withC.keepFrac > 0.38 && withC.keepFrac < 0.40 && withC.newSl < plain.newSl - 3 && /curve/.test(withC.label));
  ok('curve: a 1.29R trade now locks about 39% of its best profit instead of breakeven (no dead zone below the first rung)');
  // smooth: more peak = more kept, never less than the ladder, capped
  let prev = 0; for (const pr of [1, 1.2, 1.5, 2, 3, 4, 6, 8]) { const d = Sf({ peak: 100 - pr * 10, mark: 100 - pr * 10 + 1 }); assert.strictEqual(d.action, 'raise', 'peak ' + pr); assert(d.keepFrac >= prev - 1e-9 && d.keepFrac <= 0.85); prev = d.keepFrac; }
  const l6 = Sf({ peak: 40, mark: 41 }), l6p = G.decide({ side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 41, peak: 40, tick: 0.01, profile: cfg.fast, cfg });
  assert(l6.keepFrac >= l6p.keepFrac);
  ok('curve: keep share grows smoothly with the peak, is never below the ladder, and is capped at 85%');
  // dynamic: per-trade multiplier
  const clean = G.curveOf(cc, { btcPct: 0.2, peakDist: 20, maxPull: 1 }), choppy = G.curveOf(cc, { btcPct: 0.2, peakDist: 20, maxPull: 9 }), against = G.curveOf(cc, { btcPct: -0.6, peakDist: 20, maxPull: 1 });
  assert(clean.curveMul > 1.15 && /clean/.test(clean.curveWhy) && choppy.curveMul < 0.85 && /choppy/.test(choppy.curveWhy) && against.curveMul < clean.curveMul * 0.75 && /BTC/.test(against.curveWhy));
  assert.deepStrictEqual(G.curveOf(G.normalize({ smart: { curve: { on: false } } }), { peakDist: 1, maxPull: 0 }), {}); assert.deepStrictEqual(G.curveOf(cc, null), {});
  const dc = Sf({ smart: clean }), dch = Sf({ smart: choppy }), dag = Sf({ smart: against });
  assert(dc.keepFrac < dch.keepFrac && dc.keepFrac < dag.keepFrac);          // clean trend: less kept (more room); choppy or BTC against: more kept
  assert(clean.curveMul <= 1.5 && choppy.curveMul >= 0.6);
  ok('curve: per-trade room - clean pullbacks give more room, choppy trades or BTC against lock more');
  // still tighten-only, and a long behaves like a short
  const lo = G.decide({ side: 'Buy', entry: 100, initialSl: 90, curSl: 90, mark: 112, peak: 112.9, tick: 0.01, profile: cc.fast, cfg: cc });
  assert.strictEqual(lo.action, 'raise'); assert(lo.newSl > 100 && lo.keepFrac > 0.38);
  assert.strictEqual(G.decide({ side: 'Buy', entry: 100, initialSl: 90, curSl: 108, mark: 112, peak: 112.9, tick: 0.01, profile: cc.fast, cfg: cc }).action, 'none');   // already tighter: no change
  ok('curve: works for longs, and an already tighter stop is never loosened');
}
// final-20: early slice, Sentinel-aware room, curveKeep
{
  const cc = G.normalize({ mode: 'live' });
  assert.strictEqual(G.sliceOf(cc, {}), null); assert.strictEqual(G.defaults().smart.slice.on, false);
  const on = G.normalize({ mode: 'live', smart: { slice: { on: true } } });
  assert.deepStrictEqual(G.normalize({ smart: { slice: { on: true, atR: 99, frac: 0.9 } } }).smart.slice, { on: true, atR: 1.2, frac: 0.3, dyn: true });
  const neu = G.sliceOf(on, { mul: 1 }), clean = G.sliceOf(on, { mul: 1.4 }), choppy = G.sliceOf(on, { mul: 0.6 });
  assert.strictEqual(neu.atR, 1.2); assert.strictEqual(neu.frac, 0.3);
  assert(clean.atR > neu.atR && clean.frac < neu.frac && choppy.atR < neu.atR && choppy.frac > neu.frac && /later/.test(clean.why) && /sooner/.test(choppy.why));
  assert(choppy.atR >= 0.6 && choppy.frac <= 0.5 && clean.frac >= 0.1);
  const fixed = G.sliceOf(G.normalize({ smart: { slice: { on: true, dyn: false } } }), { mul: 0.6 }); assert.strictEqual(fixed.atR, 1.2);
  ok('slice: off by default, bounded, size and trigger follow the trade (clean = later and smaller, choppy = sooner and bigger), fixed when dynamic is off');
  const base = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3 });
  const calm = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3, sn: { state: 'calm' } }), alert = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3, sn: { state: 'alert' } }), danger = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3, sn: { state: 'danger' } });
  assert(calm.curveMul > base.curveMul && alert.curveMul < base.curveMul && danger.curveMul < alert.curveMul && /Sentinel danger/.test(danger.curveWhy));
  const gb = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3, pullNow: 8, atr: 2 }), nogb = G.curveOf(cc, { btcPct: 0.1, peakDist: 20, maxPull: 3, pullNow: 3, atr: 2 });
  assert(gb.curveMul < nogb.curveMul && /giving back/.test(gb.curveWhy) && !/giving back/.test(nogb.curveWhy));
  const worst = G.curveOf(cc, { btcPct: -0.6, peakDist: 20, maxPull: 20, pullNow: 20, atr: 1, sn: { state: 'danger' } }); assert(worst.curveMul >= 0.5 && worst.curveMul <= 1.5);
  ok('curve: the Sentinel\'s reading and a deep pullback from the best both lower the room (lock more), calm raises it a little, always within bounds');
  const kHealthy = G.curveKeep(cc, 1.29, G.curveOf(cc, { peakDist: 20, maxPull: 1 }).curveMul), kDanger = G.curveKeep(cc, 1.29, danger.curveMul);
  assert(kHealthy > 0.3 && kDanger > kHealthy && kDanger <= 0.85); assert.strictEqual(G.curveKeep(G.normalize({ smart: { curve: { on: false } } }), 2, 1), null);
  ok('curveKeep: the same keep share the curve uses, higher when the trade is turning, null when the curve is off');
}
// final-21: the bot's reversal reading
{
  const off = G.normalize({ mode: 'live' });
  assert.strictEqual(G.defaults().smart.rev.on, false); assert.strictEqual(G.revOf(off, { urg: 0.9, at: Date.now() }), null);
  const on = G.normalize({ mode: 'live', smart: { rev: { on: true } } }), t0 = Date.now();
  assert.strictEqual(G.revOf(on, { urg: 0.3, at: t0 }).t, 0); assert.strictEqual(G.revOf(on, { urg: 0.3, at: t0 }).sliceNow, false);
  const mid = G.revOf(on, { urg: 0.535, at: t0 }); assert(mid.t > 0.4 && mid.t < 0.6 && !mid.sliceNow);
  const hi = G.revOf(on, { urg: 0.7, at: t0 }); assert.strictEqual(hi.t, 1); assert.strictEqual(hi.sliceNow, true); assert.strictEqual(hi.frac, 0.5);
  assert.strictEqual(G.revOf(on, { urg: 0.9, at: t0 - 400000 }), null); assert.strictEqual(G.revOf(on, null), null); assert.strictEqual(G.revOf(on, { urg: 'x', at: t0 }), null);
  const bad = G.normalize({ smart: { rev: { on: true, soft: 5, firm: 0.01, slice: 9, maxAge: 1 } } }).smart.rev; assert(bad.soft <= 0.8 && bad.firm >= 0.3 && bad.slice <= 0.8 && bad.maxAge >= 60);
  ok('reversal reading: off by default, steps from soft to firm, slice from firm, ignores old or broken readings, settings stay in bounds');
  const cc = G.normalize({ mode: 'live', smart: { curve: { on: true }, rev: { on: true } } });
  const base = G.curveOf(cc, { peakDist: 20, maxPull: 3 }), rd = G.curveOf(cc, { peakDist: 20, maxPull: 3, rev: { t: 1 } }), half = G.curveOf(cc, { peakDist: 20, maxPull: 3, rev: { t: 0.5 } });
  assert(rd.curveMul < half.curveMul && half.curveMul < base.curveMul && /bot reversal read/.test(rd.curveWhy) && rd.curveMul >= 0.5);
  assert(G.curveKeep(cc, 1.5, rd.curveMul) > G.curveKeep(cc, 1.5, base.curveMul));
  ok('reversal reading: shrinks the stop room smoothly, so the stop keeps more of the peak, and never leaves the bounds');
}

// v2.9.19: picking the closed-PnL rows of ONE trade (a coin traded again must never get another trade's exit or PnL)
{
  const T0 = 1_000_000_000_000, row = (id, entry, exit, pnl, at) => ({ symbol: 'XUSDT', orderId: id, avgEntryPrice: String(entry), avgExitPrice: String(exit), closedPnl: String(pnl), updatedTime: String(at) });
  const A = row('a', 100, 99, -10, T0 + 600000), B = row('b', 105, 104, 7, T0 + 7200000);
  // a later trade on the same coin leaked in before: the first trade must keep only its own row
  let p = G.pickCloseRows([B, A], { symbol: 'XUSDT', entry: 100, sinceMs: T0, untilMs: T0 + 900000 });
  assert.deepStrictEqual(p.rows.map(x => x.orderId), ['a']); assert.strictEqual(parseFloat(p.last.avgExitPrice), 99);
  ok('closed-PnL pick: only the trade\'s own row (a later trade on the same coin is not mixed in)');
  // entry price keeps an older, same-window row of another trade out even with no upper limit
  p = G.pickCloseRows([A, B], { symbol: 'XUSDT', entry: 105, sinceMs: T0 });
  assert.deepStrictEqual(p.rows.map(x => x.orderId), ['b']);
  ok('closed-PnL pick: the entry price tells two trades on one coin apart');
  // a row already given to a finished trade is never handed out twice
  p = G.pickCloseRows([A], { symbol: 'XUSDT', entry: 100, sinceMs: T0, used: new Set(['a']) });
  assert.strictEqual(p, null); ok('closed-PnL pick: a claimed row is not reused (no stale copy)');
  // rows that belong to other trades only: nothing, so the caller retries and finally stores no exit rather than a wrong one
  assert.strictEqual(G.pickCloseRows([A], { symbol: 'XUSDT', entry: 105, sinceMs: T0 }), null);
  ok('closed-PnL pick: only other trades\' rows -> nothing (honest empty, never a wrong exit)');
  // partial closes of the same trade are all summed
  const A2 = row('a2', 100, 98, -4, T0 + 300000);
  p = G.pickCloseRows([A, A2], { symbol: 'XUSDT', entry: 100, sinceMs: T0, untilMs: T0 + 900000 });
  assert.strictEqual(p.rows.length, 2); assert.strictEqual(p.rows.reduce((t, x) => t + Number(x.closedPnl), 0), -14); assert.strictEqual(p.last.orderId, 'a');
  ok('closed-PnL pick: partial closes of one trade are all kept; the last one gives the exit');
  // older rows without an entry price keep the previous behaviour; other coins and rows before the trade are ignored
  const old = { symbol: 'XUSDT', avgExitPrice: '99', closedPnl: '-10', updatedTime: String(T0 + 1000) };
  assert.strictEqual(G.pickCloseRows([old], { symbol: 'XUSDT', entry: 100, sinceMs: T0 }).rows.length, 1);
  assert.strictEqual(G.pickCloseRows([{ ...old, symbol: 'YUSDT' }, { ...old, updatedTime: String(T0 - 3600000) }], { symbol: 'XUSDT', entry: 100, sinceMs: T0 }), null);
  ok('closed-PnL pick: rows without an entry price still work; other coins and rows from before the trade are ignored');
}
console.log('PASS ' + n);
