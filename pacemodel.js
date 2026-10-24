'use strict';
// PACE MODEL (v2.9.13). Tells apart calls that run FAST (hours) from the ones that will be SLOW (days), from numbers the relay already has.
// Pure functions only (no network, no database).
//   features   at signal time: how far the stop is in hourly ranges (ATRs), how fast the pair moves right now, how much of the move is already used, BTC's direction
//   score      those features -> 0..100, a class (FAST / NORMAL / SLOW), an estimate of the hours the first +1R needs, and the reasons in words
//   proof      after entry: how much R the trade really made by 15 / 30 / 60 min (fast trades prove themselves early, slow ones look flat)
//   label      after the fact: FAST (+1R within 3 h), SLOW (never +0.5R in 6 h), NORMAL, or UNCLEAR (closed early without the evidence to say)
//   buckets    history report: how past trades split by stop distance
// The scoring numbers are a starting hypothesis from a handful of trades, NOT proven. The relay records them in shadow next to what really happened, so they can be checked and changed.
// Modes: off | shadow (record and show only) | alert (shadow + one Telegram note when a trade proves slow).

const MODES = ['off', 'shadow', 'alert'];
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const obj = v => (v && typeof v === 'object' ? v : {});

function defaults() {
  return {
    mode: 'shadow',
    fastAt: 62, slowAt: 38,              // score at or above = FAST, at or below = SLOW
    hardSlowStopPct: 10, hardSlowStopAtr: 10,   // a stop this wide can never be a trade of hours
    proof: { fastR: 0.3, fastByMin: 30, slowR: 0.1, slowAfterMin: 45, slow2R: 0.4, slow2AfterMin: 120 },
    label: { fastR: 1.0, fastWithinMin: 180, slowR: 0.5, slowAfterMin: 360 },
  };
}
function normalize(raw) {
  const d = defaults(), r = obj(raw), p = obj(r.proof), l = obj(r.label);
  const out = {
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    fastAt: num(r.fastAt, 50, 95, d.fastAt), slowAt: num(r.slowAt, 5, 50, d.slowAt),
    hardSlowStopPct: num(r.hardSlowStopPct, 3, 50, d.hardSlowStopPct), hardSlowStopAtr: num(r.hardSlowStopAtr, 3, 50, d.hardSlowStopAtr),
    proof: {
      fastR: num(p.fastR, 0.1, 2, d.proof.fastR), fastByMin: num(p.fastByMin, 5, 240, d.proof.fastByMin),
      slowR: num(p.slowR, 0, 1, d.proof.slowR), slowAfterMin: num(p.slowAfterMin, 10, 600, d.proof.slowAfterMin),
      slow2R: num(p.slow2R, 0, 2, d.proof.slow2R), slow2AfterMin: num(p.slow2AfterMin, 30, 1440, d.proof.slow2AfterMin),
    },
    label: {
      fastR: num(l.fastR, 0.3, 3, d.label.fastR), fastWithinMin: num(l.fastWithinMin, 30, 1440, d.label.fastWithinMin),
      slowR: num(l.slowR, 0.1, 2, d.label.slowR), slowAfterMin: num(l.slowAfterMin, 60, 4320, d.label.slowAfterMin),
    },
  };
  if (out.slowAt >= out.fastAt) { out.fastAt = d.fastAt; out.slowAt = d.slowAt; }
  return out;
}

const atrOf = (bars, n = 14) => {
  const c = (bars || []).slice(-(n + 1)); if (c.length < 2) return 0;
  let s = 0, k = 0;
  for (let i = 1; i < c.length; i++) { s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); k++; }
  return k ? s / k : 0;
};
const sumV = (bars, a, b) => { let s = 0; for (let i = a; i < b; i++) s += Number(bars[i] && bars[i].v) || 0; return s; };

// i: { side:'Buy'|'Sell', entry, sl, bars1m (oldest first, ~60), bars1h (oldest first, ~40), btcPct (BTC's move over ~15 min in %, as it happened) }
function features(i) {
  const long = i.side === 'Buy', entry = Number(i.entry), sl = Number(i.sl);
  if (!(entry > 0) || !(sl > 0) || (long ? sl >= entry : sl <= entry)) return null;
  const dir = long ? 1 : -1, stopDist = Math.abs(entry - sl), stopPct = stopDist / entry * 100;
  const f = { stopPct: Math.round(stopPct * 100) / 100 };
  const h = i.bars1h || [], m = i.bars1m || [];
  const atrH = atrOf(h), atrM = atrOf(m);
  if (atrH > 0) {
    f.atrHPct = Math.round(atrH / entry * 10000) / 100;
    f.stopAtr = Math.round(stopDist / atrH * 100) / 100;
    if (atrM > 0) f.volExp = Math.round(atrM * Math.sqrt(60) / atrH * 100) / 100;          // 1-minute ranges scaled to an hour, against the real hourly range: above 1 = faster than usual right now
    if (h.length >= 6) {                                                                      // the move already made in the trade's direction over the last 4 hours, in hourly ranges
      const a = h[h.length - 5].c, b = h[h.length - 1].c;
      if (a > 0) { f.moved4hPct = Math.round((b - a) / a * dir * 10000) / 100; f.movedAtr = Math.round((b - a) * dir / atrH * 100) / 100; }
    }
  }
  if (m.length >= 30) {
    const recent = sumV(m, m.length - 15, m.length), before = sumV(m, 0, m.length - 15) / Math.max(1, (m.length - 15) / 15);
    if (before > 0) f.volRatio = Math.round(recent / before * 100) / 100;                    // last 15 minutes of volume against a normal 15 minutes
  }
  if (Number.isFinite(Number(i.btcPct))) f.btcDir = Math.round(Number(i.btcPct) * dir * 100) / 100;   // BTC's move in the trade's direction (positive = BTC helps)
  return f;
}

function score(f, cfg) {
  cfg = cfg || defaults();
  if (!f) return null;
  let s = 50; const why = [];
  const add = (pts, text) => { s += pts; if (text) why.push(text + ' (' + (pts > 0 ? '+' : '') + pts + ')'); };
  const hard = (f.stopPct >= cfg.hardSlowStopPct) ? 'the stop is ' + f.stopPct.toFixed(1) + '% away: a move that size takes days'
    : (f.stopAtr >= cfg.hardSlowStopAtr ? 'the stop is ' + f.stopAtr.toFixed(1) + ' hourly ranges away: a move that size takes days' : null);
  if (f.stopAtr !== undefined) {
    const a = f.stopAtr;
    if (a <= 2) add(25, 'stop only ' + a.toFixed(1) + ' hourly ranges away'); else if (a <= 3) add(18, 'stop ' + a.toFixed(1) + ' hourly ranges away'); else if (a <= 4) add(10, 'stop ' + a.toFixed(1) + ' hourly ranges away');
    else if (a <= 5) { /* neutral */ } else if (a <= 7) add(-12, 'stop ' + a.toFixed(1) + ' hourly ranges away'); else if (a <= 10) add(-25, 'stop ' + a.toFixed(1) + ' hourly ranges away'); else add(-35, 'stop ' + a.toFixed(1) + ' hourly ranges away');
  }
  if (f.volExp !== undefined) { if (f.volExp >= 1.3) add(12, 'moving ' + f.volExp.toFixed(1) + 'x faster than its usual hour'); else if (f.volExp >= 1.0) add(6, 'moving at a normal-to-brisk pace'); else if (f.volExp < 0.6) add(-10, 'quiet right now'); }
  if (f.volRatio !== undefined) { if (f.volRatio >= 2) add(10, 'volume ' + f.volRatio.toFixed(1) + 'x normal'); else if (f.volRatio >= 1.3) add(5, 'volume picking up'); else if (f.volRatio < 0.7) add(-8, 'thin volume'); }
  if (f.movedAtr !== undefined) {
    if (f.movedAtr >= 5) add(-20, 'already ran ' + f.movedAtr.toFixed(1) + ' hourly ranges in this direction (chasing)'); else if (f.movedAtr >= 3) add(-10, 'already moved ' + f.movedAtr.toFixed(1) + ' hourly ranges in this direction');
    else if (f.movedAtr >= 0.5) add(5, 'early in the move');
  }
  if (f.btcDir !== undefined) { if (f.btcDir >= 0.3) add(6, 'BTC is helping'); else if (f.btcDir <= -0.3) add(-6, 'BTC is against it'); }
  s = Math.max(0, Math.min(100, Math.round(s)));
  let klass = s >= cfg.fastAt ? 'FAST' : s <= cfg.slowAt ? 'SLOW' : 'NORMAL';
  if (hard) { klass = 'SLOW'; why.unshift(hard); }
  // rough hours for the first +1R: a random walk needs about (stop in hourly ranges)^2 hours; a trending pair is quicker, a choppy one slower
  let hours = null;
  if (f.stopAtr > 0) hours = Math.max(0.5, Math.min(240, f.stopAtr * f.stopAtr * (klass === 'FAST' ? 0.5 : klass === 'SLOW' ? 1.5 : 1)));
  else if (f.stopPct > 0) hours = klass === 'FAST' ? 2 : klass === 'SLOW' ? 48 : 8;
  return { score: s, klass, hours: hours === null ? null : Math.round(hours * 10) / 10, why, hard: !!hard };
}
const hoursText = h => (h === null || h === undefined ? '?' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? (Math.round(h * 10) / 10) + ' h' : Math.round(h / 24 * 10) / 10 + ' days');
const lineOf = sc => (sc ? 'Pace     ' + sc.klass + ' (~' + hoursText(sc.hours) + ' to +1R), score ' + sc.score : '');

// i: { elapsedMin, peakR, nowR }
function proof(i, cfg) {
  cfg = cfg || defaults(); const p = cfg.proof, e = Number(i.elapsedMin), pk = Number(i.peakR) || 0;
  if (!(e >= 0)) return { state: 'pending', why: 'no clock' };
  if (pk >= p.fastR && e <= p.fastByMin) return { state: 'fast', why: 'made ' + pk.toFixed(2) + 'R in ' + Math.round(e) + ' min' };
  if (e >= p.slow2AfterMin && pk < p.slow2R) return { state: 'slow', why: 'only ' + pk.toFixed(2) + 'R after ' + Math.round(e) + ' min' };
  if (e >= p.slowAfterMin && pk < p.slowR) return { state: 'slow', why: 'flat: best ' + pk.toFixed(2) + 'R after ' + Math.round(e) + ' min' };
  if (e > p.fastByMin && pk >= p.fastR) return { state: 'normal', why: 'got to ' + pk.toFixed(2) + 'R, but not within ' + p.fastByMin + ' min' };
  return { state: 'pending', why: Math.round(e) + ' min in, best ' + pk.toFixed(2) + 'R' };
}

// i: { t05Min, t10Min (minutes from entry until peak R first reached the levels, null if never), lifeMin (how long it has been open or was open), closed }
function label(i, cfg) {
  cfg = cfg || defaults(); const l = cfg.label, life = Number(i.lifeMin) || 0;
  if (i.t10Min !== null && i.t10Min !== undefined && i.t10Min <= l.fastWithinMin) return 'FAST';
  const reachedHalf = i.t05Min !== null && i.t05Min !== undefined;
  if (!reachedHalf && life >= l.slowAfterMin) return 'SLOW';
  if (reachedHalf || (i.t10Min !== null && i.t10Min !== undefined)) return 'NORMAL';
  return i.closed ? 'UNCLEAR' : 'OPEN';
}

// Turn a trade's recorded path [{ min, peakR }] (oldest first) into the times to +0.5R and +1R.
function timesFromPath(path, cfg) {
  cfg = cfg || defaults(); let t05 = null, t10 = null;
  for (const p of path || []) {
    if (t05 === null && p.peakR >= cfg.label.slowR) t05 = p.min;
    if (t10 === null && p.peakR >= cfg.label.fastR) t10 = p.min;
  }
  return { t05Min: t05, t10Min: t10 };
}

const median = a => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
// rows: [{ stopPct, klass (label), ... }] -> how past trades split by stop distance
function buckets(rows) {
  const edges = [[0, 3, 'under 3%'], [3, 6, '3-6%'], [6, 10, '6-10%'], [10, 1e9, '10% and over']];
  return edges.map(([lo, hi, name]) => {
    const r = rows.filter(x => x.stopPct >= lo && x.stopPct < hi), c = { FAST: 0, NORMAL: 0, SLOW: 0, UNCLEAR: 0, OPEN: 0 };
    for (const x of r) if (c[x.label] !== undefined) c[x.label]++;
    const known = c.FAST + c.NORMAL + c.SLOW;
    return { bucket: name, n: r.length, fast: c.FAST, normal: c.NORMAL, slow: c.SLOW, unclear: c.UNCLEAR + c.OPEN, fastShare: known ? Math.round(c.FAST / known * 100) : null, slowShare: known ? Math.round(c.SLOW / known * 100) : null };
  });
}
// rows: [{ label, features:{...} }] -> per feature, the median among FAST and among SLOW trades (so you can see whether it separates them)
function separation(rows) {
  const keys = ['stopPct', 'stopAtr', 'volExp', 'volRatio', 'movedAtr', 'btcDir'], out = [];
  for (const k of keys) {
    const fa = rows.filter(r => r.label === 'FAST' && r.features && Number.isFinite(Number(r.features[k]))).map(r => Number(r.features[k]));
    const sl = rows.filter(r => r.label === 'SLOW' && r.features && Number.isFinite(Number(r.features[k]))).map(r => Number(r.features[k]));
    out.push({ feature: k, fastN: fa.length, slowN: sl.length, fastMedian: median(fa), slowMedian: median(sl) });
  }
  return out;
}
// How often the signal-time class matched the label the trade really earned (only trades with a clear label).
function accuracy(rows) {
  const t = { FAST: { n: 0, FAST: 0, NORMAL: 0, SLOW: 0 }, NORMAL: { n: 0, FAST: 0, NORMAL: 0, SLOW: 0 }, SLOW: { n: 0, FAST: 0, NORMAL: 0, SLOW: 0 } };
  for (const r of rows) if (t[r.klass] && ['FAST', 'NORMAL', 'SLOW'].includes(r.label)) { t[r.klass].n++; t[r.klass][r.label]++; }
  return t;
}

// ---- v2.9.14: observed durations ----
// rows: [{ stopPct, stopAtr (optional), t10Min (minutes to +1R, null if never), lifeMin (minutes open, closed trades only), closed }]
const pct = (a, q) => { const x = a.filter(Number.isFinite).sort((p, r) => p - r); if (!x.length) return null; const i = (x.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const spread = a => { const m = pct(a, 0.5); return m === null ? null : { p25: pct(a, 0.25), med: m, p75: pct(a, 0.75), n: a.length }; };
const PCT_EDGES = [[0, 1.5, 'under 1.5%'], [1.5, 3, '1.5-3%'], [3, 6, '3-6%'], [6, 10, '6-10%'], [10, 1e9, '10% and over']];
const ATR_EDGES = [[0, 2, 'under 2 ranges'], [2, 3, '2-3 ranges'], [3, 5, '3-5 ranges'], [5, 8, '5-8 ranges'], [8, 1e9, '8 ranges and over']];
function groupStats(rows, key, edges) {
  return edges.map(([lo, hi, name]) => {
    const r = rows.filter(x => Number.isFinite(Number(x[key])) && x[key] !== null && Number(x[key]) >= lo && Number(x[key]) < hi);
    const hit = r.filter(x => x.t10Min !== null && x.t10Min !== undefined && Number.isFinite(Number(x.t10Min)));
    return { key, name, lo, hi, n: r.length, reached: hit.length, reachShare: r.length ? Math.round(hit.length / r.length * 100) : null,
      t10: spread(hit.map(x => Number(x.t10Min))), life: spread(r.filter(x => x.closed && Number.isFinite(Number(x.lifeMin))).map(x => Number(x.lifeMin))) };
  });
}
function calibrate(rows) { rows = rows || []; return { n: rows.length, byAtr: groupStats(rows, 'stopAtr', ATR_EDGES), byPct: groupStats(rows, 'stopPct', PCT_EDGES) }; }
// The best-supported group for this call: the hourly-range groups first, then the stop-% groups; a group needs `minN` similar trades, otherwise the rough formula stands.
function estimate(f, cal, sc, minN = 8) {
  if (f && cal) for (const [list, key] of [[cal.byAtr, 'stopAtr'], [cal.byPct, 'stopPct']]) {
    const v = f[key]; if (!Number.isFinite(Number(v))) continue;
    const g = (list || []).find(x => v >= x.lo && v < x.hi);
    if (g && g.n >= minN && g.reached >= 3 && g.t10) return { source: 'observed', n: g.n, reached: g.reached, group: g.name, t10: g.t10, life: g.life };
  }
  return { source: 'formula', n: 0, hours: sc ? sc.hours : null };
}
const hrs = m => (m < 60 ? Math.max(1, Math.round(m)) + ' min' : (Math.round(m / 6) / 10) + ' h');
function lineOfEst(sc, est) {
  if (!sc) return '';
  if (est && est.source === 'observed') {
    const t = est.t10, life = est.life;
    return 'Pace     ' + sc.klass + ' (score ' + sc.score + ')\n' + 'Like it   +1R usually in ' + hrs(t.p25) + ' to ' + hrs(t.p75) + ' (' + est.reached + ' of ' + est.n + ' similar trades got there)' + (life && life.n >= 3 ? ', usually done in ~' + hrs(life.med) : '');
  }
  return 'Pace     ' + sc.klass + ' (~' + hoursText(sc.hours) + ' to +1R, rough guess), score ' + sc.score;
}

module.exports = { calibrate, estimate, lineOfEst, pct, MODES, defaults, normalize, atrOf, features, score, hoursText, lineOf, proof, label, timesFromPath, buckets, separation, accuracy };
