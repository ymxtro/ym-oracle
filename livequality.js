'use strict';
// Live trade quality: a plain, explainable 0-100 reading of how an OPEN trade is doing, from what the relay can see (pure logic, no network, no database).
// It is a READING of the present, not a prediction. The four parts and their weights are shown in the admin so nothing is hidden:
//   progress   35  how far the price has moved in the trade's favour, in R (R = distance from entry to the original stop): -1R scores 0, +3R scores 100
//   protection 20  how safe the stop is: none = 0, still the original stop = 25, at breakeven = 60, more as profit is locked (up to 100)
//   momentum   25  profit given back from the best price (60%) and the last few minutes' move against the trade measured in the pair's own ATR (40%)
//   market     20  BTC's move over ~15 minutes in the trade's direction: -0.6% or worse scores 0, flat 67, +0.3% or better 100
// A part that cannot be read (no candles, no original stop) is left out and the others are re-weighted; the card says so.
const W = { progress: 35, protection: 20, momentum: 25, market: 20 };
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const BANDS = [[70, 'strong'], [50, 'steady'], [30, 'fragile'], [-1, 'at risk']];
const bandOf = s => BANDS.find(b => s >= b[0])[1];

// in: { side:'Buy'|'Sell', entry, mark, curSl, tp, initialSl, peak, atr, btcPct (in the trade's direction), recent:{ adv (move against the trade over the last ~3 bars, price units) } }
function assess(i) {
  const long = i.side === 'Buy', entry = num(i.entry), mark = num(i.mark);
  if (!(entry > 0) || !(mark > 0)) return null;
  const flags = [];
  let init = num(i.initialSl); const cur = num(i.curSl) > 0 ? num(i.curSl) : 0, tp = num(i.tp) > 0 ? num(i.tp) : 0;
  if (!(init > 0) || (long ? init >= entry : init <= entry)) {
    if (cur > 0 && (long ? cur < entry : cur > entry)) { init = cur; flags.push('risk estimated from the current stop'); } else init = 0;
  }
  const atr = num(i.atr) > 0 ? num(i.atr) : 0;
  const risk = init > 0 ? Math.abs(entry - init) : (atr > 0 ? atr * 1.5 : 0);   // last resort: 1.5 ATR, flagged
  if (!(init > 0) && risk > 0) flags.push('no original stop known: using 1.5 ATR as the risk');
  if (!(risk > 0)) return { score: null, band: 'unknown', parts: {}, flags: ['not enough information to judge'], risk: 0 };
  const sgn = long ? 1 : -1;
  const nowR = sgn * (mark - entry) / risk;
  const peak = num(i.peak) > 0 ? (long ? Math.max(num(i.peak), mark) : Math.min(num(i.peak), mark)) : mark;
  const peakR = Math.max(0, sgn * (peak - entry) / risk);
  const stopR = cur > 0 ? sgn * (cur - entry) / risk : null;
  const tpR = tp > 0 ? sgn * (tp - entry) / risk : null;
  const giveback = peakR >= 0.3 ? clamp((peakR - nowR) / peakR, 0, 1.5) : 0;
  const parts = {};
  parts.progress = clamp((nowR + 1) / 4) * 100;
  if (stopR === null) { parts.protection = 0; flags.push('no stop on the position'); }
  else if (stopR <= -0.95) parts.protection = 25;
  else if (stopR < 0.02) parts.protection = 25 + clamp((stopR + 0.95) / 0.97) * 35;
  else parts.protection = 60 + clamp(peakR > 0 ? stopR / peakR : 0) * 40;
  const mp = [];
  if (peakR >= 0.3) mp.push([0.6, clamp(1 - giveback)]);
  const rec = i.recent || {};
  if (atr > 0 && Number.isFinite(num(rec.adv))) mp.push([peakR >= 0.3 ? 0.4 : 1, clamp(1 - Math.max(0, num(rec.adv)) / atr / 1.5)]);
  if (mp.length) { const tw = mp.reduce((t, x) => t + x[0], 0); parts.momentum = mp.reduce((t, x) => t + x[0] * x[1], 0) / tw * 100; }
  const btc = num(i.btcPct);
  if (Number.isFinite(btc)) parts.market = clamp((btc + 0.6) / 0.9) * 100;
  let tw = 0, sum = 0;
  for (const k of Object.keys(W)) if (Number.isFinite(parts[k])) { tw += W[k]; sum += W[k] * parts[k]; } else flags.push(k + ' could not be read');
  const score = tw > 0 ? Math.round(sum / tw) : null;
  if (giveback >= 0.5 && peakR >= 0.5) flags.push('gave back ' + Math.round(giveback * 100) + '% of its best profit');
  if (stopR !== null && stopR > 0.02) flags.push('profit locked: stop at +' + stopR.toFixed(2) + 'R');
  if (nowR <= -0.8) flags.push('close to its stop');
  const out = { score, band: score === null ? 'unknown' : bandOf(score), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])), flags,
    risk, nowR, peakR, stopR, tpR, giveback, progressToTp: tpR > 0 ? clamp(nowR / tpR, -1, 1.5) : null };
  return out;
}
module.exports = { assess, W, BANDS, bandOf };
