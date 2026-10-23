'use strict';
// Policy lab (v2.9.5): READ-ONLY. It never touches a trade, a stop or the database. It takes the price paths the Sentinel already stores (trade_path: one row
// about every 10 s per open master trade, with the trade's profit in R and its best R so far) and replays simple stop policies on them, so a change to the
// stop rules can be compared on real trades BEFORE it is tried with real money.
//
// What the replay can and cannot say (these limits are printed with every report):
//   - a path ends when the real trade closed, so what the price did AFTER the real exit is unknown. A policy that holds longer than the real stack did is
//     therefore scored with the real exit for those trades (it can neither win nor lose more than the real result there), which understates both its upside and its downside.
//   - fills are assumed exactly at the stop level (no slippage, no gaps), and prices are the 10-second marks, not every tick.
//   - small samples and one market mood: use the grid to find what to test in shadow, not as proof.

const GAP_SEC = 1800, MIN_MIN = 3;

// rows: [{ at (ms or ISO), symbol, side, now_r, peak_r }] in any order -> trades [{ symbol, side, t0, pts:[{ t, n, p }] }]
function groupPaths(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const t = typeof r.at === 'number' ? r.at : Date.parse(r.at), n = Number(r.now_r), p = Number(r.peak_r);
    if (!Number.isFinite(t) || !Number.isFinite(n)) continue;
    const k = r.symbol + '|' + r.side;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ t: t / 1000, n, p: Number.isFinite(p) ? p : n });
  }
  const out = [];
  for (const [k, list] of by) {
    list.sort((a, b) => a.t - b.t);
    let cur = [list[0]];
    const flush = () => { if (cur.length && (cur[cur.length - 1].t - cur[0].t) / 60 >= MIN_MIN) out.push({ symbol: k.split('|')[0], side: k.split('|')[1], t0: cur[0].t, pts: cur }); };
    for (let i = 1; i < list.length; i++) { if (list[i].t - cur[cur.length - 1].t > GAP_SEC) { flush(); cur = [list[i]]; } else cur.push(list[i]); }
    flush();
  }
  return out;
}

const finalR = tr => tr.pts[tr.pts.length - 1].n;
const peakOf = tr => tr.pts.reduce((m, x) => Math.max(m, x.n, x.p), 0);

// "Best R reached, then stop at breakeven and keep k of the peak": from peak b on, the stop sits at max(0, k x peak); below that it is the original -1R.
function replayLadder(trades, b, k) {
  let total = 0, hits = 0;
  for (const tr of trades) {
    let peak = 0, out = finalR(tr), hit = false;
    for (const x of tr.pts) {
      peak = Math.max(peak, x.n, x.p);
      const stop = peak >= b ? Math.max(-1, 0, k * peak) : -1;
      if (peak >= b && x.n <= stop) { out = stop; hit = true; break; }
      if (x.n <= -1) { out = -1; hit = true; break; }
    }
    total += out; if (hit) hits++;
  }
  return { total, hits };
}

// "After T minutes, a trade that never showed +P R and is now at -X R is closed at -X R."
function replayLossCut(trades, T, P, X) {
  let total = 0, cut = 0, saved = 0, hurt = 0;
  for (const tr of trades) {
    const fin = finalR(tr); let out = fin, done = false;
    for (const x of tr.pts) {
      const peak = Math.max(0, x.p);
      if ((x.t - tr.t0) / 60 >= T && peak < P && x.n <= -X) { out = -X; done = true; break; }
    }
    if (done) { cut++; if (out > fin) saved += out - fin; else hurt += fin - out; }
    total += out;
  }
  return { total, cut, saved, hurt };
}

const r2 = v => Math.round(v * 100) / 100;

function report(rows, opts) {
  const trades = groupPaths(rows);
  const o = opts || {};
  const base = trades.reduce((t, tr) => t + finalR(tr), 0);
  const peaks = trades.map(peakOf), fin = trades.map(finalR);
  const never = trades.filter((tr, i) => peaks[i] < 0.3), moved = trades.filter((tr, i) => peaks[i] >= 0.3);
  const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
  const band = (lo, hi) => { const idx = trades.map((_, i) => i).filter(i => peaks[i] >= lo && peaks[i] < hi); return { from: lo, to: hi, n: idx.length, peakR: r2(sum(idx, i => peaks[i])), exitR: r2(sum(idx, i => fin[i])) }; };
  const bs = o.starts || [0.3, 0.5, 0.7, 1.0, 1.5], ks = o.keeps || [0, 0.25, 0.4, 0.5, 0.6, 0.7];
  const ladder = bs.map(b => ({ start: b, cells: ks.map(k => ({ keep: k, totalR: r2(replayLadder(trades, b, k).total) })) }));
  const cutGrid = [];
  for (const T of o.minutes || [0, 15, 30]) for (const P of o.never || [0.15, 0.3]) for (const X of o.loss || [0.4, 0.5, 0.6, 0.7]) {
    const c = replayLossCut(trades, T, P, X); cutGrid.push({ afterMin: T, neverShowed: P, cutAt: -X, totalR: r2(c.total), deltaR: r2(c.total - base), cut: c.cut, savedR: r2(c.saved), hurtR: r2(c.hurt) });
  }
  let best = null;
  for (const row of ladder) for (const c of row.cells) if (!best || c.totalR > best.totalR) best = { start: row.start, keep: c.keep, totalR: c.totalR };
  return {
    trades: trades.length, baselineR: r2(base),
    neverMoved: { n: never.length, exitR: r2(sum(never, finalR)), note: 'trades that never reached +0.3R: a stop policy cannot rescue these, only better entries or an earlier cut can' },
    moved: { n: moved.length, exitR: r2(sum(moved, finalR)), peakR: r2(sum(moved, peakOf)) },
    bands: [band(0, 0.1), band(0.1, 0.3), band(0.3, 0.5), band(0.5, 0.8), band(0.8, 1.0), band(1.0, 1.5), band(1.5, 99)],
    ladder, lossCut: cutGrid, bestLadder: best,
    caveats: ['A path ends when the real trade closed, so what the price did afterwards is unknown: policies that would hold longer are scored with the real exit there.',
      'Fills are assumed at the stop level, with no slippage or gaps. Marks are about 10 seconds apart.',
      'Small samples and one market mood: use this to choose what to test in shadow, not as proof.'],
  };
}

// Which layer most likely produced a trade's exit price. Approximate: it compares the exit with the stops each layer last set. in: { side, entry, initialSl, exit, guardFloor, sentinelFloor, botStop }
// Returns 'ORIGINAL_SL' | 'GUARD_STOP' | 'SENTINEL_STOP' | 'BOT_STOP' | 'OTHER' (the Bybit trailing stop, a market close from the bot, a manual close or a target) | 'UNKNOWN'.
function attributeExit(i, tolR) {
  const entry = Number(i.entry), init = Number(i.initialSl), x = Number(i.exit);
  const risk = Math.abs(entry - init);
  if (!(entry > 0) || !(x > 0) || !(risk > 0)) return 'UNKNOWN';
  // A stop fills at or WORSE than its level (slippage on a thin pair can be 0.2-0.3R), almost never better: allow up to 0.30R adverse and only 0.05R in the trade's favour (v2.9.9; before it was 0.12R either way)
  const long = String(i.side) === 'Buy', adv = (tolR > 0 ? tolR : 0.30) * risk, fav = 0.05 * risk;
  const c = [['ORIGINAL_SL', init], ['GUARD_STOP', Number(i.guardFloor)], ['SENTINEL_STOP', Number(i.sentinelFloor)], ['BOT_STOP', Number(i.botStop)]].filter(a => a[1] > 0);
  let best = null;
  for (const a of c) { const g = long ? a[1] - x : x - a[1]; /* + = filled worse than the stop */ if (g <= adv && g >= -fav) { const d = Math.abs(g); if (!best || d < best.d) best = { name: a[0], d }; } }
  return best ? best.name : 'OTHER';
}

module.exports = { groupPaths, replayLadder, replayLossCut, report, attributeExit };
