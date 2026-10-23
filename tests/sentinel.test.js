// Unit checks for the Trade Sentinel logic (sentinel.js). Run: node tests/sentinel.test.js
const assert = require('assert');
const S = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/sentinel.js' : '../sentinel.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const cfg = S.normalize({ mode: 'live' });

// ---- config ----
assert.strictEqual(S.defaults().mode, 'off'); assert.strictEqual(S.normalize(null).mode, 'off'); assert.strictEqual(S.normalize({ mode: 'x' }).mode, 'off');
const c2 = S.normalize({ th: { watch: 80, alert: 50, danger: 40 }, weights: { vel: 1000, giveback: 'x' }, limits: { maxMoves: 99 } });
assert(c2.th.watch < c2.th.alert && c2.th.alert < c2.th.danger); assert(Math.abs(Object.values(c2.weights).reduce((a, b) => a + b, 0) - 100) < 1); assert.strictEqual(c2.limits.maxMoves, 3);
ok('off by default; bad values fall back; boundaries stay ordered; weights always sum to ~100');
assert.strictEqual(S.effMode(S.normalize({ mode: 'off', fast: { mode: 'live' } }), 'fast'), 'off');
assert.strictEqual(S.effMode(S.normalize({ mode: 'shadow', swing: { mode: 'live' } }), 'swing'), 'live');
assert.strictEqual(S.effMode(S.normalize({ mode: 'shadow' }), 'fast'), 'shadow');
ok('overall off is a master switch; a profile may have its own mode');

// ---- synthetic paths: long, entry 100, original stop 99 (R = 1), 1-minute bars ----
const T0 = 1_700_000_000_000, MIN = 60000;
const bar = (k, o, c, v = 100, wick = 0.03) => ({ t: T0 + k * MIN, o, c, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, v });
const calmPre = []; for (let k = -30; k < 0; k++) calmPre.push(bar(k, 100 + (k % 2) * 0.02, 100 - (k % 2) * 0.02));   // quiet history, ATR ~0.08
// A: steady trend up
const trend = [...calmPre]; for (let k = 0; k < 40; k++) trend.push(bar(k, 100 + k * 0.03, 100 + (k + 1) * 0.03));
// B: trap - drifts up slowly for 30 min to +0.45R, then falls hard on heavy volume
const trap = [...calmPre]; for (let k = 0; k < 30; k++) trap.push(bar(k, 100 + k * 0.015, 100 + (k + 1) * 0.015));
for (let k = 30; k < 38; k++) trap.push(bar(k, 100.45 - (k - 30) * 0.2, 100.45 - (k - 29) * 0.2, 400, 0.05));
const run = (candles, upTo, tradeOver = {}) => {
  const long = true, c = candles.slice(0, 30 + upTo + 1), last = c[c.length - 1];
  let peak = 100, peakAt = T0; for (const x of c.filter(x => x.t >= T0)) if (x.h > peak) { peak = x.h; peakAt = x.t; }
  const f = S.features({ side: 'Buy', entry: 100, mark: last.c, peak, peakAt, entryAt: T0, now: last.t + MIN, initialSl: 99, candles: c, profile: 'fast', cfg, ...tradeOver });
  const nf = S.normFeatures(f, 'fast', cfg); return { f, nf, sc: S.score(nf, cfg.weights, 1) };
};
const tr = run(trend, 39), tp = run(trap, 37);
assert(tr.sc < cfg.th.watch, 'steady trend should score calm, got ' + tr.sc);
assert(tp.sc >= cfg.th.alert, 'the reversal should reach alert, got ' + tp.sc);
ok('a steady trend scores calm (' + tr.sc + '); the slow-then-hard-reversal path reaches alert/danger (' + tp.sc + ')');
const early = run(trap, 28);
assert(early.sc < cfg.th.alert, 'the slow drift alone must not alert, got ' + early.sc);
ok('the slow drift by itself (before the reversal) stays below alert (' + early.sc + ')');
assert.strictEqual(S.features({ side: 'Buy', entry: 100, mark: 100, peak: 100, initialSl: 0, candles: trend, now: T0, cfg }), null);
assert.strictEqual(S.features({ side: 'Buy', entry: 100, mark: 100, peak: 100, initialSl: 99, candles: trend.slice(0, 3), now: T0, cfg }), null);
ok('no original stop or no candles: it says "cannot judge" instead of guessing');

// ---- state machine ----
const th = cfg.th;
let m = S.step(null, 60, th); assert.strictEqual(m.state, 'watch'); assert.strictEqual(m.want, 'alert');
m = S.step(m, 60, th); assert.strictEqual(m.state, 'alert');
ok('rising to alert needs ' + th.confirm + ' reads in a row (one wick does not do it)');
m = S.step(S.step(null, 60, th), 35, th); assert.strictEqual(m.state, 'watch'); assert.strictEqual(m.want, null);   // the spike was not confirmed: forgotten
m = { state: 'alert', want: null, n: 0 }; m = S.step(m, th.alert - 3, th); assert.strictEqual(m.state, 'alert');   // inside the hysteresis band
m = S.step(m, th.alert - th.hyst - 1, th); assert.strictEqual(m.state, 'watch');
ok('falling needs the score to be ' + th.hyst + ' points below the boundary (no flapping)');
assert.strictEqual(S.step({ state: 'bogus' }, 0, th).state, 'calm');
ok('a damaged memory restarts at calm');

// ---- decide: tighten only ----
const D = (o) => S.decide({ side: 'Buy', entry: 100, mark: 100.7, peak: 100.8, curSl: 99, initialSl: 99, tick: 0.01, atr: 0.1, state: 'alert', cfg, ...o });
assert.strictEqual(D({ state: 'watch' }).action, 'none'); assert.strictEqual(D({ state: 'calm' }).action, 'none');
ok('calm and watch never touch a stop');
let d = D({});                                                  // in profit (peak 0.8R, past the 0.7R start), alert -> breakeven
assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.newSl, 100.1);
ok('in profit + alert: stop to breakeven plus fee cushion (' + d.newSl + ')');
d = D({ state: 'danger', mark: 100.9, peak: 100.95 });          // keep 50% of the 0.95 peak = 100.475; the price gap (0.25%) allows up to ~100.65
assert.strictEqual(d.action, 'raise'); assert(d.newSl >= 100.4 && d.newSl <= 100.9 - 0.25, 'got ' + d.newSl);
ok('in profit + danger: keeps a share of the peak, never closer to the price than the gap (' + d.newSl + ')');
{ // final-20: with the Profit Guard curve's share the actions follow the trade; without it the old fixed behaviour is unchanged
  const base = { side: 'Buy', entry: 100, mark: 112, peak: 112.9, curSl: 90, initialSl: 90, tick: 0.01, atr: 0.1, cfg };
  const aOld = S.decide({ ...base, state: 'alert' }), aNew = S.decide({ ...base, state: 'alert', keepFrac: 0.45 });
  assert(/breakeven/.test(aOld.label) && Math.abs(aOld.newSl - 100.1) < 0.02 && /curve/.test(aNew.label) && Math.abs(aNew.newSl - (100 + 0.45 * 12.9)) < 0.02);
  const dOld = S.decide({ ...base, state: 'danger' }), dNew = S.decide({ ...base, state: 'danger', keepFrac: 0.6 }), dLow = S.decide({ ...base, state: 'danger', keepFrac: 0.2 });
  assert(Math.abs(dOld.newSl - (100 + 0.5 * 12.9)) < 0.02 && Math.abs(dNew.newSl - (100 + 0.75 * 12.9)) < 0.02 && Math.abs(dLow.newSl - (100 + 0.5 * 12.9)) < 0.02, JSON.stringify([dOld, dNew, dLow]));
  const sh = S.decide({ ...base, side: 'Sell', entry: 100, mark: 88, peak: 87.1, curSl: 110, initialSl: 110, state: 'danger', keepFrac: 0.6 }); assert(sh.newSl < 100 - 0.7 * 12.9 + 0.02 && sh.newSl > 85);
  ok('sentinel: in profit, alert keeps the curve share and danger 15 points more (never below its own fixed share); without a curve share nothing changes; shorts too');
}
// v2.9.10: the profit start is 0.7R. The SOON trade (peak about +0.3R, then an alert) used to jump to breakeven; now it keeps the loss-side stop and gets room.
assert.strictEqual(S.defaults().profit.startR, 0.7); assert.strictEqual(S.normalize({}).profit.startR, 0.7);
d = D({ peak: 100.45, mark: 100.3, state: 'alert' }); assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.newSl, 99.4); assert(/-0\.6R/.test(d.label), d.label);
d = D({ peak: 100.69, mark: 100.3, state: 'alert' }); assert.strictEqual(d.newSl, 99.4, 'just under 0.7R is still the loss side');
d = D({ peak: 100.7, mark: 100.5, state: 'alert' }); assert.strictEqual(d.newSl, 100.1, 'at 0.7R it counts as in profit: breakeven');
assert.strictEqual(S.normalize({ profit: { startR: 0.3 } }).profit.startR, 0.3, 'a chosen 0.3 is still allowed');
{ const old = S.normalize({ profit: { startR: 0.3, dangerKeep: 0.4 }, th: { alert: 55 } });
  let m = S.migrateStart(old, true); assert(m.changed && m.cfg.profit.startR === 0.7 && m.cfg.profit.dangerKeep === 0.4 && m.cfg.th.alert === 55, 'only the start moves; everything else is kept');
  m = S.migrateStart(S.normalize({ profit: { startR: 0.5 } }), true); assert(!m.changed && m.cfg.profit.startR === 0.5, 'a value somebody chose is never touched');
  m = S.migrateStart(old, false); assert(!m.changed, 'nothing saved: the new default already applies');
  assert(!S.migrateStart(null, true).changed); }
ok('v2.9.10: profit start is 0.7R (an alert at +0.3-0.7R keeps the loss-side stop, from 0.7R it is breakeven); a saved 0.3R moves once, a chosen value never');
d = D({ peak: 100, mark: 99.7, curSl: 99, state: 'alert' });    // loss side: -0.6R = 99.4
assert.strictEqual(d.newSl, 99.4);
ok('loss side + alert: stop moves from -1R to -0.6R');
d = D({ peak: 100, mark: 99.7, curSl: 99, state: 'danger' });   // just behind price: gap = max(0.25%, 0.5 x ATR) = max(0.249, 0.05)
assert.strictEqual(d.action, 'raise'); assert(d.newSl > 99.4 && d.newSl < 99.7);
ok('loss side + danger: stop just behind the price (' + d.newSl + ')');
assert.strictEqual(D({ curSl: 100.2, peak: 100.45 }).action, 'none');
d = D({ mark: 100.2 });                                         // breakeven would sit inside the 0.25% gap: it is held back from the price, not placed on it
assert(d.action === 'none' || d.newSl <= 100.2 - 0.25 + 0.011, 'gap rule');
assert.strictEqual(D({ peak: 100, mark: 99.7, curSl: 99.5, state: 'alert' }).action, 'none');
ok('never loosens and never repeats a move that is already tighter');
d = S.decide({ side: 'Sell', entry: 100, mark: 99.3, peak: 99.2, curSl: 101, initialSl: 101, tick: 0.01, atr: 0.1, state: 'alert', cfg });
assert.strictEqual(d.action, 'raise'); assert.strictEqual(d.newSl, 99.9);
ok('short side mirrors the long side');
assert.strictEqual(D({ initialSl: 0 }).action, 'none');
ok('no original stop: does nothing');

// ---- label ----
assert.strictEqual(S.labelTrade({ elapsedMin: 2, peakR: 0.2, crosses: 0 }, cfg), 'unlabeled');
assert.strictEqual(S.labelTrade({ elapsedMin: 6, peakR: 0.7, crosses: 0 }, cfg), 'runner');
assert.strictEqual(S.labelTrade({ elapsedMin: 10, peakR: 0.1, crosses: 0 }, cfg), 'grinder');
assert.strictEqual(S.labelTrade({ elapsedMin: 10, peakR: 0.3, crosses: 3 }, cfg), 'chop');
assert(S.labelMult('grinder', cfg) > 1 && S.labelMult('runner', cfg) < 1 && S.labelMult('unlabeled', cfg) === 1);
ok('labels: unlabeled before the window, runner, grinder, chop; the multipliers are bounded');

// ---- clamp ----
assert.strictEqual(S.clampStop('Buy', 99, 100.1), 100.1); assert.strictEqual(S.clampStop('Buy', 0, 100.1), 100.1);
assert.strictEqual(S.clampStop('Buy', 100.5, 100.1), null); assert.strictEqual(S.clampStop('Sell', 101, 99.9), 99.9); assert.strictEqual(S.clampStop('Buy', 99, 0), null);
ok('a looser stop or a stop removal from a bot is held at the Sentinel floor');

// ---- learning from history ----
const mk = (series, over = {}) => ({ side: 'Buy', entry: 100, initialSl: 99, entryAt: T0, exitAt: series[series.length - 1].t, ...over });
const s1 = S.replay(mk(trap), trap, cfg, 'fast'), s2 = S.replay(mk(trend), trend, cfg, 'fast');
assert(s1.length > 20 && s2.length > 20);
assert(s1.some(s => s.y === 1) && s2.every(s => s.y === 0));
ok('replay labels samples by what happened next: trap path has danger samples, the trend has none');
// many trades with different shapes -> enough samples to fit
const samples = [];
for (let t = 0; t < 40; t++) {
  const slope = 0.01 + (t % 5) * 0.004, hold = 20 + (t % 4) * 6, pre = [...calmPre], path = [...pre];
  for (let k = 0; k < hold; k++) path.push(bar(k, 100 + k * slope, 100 + (k + 1) * slope));
  const top = 100 + hold * slope;
  const trapDo = t % 2 === 0;
  for (let k = hold; k < hold + 10; k++) path.push(trapDo ? bar(k, top - (k - hold) * 0.18, top - (k - hold + 1) * 0.18, 350, 0.05) : bar(k, top + (k - hold) * 0.02, top + (k - hold + 1) * 0.02));
  samples.push(...S.replay(mk(path), path, cfg, 'fast'));
}
const w = S.fitWeights(samples, cfg);
assert(w, 'enough evidence should produce weights');
assert(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 100) < 1.5);
assert(Object.values(w).every(v => v >= 0));
const before = S.evalWeights(samples, cfg.weights, cfg.th), after = S.evalWeights(samples, w, cfg.th);
assert(after.recall !== null && before.recall !== null);
ok('fit: weights from 40 synthetic trades sum to ~100, none negative; recall at alert ' + (before.recall * 100).toFixed(0) + '% -> ' + (after.recall * 100).toFixed(0) + '%');
assert.strictEqual(S.fitWeights(samples.slice(0, 5), cfg), null);
assert.strictEqual(S.fitWeights(samples.filter(s => s.y === 0), cfg), null);
ok('too little data, or only one kind of outcome: no suggestion');
console.log('sentinel: ' + n + ' checks passed');
