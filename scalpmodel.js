'use strict';
// YM Oracle v2.9.16: the SCALP model (v2.9.15 base + risk-based leverage, per-group targets, trailing/stall exits, gates, portfolio guards, walk-forward). Pure functions, no database, no network, no timers.
// A scalp = take one of the normal calls, wait until price has started to move our way (Confirmed entry),
// then jump out quickly at a small target, a tight stop, break-even after half the target, or a short time limit.
// All numbers are percent of PRICE (not of margin). Costs (fees + slippage) are charged on every entered trade.

const DEFAULTS = {
  confirmPct: 0.25,        // price must move this far our way before we enter (Confirmed entry)
  confirmWindowMin: 10,    // ... within this many minutes of the call, else the call is skipped
  targetFrac: 0.6,         // target = this share of the recent average winning move
  targetFloorPct: 0.5,     // never smaller than this (about 3x the round-trip cost)
  targetCapPct: 1.5,       // never larger than this (a scalp is a small, quick move)
  fallbackTargetPct: 0.8,  // used until enough winners are recorded
  stopFrac: 1.0,           // stop distance = target distance x this
  beFrac: 0.5,             // after half the target is reached the stop moves to the entry price
  timeStopMin: 20,         // leave after this many minutes whatever the price is
  feePct: 0.11,            // taker fee in + out, percent of position
  slipPct: 0.05,           // assumed slippage in + out, percent of position
  minWins: 8,              // winners needed before the average is trusted
  leverage: 5,             // set by the system for the scalp lane
  shadowUsd: 1000,         // margin per trade in the shadow test
  instant: false,          // Instant entry (no confirmation): shadow comparison only
  // ---- v2.9.16 ----
  riskPct: 4,              // loss at the stop, as percent of the margin put in (leverage is worked out from this)
  maxLev: 10,              // leverage never above this
  liqMult: 3,              // the liquidation price must be at least this many stop-distances away
  mmrPct: 0.5,             // maintenance margin used in the liquidation estimate
  trail: true,             // after the target is reached, trail instead of leaving at once
  trailGive: 0.3,          // trailing room = this share of the best gain so far (at least trailMinPct)
  trailMinPct: 0.15,
  trailLockFrac: 0.85,     // once the target is reached the stop never sits below this share of the target
  stallMin: 5,             // leave in profit when no new best price for this many minutes (0 = off)
  minGroupRows: 12,        // recorded calls needed before a coin's own history picks its target
  maxSpreadPct: 0.05,      // gate: skip when the bid/ask gap is wider than this (percent of price)
  minTurnoverUsd: 5000000, // gate: skip thin coins (24 h turnover)
  onlyFast: false,         // gate (off by default): only calls Pace calls FAST
  fastConfirmMin: 0,       // gate (off by default): only when confirmed within this many minutes (0 = off)
  maxMovedAtr: 0,          // gate (off by default): skip when more than this many ranges have already moved (0 = off)
  maxSameSide: 3,          // portfolio: at most this many open scalps in the same direction
  dailyLossUsd: 200,       // portfolio: stop for the day after losing this much (test amount)
};

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function normalize(c) {
  const o = { ...DEFAULTS };
  const s = c || {};
  const lim = {
    confirmPct: [0.05, 2], confirmWindowMin: [1, 60], targetFrac: [0.2, 1], targetFloorPct: [0.2, 3], targetCapPct: [0.3, 5],
    fallbackTargetPct: [0.2, 3], stopFrac: [0.3, 3], beFrac: [0.2, 0.9], timeStopMin: [3, 120], feePct: [0, 0.5], slipPct: [0, 0.5],
    minWins: [3, 100], leverage: [1, 10], shadowUsd: [10, 100000],
    riskPct: [0.5, 20], maxLev: [1, 10], liqMult: [1.5, 10], mmrPct: [0, 3], trailGive: [0.1, 0.8], trailMinPct: [0.05, 1], trailLockFrac: [0.3, 1],
    stallMin: [0, 60], minGroupRows: [5, 200], maxSpreadPct: [0.01, 1], minTurnoverUsd: [0, 1e9], fastConfirmMin: [0, 60], maxMovedAtr: [0, 20], maxSameSide: [1, 20], dailyLossUsd: [10, 1e6],
  };
  for (const k of Object.keys(lim)) if (s[k] !== undefined && s[k] !== null && s[k] !== '') o[k] = clamp(num(s[k], DEFAULTS[k]), lim[k][0], lim[k][1]);
  if (o.targetCapPct < o.targetFloorPct) o.targetCapPct = o.targetFloorPct;
  o.instant = s.instant === true;
  o.trail = s.trail === undefined ? DEFAULTS.trail : (s.trail === true || s.trail === 'true');
  o.onlyFast = s.onlyFast === true || s.onlyFast === 'true';
  return o;
}

function costPct(cfg) { return num(cfg.feePct, 0.11) + num(cfg.slipPct, 0.05); }

function median(a) {
  const x = a.filter(v => Number.isFinite(v)).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = x.length >> 1;
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}

// target (percent of price) from the recent winners' favourable moves (percent of price, positive numbers)
function targetPct(winMoves, cfgIn) {
  const cfg = normalize(cfgIn);
  const w = (winMoves || []).map(Number).filter(v => v > 0 && Number.isFinite(v));
  if (w.length < cfg.minWins) return { pct: clamp(cfg.fallbackTargetPct, cfg.targetFloorPct, cfg.targetCapPct), n: w.length, source: 'fallback', median: null };
  const m = median(w);
  return { pct: Math.round(clamp(m * cfg.targetFrac, cfg.targetFloorPct, cfg.targetCapPct) * 1000) / 1000, n: w.length, source: 'wins', median: Math.round(m * 1000) / 1000 };
}

// Walk one price path. path = [{ t: ms since the call, p: price }] in time order. side = 'Buy' | 'Sell'.
// Returns { entered, reason?, entryT, entryPx, exit, grossPct, netPct, mfePct, maePct, heldMin }
function simulate(path, side, signalPx, cfgIn, opts) {
  const cfg = normalize(cfgIn);
  const dir = side === 'Buy' ? 1 : -1;
  const target = num(opts && opts.target, cfg.fallbackTargetPct);
  const stopPct = target * cfg.stopFrac;
  const pts = (path || []).filter(x => x && x.p > 0 && Number.isFinite(x.t));
  if (!pts.length || !(signalPx > 0)) return { entered: false, reason: 'no data' };
  let i0 = -1, entryPx = 0, entryT = 0;
  if (cfg.instant) { i0 = 0; entryPx = signalPx; entryT = 0; }
  else {
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].t > cfg.confirmWindowMin * 60000) break;
      if (dir * (pts[i].p - signalPx) / signalPx * 100 >= cfg.confirmPct) { i0 = i; entryPx = pts[i].p; entryT = pts[i].t; break; }
    }
    if (i0 < 0) return { entered: false, reason: 'no confirmation' };
  }
  const cost = costPct(cfg);
  let mfe = 0, mae = 0, be = false, last = null, armed = false, lastHighT = entryT;
  const fin = (exit, gross, t) => ({
    entered: true, entryT, entryPx, exit, grossPct: Math.round(gross * 1000) / 1000, netPct: Math.round((gross - cost) * 1000) / 1000,
    mfePct: Math.round(mfe * 1000) / 1000, maePct: Math.round(mae * 1000) / 1000, heldMin: Math.round((t - entryT) / 600) / 100,
  });
  for (let i = i0 + (cfg.instant ? 0 : 1); i < pts.length; i++) {
    const t = pts[i].t, g = dir * (pts[i].p - entryPx) / entryPx * 100;
    last = { t, g };
    if (g > mfe + 0.02) lastHighT = t;
    if (g > mfe) mfe = g;
    if (g < mae) mae = g;
    if (armed) {   // the target was reached: trail. The stop never sits below a share of the target.
      const lvl = Math.max(mfe - Math.max(cfg.trailMinPct, cfg.trailGive * mfe), target * cfg.trailLockFrac);
      if (g <= lvl) return fin('trail', g, t);
      if (t - entryT >= cfg.timeStopMin * 60000) return fin('time', g, t);
      continue;
    }
    // order of checks inside one sample: stop first (the careful assumption), then target
    const floor = be ? 0 : -stopPct;
    if (g <= floor) return fin(be ? 'breakeven' : 'stop', g, t);   // the sampled price, not the level: honest when price gaps past the stop
    if (g >= target) { if (cfg.trail) { armed = true; continue; } return fin('target', target, t); }
    if (!be && g >= target * cfg.beFrac) be = true;
    if (cfg.stallMin > 0 && t - lastHighT >= cfg.stallMin * 60000 && g >= cost + 0.05) return fin('stall', g, t);   // no new best price for a while, and in profit: take it
    if (t - entryT >= cfg.timeStopMin * 60000) return fin('time', g, t);
  }
  if (!last) return fin('end', 0, entryT);
  return fin('end', last.g, last.t);
}

// ---- v2.9.16 ----
// Leverage from risk: loss at the stop (percent of margin) = leverage x stop distance (percent of price), so leverage = riskPct / stopPct.
// Capped by maxLev and by liquidation: liquidation is about (100/leverage - mmr)% away and must be at least liqMult stop-distances away.
function leverageFor(stopPct, cfgIn) {
  const cfg = normalize(cfgIn);
  const sp = Math.max(0.01, num(stopPct, 1));
  const byRisk = cfg.riskPct / sp, byLiq = 100 / (cfg.liqMult * sp + cfg.mmrPct);
  let lev = byRisk, by = 'risk';
  if (cfg.maxLev < lev) { lev = cfg.maxLev; by = 'maxLev'; }
  if (byLiq < lev) { lev = byLiq; by = 'liquidation'; }
  lev = Math.max(1, Math.floor(lev * 10) / 10);
  return { lev, limitedBy: by, riskPctOfMargin: Math.round(lev * sp * 100) / 100 };
}

// The target for one call from the recorded paths of its group (same coin, else all coins). Picks the target with the best average
// result after costs, but only when it clearly beats the plain default (by 0.05%); a group with no positive target is flagged.
function bestTarget(rows, cfgIn, gridIn) {
  const cfg = normalize(cfgIn);
  const grid = (gridIn || [0.5, 0.6, 0.8, 1.0, 1.25, 1.5]).filter(v => v >= cfg.targetFloorPct && v <= cfg.targetCapPct);
  const dflt = clamp(cfg.fallbackTargetPct, cfg.targetFloorPct, cfg.targetCapPct);
  const rs = (rows || []).filter(r => r && Array.isArray(r.path) && r.path.length > 2);
  if (rs.length < cfg.minGroupRows || !grid.length) return { pct: dflt, source: 'default', n: rs.length, skip: false };
  const evalT = (target) => {
    const res = []; for (const r of rs) { const x = simulate(r.path, r.side, r.signalPx, cfg, { target }); if (x.entered) res.push(x.netPct); }
    return { n: res.length, avg: res.length ? res.reduce((a, b) => a + b, 0) / res.length : null };
  };
  const base = evalT(dflt);
  let best = { t: dflt, ...base };
  for (const t of grid) { const e = evalT(t); if (e.n >= Math.min(8, cfg.minGroupRows) && e.avg !== null && (best.avg === null || e.avg > best.avg)) best = { t, ...e }; }
  const r3 = v => v === null ? null : Math.round(v * 1000) / 1000;
  if (best.avg === null || best.avg <= 0) return { pct: dflt, source: 'group', n: rs.length, entered: best.n, avgNet: r3(best.avg), skip: true, why: 'no target in this group made money after costs' };
  const use = base.avg !== null && best.avg - base.avg < 0.05 ? dflt : best.t;
  return { pct: use, source: 'group', n: rs.length, entered: best.n, avgNet: r3(use === best.t ? best.avg : base.avg), skip: false };
}

// Quality gates. feat = { spreadPct, turnoverUsd, movedAtr }. Returns the first reason to skip, or null.
function gateCheck(feat, entryMin, klass, cfgIn) {
  const cfg = normalize(cfgIn), f = feat || {};
  if (f.spreadPct !== undefined && f.spreadPct !== null && f.spreadPct > cfg.maxSpreadPct) return 'wide spread';
  if (f.turnoverUsd !== undefined && f.turnoverUsd !== null && cfg.minTurnoverUsd > 0 && f.turnoverUsd < cfg.minTurnoverUsd) return 'thin coin';
  if (cfg.onlyFast && klass !== 'FAST') return 'not FAST';
  if (cfg.maxMovedAtr > 0 && f.movedAtr !== undefined && f.movedAtr !== null && f.movedAtr > cfg.maxMovedAtr) return 'already moved';
  if (cfg.fastConfirmMin > 0 && entryMin !== null && entryMin !== undefined && entryMin > cfg.fastConfirmMin) return 'slow confirmation';
  return null;
}

// Portfolio guards over entered trades [{ startMs, endMs, side, usd }]: at most maxSameSide open in one direction, and the lane stops
// for the UTC day after dailyLossUsd is lost. Returns { accepted, skipped: { crowd, dayloss } }.
function portfolio(trades, cfgIn) {
  const cfg = normalize(cfgIn);
  const t = [...(trades || [])].sort((a, b) => a.startMs - b.startMs);
  const acc = [], skipped = { crowd: 0, dayloss: 0 };
  for (const x of t) {
    const day = new Date(x.startMs).toISOString().slice(0, 10);
    const realized = acc.filter(a => a.endMs <= x.startMs && new Date(a.startMs).toISOString().slice(0, 10) === day).reduce((p, a) => p + (a.usd || 0), 0);
    if (realized <= -cfg.dailyLossUsd) { skipped.dayloss++; continue; }
    const open = acc.filter(a => a.side === x.side && a.endMs > x.startMs).length;
    if (open >= cfg.maxSameSide) { skipped.crowd++; continue; }
    acc.push(x);
  }
  return { accepted: acc, skipped };
}

// USD result of a net percent on a position (margin x leverage)
function usdOf(netPct, cfgIn, marginUsd, lev) {
  const cfg = normalize(cfgIn);
  const m = num(marginUsd, cfg.shadowUsd);
  return Math.round(netPct / 100 * m * num(lev, cfg.leverage) * 100) / 100;
}

// Summary of finished simulated trades [{ netPct, grossPct, exit, ts }]
function summarize(trades) {
  const t = (trades || []).filter(x => x && Number.isFinite(x.netPct));
  const n = t.length;
  if (!n) return { n: 0, wins: 0, winRate: null, avgNet: null, sumNet: 0, avgWin: null, avgLoss: null, halves: [null, null], exits: {} };
  const wins = t.filter(x => x.netPct > 0), loss = t.filter(x => x.netPct <= 0);
  const avg = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
  const r3 = v => v === null ? null : Math.round(v * 1000) / 1000;
  const sorted = [...t].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const h = sorted.length >> 1;
  const exits = {}; for (const x of t) exits[x.exit || '?'] = (exits[x.exit || '?'] || 0) + 1;
  return {
    n, wins: wins.length, winRate: r3(wins.length / n), avgNet: r3(avg(t.map(x => x.netPct))), sumNet: r3(t.reduce((p, q) => p + q.netPct, 0)),
    avgWin: r3(avg(wins.map(x => x.netPct))), avgLoss: r3(avg(loss.map(x => x.netPct))),
    halves: n >= 4 ? [r3(avg(sorted.slice(0, h).map(x => x.netPct))), r3(avg(sorted.slice(h).map(x => x.netPct)))] : [null, null], exits,
  };
}

function styleOf(style, cfg) { return style === 'fixed' ? { trail: false, stallMin: 0 } : style === 'trail' ? { trail: true, stallMin: 0 } : { trail: true, stallMin: cfg.stallMin > 0 ? cfg.stallMin : 5 }; }

// The Lab: replay recorded paths over a grid of rules. rows = [{ side, signalPx, path, ts }]
function lab(rows, cfgIn, gridIn) {
  const cfg = normalize(cfgIn);
  const g = gridIn || {};
  const targets = g.targets || [0.5, 0.8, 1.0, 1.5];
  const confirms = g.confirms || [0.15, 0.25, 0.4];
  const times = g.times || [10, 20, 40];
  const styles = g.styles || ['fixed', 'trail', 'smart'];
  const out = [];
  for (const style of styles) for (const target of targets) for (const confirmPct of confirms) for (const timeStopMin of times) {
    const c = { ...cfg, confirmPct, timeStopMin, ...styleOf(style, cfg) };
    const res = [];
    let seen = 0;
    for (const r of rows || []) {
      seen++;
      const s = simulate(r.path, r.side, r.signalPx, c, { target });
      if (s.entered) res.push({ ...s, ts: r.ts });
    }
    const sm = summarize(res);
    const ok = sm.n >= 30 && sm.avgNet > 0 && sm.halves[0] > 0 && sm.halves[1] > 0;
    out.push({ style, target, confirmPct, timeStopMin, calls: seen, entered: sm.n, winRate: sm.winRate, avgNet: sm.avgNet, sumNet: sm.sumNet, halves: sm.halves, robust: !!ok });
  }
  out.sort((a, b) => (b.avgNet === null ? -1e9 : b.avgNet) - (a.avgNet === null ? -1e9 : a.avgNet));
  return out;
}

// go-live test: shadow trades must show a real, steady edge after costs
function verdict(sm, minTrades = 50, minAvgNet = 0.15) {
  if (!sm || sm.n < minTrades) return { ready: false, why: 'only ' + (sm ? sm.n : 0) + ' of ' + minTrades + ' shadow trades so far' };
  if (!(sm.avgNet >= minAvgNet)) return { ready: false, why: 'average ' + sm.avgNet + '% per trade after costs; needs at least ' + minAvgNet + '%' };
  if (!(sm.halves[0] > 0 && sm.halves[1] > 0)) return { ready: false, why: 'not positive in both halves of the test' };
  return { ready: true, why: 'average ' + sm.avgNet + '% per trade after costs on ' + sm.n + ' trades, positive in both halves' };
}

// Walk-forward suggestion: choose rules on the older 70% of the calls, accept them only if they also beat the current rules on the newer 30%.
function walkForward(rows, cfgIn, gridIn) {
  const cfg = normalize(cfgIn);
  const all = [...(rows || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (all.length < 40) return { suggest: null, why: 'needs at least 40 recorded calls (' + all.length + ' so far)' };
  const cut = Math.floor(all.length * 0.7), train = all.slice(0, cut), test = all.slice(cut);
  const best = lab(train, cfg, gridIn).find(x => x.entered >= 15 && x.avgNet > 0);
  if (!best) return { suggest: null, why: 'nothing made money after costs on the older calls' };
  const run = (c, target) => { const res = []; for (const r of test) { const x = simulate(r.path, r.side, r.signalPx, c, { target }); if (x.entered) res.push({ netPct: x.netPct }); } return summarize(res); };
  const sc = { ...cfg, confirmPct: best.confirmPct, timeStopMin: best.timeStopMin, ...styleOf(best.style, cfg) };
  const val = run(sc, best.target), cur = run(cfg, cfg.fallbackTargetPct);
  const out = { suggest: null, train: { entered: best.entered, avgNet: best.avgNet }, validate: { n: val.n, avgNet: val.avgNet }, current: { n: cur.n, avgNet: cur.avgNet }, candidate: { style: best.style, target: best.target, confirmPct: best.confirmPct, timeStopMin: best.timeStopMin } };
  if (val.n < 10) return { ...out, why: 'the newer calls give only ' + val.n + ' trades under these rules; too few to confirm' };
  if (!(val.avgNet > 0)) return { ...out, why: 'the rules that won on the older calls lose on the newer ones (' + val.avgNet + '%): that is noise, not an edge' };
  if (cur.avgNet !== null && val.avgNet - cur.avgNet < 0.05) return { ...out, why: 'no clear gain over the current rules on the newer calls' };
  return { ...out, suggest: { confirmPct: best.confirmPct, timeStopMin: best.timeStopMin, trail: best.style !== 'fixed', stallMin: best.style === 'smart' ? (cfg.stallMin > 0 ? cfg.stallMin : 5) : 0 }, why: 'held up on the newer calls: ' + val.avgNet + '% per trade vs ' + cur.avgNet + '% now' };
}

module.exports = { DEFAULTS, normalize, costPct, median, targetPct, simulate, usdOf, summarize, lab, verdict, leverageFor, bestTarget, gateCheck, portfolio, walkForward, styleOf };
