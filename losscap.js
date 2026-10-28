// Loss cap + stop-distance limit, one rule for every route (v2.9.20).
//   * stop-distance limit (MAX_STOP_PCT, default 15): a trade whose stop is further than this % from the price is skipped.
//   * loss cap (LOSS_CAP_MARGIN_PCT, default 13; 0 = off): leverage is lowered so a stop-out costs at most this % of the margin
//     (loss % of margin = stop distance % x leverage). 13 leaves room for slippage under the 15% rule.
// Pure functions: no network. Anything unknown (no price, no stop, no leverage) means "do nothing" -- never block a trade on missing data.
function parseNum(raw, dflt, lo, hi) { if (raw === undefined || raw === '') return dflt; const n = Number(raw); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; }
function settings(env) {
  env = env || process.env;
  return { lossCapPct: parseNum(env.LOSS_CAP_MARGIN_PCT, 13, 0, 100), maxStopPct: parseNum(env.MAX_STOP_PCT, 15, 0, 50) };
}
// -> { away, refuse, maxLev, lev, capped, note }
function evaluate({ lev, price, stop, lossCapPct, maxStopPct }) {
  const out = { away: 0, refuse: false, maxLev: 0, lev: lev > 0 ? lev : 0, capped: false, note: '' };
  price = Number(price); stop = Number(stop);
  if (!(price > 0) || !(stop > 0)) return out;
  out.away = Math.abs(price - stop) / price * 100;
  if (!(out.away > 0)) return out;
  if (maxStopPct > 0 && out.away > maxStopPct) { out.refuse = true; out.note = 'stop is ' + out.away.toFixed(1) + '% from the price (limit ' + maxStopPct + '%)'; return out; }
  if (lossCapPct > 0 && lev > 0) {
    out.maxLev = Math.max(1, Math.floor(lossCapPct / out.away));
    if (lev > out.maxLev) { out.capped = true; out.lev = out.maxLev; out.note = 'loss cap: stop ' + out.away.toFixed(1) + '% away, so ' + out.maxLev + 'x (not ' + lev + 'x) keeps a stop-out under ' + lossCapPct + '% of the margin'; }
  }
  return out;
}
// same margin at lower leverage -> proportionally smaller position; rounded DOWN to the step, never below the minimum
function scaleQty(qty, fromLev, toLev, step, minQty) {
  qty = Number(qty); if (!(qty > 0) || !(fromLev > 0) || !(toLev > 0) || toLev >= fromLev) return qty;
  let q = qty * toLev / fromLev;
  if (step > 0) q = Math.floor(q / step + 1e-9) * step;
  q = Number(q.toFixed(12));
  if (minQty > 0 && q < minQty) q = minQty;
  return q;
}
module.exports = { settings, evaluate, scaleQty };
