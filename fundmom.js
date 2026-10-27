'use strict';
// FUNDING + MOMENTUM SHADOW MODULE (v2.9.21). It places NO orders and touches no trade. Every 4 hours, right after a 4h candle closes, it reads funding, price and 14 days of
// 4h candles for the most-traded Bybit perpetuals and logs the calls that three rules WOULD have made, then follows each call to its stop, target or timeout and scores it in R.
// A random-coin control call (same direction, same moment) is logged beside every real call, so the summary shows whether a rule beats chance.
//   combo      long: top 5% 14-day return AND funding in the top 10% AND 3-day return above +3%   |  short: the mirror image (bottom 5%, bottom 10%, below -3%)
//   fundtrend  long: funding top 5% AND 3-day return above +3%   |  short: funding bottom 5% AND 3-day return below -3%
//   mom        long: top 5% 14-day return   |  short: bottom 5%
//   trend      (v2.9.23 swing rebuild) long: top 10% 14-day return AND the 4h close above the highest high of the previous 50 days   |  short: bottom 10% AND close below the lowest low of 50 days.
//              Exit: stop 2 ATR, NO target; once the trade is 1 ATR in profit the stop trails the best price by 1.5 ATR; closed at market after 84 bars (14 days).
//   trendbtc   the same, only longs while BTC is more than 1.5% above its 30-bar average and only shorts while it is more than 1.5% below.
// Every call uses the same fixed exit the tests used: stop 1.5 ATR, target 3 ATR, 30 bars (5 days), stop checked first, fee 0.11% round trip. Funding paid while holding is estimated and shown.
// Off only if FUNDMOM=off. Read the result at /api/fundmom.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const BAR_MS = 4 * 3600 * 1000;
const DEF = { UNIVERSE: 120, KLINES: 320, STOP_ATR: 1.5, TGT_ATR: 3.0, HOLD_BARS: 30, FEE_PCT: 0.11, MOM_LAG: 84, TREND_LAG: 18, TREND_MIN: 3, KEEP_CLOSED: 3000, DELAY_MS: 90000, CONC: 4,
  MIN_ATR_PCT: 0.1, MIN_UNIVERSE: 40,
  BRK_LAG: 300, TREND_RANK: 0.9, TREND_STOP_ATR: 2.0, TRAIL_START_ATR: 1.0, TRAIL_K_ATR: 1.5, TREND_HOLD: 84, BTC_DEV_PCT: 1.5 };
const MODULES = ['combo', 'fundtrend', 'mom', 'trend', 'trendbtc'];
const STABLE = /^(USDC|USDE|FDUSD|TUSD|DAI|USDP|USDD|PYUSD|USD1|BUSD|EUR|XAUT|PAXG)USDT$/;

// percentile rank in (0,1], ties averaged (same as the pandas rank(pct=True) the tests used)
function rankPct(vals) {
  const n = vals.length, idx = vals.map((v, i) => i).filter(i => Number.isFinite(vals[i])).sort((a, b) => vals[a] - vals[b]);
  const out = new Array(n).fill(NaN), m = idx.length;
  for (let i = 0; i < m;) { let j = i; while (j + 1 < m && vals[idx[j + 1]] === vals[idx[i]]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) out[idx[k]] = r / m; i = j + 1; }
  return out;
}
// candles: [{t,o,h,l,c}] oldest first. ATR(14) = plain average of the last 14 true ranges
function atr14(cs, end) {
  if (end < 14) return NaN;
  let s = 0;
  for (let i = end - 13; i <= end; i++) s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  return s / 14;
}

// Trailing stop used by the trend rules. Walks the CLOSED candles from the entry bar on and returns where the stop sits now (and the best price so far).
// A bar is checked against the stop it started with; the bar's own high/low then moves the stop for the NEXT bar (the same order the tests used).
function trailState(call, cs, asOf) {
  const long = call.dir === 1; let stop = call.stop, best = call.entry;
  for (const c of cs) {
    if (c.t < call.entryBar || c.t + BAR_MS > asOf) continue;
    if (long ? c.l <= stop : c.h >= stop) break;
    best = long ? Math.max(best, c.h) : Math.min(best, c.l);
    const fav = (best - call.entry) * call.dir / call.atr;
    if (call.trail && fav >= call.trail.start) { const ns = best - call.dir * call.trail.k * call.atr; stop = long ? Math.max(stop, ns) : Math.min(stop, ns); }
  }
  return { stop, best };
}

function create(opts = {}) {
  const cfg = { ...DEF, ...(opts.config || {}) };
  const enabled = opts.enabled !== undefined ? !!opts.enabled : String(process.env.FUNDMOM || 'on').toLowerCase() !== 'off';
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const rand = opts.random || Math.random;
  const store = opts.store || null;
  const st = { lastBar: 0, nextId: 1, open: [], closed: [], cycles: [], lastError: null, universe: 0, lastNew: [], watch: [], all: [], market: null, trendWatch: [] };
  let busy = false, loaded = false;

  async function load() {
    if (loaded) return; loaded = true;
    try { const s = store && await store.load(); if (s && Array.isArray(s.open) && Array.isArray(s.closed)) Object.assign(st, { lastBar: s.lastBar || 0, nextId: s.nextId || 1, open: s.open, closed: s.closed, cycles: s.cycles || [], watch: s.watch || [], all: s.all || [], market: s.market || null, trendWatch: s.trendWatch || [] }); } catch { /* start fresh */ }
  }
  async function save() { try { if (store) await store.save({ lastBar: st.lastBar, nextId: st.nextId, open: st.open, closed: st.closed.slice(-cfg.KEEP_CLOSED), cycles: st.cycles.slice(-60), watch: st.watch, all: st.all, market: st.market, trendWatch: st.trendWatch }); } catch { /* memory still has it */ } }

  // Follow one open call along the candles that came after its entry. Returns the closing record, or null while still open.
  function resolve(call, cs, asOf) {
    asOf = asOf === undefined ? now() : asOf;
    const long = call.dir === 1, hold = call.hold || cfg.HOLD_BARS;
    let stop = call.stop, best = call.entry;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]; if (c.t < call.entryBar) continue;
      const bars = (c.t - call.entryBar) / BAR_MS;
      const hitS = long ? c.l <= stop : c.h >= stop, hitT = call.tgt != null && (long ? c.h >= call.tgt : c.l <= call.tgt);
      let px = null, why = null;
      if (hitS) { px = stop; why = stop === call.stop ? 'stop' : 'trail'; } else if (hitT) { px = call.tgt; why = 'target'; }
      else if (bars >= hold - 1 && c.t + BAR_MS <= asOf) { px = c.c; why = 'timeout'; }
      else if (call.trail) {
        best = long ? Math.max(best, c.h) : Math.min(best, c.l);
        if ((best - call.entry) * call.dir / call.atr >= call.trail.start) { const ns = best - call.dir * call.trail.k * call.atr; stop = long ? Math.max(stop, ns) : Math.min(stop, ns); }
      }
      if (px !== null) {
        const pnl = (px - call.entry) / call.entry * 100 * call.dir - cfg.FEE_PCT, risk = call.riskPct;
        const heldH = Math.max(4, (c.t + BAR_MS - call.entryBar) / 3600000);
        const fundPct = -call.dir * (call.funding || 0) * 100 * (heldH / 8);   // paid when you are on the side that pays
        return { why, R: pnl / risk, fundR: fundPct / risk, closedAt: c.t + BAR_MS };
      }
    }
    return null;
  }

  // Evaluate the rules on the universe: items = [{symbol, funding, turnover, cs}] with cs = CLOSED 4h candles oldest first, plus `forming` = open price of the current bar.
  function signals(items) {
    const ok = items.filter(it => it.cs.length > cfg.MOM_LAG + 2 && Number.isFinite(it.funding));
    const sig = ok.map(it => { const n = it.cs.length - 1, c = it.cs[n].c; return { it, n, c, r84: (c / it.cs[n - cfg.MOM_LAG].c - 1) * 100, r18: (c / it.cs[n - cfg.TREND_LAG].c - 1) * 100, atr: atr14(it.cs, n) }; });
    const rk = rankPct(sig.map(s => s.r84)), fr = rankPct(sig.map(s => s.it.funding));
    const out = [];
    const btcS = sig.find(x => x.it.symbol === 'BTCUSDT');
    let btcDev = NaN; if (btcS && btcS.it.cs.length >= 30) { const cs = btcS.it.cs, n = cs.length - 1; let m = 0; for (let k = n - 29; k <= n; k++) m += cs[k].c; m /= 30; btcDev = (cs[n].c - m) / m * 100; }
    sig.forEach((s, i) => {
      if (!(s.atr > 0) || s.atr / s.c * 100 < cfg.MIN_ATR_PCT) return;
      if (s.it.symbol !== 'BTCUSDT' && s.n >= cfg.BRK_LAG + 1) {   // swing rebuild: momentum top/bottom 10% AND a break of the previous 50-day range
        let hh = -Infinity, ll = Infinity; for (let k = s.n - cfg.BRK_LAG; k < s.n; k++) { hh = Math.max(hh, s.it.cs[k].h); ll = Math.min(ll, s.it.cs[k].l); }
        const rec2 = { symbol: s.it.symbol, funding: s.it.funding, atr: s.atr, r84: s.r84, r18: s.r18, sigClose: s.c, hh, ll };
        if (rk[i] > cfg.TREND_RANK && s.c > hh) { out.push({ ...rec2, module: 'trend', dir: 1 }); if (btcDev > cfg.BTC_DEV_PCT) out.push({ ...rec2, module: 'trendbtc', dir: 1 }); }
        if (rk[i] < 1 - cfg.TREND_RANK && s.c < ll) { out.push({ ...rec2, module: 'trend', dir: -1 }); if (btcDev < -cfg.BTC_DEV_PCT) out.push({ ...rec2, module: 'trendbtc', dir: -1 }); }
      }
      const T = cfg.TREND_MIN, rec = { symbol: s.it.symbol, funding: s.it.funding, atr: s.atr, r84: s.r84, r18: s.r18, sigClose: s.c };
      if (rk[i] > 0.95 && fr[i] > 0.9 && s.r18 > T) out.push({ ...rec, module: 'combo', dir: 1 });
      if (rk[i] < 0.05 && fr[i] < 0.1 && s.r18 < -T) out.push({ ...rec, module: 'combo', dir: -1 });
      if (fr[i] > 0.95 && s.r18 > T) out.push({ ...rec, module: 'fundtrend', dir: 1 });
      if (fr[i] < 0.05 && s.r18 < -T) out.push({ ...rec, module: 'fundtrend', dir: -1 });
      if (rk[i] > 0.95) out.push({ ...rec, module: 'mom', dir: 1 });
      if (rk[i] < 0.05) out.push({ ...rec, module: 'mom', dir: -1 });
    });
    const trendWatch = [];
    sig.forEach((s, i) => {   // coins in the top/bottom 10% of 14-day momentum: how far each is from breaking its 50-day range (0% = broken = a call)
      if (s.it.symbol === 'BTCUSDT' || s.n < cfg.BRK_LAG + 1 || !(s.atr > 0)) return;
      const long = rk[i] > cfg.TREND_RANK, short = rk[i] < 1 - cfg.TREND_RANK; if (!long && !short) return;
      let hh = -Infinity, ll = Infinity; for (let k = s.n - cfg.BRK_LAG; k < s.n; k++) { hh = Math.max(hh, s.it.cs[k].h); ll = Math.min(ll, s.it.cs[k].l); }
      const away = long ? (hh - s.c) / s.c * 100 : (s.c - ll) / s.c * 100;
      trendWatch.push({ symbol: s.it.symbol, side: long ? 'long' : 'short', momentumRankPct: Math.round(rk[i] * 100), return14dPct: Math.round(s.r84 * 10) / 10, level: long ? hh : ll, toBreakPct: Math.max(0, Math.round(away * 100) / 100), broken: away <= 0 });
    });
    trendWatch.sort((a, b) => a.toBreakPct - b.toBreakPct);
    const watch = sig.map((s, i) => {
      const T = cfg.TREND_MIN, atrPct = s.atr / s.c * 100;
      const L = [['momentum top 5%', rk[i] > 0.95], ['funding top 10%', fr[i] > 0.9], ['3-day trend above +' + T + '%', s.r18 > T]];
      const S = [['momentum bottom 5%', rk[i] < 0.05], ['funding bottom 10%', fr[i] < 0.1], ['3-day trend below -' + T + '%', s.r18 < -T]];
      const nl = L.filter(x => x[1]).length, ns = S.filter(x => x[1]).length, long = nl + 0.001 * (rk[i] + fr[i]) >= ns + 0.001 * ((1 - rk[i]) + (1 - fr[i])), c = long ? L : S;
      return { symbol: s.it.symbol, side: long ? 'long' : 'short', met: c.filter(x => x[1]).length, of: 3, missing: c.filter(x => !x[1]).map(x => x[0]), momentumRankPct: Math.round(rk[i] * 100), fundingRankPct: Math.round(fr[i] * 100), return14dPct: Math.round(s.r84 * 10) / 10, return3dPct: Math.round(s.r18 * 10) / 10, atr4hPct: Math.round(atrPct * 100) / 100, fundingRate: s.it.funding, turnover24h: s.it.turnover,
        _k: c.filter(x => x[1]).length + 0.001 * (long ? rk[i] + fr[i] : (1 - rk[i]) + (1 - fr[i])) };
    }).sort((a, b) => b._k - a._k).map(({ _k, ...r }) => r);
    const pct = f => sig.length ? Math.round(sig.filter(f).length / sig.length * 1000) / 10 : null;
    const r6 = it => { const n = it.cs.length - 1; return (it.cs[n].c / it.cs[n - 6].c - 1) * 100; };
    const btc = sig.find(x => x.it.symbol === 'BTCUSDT'), fs = sig.map(x => x.it.funding).sort((a, b) => a - b);
    const b24 = pct(x => r6(x.it) > 0);
    const market = { universe: sig.length, breadth24hPct: b24, breadth3dPct: pct(x => x.r18 > 0), breadth14dPct: pct(x => x.r84 > 0), fundingPositivePct: pct(x => x.it.funding > 0), medianFunding: fs.length ? fs[Math.floor(fs.length / 2)] : null,
      btc24hPct: btc ? Math.round(r6(btc.it) * 100) / 100 : null, btc3dPct: btc ? Math.round(btc.r18 * 100) / 100 : null, btc14dPct: btc ? Math.round(btc.r84 * 100) / 100 : null,
      state: btc && Math.abs(r6(btc.it)) > 3 ? 'SHOCK' : b24 === null ? 'UNKNOWN' : b24 > 60 ? 'RISING' : b24 < 40 ? 'FALLING' : 'MIXED',
      note: 'Information only: nothing is gated on this yet, because no gate built on it has passed the tests.' };
    return { out, sig, watch, market, trendWatch };
  }

  const isTrend = m => m === 'trend' || m === 'trendbtc';
  function openCall(sg, entry, bar, ctl) {
    const tr = isTrend(sg.module), mult = tr ? cfg.TREND_STOP_ATR : cfg.STOP_ATR;
    const stop = entry - sg.dir * mult * sg.atr, tgt = tr ? null : entry + sg.dir * cfg.TGT_ATR * sg.atr;
    st.open.push({ id: st.nextId++, module: sg.module, ctl: !!ctl, symbol: sg.symbol, dir: sg.dir, entry, stop, tgt, riskPct: mult * sg.atr / entry * 100, atr: sg.atr, atrPct: sg.atr / entry * 100, funding: sg.funding, entryBar: bar, at: now(), r84: sg.r84, r18: sg.r18,
      ...(tr ? { trail: { start: cfg.TRAIL_START_ATR, k: cfg.TRAIL_K_ATR }, hold: cfg.TREND_HOLD } : {}) });
  }

  // One cycle for the bar that just closed. data = { bar (start time of the NEW bar), items:[{symbol,funding,turnover,cs (closed candles), cur (forming candle)}] }
  function cycle(data) {
    const bar = data.bar;
    // 1. settle open calls using the freshest candles
    const bySym = new Map(data.items.map(it => [it.symbol, it]));
    st.open = st.open.filter(call => {
      const it = bySym.get(call.symbol); if (!it) return (bar - call.entryBar) / BAR_MS <= cfg.HOLD_BARS + 6;   // a coin that left the list is dropped after its window
      const r = resolve(call, it.cs, bar);
      if (!r) return true;
      st.closed.push({ ...call, ...r }); return false;
    });
    while (st.closed.length > cfg.KEEP_CLOSED) st.closed.shift();
    // 2. new calls on the bar that just closed
    const { out, sig, watch, market, trendWatch } = signals(data.items.map(it => ({ ...it, cs: it.cs }))); st.watch = watch.slice(0, 30); st.market = market; st.trendWatch = trendWatch.slice(0, 40);
    { const byT = [...data.items].sort((a, b) => num(b.turnover) - num(a.turnover)).map(i => i.symbol); st.all = watch.map(w => ({ symbol: w.symbol, side: w.side, met: w.met, momentumRankPct: w.momentumRankPct, fundingRankPct: w.fundingRankPct, return14dPct: w.return14dPct, return3dPct: w.return3dPct, atr4hPct: w.atr4hPct, fundingRate: w.fundingRate, turnoverRank: byT.indexOf(w.symbol) + 1 })); }
    let made = 0; st.lastNew = [];
    const have = new Set(st.open.filter(c => !c.ctl).map(c => c.module + '|' + c.symbol));
    for (const sg of out) {
      const key = sg.module + '|' + sg.symbol; if (have.has(key)) continue;
      const it = bySym.get(sg.symbol), entry = it.cur ? it.cur.o : sg.sigClose; if (!(entry > 0)) continue;
      have.add(key); openCall(sg, entry, bar, false); made++; st.lastNew.push(st.open[st.open.length - 1]);
      // matched control: a random other coin, same direction, same moment, same exit rule
      const pool = sig.filter(s => s.it.symbol !== sg.symbol && s.atr > 0 && s.atr / s.c * 100 >= cfg.MIN_ATR_PCT);
      if (pool.length) {
        const p = pool[Math.floor(rand() * pool.length)], pi = bySym.get(p.it.symbol), pe = pi.cur ? pi.cur.o : p.c;
        if (pe > 0) openCall({ symbol: p.it.symbol, dir: sg.dir, atr: p.atr, funding: p.it.funding, module: sg.module, r84: p.r84, r18: p.r18 }, pe, bar, true);
      }
    }
    st.lastBar = bar; st.universe = sig.length;
    st.cycles.push({ bar, universe: sig.length, newCalls: made, open: st.open.length });
    return made;
  }

  async function tick() {
    if (!enabled || busy || !opts.fetchUniverse) return;
    const bar = Math.floor(now() / BAR_MS) * BAR_MS;
    await load();
    if (st.lastBar >= bar || now() - bar < cfg.DELAY_MS) return;
    busy = true;
    try {
      const data = await opts.fetchUniverse(cfg, bar);
      if (!data || !data.items || data.items.length < cfg.MIN_UNIVERSE) { st.lastError = 'universe too small: ' + (data && data.items ? data.items.length : 0); return; }
      const made = cycle({ bar, items: data.items });
      st.lastError = null;
      if (opts.onBar) { try { await opts.onBar(data, st.open.filter(c => !c.ctl)); } catch (e) { log('[fundmom] onBar failed:', e && e.message); } }   // every bar: the live layer moves trailing stops
      if (opts.onNewCalls && st.lastNew.length) { try { await opts.onNewCalls(st.lastNew.slice(), data); } catch (e) { log('[fundmom] onNewCalls failed:', e && e.message); } }   // the live layer; a failure there never touches the shadow log
      log('[fundmom] bar ' + new Date(bar).toISOString() + ' universe ' + st.universe + ', ' + made + ' new calls, ' + st.open.length + ' open');
      await save();
    } catch (e) { st.lastError = String(e && e.message || e).slice(0, 200); }
    finally { busy = false; }
  }

  const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
  const r3 = v => v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
  // Rolling check for the health monitor: the last n closed REAL calls of a module against the last n of its controls.
  function window(module, n) {
    const real = st.closed.filter(c => c.module === module && !c.ctl).slice(-n), ctl = st.closed.filter(c => c.module === module && c.ctl).slice(-n);
    const m = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
    const mr = m(real.map(c => c.R)), mc = m(ctl.map(c => c.R));
    return { real: real.length, control: ctl.length, meanR: mr, meanRAfterFunding: m(real.map(c => c.R + c.fundR)), controlMeanR: mc, edge: mr !== null && mc !== null ? mr - mc : null, totalReal: st.closed.filter(c => c.module === module && !c.ctl).length };
  }
  function summary() {
    const mods = {};
    for (const m of MODULES) {
      const real = st.closed.filter(c => c.module === m && !c.ctl), ctl = st.closed.filter(c => c.module === m && c.ctl);
      const R = real.map(c => c.R), RF = real.map(c => c.R + c.fundR), C = ctl.map(c => c.R);
      const edge = R.length >= 5 && C.length >= 5 ? mean(R) - mean(C) : null;
      mods[m] = { closedCalls: real.length, open: st.open.filter(c => c.module === m && !c.ctl).length, meanR: r3(mean(R)), meanRAfterFunding: r3(mean(RF)), winPct: R.length ? Math.round(R.filter(x => x > 0).length / R.length * 1000) / 10 : null,
        controlMeanR: r3(mean(C)), edgeVsControl: r3(edge), longs: real.filter(c => c.dir === 1).length, shorts: real.filter(c => c.dir === -1).length,
        health: R.length < 50 ? 'too few calls yet (needs 50)' : (edge !== null && edge < -0.05 ? 'BEHIND random coins' : 'ok so far') };
    }
    return { enabled, lastBar: st.lastBar ? new Date(st.lastBar).toISOString() : null, universe: st.universe, lastError: st.lastError, market: st.market, modules: mods,
      read: 'Shadow only: nothing is traded. A rule earns a live slot only with 100+ closed calls, a positive edge over its control and meanR after funding above zero.',
      openCalls: st.open.filter(c => !c.ctl).slice(-15).map(c => ({ id: c.id, module: c.module, symbol: c.symbol, dir: c.dir > 0 ? 'long' : 'short', entry: c.entry, stop: c.stop, target: c.tgt, trailing: !!c.trail })), cycles: st.cycles.slice(-6), watching: { note: 'Coins closest to a combo trigger as of the last 4h bar (all 3 conditions = a call). Sorted by how many conditions are met.', asOf: st.lastBar ? new Date(st.lastBar).toISOString() : null, list: st.watch, all: st.all || [], trend: { note: 'Trend rule (swing rebuild): coins in the top or bottom 10% of 14-day momentum, and how far each still is from breaking its previous 50-day high (long) or low (short). 0% = broken = a call on the next bar.', list: st.trendWatch || [] } } };
  }
  return { tick, cycle, summary, signals, resolve, window, cfg, state: st, get enabled() { return enabled; } };
}
module.exports = { create, rankPct, atr14, trailState, DEF, BAR_MS, STABLE };
