'use strict';
// Trade Sentinel: pure decision logic (no network, no database), like profitguard.js, so it can be tested alone.
//
// It watches an OPEN trade and scores how much it looks like a "trap" (it moved a little into profit, or sat flat, then turns hard against the position).
// The score drives four states: calm -> watch -> alert -> danger. At alert and danger it may TIGHTEN the stop toward the price, never loosen it,
// and it never opens or closes anything itself: the stop stays on Bybit, so if this server sleeps the trade keeps its last stop.
//
// R = distance from entry to the trade's ORIGINAL stop. Features are measured in R and in the pair's own ATR so pairs compare.
// Modes: off (does nothing), shadow (records what it WOULD do), live (moves the real stop). All seed numbers below are starting values, NOT tuned:
// the server can refit the weights from the trade history (see fitWeights / replay) and shows a suggestion; nothing changes without an explicit apply.

const MODES = ['off', 'shadow', 'live'];
const PMODES = ['inherit', 'off', 'shadow', 'live'];
const KEYS = ['giveback', 'vel', 'vol', 'stall', 'cross', 'grind', 'btc', 'under'];
const STATES = ['calm', 'watch', 'alert', 'danger'];

const DEFAULT_WEIGHTS = { giveback: 20, vel: 22, vol: 10, stall: 8, cross: 12, grind: 6, btc: 6, under: 16 };   // sums to 100

function defaults() {
  return {
    mode: 'off', pollSec: 5, candleSec: 15, minGapPct: 0.25, beOffsetPct: 0.1, alerts: true,
    fast: { mode: 'inherit', stallMin: 30 },
    // v2.9.12 swing: the 15-second reads are noise on a multi-day trade. After a grace period it acts only in 'danger' (graceH hours, actOn), a loss-side alert goes to -alertR (not -0.6R),
    // it stays minGapPct from the price, the danger gap is dangerGapAtr x the HOURLY ATR, and 'in profit' starts at startR.
    swing: { mode: 'inherit', stallMin: 360, graceH: 5, actOn: 'danger', alertR: 0.85, minGapPct: 1.2, dangerGapAtr: 1.0, startR: 1.0 },
    weights: { ...DEFAULT_WEIGHTS },
    th: { watch: 28, alert: 50, danger: 70, hyst: 8, confirm: 2 },                 // score boundaries, how far a state must fall to drop, reads in a row to rise to alert/danger
    loss: { alertR: 0.6, dangerGapAtr: 0.5 },                                       // loss side: alert moves the stop to -alertR; danger puts it dangerGapAtr x ATR behind the price
    profit: { startR: 0.7, dangerKeep: 0.5 },                                       // past startR the trade counts as "in profit": alert = breakeven, danger = keep this share of the peak profit. 0.7 since v2.9.10 (was 0.3: on 51 recorded trades a breakeven stop from +0.3R cost about 1.7R, from +0.7R it added about 0.6R-1.2R; SOON was stopped at breakeven then ran +7%)
    label: { afterMin: 5, mult: { runner: 0.85, neutral: 1, grinder: 1.15, chop: 1.1 } },   // per-trade tweak of the score, bounded
    limits: { maxMoves: 3, moveGapSec: 30 },
    fit: { minTrades: 30, minTraps: 10 },
  };
}

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const obj = v => (v && typeof v === 'object' ? v : {});

function normWeights(raw, d) {
  const r = obj(raw), w = {};
  let sum = 0;
  for (const k of KEYS) { w[k] = num(r[k], 0, 100, d[k]); sum += w[k]; }
  if (!(sum > 0)) return { ...d };
  for (const k of KEYS) w[k] = Math.round(w[k] / sum * 1000) / 10;                  // always sums to ~100
  return w;
}

function normalize(raw) {
  const d = defaults(), r = obj(raw), th = obj(r.th), lo = obj(r.loss), pr = obj(r.profit), lb = obj(r.label), lm = obj(r.limits), ft = obj(r.fit), mu = obj(lb.mult);
  const out = {
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    pollSec: num(r.pollSec, 3, 60, d.pollSec), candleSec: num(r.candleSec, 5, 120, d.candleSec), minGapPct: num(r.minGapPct, 0.05, 5, d.minGapPct),
    beOffsetPct: num(r.beOffsetPct, 0, 1, d.beOffsetPct), alerts: r.alerts === undefined ? d.alerts : r.alerts === true,
    fast: { mode: PMODES.includes(obj(r.fast).mode) ? r.fast.mode : 'inherit', stallMin: num(obj(r.fast).stallMin, 5, 720, d.fast.stallMin) },
    swing: { mode: PMODES.includes(obj(r.swing).mode) ? r.swing.mode : 'inherit', stallMin: num(obj(r.swing).stallMin, 30, 4320, d.swing.stallMin), graceH: num(obj(r.swing).graceH, 0, 48, d.swing.graceH),
             actOn: obj(r.swing).actOn === 'alert' ? 'alert' : 'danger', alertR: num(obj(r.swing).alertR, 0.1, 0.95, d.swing.alertR), minGapPct: num(obj(r.swing).minGapPct, 0.05, 5, d.swing.minGapPct),
             dangerGapAtr: num(obj(r.swing).dangerGapAtr, 0.1, 5, d.swing.dangerGapAtr), startR: num(obj(r.swing).startR, 0.05, 3, d.swing.startR) },
    weights: normWeights(r.weights, d.weights),
    th: { watch: num(th.watch, 5, 90, d.th.watch), alert: num(th.alert, 10, 95, d.th.alert), danger: num(th.danger, 15, 100, d.th.danger),
          hyst: num(th.hyst, 0, 30, d.th.hyst), confirm: Math.round(num(th.confirm, 1, 6, d.th.confirm)) },
    loss: { alertR: num(lo.alertR, 0.1, 0.95, d.loss.alertR), dangerGapAtr: num(lo.dangerGapAtr, 0.1, 3, d.loss.dangerGapAtr) },
    profit: { startR: num(pr.startR, 0.05, 2, d.profit.startR), dangerKeep: num(pr.dangerKeep, 0.1, 0.9, d.profit.dangerKeep) },
    label: { afterMin: num(lb.afterMin, 2, 30, d.label.afterMin),
             mult: { runner: num(mu.runner, 0.7, 1.3, 0.85), neutral: num(mu.neutral, 0.7, 1.3, 1), grinder: num(mu.grinder, 0.7, 1.3, 1.15), chop: num(mu.chop, 0.7, 1.3, 1.1) } },
    limits: { maxMoves: Math.round(num(lm.maxMoves, 1, 10, d.limits.maxMoves)), moveGapSec: num(lm.moveGapSec, 5, 600, d.limits.moveGapSec) },
    fit: { minTrades: Math.round(num(ft.minTrades, 10, 1000, d.fit.minTrades)), minTraps: Math.round(num(ft.minTraps, 5, 500, d.fit.minTraps)) },
  };
  // boundaries must be in order: watch < alert < danger
  if (!(out.th.watch < out.th.alert)) out.th.watch = Math.max(5, out.th.alert - 20);
  if (!(out.th.alert < out.th.danger)) out.th.danger = Math.min(100, out.th.alert + 15);
  return out;
}

function effMode(cfg, profile) {
  if (cfg.mode === 'off') return 'off';
  const m = (cfg[profile] || {}).mode;
  return !m || m === 'inherit' ? cfg.mode : m;
}

// ---- features ----
// candles: 1-minute bars, oldest first: { t (ms), o, h, l, c, v }
function atrOf(candles, n = 14) {
  const c = (candles || []).slice(-(n + 1));
  if (c.length < 2) return 0;
  let s = 0, k = 0;
  for (let i = 1; i < c.length; i++) { s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); k++; }
  return k ? s / k : 0;
}
const medianOf = arr => { const a = arr.filter(x => x >= 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

// in: { side, entry, mark, peak, peakAt, entryAt, now, initialSl, candles, btcPct (BTC's move in the trade's direction over ~15 min, in %, optional), profile, cfg }
// out: the raw readings, or null when there is not enough to judge (no stop to measure risk from, no candles).
function features(i) {
  const long = i.side === 'Buy', entry = Number(i.entry), mark = Number(i.mark), init = Number(i.initialSl);
  if (!(entry > 0) || !(mark > 0) || !(init > 0) || (long ? init >= entry : init <= entry)) return null;
  const c = i.candles || [];
  if (c.length < 5) return null;
  const atr = atrOf(c);
  if (!(atr > 0)) return null;
  const risk = Math.abs(entry - init);
  const peak = Number(i.peak) > 0 ? Number(i.peak) : entry;
  const peakDist = Math.max(0, long ? peak - entry : entry - peak), nowDist = long ? mark - entry : entry - mark;
  const peakR = peakDist / risk, nowR = nowDist / risk;
  const giveback = peakDist > 0 ? clamp((peakDist - nowDist) / peakDist, 0, 1.5) : 0;
  const stallMin = Number(i.peakAt) > 0 && i.now > i.peakAt ? (i.now - i.peakAt) / 60000 : 0;
  const n = c.length, last = c[n - 1], back = c[Math.max(0, n - 4)];
  const adv = long ? back.c - last.c : last.c - back.c;                         // move AGAINST the position over the last ~3 minutes
  const advAtr = adv > 0 ? adv / atr : 0;
  const med = medianOf(c.slice(-21, -1).map(x => x.v));
  const recent = c.slice(-3).filter(x => (long ? x.c < x.o : x.c > x.o));
  const advVol = recent.length && med > 0 ? recent.reduce((t, x) => t + x.v, 0) / recent.length / med : 1;
  const lastClose = last.c;
  const cross = peakR >= 0.3 && (long ? lastClose <= entry : lastClose >= entry) ? 1 : 0;
  const elapsedMin = Number(i.entryAt) > 0 && i.now > i.entryAt ? (i.now - i.entryAt) / 60000 : 0;
  const rPerMin = elapsedMin > 0 ? peakR / elapsedMin : 0;
  const grind = elapsedMin >= 5 && peakR > 0.05 && peakR < 0.8 ? clamp(1 - rPerMin / 0.05) : 0;
  const btcAgainst = Number.isFinite(Number(i.btcPct)) ? clamp(-Number(i.btcPct) / 0.6) : 0;
  return { risk, atr, peakR, nowR, giveback, stallMin, advAtr, advVol, cross, grind, btcAgainst, elapsedMin };
}

// readings -> each feature as 0..1
function normFeatures(f, profile, cfg) {
  const ref = (cfg[profile] || cfg.fast).stallMin;
  return {
    giveback: f.peakR >= 0.3 ? clamp((f.giveback - 0.15) / 0.6) : 0,
    vel: clamp(f.advAtr / 1.5),
    vol: f.advAtr > 0 ? clamp((f.advVol - 1) / 2) : 0,
    stall: f.peakR >= 0.2 ? clamp(f.stallMin / ref) : 0,
    cross: f.cross,
    grind: f.grind,
    btc: f.btcAgainst,
    under: clamp((-f.nowR - 0.2) / 0.6),
  };
}

// 0..100. mult: the per-trade label tweak (bounded in normalize).
function score(nf, weights, mult) {
  let s = 0;
  for (const k of KEYS) s += (weights[k] || 0) * (nf[k] || 0);
  return Math.round(clamp(s * (mult > 0 ? mult : 1), 0, 100) * 10) / 10;
}

// ---- state machine ----
const stateFor = (s, th) => (s >= th.danger ? 'danger' : s >= th.alert ? 'alert' : s >= th.watch ? 'watch' : 'calm');
// mem: { state, want, n } is kept per trade. Rising to alert/danger needs th.confirm reads in a row; falling needs the score to be th.hyst below the boundary.
function step(mem, sc, th) {
  const m = mem && STATES.includes(mem.state) ? { state: mem.state, want: mem.want || null, n: mem.n || 0 } : { state: 'calm', want: null, n: 0 };
  const cur = STATES.indexOf(m.state), tgt = stateFor(sc, th), t = STATES.indexOf(tgt);
  if (t > cur) {
    if (tgt === 'watch') { m.state = 'watch'; m.want = null; m.n = 0; }
    else {
      if (m.want === tgt) m.n++; else { m.want = tgt; m.n = 1; }
      if (m.n >= th.confirm) { m.state = tgt; m.want = null; m.n = 0; }
      else if (cur < 1) m.state = 'watch';                                         // visible as watch while it waits for the confirming read
    }
  } else {
    m.want = null; m.n = 0;
    if (t < cur) {
      const bound = th[STATES[cur]];                                              // the boundary of the state it is in now
      if (sc < bound - th.hyst) m.state = tgt;
    }
  }
  return m;
}

// Per-trade label from the trade's own first minutes. Only changes the score by a bounded multiplier.
function labelTrade(x, cfg) {
  if (!(x.elapsedMin >= cfg.label.afterMin)) return 'unlabeled';
  if (x.crosses >= 2) return 'chop';
  if (x.peakR >= 0.5) return 'runner';
  if (x.peakR > 0.05 && x.peakR / x.elapsedMin < 0.04) return 'grinder';
  return 'neutral';
}
const labelMult = (label, cfg) => cfg.label.mult[label] || 1;

const roundTo = (v, tick) => (tick > 0 ? Math.round(v / tick) * tick : v);
const fixTick = (v, tick) => (tick > 0 ? Number(v.toFixed(Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 1)))) : v);

// Tighten-only stop decision. in: { side, entry, mark, peak, curSl (0 = none), initialSl, tick, atr, state, cfg }
// out: { action:'none', why } or { action:'raise', newSl, label }
function decide(i) {
  const cfg = i.cfg, long = i.side === 'Buy', entry = Number(i.entry), mark = Number(i.mark), peak = Number(i.peak) > 0 ? Number(i.peak) : entry;
  const init = Number(i.initialSl), cur = Number(i.curSl) > 0 ? Number(i.curSl) : 0, tick = Number(i.tick) || 0, atr = Number(i.atr) || 0;
  if (i.state !== 'alert' && i.state !== 'danger') return { action: 'none', why: 'state ' + i.state };
  if (!(entry > 0) || !(mark > 0) || !(init > 0) || (long ? init >= entry : init <= entry)) return { action: 'none', why: 'no original stop to measure the risk from' };
  const risk = Math.abs(entry - init), peakDist = Math.max(0, long ? peak - entry : entry - peak), peakR = peakDist / risk;
  const be = long ? entry * (1 + cfg.beOffsetPct / 100) : entry * (1 - cfg.beOffsetPct / 100);
  const sw = i.profile === 'swing' ? cfg.swing : null;   // v2.9.12: swing has its own numbers
  const startR = sw ? sw.startR : cfg.profit.startR, alertR = sw ? sw.alertR : cfg.loss.alertR, gapPct = sw ? sw.minGapPct : cfg.minGapPct, dangerAtr = sw ? sw.dangerGapAtr : cfg.loss.dangerGapAtr;
  const inProfit = peakR >= startR;
  const gap = Math.max(mark * gapPct / 100, i.state === 'danger' ? atr * dangerAtr : 0);
  const limit = long ? mark - gap : mark + gap;                                   // never closer to the price than this
  let target, label;
  if (inProfit) {
    const kf = Number(i.keepFrac) > 0 ? Number(i.keepFrac) : 0;                    // the Profit Guard curve's share for THIS trade (when given): alert keeps it, danger keeps 15 points more
    if (i.state === 'alert') {
      const keepA = kf ? (long ? entry + kf * peakDist : entry - kf * peakDist) : be;
      target = long ? Math.max(be, keepA) : Math.min(be, keepA); label = kf ? 'alert: keep ' + Math.round(kf * 100) + '% of the peak (curve)' : 'alert: breakeven';
    } else {
      const f = kf ? Math.max(cfg.profit.dangerKeep, Math.min(0.85, kf + 0.15)) : cfg.profit.dangerKeep;
      const keep = long ? entry + f * peakDist : entry - f * peakDist;
      target = long ? Math.max(be, keep) : Math.min(be, keep); label = 'danger: keep ' + Math.round(f * 100) + '% of the peak' + (kf ? ' (curve)' : '');
    }
  } else if (i.state === 'alert') { target = long ? entry - alertR * risk : entry + alertR * risk; label = 'alert: stop to -' + alertR + 'R'; }
  else { target = limit; label = 'danger: stop just behind the price'; }
  if (long ? target > limit : target < limit) { target = limit; label += ' (held back from the price)'; }
  target = roundTo(target, tick);
  if (tick > 0) { if (long && target > limit) target -= tick; if (!long && target < limit) target += tick; }
  target = fixTick(target, tick);
  const baseline = cur > 0 ? cur : init;
  const minStep = Math.max(0.05 * risk, tick);
  if (!(long ? target >= baseline + minStep : target <= baseline - minStep)) return { action: 'none', why: 'the stop is already as tight or tighter' };
  return { action: 'raise', newSl: target, label };
}

// Anything arriving from a bot must not undo the Sentinel's stop. Same rule as profitguard.clampStop.
function clampStop(side, incoming, floor) {
  const f = Number(floor);
  if (!(f > 0)) return null;
  const inc = Number(incoming), long = side === 'Buy';
  if (!(inc > 0)) return f;
  if (long ? inc < f : inc > f) return f;
  return null;
}

// ---- learning from history (pure) ----
// Replays one finished trade over its 1-minute candles. trade: { side, entry, initialSl, entryAt, exitAt }, candles: oldest first, starting before entryAt.
// Returns samples { x: [normalized features in KEYS order], y: 1 if from this point the price reached the ORIGINAL stop before making a new best +0.5R, else 0 }.
function replay(trade, candles, cfg, profile) {
  const long = trade.side === 'Buy', entry = Number(trade.entry), init = Number(trade.initialSl), risk = Math.abs(entry - init);
  const out = [];
  if (!(risk > 0) || !candles || candles.length < 20) return out;
  let peak = entry, peakAt = trade.entryAt, firstIdx = candles.findIndex(c => c.t >= trade.entryAt);
  if (firstIdx < 0) return out;
  for (let k = firstIdx; k < candles.length && candles[k].t <= trade.exitAt; k++) {
    const c = candles[k];
    const hi = long ? c.h : c.l;
    if (long ? hi > peak : hi < peak) { peak = hi; peakAt = c.t; }
    if (k < firstIdx + 3 || k < 6) continue;
    const win = candles.slice(0, k + 1), now = c.t + 60000;
    const f = features({ side: trade.side, entry, mark: c.c, peak, peakAt, entryAt: trade.entryAt, now, initialSl: init, candles: win, btcPct: trade.btcPct, profile, cfg });
    if (!f) continue;
    const nf = normFeatures(f, profile, cfg);
    const peakR = f.peakR;
    let y = 0;
    for (let j = k + 1; j < candles.length && candles[j].t <= trade.exitAt; j++) {   // what happened next
      const lo = long ? candles[j].l : candles[j].h, up = long ? candles[j].h : candles[j].l;
      const downR = ((long ? lo - entry : entry - lo) / risk), upR = ((long ? up - entry : entry - up) / risk);
      if (downR <= -1) { y = 1; break; }
      if (upR >= peakR + 0.5) break;
    }
    out.push({ x: KEYS.map(key => nf[key]), y, t: c.t, score: score(nf, cfg.weights, 1) });
  }
  return out;
}

// Logistic regression with L2, plain gradient descent. Returns weights scaled to sum 100, or null when there is not enough evidence.
function fitWeights(samples, cfg) {
  const pos = samples.filter(s => s.y === 1).length, neg = samples.length - pos;
  if (pos < 10 || neg < 10) return null;
  const n = samples.length, w = KEYS.map(() => 0); let b = Math.log((pos + 1) / (neg + 1));
  const wp = n / (2 * pos), wn = n / (2 * neg);                                   // balance the classes
  const lr = 0.5, l2 = 0.01;
  for (let it = 0; it < 400; it++) {
    const g = KEYS.map(() => 0); let gb = 0;
    for (const s of samples) {
      let z = b; for (let k = 0; k < w.length; k++) z += w[k] * s.x[k];
      const p = 1 / (1 + Math.exp(-z)), e = (p - s.y) * (s.y ? wp : wn);
      for (let k = 0; k < w.length; k++) g[k] += e * s.x[k]; gb += e;
    }
    for (let k = 0; k < w.length; k++) w[k] -= lr * (g[k] / n + l2 * w[k]);
    b -= lr * gb / n;
  }
  const clipped = w.map(v => Math.max(0, v));                                    // a feature never counts AGAINST danger
  const sum = clipped.reduce((t, v) => t + v, 0);
  if (!(sum > 0)) return null;
  const out = {}; KEYS.forEach((k, i) => { out[k] = Math.round(clipped[i] / sum * 1000) / 10; });
  return normWeights(out, DEFAULT_WEIGHTS);
}

// How a set of weights would have done on samples at the alert boundary.
function evalWeights(samples, weights, th) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of samples) {
    let sc = 0; KEYS.forEach((k, i) => { sc += (weights[k] || 0) * s.x[i]; });
    const hit = sc >= th.alert;
    if (hit && s.y) tp++; else if (hit) fp++; else if (s.y) fn++; else tn++;
  }
  return { n: samples.length, tp, fp, fn, tn, recall: tp + fn ? tp / (tp + fn) : null, precision: tp + fp ? tp / (tp + fp) : null };
}

// v2.9.10 one-time migration: a SAVED Sentinel whose profit start is still exactly the old default (0.3R) moves to the new default (0.7R). A value anyone chose
// themselves (anything but 0.3) is never touched, and the caller marks the migration done so a later deliberate 0.3 is respected.
function migrateStart(cfg, hadSaved) {
  if (!hadSaved || !cfg || !cfg.profit || Math.abs(Number(cfg.profit.startR) - 0.3) > 1e-9) return { cfg, changed: false };
  return { cfg: normalize({ ...cfg, profit: { ...cfg.profit, startR: 0.7 } }), changed: true };
}

module.exports = { migrateStart, MODES, PMODES, KEYS, STATES, DEFAULT_WEIGHTS, defaults, normalize, effMode, atrOf, features, normFeatures, score, stateFor, step, labelTrade, labelMult, decide, clampStop, replay, fitWeights, evalWeights };
