'use strict';
// Re-entry brain (v2.9.9): a plain, explainable 0-100 reading of "is THIS pullback-and-resume worth a second entry right now?". Pure logic: no network, no database.
// It looks at what a trader would look at, in the pair's OWN units (ATR), so the same rule fits BTC and a thin altcoin:
//   trend      25  does the 15-minute and 1-hour trend still point the trade's way (EMA20 vs EMA50, in ATRs) and is the 1-hour slope with it?
//   pullback   20  was the pullback a healthy size in ATRs (not noise, not a collapse), and, after a real winner, not deeper than the run it followed?
//   resume     20  is the resume real: price back above the fast average, the last closed 15-minute candle with the trade, volume at or above normal?
//   btc        15  is BTC (the market) moving with the trade over the last hour and four hours?
//   stop       10  is the stop (the pullback low) a sensible distance in ATRs: not inside the noise, not far away?
//   liquidity   6  24-hour turnover: a thin book slips its stops (a 2M-a-day pair slipped a stop by about 0.2%)
//   pair        4  how earlier re-entries on this pair ended (shrunk toward neutral while there are few)
// The weights are PRIORS (judgement), not fitted numbers. Every chance is scored and logged WITH ITS RESULT, so the admin can check whether a higher score really
// means better outcomes (score bands), and change the weights or the minimum from evidence, not from this file's opinion.
// If the market data cannot be read, the score is "unreadable" and a live re-entry is NOT placed: no guessing with money.
const W = { trend: 25, pullback: 20, resume: 20, btc: 15, stop: 10, liquidity: 6, pair: 4 };
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const num = v => { if (v === null || v === undefined || v === '') return NaN; const n = Number(v); return Number.isFinite(n) ? n : NaN; };   // null / '' is NOT zero: "not read" must stay distinguishable from "nothing"
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;

function emaSeries(vals, n) { const k = 2 / (n + 1); const out = []; let e = vals[0]; for (let i = 0; i < vals.length; i++) { e = i === 0 ? vals[0] : vals[i] * k + e * (1 - k); out.push(e); } return out; }
function atrOf(bars, n = 14) {
  if (!bars || bars.length < 3) return 0;
  const tr = []; for (let i = 1; i < bars.length; i++) tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  const t = tr.slice(-n); return t.reduce((a, b) => a + b, 0) / t.length;
}
const goodBars = b => Array.isArray(b) && b.every(x => x && x.c > 0 && x.h > 0 && x.l > 0 && x.o > 0 && x.h >= x.l);

// i = { side, price (the entry now), stop (the pullback low/high), peak (best price of the trade that closed), entry (its entry), src ('winner' | 'shake'),
//       c15, c60 (oldest -> newest candles { o,h,l,c,v } of the pair), btc (candles of BTCUSDT 1h) | null, turnover (24h USD) | null, pair { n, avgR } | null }
function score(i) {
  const long = i.side === 'Buy', dir = long ? 1 : -1, price = num(i.price), stop = num(i.stop), peak = num(i.peak), entry = num(i.entry);
  const c15 = i.c15, c60 = i.c60;
  if (!(price > 0) || !(stop > 0) || (long ? stop >= price : stop <= price)) return { ok: false, reason: 'the stop is not on the protective side of the entry' };
  if (!goodBars(c15) || c15.length < 40) return { ok: false, reason: 'not enough 15-minute candles to read the pair' };
  if (!goodBars(c60) || c60.length < 25) return { ok: false, reason: 'not enough 1-hour candles to read the pair' };
  const atr15 = atrOf(c15), atr60 = atrOf(c60);
  if (!(atr15 > 0) || !(atr60 > 0)) return { ok: false, reason: 'the pair has no measurable range' };
  const flags = [], parts = {}, feat = {};
  const cl15 = c15.map(b => b.c), cl60 = c60.map(b => b.c);
  const e20 = emaSeries(cl15, 20), e50 = emaSeries(cl15, 50), e9 = emaSeries(cl15, 9), h20 = emaSeries(cl60, 20), h50 = emaSeries(cl60, 50);
  const n15 = c15.length, n60 = c60.length;

  // trend
  const t15 = clamp(0.5 + 0.5 * dir * (e20[n15 - 1] - e50[n15 - 1]) / atr15), t60 = clamp(0.5 + 0.5 * dir * (h20[n60 - 1] - h50[n60 - 1]) / atr60);
  const slope = clamp(0.5 + dir * (h20[n60 - 1] - h20[n60 - 4]) / atr60);
  parts.trend = { pts: W.trend * (0.4 * t15 + 0.4 * t60 + 0.2 * slope), max: W.trend, note: '15m ' + (t15 >= 0.5 ? 'with' : 'against') + ' the trade, 1h ' + (t60 >= 0.5 ? 'with' : 'against') + ', 1h slope ' + (slope >= 0.5 ? 'with' : 'against') };
  Object.assign(feat, { t15: r3(t15), t60: r3(t60), slope: r3(slope) });

  // pullback
  const depth = Number.isFinite(peak) ? Math.abs(peak - stop) : Math.abs(price - stop), dA = depth / atr15;
  const fit1 = dA < 0.8 ? dA / 0.8 : dA <= 3.5 ? 1 : clamp(1 - (dA - 3.5) / 3.5);
  let fit2 = fit1;
  if (i.src !== 'shake' && Number.isFinite(peak) && Number.isFinite(entry)) {
    const run = Math.abs(peak - entry), ratio = run > 0 ? depth / run : 9;
    fit2 = ratio <= 0.6 ? 1 : ratio >= 1.5 ? 0.2 : 1 - (ratio - 0.6) / 0.9 * 0.8;
    feat.ratio = r3(ratio);
  }
  parts.pullback = { pts: W.pullback * (0.6 * fit1 + 0.4 * fit2), max: W.pullback, note: 'pullback ' + dA.toFixed(1) + ' ATR' + (i.src === 'shake' ? ' (a shake-out: judged by size only)' : '') };
  feat.dA = r3(dA);

  // resume
  const last = c15[n15 - 2], cur = c15[n15 - 1];
  const mom = clamp(0.5 + 0.5 * dir * (price - e9[n15 - 1]) / (0.5 * atr15));
  const candle = clamp(0.5 + 0.5 * clamp(dir * (last.c - last.o) / (0.5 * atr15), -1, 1));
  const volBase = c15.slice(-22, -2), avgV = volBase.reduce((t, b) => t + (b.v || 0), 0) / (volBase.length || 1);
  const vr = avgV > 0 ? (last.v || 0) / avgV : NaN;
  let vol = 0.5; if (Number.isFinite(vr)) vol = clamp((vr - 0.5) / 1.0); else flags.push('volume not readable: neutral');
  parts.resume = { pts: W.resume * (0.4 * mom + 0.3 * candle + 0.3 * vol), max: W.resume, note: 'price ' + (mom >= 0.5 ? 'above' : 'below') + ' the fast average, last 15m candle ' + (candle >= 0.5 ? 'with' : 'against') + ', volume ' + (Number.isFinite(vr) ? vr.toFixed(1) + 'x normal' : 'unknown') };
  Object.assign(feat, { mom: r3(mom), candle: r3(candle), vr: Number.isFinite(vr) ? r3(vr) : null });

  // btc
  if (goodBars(i.btc) && i.btc.length >= 6) {
    const b = i.btc.map(x => x.c), n = b.length, b1 = (b[n - 1] - b[n - 2]) / b[n - 2] * 100, b4 = (b[n - 1] - b[n - 5]) / b[n - 5] * 100;
    const s1 = clamp(0.5 + 0.5 * dir * b1 / 0.5), s4 = clamp(0.5 + 0.5 * dir * b4 / 1.0);
    parts.btc = { pts: W.btc * (0.6 * s1 + 0.4 * s4), max: W.btc, note: 'BTC ' + (b1 >= 0 ? '+' : '') + b1.toFixed(2) + '% in 1h, ' + (b4 >= 0 ? '+' : '') + b4.toFixed(2) + '% in 4h' + ((dir * b1 < 0 && dir * b4 < 0) ? ' (against the trade)' : '') };
    Object.assign(feat, { b1: r3(b1), b4: r3(b4) });
  } else { parts.btc = { pts: W.btc / 2, max: W.btc, note: 'BTC not read: neutral' }; flags.push('BTC not readable: neutral'); }

  // stop
  const sA = Math.abs(price - stop) / atr15;
  const fs = sA < 0.8 ? sA / 0.8 : sA <= 2.5 ? 1 : clamp(1 - (sA - 2.5) / 2.5);
  parts.stop = { pts: W.stop * fs, max: W.stop, note: 'stop ' + sA.toFixed(1) + ' ATR away' };
  feat.sA = r3(sA);

  // liquidity
  const turn = num(i.turnover);
  if (turn >= 0) {
    const fl = turn <= 0.5e6 ? 0 : turn >= 20e6 ? 1 : Math.log(turn / 0.5e6) / Math.log(40);
    parts.liquidity = { pts: W.liquidity * fl, max: W.liquidity, note: '24h turnover $' + (turn / 1e6).toFixed(1) + 'M' + (fl < 0.5 ? ' (thin: stops slip)' : '') };
    feat.turn = Math.round(turn);
  } else { parts.liquidity = { pts: W.liquidity / 2, max: W.liquidity, note: 'turnover not read: neutral' }; flags.push('turnover not readable: neutral'); }

  // pair record
  const pn = num(i.pair && i.pair.n), pr = num(i.pair && i.pair.avgR);
  const fp = pn > 0 && Number.isFinite(pr) ? 0.5 + 0.5 * clamp(pr, -1, 1) * (pn / (pn + 2)) : 0.5;
  parts.pair = { pts: W.pair * fp, max: W.pair, note: pn > 0 ? pn + ' earlier re-entr' + (pn === 1 ? 'y' : 'ies') + ' here, average ' + pr.toFixed(2) + 'R' : 'no earlier re-entries here: neutral' };

  let total = 0; for (const k of Object.keys(parts)) { parts[k].pts = r1(parts[k].pts); total += parts[k].pts; }
  total = r1(Math.max(0, Math.min(100, total)));
  // A pretty pullback cannot buy back a wrong-way market, so two caps sit on top of the sum: both timeframes against the trade caps the score at 55 (below the usual
  // minimum of 60); a weak trend plus BTC clearly against caps it at 58. The caps are shown in the result, so the reason is never hidden.
  let capped = null;
  if (parts.trend.pts < 0.30 * W.trend && total > 55) { capped = { at: 55, why: 'the 15-minute and 1-hour trends are against the trade' }; total = 55; }
  else if (parts.btc.pts < 0.25 * W.btc && parts.trend.pts < 0.60 * W.trend && /against the trade/.test(parts.btc.note) && total > 58) { capped = { at: 58, why: 'BTC is moving against the trade and the pair trend is not strong enough to ignore it' }; total = 58; }
  if (capped) flags.push('capped at ' + capped.at + ': ' + capped.why);
  feat.atrPct = r3(atr15 / price * 100);
  return { ok: true, score: total, verdict: total >= 75 ? 'strong' : total >= 60 ? 'ok' : total >= 45 ? 'weak' : 'poor', capped, parts, flags, feat };
}

// How big the re-entry may be, as a multiple of the base re-entry size: 0.6 at the minimum score, 1.1 at 100.
function sizeFactor(sc, minScore) {
  const m = Number.isFinite(minScore) ? minScore : 60;
  return Math.round((0.6 + 0.5 * clamp((sc - m) / Math.max(1, 100 - m))) * 100) / 100;
}

// One line for the log / Telegram: "72.4 ok [trend 20.1/25, pullback 15.0/20, ...]"
function summary(r) { return r && r.ok ? r.score + ' ' + r.verdict + (r.capped ? ' (capped: ' + r.capped.why + ')' : '') + ' [' + Object.keys(r.parts).map(k => k + ' ' + r.parts[k].pts + '/' + r.parts[k].max).join(', ') + ']' : 'unreadable: ' + (r && r.reason); }

module.exports = { score, sizeFactor, summary, atrOf, emaSeries, W };
