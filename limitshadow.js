'use strict';
// LIMIT-ORDER SHADOW (v2.9.20). It places NO orders and changes NO trade. For every real OPEN the relay sends, it asks:
//   "If we had tried a post-only limit at the best bid/ask instead of a market order, would it have filled, how fast, and what did we miss?"
// It only reads public prices (the ticker) and keeps a small log, so a few weeks of live signals show the real fill rate, the fee saved,
// and whether the trades a limit would have MISSED were the good ones (the "adverse selection" test). Off unless LIMIT_SHADOW=on.
//
// How a shadow limit is judged (deliberately cautious, so it never flatters the idea):
//   - Buy joins the best bid, Sell joins the best ask, at the moment the signal arrives.
//   - It counts as FILLED only when the last traded price goes THROUGH the limit (below it for a Buy, above it for a Sell). Touching is not enough.
//   - Every REPRICE_MS it moves to the current best bid/ask, at most MAX_REPRICES times, then gives up at WINDOW_MS ("missed").
//   - Prices are sampled every POLL_MS, so a quick touch between samples is missed: the fill rate is a floor, not a guess upward.
//   - Afterwards the price is read again at +5 and +30 minutes, in the trade's direction, for filled and missed alike.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const DEF = { WINDOW_MS: 30000, POLL_MS: 2000, REPRICE_MS: 8000, MAX_REPRICES: 3, FOLLOW_MS: [300000, 1800000], KEEP: 500, TAKER_PCT: 0.055, MAKER_PCT: 0.02 };

function create(opts = {}) {
  const cfg = { ...DEF, ...(opts.config || {}) };
  const getTicker = opts.getTicker;                 // async (symbol) => { bid, ask, last } or null
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const enabled = opts.enabled !== undefined ? !!opts.enabled : String(process.env.LIMIT_SHADOW || '').toLowerCase() === 'on';
  const rows = []; let running = 0;
  const keep = r => { rows.push(r); while (rows.length > cfg.KEEP) rows.shift(); };

  async function read(sym) {
    try { const t = await getTicker(sym); if (!t) return null; const o = { bid: num(t.bid), ask: num(t.ask), last: num(t.last) }; return (o.bid > 0 && o.ask > 0 && o.last > 0) ? o : null; }
    catch { return null; }
  }

  // Watch one open order. Resolves with the finished row (also stored). Never throws.
  async function watch(order) {
    const long = order.side === 'Buy', sgn = long ? 1 : -1, sym = order.symbol;
    const t0 = now(); const first = await read(sym);
    if (!first) return null;
    const market = long ? first.ask : first.bid;                      // what a market order would pay (before slippage)
    let limit = long ? first.bid : first.ask, reprices = 0, filledAt = null, nextReprice = t0 + cfg.REPRICE_MS;
    while (now() - t0 < cfg.WINDOW_MS) {
      await sleep(cfg.POLL_MS);
      const t = await read(sym); if (!t) continue;
      if (long ? t.last < limit : t.last > limit) { filledAt = now(); break; }
      if (now() >= nextReprice && reprices < cfg.MAX_REPRICES) {
        const best = long ? t.bid : t.ask;
        if (best !== limit) { limit = best; reprices++; }
        nextReprice = now() + cfg.REPRICE_MS;
      }
    }
    const filled = filledAt !== null;
    const sl = num(order.stopLoss), stopPct = sl > 0 ? Math.abs(market - sl) / market * 100 : NaN;
    const feeSavePct = cfg.TAKER_PCT - cfg.MAKER_PCT;                   // per leg, % of notional
    const row = {
      t: t0, symbol: sym, side: order.side, market, limit, filled, reprices,
      fillSec: filled ? Math.round((filledAt - t0) / 100) / 10 : null,
      improveBps: filled ? Math.round(sgn * (market - limit) / market * 1e5) / 10 : null,   // price better than market, in basis points (positive = good)
      feeSavePct, savedR: stopPct > 0 ? Math.round(feeSavePct / stopPct * 1000) / 1000 : null,
      fwd: {},
    };
    keep(row); log('[limit-shadow]', JSON.stringify({ s: sym, side: order.side, filled, sec: row.fillSec, imp: row.improveBps }));
    // later look-ups: how far the market went in the trade's direction after the signal (from the market-order price)
    for (const ms of cfg.FOLLOW_MS) {
      const wait = t0 + ms - now(); if (wait > 0) await sleep(wait);
      const t = await read(sym); if (t) row.fwd[Math.round(ms / 60000) + 'm'] = Math.round(sgn * (t.last - market) / market * 1e4) / 100;   // % in the trade's favour
    }
    return row;
  }

  // Called for every real open. Fire-and-forget: returns at once, never throws, caps how many watches run together.
  function observe(order) {
    try {
      if (!enabled || !getTicker || !order || order.reduceOnly === true || order.reduceOnly === 'true') return;
      if (order.side !== 'Buy' && order.side !== 'Sell') return;
      if (running >= 12) return;
      running++;
      watch(order).catch(() => {}).finally(() => { running--; });
    } catch { /* a shadow must never touch a trade */ }
  }

  const avg = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
  const r2 = v => v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
  function summary() {
    const done = rows.filter(r => r.market > 0);
    const f = done.filter(r => r.filled), m = done.filter(r => !r.filled);
    const fw = (a, k) => r2(avg(a.map(r => r.fwd[k]).filter(Number.isFinite)));
    return {
      enabled, signals: done.length, filled: f.length, missed: m.length,
      fillRatePct: done.length ? Math.round(f.length / done.length * 1000) / 10 : null,
      avgFillSec: r2(avg(f.map(r => r.fillSec))),
      avgImproveBps: r2(avg(f.map(r => r.improveBps))),
      avgSavedR: r2(avg(done.map(r => r.savedR).filter(Number.isFinite))),
      forwardPctInTradeDirection: { filled: { '5m': fw(f, '5m'), '30m': fw(f, '30m') }, missed: { '5m': fw(m, '5m'), '30m': fw(m, '30m') } },
      read: 'If MISSED trades go further in the trade direction than FILLED ones, a limit entry would skip the winners: keep market (or chase less). If they are similar, the fee saving is real.',
      last: rows.slice(-10),
    };
  }
  return { observe, watch, summary, cfg, get enabled() { return enabled; } };
}
module.exports = { create, DEF };
