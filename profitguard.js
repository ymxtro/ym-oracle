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
//
// SMART layer (final-17c, each part can be switched off on the admin card; with all of it off the rules above are unchanged):
//   a. Breathing room: the trade's own wobble (its largest pullback from its best price so far) sets a minimum distance between the stop and the price,
//      so a stop is not raised into the noise this particular trade has already shown. It only DELAYS a raise; it never loosens a stop.
//   b. Stall tightening: a trade that has been in profit but has made no new best for a while is more likely to turn than one still pushing, so the
//      share of the best profit it must keep creeps up (a few points per stalled period, capped). Any new best resets it.
//   c. Self-tuning: from the closed-trade scorecard (and the re-entry recorder) it suggests, or with explicit consent applies, small changes to the keep shares.
//      Bounded: 0.15 to 0.85, a few points at a time, never before enough closed trades, never making a higher rung keep less than a lower one.

const MODES = ['off', 'shadow', 'live'];   // off: does nothing. shadow: records what it WOULD do, touches nothing. live: moves the real stops.

const DEFAULT_LADDER = {
  fast:  { beR: 1, ladder: [[1.5, 0.45], [3, 0.60], [6, 0.70]], scale: { on: false, steps: [[2, 0.25]] } },
  swing: { beR: 1, ladder: [[2, 0.35], [4, 0.55], [8, 0.65]], scale: { on: false, steps: [[3, 0.25]] } },
};
const PMODES = ['inherit', 'off', 'shadow', 'live'];   // a profile can follow the overall switch ("inherit") or have its own

const copyProfile = p => ({ mode: 'inherit', beR: p.beR, ladder: p.ladder.map(x => x.slice()), scale: { on: p.scale.on, steps: p.scale.steps.map(x => x.slice()) } });

const DEFAULT_SMART = {
  noise: { on: true, mult: 1.0, capR: 1.5 },                                   // breathing room: gap >= mult x the trade's largest pullback, never more than capR x R
  stall: { on: true, fastMin: 30, swingMin: 360, stepPts: 0.10, maxPts: 0.20 }, // every stalled period adds stepPts to the keep share, up to maxPts
  tune:  { mode: 'suggest', minTrades: 20, every: 10, step: 0.05, lastAtN: { fast: 0, swing: 0 } },   // off | suggest | auto
  // final-18 ADAPT: reads the pair's own speed and the market around the trade (needs the 1-minute candles; with none, nothing here applies).
  //   a. Volatility gap: the stop never goes closer to the price than atrMult x this pair's 1-minute ATR (capped at capR x R). A fast coin gets room at once, before it
  //      has shown a pullback of its own; a flat coin keeps the plain minimum gap.
  //   b. Market keep: the share of the best profit kept moves by at most +/- pts: UP while BTC is moving against the trade, DOWN (let it run) while the trade is trending
  //      cleanly (deep in profit, pullbacks smaller than the pair's ATR). Same shift for every rung, so a higher rung never keeps less than a lower one.
  adapt: { on: true, atrMult: 0.8, capR: 1.5, mkt: { on: true, pts: 0.08 } },
};
const copySmart = d => JSON.parse(JSON.stringify(d));

function defaults() {
  return { mode: 'off', pollSec: 5, minGapPct: 0.25, stepR: 0.1, beOffsetPct: 0.1, alerts: true, swingBots: [], smart: copySmart(DEFAULT_SMART),
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

function normAdapt(raw, d) {
  const a = (raw && typeof raw === 'object') ? raw : {}, m = (a.mkt && typeof a.mkt === 'object') ? a.mkt : {};
  return { on: a.on === undefined ? d.on : a.on === true, atrMult: num(a.atrMult, 0, 3, d.atrMult), capR: num(a.capR, 0.2, 5, d.capR),
           mkt: { on: m.on === undefined ? d.mkt.on : m.on === true, pts: num(m.pts, 0, 0.2, d.mkt.pts) } };
}

function normSmart(raw, d) {
  const r = (raw && typeof raw === 'object') ? raw : {}, n = (r.noise && typeof r.noise === 'object') ? r.noise : {}, st = (r.stall && typeof r.stall === 'object') ? r.stall : {}, t = (r.tune && typeof r.tune === 'object') ? r.tune : {};
  const la = (t.lastAtN && typeof t.lastAtN === 'object') ? t.lastAtN : {};
  return {
    noise: { on: n.on === undefined ? d.noise.on : n.on === true, mult: num(n.mult, 0, 3, d.noise.mult), capR: num(n.capR, 0.2, 5, d.noise.capR) },
    stall: { on: st.on === undefined ? d.stall.on : st.on === true, fastMin: num(st.fastMin, 5, 720, d.stall.fastMin), swingMin: num(st.swingMin, 30, 4320, d.stall.swingMin),
             stepPts: num(st.stepPts, 0.02, 0.3, d.stall.stepPts), maxPts: num(st.maxPts, 0.02, 0.5, d.stall.maxPts) },
    adapt: normAdapt(r.adapt, d.adapt),
    tune: { mode: ['off', 'suggest', 'auto'].includes(t.mode) ? t.mode : d.tune.mode, minTrades: Math.round(num(t.minTrades, 5, 500, d.tune.minTrades)), every: Math.round(num(t.every, 3, 200, d.tune.every)),
            step: num(t.step, 0.01, 0.1, d.tune.step), lastAtN: { fast: Math.round(num(la.fast, 0, 1e6, 0)), swing: Math.round(num(la.swing, 0, 1e6, 0)) } },
  };
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
  const bots = Array.isArray(r.swingBots) ? r.swingBots.map(x => String(x).trim().toUpperCase().slice(0, 40)).filter(Boolean).slice(0, 8) : d.swingBots;   // optional: bot names to treat as swing when a signal carries no engine tag. Empty by default: no bot is special
  return {
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    pollSec: num(r.pollSec, 3, 60, d.pollSec), minGapPct: num(r.minGapPct, 0.05, 5, d.minGapPct), stepR: num(r.stepR, 0.02, 1, d.stepR),
    beOffsetPct: num(r.beOffsetPct, 0, 1, d.beOffsetPct), alerts: r.alerts === undefined ? d.alerts : r.alerts === true,
    swingBots: bots,
    reentry: normReentry(r.reentry, d.reentry), smart: normSmart(r.smart, d.smart),
    fast: normProfile(r.fast, d.fast), swing: normProfile(r.swing, d.swing),
  };
}

const isSwingBot = (cfg, bot) => !!bot && cfg.swingBots.includes(String(bot).trim().toUpperCase());
// Which profile a trade follows: what the trade itself says (the engine tag the bot reports with its signal). Only a signal without a tag falls back to the optional bot-name list.
const profileOf = (cfg, eng, bot) => (eng === 'swing' ? 'swing' : eng === 'fast' ? 'fast' : isSwingBot(cfg, bot) ? 'swing' : 'fast');

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
  const sm = i.smart || {};
  const adj = Number.isFinite(Number(sm.keepAdj)) ? Math.max(-0.2, Math.min(0.2, Number(sm.keepAdj))) : 0;   // market-aware shift of the keep share (see ADAPT)
  for (const [thr, base] of pf.ladder) {
    if (peakR < thr) continue;
    const frac = adj ? Math.max(0.1, Math.min(0.9, base + adj)) : base;
    const cand = long ? entry + frac * peakDist : entry - frac * peakDist;
    if (long ? cand > target : cand < target) { target = cand; label = 'keep ' + Math.round(frac * 100) + '% of the peak' + (adj ? ' (' + (adj > 0 ? '+' : '') + Math.round(adj * 100) + ' pts: market)' : ''); keepFrac = frac; }
  }
  const noiseGap = Number(sm.noisePrice) > 0 ? Math.min(Number(sm.noisePrice), (Number(sm.noiseCapR) > 0 ? Number(sm.noiseCapR) : 1.5) * risk) : 0;   // breathing room from this trade's own wobble
  const stallExtra = Number(sm.stallExtra) > 0 ? Math.min(0.5, Number(sm.stallExtra)) : 0;
  if (stallExtra > 0) {                       // stalled: no new best for a while, so keep a bit more of what was made
    const f = Math.min(0.9, keepFrac + stallExtra), cand = long ? entry + f * peakDist : entry - f * peakDist;
    if (long ? cand > target : cand < target) { target = cand; label = keepFrac > 0 ? label + ' +' + Math.round(stallExtra * 100) + ' pts (stalled)' : 'keep ' + Math.round(f * 100) + '% of the peak (stalled)'; keepFrac = f; }
  }
  const atrGap = Number(sm.atrPrice) > 0 ? Math.min(Number(sm.atrPrice), (Number(sm.atrCapR) > 0 ? Number(sm.atrCapR) : 1.5) * risk) : 0;   // breathing room from this pair's own speed
  const gapDist = Math.max(mark * cfg.minGapPct / 100, noiseGap, atrGap);
  const limit = long ? mark - gapDist : mark + gapDist;          // never closer to the price than this
  if (long ? target > limit : target < limit) { target = limit; label += Math.max(noiseGap, atrGap) > mark * cfg.minGapPct / 100 ? (atrGap > noiseGap ? ' (held back: pair volatility)' : ' (held back: breathing room)') : ' (held back from the price)'; }
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


// ---- smart helpers (pure) ----
// The trade's largest pullback from its best price so far, in price units (grows only).
function updatePull(prev, side, peak, mark) {
  const long = side === 'Buy', p = Number(prev) > 0 ? Number(prev) : 0;
  if (!(peak > 0) || !(mark > 0)) return p;
  const pull = long ? peak - mark : mark - peak;
  return pull > p ? pull : p;
}
const noiseOf = (cfg, maxPull) => (cfg.smart.noise.on && maxPull > 0 ? { noisePrice: cfg.smart.noise.mult * maxPull, noiseCapR: cfg.smart.noise.capR } : {});
// ADAPT: what the pair's own speed and the market around the trade say. in: { atr (1-minute ATR, price units), btcPct (BTC's % move over ~15 min in the TRADE's direction, + = with it),
// peakR, maxPull (price units) }. Returns the extra inputs for decide(); {} when the feature is off or there is nothing to read.
function adaptOf(cfg, x) {
  const a = cfg.smart.adapt;
  if (!a || !a.on || !x) return {};
  const out = {};
  const atr = Number(x.atr);
  if (atr > 0 && a.atrMult > 0) { out.atrPrice = a.atrMult * atr; out.atrCapR = a.capR; }
  if (a.mkt.on && a.mkt.pts > 0) {
    const btc = Number(x.btcPct);
    const against = Number.isFinite(btc) ? Math.min(1, Math.max(0, -btc / 0.6)) : 0;                       // same scale the Sentinel uses: -0.6% in 15 min = fully against
    const clean = atr > 0 && Number(x.peakR) >= 2 && Number(x.maxPull) >= 0 && Number(x.maxPull) < atr ? 1 : 0;   // deep in profit and every pullback so far smaller than one ATR
    out.keepAdj = Math.round(a.mkt.pts * (against - clean) * 1000) / 1000;
  }
  return out;
}
// Extra share of the best profit to keep because the trade has made no new best for a while. 0 when it is still pushing or the feature is off.
function stallExtra(cfg, profile, nowMs, peakAt) {
  const st = cfg.smart.stall;
  if (!st.on || !(peakAt > 0) || !(nowMs > peakAt)) return 0;
  const periodMs = (profile === 'swing' ? st.swingMin : st.fastMin) * 60000;
  const steps = Math.floor((nowMs - peakAt) / periodMs);
  return steps > 0 ? Math.min(st.maxPts, steps * st.stepPts) : 0;
}

// Self-tuning from the scorecard. rows: closed trades of ONE profile that ran with the guard LIVE ({ peak_pct, exit_pct, peak_r, giveback_pct }).
// re: the re-entry recorder summary for that profile ({ done, wins, avg_r }). Returns what it would change and why; changes nothing itself.
function suggestTuning(cfg, profile, rows, re) {
  const tu = cfg.smart.tune, pf = cfg[profile], first = pf.ladder.length ? pf.ladder[0][0] : pf.beR;
  const used = (rows || []).filter(r => Number(r.peak_pct) > 0 && r.exit_pct !== null && r.exit_pct !== undefined && Number(r.peak_r) >= first);
  const n = used.length, since = n - (tu.lastAtN[profile] || 0);
  const out = { profile, n, ready: false, action: 'hold', changes: [], reasons: [], since, share: null };
  if (!pf.ladder.length) { out.reasons.push('this profile has no ladder rungs to tune'); return out; }
  if (n < tu.minTrades) { out.reasons.push('needs ' + (tu.minTrades - n) + ' more closed live trade(s) that reached the first step (' + n + ' so far)'); return out; }
  out.ready = true;
  const share = used.reduce((t, r) => t + Math.min(1.5, Math.max(0, (Number(r.giveback_pct) || 0) / Number(r.peak_pct))), 0) / n;
  out.share = share;
  const done = Number(re && re.done) || 0, wins = Number(re && re.wins) || 0, avgR = Number(re && re.avg_r);
  let dir = 0;
  if (share > 0.5) { dir = 1; out.reasons.push('on average these trades gave back ' + Math.round(share * 100) + '% of their best profit: keep more'); }
  else if (share < 0.2 && done >= 10 && wins / done >= 0.6 && avgR >= 0.5) { dir = -1; out.reasons.push('only ' + Math.round(share * 100) + '% given back, yet ' + wins + ' of ' + done + ' re-entries after the guard exit would have won (average ' + avgR.toFixed(1) + 'R): the guard may be leaving too early, keep less'); }
  else out.reasons.push('gave back ' + Math.round(share * 100) + '% of the best profit on average: within the comfortable range, no change');
  if (!dir) return out;
  const next = pf.ladder.map(x => x.slice());
  for (const rung of next) rung[1] = Math.round(Math.min(0.85, Math.max(0.15, rung[1] + dir * tu.step)) * 1000) / 1000;
  for (let k = 1; k < next.length; k++) if (next[k][1] < next[k - 1][1]) next[k][1] = next[k - 1][1];
  next.forEach((rung, k) => { if (Math.abs(rung[1] - pf.ladder[k][1]) > 1e-9) out.changes.push({ rung: k, atR: rung[0], from: pf.ladder[k][1], to: rung[1] }); });
  if (!out.changes.length) { out.reasons.push('already at the limit of the allowed range'); return out; }
  out.action = dir > 0 ? 'tighten' : 'loosen'; out.next = next;
  return out;
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

module.exports = { adaptOf, updatePull, noiseOf, stallExtra, suggestTuning, DEFAULT_SMART, PMODES, effMode, scaleDue, sliceQty, reentryStep, MODES, defaults, normalize, isSwingBot, profileOf, updatePeak, decide, clampStop };
