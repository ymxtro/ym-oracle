'use strict';
// Profit Guard: pure decision logic (no network, no database), so it can be tested alone.
//
// It watches an OPEN trade and only ever RAISES its stop-loss toward the profit side ("tighten only"), never loosens it and never opens or
// closes anything itself: the stop always stays on Bybit, so if this server sleeps or restarts the trade keeps its last stop.
//
// R = the distance from entry to the ORIGINAL stop (the money the trade risked). Peak = the best price the trade has reached.
//   1. Once the peak reaches `beR` R, the stop moves to breakeven (plus a small cushion for fees).
//   2. Above that, a ladder says what share of the peak PROFIT must be kept: [[2R, 35%], [4R, 55%], [8R, 65%]] means
//      "once the trade has been 2R in profit keep at least 35% of its best profit, at 4R keep 55%", and so on.
//   3. The stop never goes closer to the current price than `minGapPct` (Bybit would refuse it, and it would be noise).
// Two profiles with their own ladders: fast (the fast engines) and swing (Oracle IV).

const MODES = ['off', 'shadow', 'live'];   // off: does nothing. shadow: records what it WOULD do, touches nothing. live: moves the real stops.

const DEFAULT_LADDER = {
  fast:  { beR: 1, ladder: [[1.5, 0.45], [3, 0.60], [6, 0.70]], scale: { on: false, steps: [[2, 0.25]] } },
  swing: { beR: 1, ladder: [[2, 0.35], [4, 0.55], [8, 0.65]], scale: { on: false, steps: [[3, 0.25]] } },
};
const PMODES = ['inherit', 'off', 'shadow', 'live'];   // a profile can follow the overall switch ("inherit") or have its own

const copyProfile = p => ({ mode: 'inherit', beR: p.beR, ladder: p.ladder.map(x => x.slice()), scale: { on: p.scale.on, steps: p.scale.steps.map(x => x.slice()) } });

function defaults() {
  return { mode: 'off', pollSec: 5, minGapPct: 0.25, stepR: 0.1, beOffsetPct: 0.1, alerts: true, swingBots: ['YM ORACLE IV'],
    reentry: { on: true, minPullR: 0.5, resumePct: 40, targetR: 2, hoursFast: 6, hoursSwing: 48 },
    fast: copyProfile(DEFAULT_LADDER.fast), swing: copyProfile(DEFAULT_LADDER.swing) };
}

const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };

function normSteps(arr, dflt, maxFrac) {
  if (!Array.isArray(arr)) return dflt.map(x => x.slice());
  const steps = [];
  for (const s of arr.slice(0, 3)) {
    if (!Array.isArray(s)) continue;
    const thr = num(s[0], 0.5, 50, NaN), frac = num(s[1], 0.05, maxFrac, NaN);
    if (Number.isFinite(thr) && Number.isFinite(frac)) steps.push([thr, frac]);
  }
  steps.sort((a, b) => a[0] - b[0]);
  return steps;
}

function normProfile(raw, dflt) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const sc = (r.scale && typeof r.scale === 'object') ? r.scale : {};
  const out = { mode: PMODES.includes(r.mode) ? r.mode : 'inherit', beR: num(r.beR, 0.3, 5, dflt.beR), ladder: dflt.ladder.map(x => x.slice()),
    scale: { on: sc.on === undefined ? dflt.scale.on : sc.on === true, steps: normSteps(sc.steps, dflt.scale.steps, 0.5) } };
  if (out.scale.steps.reduce((t, x) => t + x[1], 0) > 0.7) out.scale.steps = dflt.scale.steps.map(x => x.slice());   // never take more than 70% off in total: a runner always stays
  if (Array.isArray(r.ladder)) {
    const steps = [];
    for (const s of r.ladder.slice(0, 6)) {
      if (!Array.isArray(s)) continue;
      const thr = num(s[0], 0.5, 50, NaN), frac = num(s[1], 0.1, 0.9, NaN);
      if (Number.isFinite(thr) && Number.isFinite(frac)) steps.push([thr, frac]);
    }
    steps.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < steps.length; i++) if (steps[i][1] < steps[i - 1][1]) steps[i][1] = steps[i - 1][1];   // a higher rung never keeps less than a lower one
    if (steps.length || r.ladder.length === 0) out.ladder = steps;
  }
  return out;
}

function normReentry(raw, d) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return { on: r.on === undefined ? d.on : r.on === true, minPullR: num(r.minPullR, 0.1, 5, d.minPullR), resumePct: num(r.resumePct, 10, 90, d.resumePct),
    targetR: num(r.targetR, 0.5, 10, d.targetR), hoursFast: num(r.hoursFast, 1, 72, d.hoursFast), hoursSwing: num(r.hoursSwing, 1, 240, d.hoursSwing) };
}

// The mode really in force for one profile: the overall switch is a master (off turns everything off), a profile may then set its own.
function effMode(cfg, profile) {
  if (cfg.mode === 'off') return 'off';
  const m = (cfg[profile] || {}).mode;
  return !m || m === 'inherit' ? cfg.mode : m;
}

// Anything stored or submitted becomes a full, valid config; bad values fall back to the defaults, never throw.
function normalize(raw) {
  const d = defaults(), r = (raw && typeof raw === 'object') ? raw : {};
  const bots = Array.isArray(r.swingBots) ? r.swingBots.map(x => String(x).trim().toUpperCase().slice(0, 40)).filter(Boolean).slice(0, 8) : d.swingBots;
  return {
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    pollSec: num(r.pollSec, 3, 60, d.pollSec), minGapPct: num(r.minGapPct, 0.05, 5, d.minGapPct), stepR: num(r.stepR, 0.02, 1, d.stepR),
    beOffsetPct: num(r.beOffsetPct, 0, 1, d.beOffsetPct), alerts: r.alerts === undefined ? d.alerts : r.alerts === true,
    swingBots: bots.length ? bots : d.swingBots,
    reentry: normReentry(r.reentry, d.reentry),
    fast: normProfile(r.fast, d.fast), swing: normProfile(r.swing, d.swing),
  };
}

const isSwingBot = (cfg, bot) => !!bot && cfg.swingBots.includes(String(bot).trim().toUpperCase());

// The best price seen so far (highest for a long, lowest for a short).
function updatePeak(peak, side, mark, entry) {
  const long = side === 'Buy';
  let p = Number(peak); if (!(p > 0)) p = entry;
  if (!(mark > 0)) return p;
  return long ? Math.max(p, mark) : Math.min(p, mark);
}

const roundTo = (v, tick) => (tick > 0 ? Math.round(v / tick) * tick : v);
const fixTick = (v, tick) => (tick > 0 ? Number(v.toFixed(Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 1)))) : v);

// Decides whether the stop should move. in: { side:'Buy'|'Sell', entry, mark, peak, curSl (0 = none), initialSl, tick, profile:{beR,ladder}, cfg }
// out: { action:'none', why } or { action:'raise', newSl, label, peakR, lockPct, keepFrac }
function decide(i) {
  const cfg = i.cfg, long = i.side === 'Buy', entry = Number(i.entry), mark = Number(i.mark), peak = Number(i.peak);
  const cur = Number(i.curSl) > 0 ? Number(i.curSl) : 0, init = Number(i.initialSl), tick = Number(i.tick) || 0;
  if (!(entry > 0) || !(mark > 0)) return { action: 'none', why: 'no price' };
  if (!(init > 0) || (long ? init >= entry : init <= entry)) return { action: 'none', why: 'no original stop to measure the risk from' };
  const risk = Math.abs(entry - init);
  const peakDist = long ? peak - entry : entry - peak;
  if (!(peakDist > 0)) return { action: 'none', why: 'not in profit yet' };
  const peakR = peakDist / risk;
  const pf = i.profile;
  if (peakR < pf.beR) return { action: 'none', why: 'peak ' + peakR.toFixed(2) + 'R is below the ' + pf.beR + 'R start', peakR };
  let target = long ? entry * (1 + cfg.beOffsetPct / 100) : entry * (1 - cfg.beOffsetPct / 100), label = 'breakeven', keepFrac = 0;
  for (const [thr, frac] of pf.ladder) {
    if (peakR < thr) continue;
    const cand = long ? entry + frac * peakDist : entry - frac * peakDist;
    if (long ? cand > target : cand < target) { target = cand; label = 'keep ' + Math.round(frac * 100) + '% of the peak'; keepFrac = frac; }
  }
  const gap = cfg.minGapPct / 100;
  const limit = long ? mark * (1 - gap) : mark * (1 + gap);      // never closer to the price than this
  if (long ? target > limit : target < limit) { target = limit; label += ' (held back from the price)'; }
  target = roundTo(target, tick);
  if (tick > 0) { if (long && target > limit) target -= tick; if (!long && target < limit) target += tick; }
  target = fixTick(target, tick);
  const minStep = Math.max(cfg.stepR * risk, tick);
  if (cur > 0 && !(long ? target >= cur + minStep : target <= cur - minStep)) return { action: 'none', why: 'the stop is already as tight or tighter', peakR };
  if (long ? target <= entry * (1 - 0.0001) : target >= entry * (1 + 0.0001)) { if (!(cur > 0) || (long ? target <= cur : target >= cur)) return { action: 'none', why: 'nothing to lock yet', peakR }; }
  const lockPct = (long ? target - entry : entry - target) / entry * 100;
  return { action: 'raise', newSl: target, label, peakR, lockPct, keepFrac };
}

// A stop that arrives from a bot (or anyone) must never undo the guard: it is held at the guard's floor.
// Returns the stop to use, or null when no change is needed.
function clampStop(side, incoming, floor) {
  const f = Number(floor);
  if (!(f > 0)) return null;
  const inc = Number(incoming);
  const long = side === 'Buy';
  if (!(inc > 0)) return f;                          // "remove the stop" (0 or empty) must not remove the floor
  if (long ? inc < f : inc > f) return f;
  return null;
}

// Scale-out: which step (if any) is due. currentR = how many R the trade is in profit right now; done = indexes already taken.
function scaleDue(steps, currentR, done) {
  const d = Array.isArray(done) ? done : [];
  for (let i = 0; i < steps.length; i++) if (!d.includes(i) && currentR >= steps[i][0]) return i;
  return -1;
}
// The quantity for a partial close: rounded DOWN to the pair's step, and only if both the slice and what remains are tradable. null = skip.
function sliceQty(size, frac, step, minQty) {
  size = Number(size); step = Number(step) > 0 ? Number(step) : 0; minQty = Number(minQty) || 0;
  if (!(size > 0) || !(frac > 0)) return null;
  let q = size * frac;
  if (step) q = Math.floor(q / step + 1e-9) * step;
  const dec = step ? (String(step).split('.')[1] || '').length : 8;
  q = Number(q.toFixed(dec));
  if (!(q > 0) || q < minQty || size - q < Math.max(minQty, step || 0) - 1e-12) return null;
  return q;
}

// Re-entry RECORDER (it never trades): after a winner has closed, watches the pair and notes when a "pulled back, then resumed" entry would have appeared,
// and how that would have turned out. w = { side, exit, peak, risk, extreme, cand, expiresAt }. Returns { events, finished }.
//   pullback depth = peak - lowest price since the close (long); it must reach minPullR x R; the signal is the price recovering resumePct% of that depth.
//   outcome: the pullback low is the stop; +targetR counts as a win, touching the stop is -1R, otherwise the R at the end of the window.
function reentryStep(w, mark, nowMs, rc) {
  const long = w.side === 'Buy', ev = [];
  if (!(mark > 0)) return { events: ev, finished: false };
  if (!w.cand) {
    w.extreme = !(w.extreme > 0) ? mark : (long ? Math.min(w.extreme, mark) : Math.max(w.extreme, mark));
    const depth = long ? w.peak - w.extreme : w.extreme - w.peak;
    const resumed = long ? mark >= w.extreme + depth * rc.resumePct / 100 : mark <= w.extreme - depth * rc.resumePct / 100;
    if (depth >= rc.minPullR * w.risk && resumed && (long ? w.extreme < mark : w.extreme > mark)) {
      w.cand = { price: mark, stop: w.extreme, at: nowMs, best: mark };
      ev.push({ type: 'would_reenter', price: mark, stop: w.extreme, pullR: depth / w.risk });
    } else if (nowMs >= w.expiresAt) { ev.push({ type: 'no_reentry', pullR: Math.max(0, depth) / w.risk }); return { events: ev, finished: true }; }
    return { events: ev, finished: false };
  }
  const c = w.cand, dist = Math.abs(c.price - c.stop);
  c.best = long ? Math.max(c.best, mark) : Math.min(c.best, mark);
  const bestR = dist > 0 ? (long ? c.best - c.price : c.price - c.best) / dist : 0;
  const nowR = dist > 0 ? (long ? mark - c.price : c.price - mark) / dist : 0;
  if (long ? mark <= c.stop : mark >= c.stop) { ev.push({ type: 'reentry_result', r: -1, why: 'stopped out at the pullback low', bestR }); return { events: ev, finished: true }; }
  if (bestR >= rc.targetR) { ev.push({ type: 'reentry_result', r: rc.targetR, why: 'reached +' + rc.targetR + 'R', bestR }); return { events: ev, finished: true }; }
  if (nowMs >= w.expiresAt) { ev.push({ type: 'reentry_result', r: nowR, why: 'window ended', bestR }); return { events: ev, finished: true }; }
  return { events: ev, finished: false };
}

module.exports = { PMODES, effMode, scaleDue, sliceQty, reentryStep, MODES, defaults, normalize, isSwingBot, updatePeak, decide, clampStop };
