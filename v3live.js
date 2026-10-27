'use strict';
// V3 LIVE LAYER (v2.9.21). It takes the calls the funding + momentum shadow module makes after each 4h bar and, ONLY when switched on, turns the chosen module's calls into real master-account trades
// through the relay's own trade executor (the same path the bots use: balance check, one position per coin, instrument rules, leverage, quantity, exchange-side stop and target).
// OFF by default: with V3_LIVE unset it only writes down what it WOULD have done (sizes, leverage, reasons for every skip), so you can read it before arming it.
//
// Safety gates, in order (each skip is logged with its reason):
//   module is on the list (default: combo)  >  not paused  >  data readable  >  drawdown pause (equity 10% below its peak)  >  daily loss limit (3% of equity)
//   >  open trades < 8  >  coin in the top 100 by turnover and its 4h ATR at least 2% of price  >  stop no wider than 15%  >  price still within 0.3% of the signal price and spread under 0.1%  >  total open risk <= 4% of equity and one direction <= 3%
// Size: risk per trade = 0.5% of equity; position = risk / stop distance; leverage = floor(13 / stop %), 1x to 10x (so a stop-out costs at most about 13% of the margin, inside your 15%);
// margin per trade is capped at 20% of equity. Exit: the exchange holds the stop (1.5 ATR) and target (3 ATR); a trade still open after 30 bars (5 days) is closed at market.
// These are exactly the exits the tests used. Profit Guard / Sentinel, if you switched them on, can still change a trade; they are off unless you enabled them.
const BAR_MS = 4 * 3600 * 1000;
const DEF = { RISK_PCT: 0.5, MAX_STOP_PCT: 15, MIN_ATR_PCT: 2.0, MAX_TURNOVER_RANK: 100, MAX_LEV: 10, LEV_BUDGET: 13, MAX_OPEN: 8, MAX_OPEN_RISK_PCT: 4, MAX_DIR_RISK_PCT: 2.5, MAX_MARGIN_PCT: 20, DAILY_LOSS_PCT: 3, DD_PAUSE_PCT: 10,
  MAX_SLIP_PCT: 0.3, MAX_SPREAD_PCT: 0.1, HOLD_BARS: 30, MODULES: ['trend', 'combo'], KEEP: 300 };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const r2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

function decimalsOf(step) { const s = String(step), e = s.match(/e-(\d+)$/i); if (e) return Number(e[1]); return (s.split('.')[1] || '').length; }
function roundTick(x, tick) { const t = num(tick); if (!(t > 0)) return String(x); return (Math.round(x / t) * t).toFixed(decimalsOf(tick)); }

// stop distance (% of price) -> leverage, margin, notional, risk in dollars
function size(stopPct, equity, cfg) {
  if (!(stopPct > 0)) return { ok: false, reason: 'no stop distance' };
  if (stopPct > cfg.MAX_STOP_PCT) return { ok: false, reason: 'stop ' + stopPct.toFixed(1) + '% away is over the ' + cfg.MAX_STOP_PCT + '% limit' };
  const lev = Math.max(1, Math.min(cfg.MAX_LEV, Math.floor(cfg.LEV_BUDGET / stopPct)));
  let riskUsd = equity * cfg.RISK_PCT / 100, notional = riskUsd / (stopPct / 100), margin = notional / lev;
  const cap = equity * cfg.MAX_MARGIN_PCT / 100;
  if (margin > cap) { margin = cap; notional = margin * lev; riskUsd = notional * stopPct / 100; }
  return { ok: true, lev, margin, notional, riskUsd, stopPct };
}

// Settings from the V3_CFG environment variable (JSON). Only known keys, only numbers inside sane limits; anything else is ignored and reported.
const LIMITS = { RISK_PCT: [0.05, 2], MAX_STOP_PCT: [1, 15], MIN_ATR_PCT: [0, 10], MAX_TURNOVER_RANK: [10, 200], MAX_LEV: [1, 20], LEV_BUDGET: [3, 15], MAX_OPEN: [1, 10], MAX_OPEN_RISK_PCT: [0.5, 10], MAX_DIR_RISK_PCT: [0.5, 8],
  MAX_MARGIN_PCT: [1, 50], DAILY_LOSS_PCT: [0.5, 10], DD_PAUSE_PCT: [2, 40], MAX_SLIP_PCT: [0.05, 2], MAX_SPREAD_PCT: [0.02, 1], HOLD_BARS: [6, 60] };
function sanitizeConfig(raw) {
  const out = {}, ignored = [];
  if (!raw || typeof raw !== 'object') return { cfg: out, ignored };
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'MODULES') { if (Array.isArray(v) && v.every(x => ['combo', 'fundtrend', 'mom', 'trend', 'trendbtc'].includes(x)) && v.length) out.MODULES = v; else ignored.push(k); continue; }
    const lim = LIMITS[k], n = Number(v);
    if (lim && Number.isFinite(n) && n >= lim[0] && n <= lim[1]) out[k] = n; else ignored.push(k);
  }
  return { cfg: out, ignored };
}

function create(opts = {}) {
  const cfg = { ...DEF, ...(opts.config || {}) };
  // `allowed` = V3_LIVE=on on the server (the one-time permission). `armed` = allowed AND not switched off from the Ecosystem page. Open trades are managed whenever the lane is allowed, armed or not.
  const allowed = opts.enabled !== undefined ? !!opts.enabled : String(process.env.V3_LIVE || '').toLowerCase() === 'on';
  const now = opts.now || (() => Date.now()), log = opts.log || (() => {}), store = opts.store || null;
  const d = opts.deps || {};   // equity(), positions(), dayPnl(), closedPnl(symbol, since), tick(symbol), exec(body), mode()
  const st = { live: [], history: [], decisions: [], peak: 0, paused: false, lastError: null, health: { stage: 0, checked: 0 }, lastSummaryDay: '', armChoice: null, lastEquity: null, lastDayPnl: null };
  let loaded = false, busy = false; const placing = new Set();

  async function load() { if (loaded) return; loaded = true; try { const s = store && await store.load(); if (s) Object.assign(st, { live: s.live || [], history: s.history || [], peak: s.peak || 0, paused: !!s.paused, health: s.health || { stage: 0, checked: 0 }, lastSummaryDay: s.lastSummaryDay || '', armChoice: s.armChoice === false ? false : s.armChoice === true ? true : null }); } catch { /* fresh */ } }
  async function save() { try { if (store) await store.save({ live: st.live, history: st.history.slice(-cfg.KEEP), peak: st.peak, paused: st.paused, health: st.health, lastSummaryDay: st.lastSummaryDay, armChoice: st.armChoice }); } catch { /* memory still has it */ } }
  const isArmed = () => allowed && st.armChoice !== false;
  const alert = text => { try { if (d.alert) d.alert(text); } catch { /* an alert never blocks trading */ } };
  const hm = m => { st.health.by = st.health.by || {}; return st.health.by[m] || (st.health.by[m] = { stage: 0, checked: 0 }); };   // health is judged per module: one rule falling behind never shrinks or stops another
  const factor = m => (hm(m).stage === 1 ? 0.5 : 1);
  const note = (call, verdict, reason, extra) => { st.decisions.push({ at: now(), module: call.module, symbol: call.symbol, dir: call.dir > 0 ? 'long' : 'short', verdict, reason, ...(extra || {}) }); while (st.decisions.length > 120) st.decisions.shift(); };

  // This lane's own realized result since 00:00 UTC (closed v3 trades only). The ESP32 bots trade the same account; their losses are theirs,
  // so they must not switch this lane off, and this lane's losses are judged on their own.
  function ownDayPnl() {
    const d0 = new Date(now()); d0.setUTCHours(0, 0, 0, 0);
    return st.history.filter(h => (h.closedAt || 0) >= d0.getTime() && Number.isFinite(h.pnlUsd)).reduce((t, h) => t + h.pnlUsd, 0);
  }

  // Decide one call. Returns { go, reason, sz }.
  async function decide(call, ctx) {
    if (!cfg.MODULES.includes(call.module)) return { go: false, reason: 'module ' + call.module + ' is not on the live list' };
    if (st.paused) return { go: false, reason: 'paused by you' };
    const eq = ctx.equity;
    if (!(eq > 0)) return { go: false, reason: 'account equity unreadable' };
    if (eq < st.peak * (1 - cfg.DD_PAUSE_PCT / 100)) return { go: false, reason: 'drawdown pause: equity ' + r2(eq) + ' is more than ' + cfg.DD_PAUSE_PCT + '% under its peak ' + r2(st.peak) + ' (resume it on the dashboard when you are ready)' };
    if (ctx.dayPnl === null || ctx.dayPnl === undefined) return { go: false, reason: 'today\'s profit and loss unreadable (fail closed)' };
    const own = ownDayPnl();
    if (own <= -eq * cfg.DAILY_LOSS_PCT / 100) return { go: false, reason: 'daily loss limit: this lane lost ' + r2(own) + ' today (limit ' + cfg.DAILY_LOSS_PCT + '% of equity)' };
    if (ctx.dayPnl <= -eq * cfg.DAILY_LOSS_PCT * 2 / 100) return { go: false, reason: 'account-wide daily loss limit: the whole account is ' + r2(ctx.dayPnl) + ' today (limit ' + cfg.DAILY_LOSS_PCT * 2 + '% of equity, bots included)' };
    const open = st.live.filter(x => x.status === 'open');
    if (open.length >= cfg.MAX_OPEN) return { go: false, reason: open.length + ' trades already open (limit ' + cfg.MAX_OPEN + ')' };
    if (open.some(x => x.symbol === call.symbol)) return { go: false, reason: 'already in ' + call.symbol };
    if (ctx.positions && ctx.positions.some(p => p.symbol === call.symbol)) return { go: false, reason: call.symbol + ' is already held by another lane (a bot or a manual trade): one position per coin on this account' };
    const atrPct = call.atrPct || call.riskPct / 1.5;   // combo: the stop is 1.5 ATR away, so ATR% = stop% / 1.5
    if (atrPct < cfg.MIN_ATR_PCT) return { go: false, reason: '4h ATR is only ' + atrPct.toFixed(1) + '% of price (needs ' + cfg.MIN_ATR_PCT + '%): too quiet, fees eat the move' };
    if (ctx.turnoverRank && ctx.turnoverRank > cfg.MAX_TURNOVER_RANK) return { go: false, reason: 'ranks ' + ctx.turnoverRank + ' by turnover (only the top ' + cfg.MAX_TURNOVER_RANK + ' trade live)' };
    if (hm(call.module).stage >= 2) return { go: false, reason: 'switched off by the health monitor: ' + call.module + ' fell behind random coins twice in a row (resume it on the dashboard when you decide)' };
    const sz = size(call.riskPct, eq, { ...cfg, RISK_PCT: cfg.RISK_PCT * factor(call.module) }); if (!sz.ok) return { go: false, reason: sz.reason };
    const it = ctx.item || {}, last = num(it.last);
    if (!(last > 0)) return { go: false, reason: 'no live price' };
    const slip = Math.abs(last - call.entry) / call.entry * 100;
    if (slip > cfg.MAX_SLIP_PCT) return { go: false, reason: 'price moved ' + slip.toFixed(2) + '% since the signal (limit ' + cfg.MAX_SLIP_PCT + '%)' };
    const bid = num(it.bid), ask = num(it.ask);
    if (bid > 0 && ask > 0 && (ask - bid) / ((ask + bid) / 2) * 100 > cfg.MAX_SPREAD_PCT) return { go: false, reason: 'spread wider than ' + cfg.MAX_SPREAD_PCT + '%' };
    if (call.tgt == null ? (call.dir === 1 ? !(call.stop < last) : !(last < call.stop)) : (call.dir === 1 ? !(call.stop < last && last < call.tgt) : !(call.tgt < last && last < call.stop))) return { go: false, reason: 'price is already outside the stop/target range' };
    const totRisk = open.reduce((t, x) => t + x.riskUsd, 0) + sz.riskUsd, dirRisk = open.filter(x => x.dir === call.dir).reduce((t, x) => t + x.riskUsd, 0) + sz.riskUsd;
    if (totRisk > eq * cfg.MAX_OPEN_RISK_PCT / 100) return { go: false, reason: 'total open risk would be ' + r2(totRisk) + ' (limit ' + cfg.MAX_OPEN_RISK_PCT + '% of equity)' };
    if (dirRisk > eq * cfg.MAX_DIR_RISK_PCT / 100) return { go: false, reason: 'risk in one direction would be ' + r2(dirRisk) + ' (limit ' + cfg.MAX_DIR_RISK_PCT + '% of equity)' };
    return { go: true, reason: 'ok', sz };
  }


  // HEALTH MONITOR: every 50 closed shadow calls of a live module, compare the last 50 with their random-coin controls.
  // Behind by 0.05R or more: the size is halved. Still behind at the next check: the module is switched off. Back at or above its control: full size again.
  function checkHealth() {
    if (!d.windowStats) return;
    for (const m of cfg.MODULES) {
      const w = d.windowStats(m, 50); if (!w || w.real < 50 || w.control < 50) continue;
      const h = hm(m), k = Math.floor(w.totalReal / 50); if (k <= h.checked) continue;
      h.checked = k;
      const edge = w.edge, txt = m + ': last 50 calls averaged ' + r2(w.meanR) + 'R against ' + r2(w.controlMeanR) + 'R for random coins (edge ' + r2(edge) + 'R)';
      if (edge !== null && edge <= -0.05) {
        if (h.stage === 0) { h.stage = 1; alert('⚠️ V3 health: ' + txt + '. Position size for ' + m + ' is now HALVED.'); }
        else if (h.stage === 1) { h.stage = 2; alert('🛑 V3 health: ' + txt + ' for the second check in a row. ' + m + ' is SWITCHED OFF for new trades. Open trades keep their stops. Resume it from the dashboard when you decide.'); }
      } else if (h.stage === 1) { h.stage = 0; alert('✅ V3 health: ' + txt + '. Back to full size.'); }
    }
    st.health.stage = Math.max(0, ...Object.values(st.health.by || {}).map(x => x.stage));
  }

  // Called by the shadow module after each bar with the new real calls.
  // Is this position one of this lane's own trades (or being placed right now)? Profit Guard, Sentinel, the swing manager and re-entry leave such positions alone:
  // their fast-trade rules (breakeven at 0.3R, early partial exits) would cut the long runs the trailing stop is designed to ride.
  const owns = (symbol, side) => placing.has(symbol) || st.live.some(x => x.status === 'open' && x.symbol === symbol && (!side || side === (x.dir > 0 ? 'Buy' : 'Sell')));
  const warm = () => load();
  async function onNewCalls(calls, data) {
    await load();
    const by = new Map(((data && data.items) || []).map(i => [i.symbol, i]));
    const rank = new Map(((data && data.items) || []).slice().sort((a, b) => num(b.turnover) - num(a.turnover)).map((i, k) => [i.symbol, k + 1]));
    let equity = null, dayPnl = null;
    try { equity = await d.equity(); } catch { /* unreadable */ }
    try { dayPnl = await d.dayPnl(); } catch { /* unreadable */ }
    if (equity > st.peak) st.peak = equity;
    st.lastEquity = equity; st.lastDayPnl = dayPnl;
    checkHealth();
    let positions = null;   // everything held on the account right now, whoever opened it; unreadable = null (the order path still refuses a second position on a coin)
    try { positions = d.positions ? await d.positions() : null; } catch { /* unreadable */ }
    if (positions) st.others = positions.filter(p => !st.live.some(x => x.status === 'open' && x.symbol === p.symbol)).map(p => p.symbol + ' ' + (p.side === 'Buy' ? 'long' : 'short')).slice(0, 40);
    for (const call of calls) {
      if (!cfg.MODULES.includes(call.module)) continue;
      const v = await decide(call, { equity, dayPnl, positions, item: by.get(call.symbol), turnoverRank: rank.get(call.symbol) });
      if (!v.go) { note(call, 'skip', v.reason); continue; }
      const sz = v.sz, tickSize = await Promise.resolve(d.tick ? d.tick(call.symbol) : null).catch(() => null);
      const extra = { margin: r2(sz.margin), lev: sz.lev, riskUsd: r2(sz.riskUsd), stopPct: r2(sz.stopPct) };
      if (!isArmed()) { note(call, 'dry-run', 'would place: margin $' + r2(sz.margin) + ' at ' + sz.lev + 'x, risking $' + r2(sz.riskUsd) + (allowed ? ' (switched to dry run on the Ecosystem page)' : ' (not armed: set V3_LIVE=on)'), extra); continue; }
      const id = ('v3' + call.id.toString(36) + Math.floor(call.entryBar / BAR_MS).toString(36)).slice(0, 20);
      const body = { kind: 'open', id, side: call.dir > 0 ? 'BUY' : 'SELL', symbol: call.symbol, usdMargin: Number(sz.margin.toFixed(2)), leverage: sz.lev,
        ...(call.tgt != null ? { tp: tickSize ? roundTick(call.tgt, tickSize) : String(call.tgt) } : {}), sl: tickSize ? roundTick(call.stop, tickSize) : String(call.stop), bot: 'v3' };
      let res; placing.add(call.symbol); try { res = await d.exec(body); } catch (e) { res = { body: { ok: false, code: 'ERR', detail: String(e && e.message || e).slice(0, 120) } }; }
      const b = (res && res.body) || {};
      if (b.ok) { alert('🟢 V3 ' + (call.dir > 0 ? 'LONG ' : 'SHORT ') + call.symbol + ' opened: margin $' + r2(sz.margin) + ' at ' + sz.lev + 'x, risking $' + r2(sz.riskUsd) + ' (stop ' + call.stop + (call.tgt != null ? ', target ' + call.tgt : ', trailing stop, no target') + ')'); st.live.push({ id, callId: call.id, module: call.module, symbol: call.symbol, dir: call.dir, openedAt: now(), entry: call.entry, stop: call.stop, stop0: call.stop, tgt: call.tgt, entryBar: call.entryBar, atr: call.atr, trail: call.trail || null, hold: call.hold || cfg.HOLD_BARS, tickSize: tickSize || null, margin: sz.margin, lev: sz.lev, riskUsd: sz.riskUsd, status: 'open', code: b.code }); note(call, 'placed', b.code + ' ' + (b.detail || ''), extra); }
      else { note(call, 'failed', (b.code || '?') + ' ' + (b.detail || b.message || ''), extra); alert('🔴 V3 order for ' + call.symbol + ' was refused: ' + (b.code || '?') + ' ' + (b.detail || b.message || '')); }
      placing.delete(call.symbol);
      log('[v3live] ' + call.symbol + ' ' + (b.ok ? 'placed' : 'failed') + ' ' + (b.code || ''));
    }
    await save();
  }

  // After every 4h bar (armed only): move the exchange-side stop of each trailing trade to where the tests' trailing rule says it should be now.
  // The stop only ever moves in the trade's favour; a refused update is retried at the next bar and never closes anything.
  async function onBar(data) {
    if (!allowed) return;
    try {
      await load();
      const by = new Map(((data && data.items) || []).map(i => [i.symbol, i])), asOf = (data && data.bar) || now();
      for (const t of st.live) {
        if (t.status !== 'open' || !t.trail || !d.trailState) continue;
        const it = by.get(t.symbol); if (!it) continue;
        const ts = d.trailState({ dir: t.dir, entry: t.entry, stop: t.stop0, atr: t.atr, entryBar: t.entryBar, trail: t.trail }, it.cs, asOf);
        const better = t.dir === 1 ? ts.stop > t.stop + 1e-12 : ts.stop < t.stop - 1e-12;
        if (!better) continue;
        const sl = t.tickSize ? roundTick(ts.stop, t.tickSize) : String(ts.stop);
        let res; try { res = await d.exec({ kind: 'sltp', id: ('v3s' + t.callId.toString(36) + Math.floor(asOf / BAR_MS).toString(36)).slice(0, 20), side: t.dir > 0 ? 'BUY' : 'SELL', symbol: t.symbol, sl, bot: 'v3' }); } catch (e) { res = { body: { ok: false, detail: String(e && e.message || e) } }; }
        const b = (res && res.body) || {};
        if (b.ok) { t.stop = ts.stop; t.trailMoves = (t.trailMoves || 0) + 1; t.trailNote = ''; }
        else t.trailNote = (b.code || '?') + ' ' + (b.detail || '');
      }
      await save();
    } catch (e) { st.lastError = String(e && e.message || e).slice(0, 160); }
  }

  // Every minute (armed only): notice closed trades, close timed-out ones.
  async function tick() {
    if (!allowed || busy) return; busy = true;
    try {
      await load();
      const open = st.live.filter(x => x.status === 'open'); if (!open.length) return;
      const pos = await d.positions();   // [{symbol, side}]
      st.others = pos.filter(p => !open.some(x => x.symbol === p.symbol)).map(p => p.symbol + ' ' + (p.side === 'Buy' ? 'long' : 'short')).slice(0, 40);
      for (const t of open) {
        const held = pos.some(p => p.symbol === t.symbol && p.side === (t.dir > 0 ? 'Buy' : 'Sell'));
        if (!held) {
          t.status = 'closed'; t.closedAt = now();
          try { const pnl = d.closedPnl ? await d.closedPnl(t.symbol, t.openedAt - 60000) : null; if (Number.isFinite(pnl)) { t.pnlUsd = r2(pnl); t.R = r2(pnl / t.riskUsd); } } catch { /* leave blank */ }
          st.history.push(t); alert('⚪ V3 ' + t.symbol + ' closed' + (Number.isFinite(t.R) ? ': ' + t.R + 'R (' + (t.pnlUsd >= 0 ? '+' : '') + t.pnlUsd + ' USDT)' : '')); continue;
        }
        if (now() - t.openedAt >= (t.hold || cfg.HOLD_BARS) * BAR_MS && now() - (t.lastCloseTry || 0) >= 20 * 60000) {   // time is up: close at market, retry every 20 minutes if it did not go through
          t.lastCloseTry = now(); t.closeTries = (t.closeTries || 0) + 1;
          let res; try { res = await d.exec({ kind: 'close', id: ('v3c' + t.callId.toString(36) + t.closeTries).slice(0, 20), side: 'ANY', symbol: t.symbol, bot: 'v3' }); } catch (e) { res = { body: { ok: false, detail: String(e && e.message || e) } }; }
          t.timeoutNote = (res && res.body && (res.body.code + ' ' + (res.body.detail || ''))) || '';
        }
      }
      st.live = st.live.filter(x => x.status === 'open');
      st.lastError = null; await save();
    } catch (e) { st.lastError = String(e && e.message || e).slice(0, 160); }
    finally { busy = false; }
  }


  // One Telegram summary a day (08:00 Lagos = 07:00 UTC): equity and drawdown, today's P&L, open exposure, live results, and every shadow rule against its control.
  function dailyText() {
    const open = st.live.filter(x => x.status === 'open'), done = st.history.filter(h => Number.isFinite(h.R)), mean = done.length ? done.reduce((t, h) => t + h.R, 0) / done.length : null;
    const sh = d.shadowSummary ? d.shadowSummary() : null, lines = ['📊 V3 daily summary' + (isArmed() ? '' : ' (not armed: dry run)')];
    if (st.lastEquity) lines.push('Equity $' + r2(st.lastEquity) + ' (peak $' + r2(st.peak) + ', ' + r2((st.lastEquity / st.peak - 1) * 100) + '% from peak); today ' + (st.lastDayPnl === null || st.lastDayPnl === undefined ? 'unknown' : (st.lastDayPnl >= 0 ? '+' : '') + r2(st.lastDayPnl) + ' USDT'));
    lines.push('Open V3 trades: ' + open.length + ', risk $' + r2(open.reduce((t, x) => t + x.riskUsd, 0)) + '. Closed live trades: ' + done.length + (mean === null ? '' : ', average ' + (Math.round(mean * 1000) / 1000) + 'R'));
    lines.push('Health: ' + (st.health.stage === 0 ? 'full size' : st.health.stage === 1 ? 'HALF size (behind random coins)' : 'SWITCHED OFF') + (st.paused ? '; PAUSED by you' : ''));
    if (sh && sh.modules) for (const [k, m] of Object.entries(sh.modules)) lines.push(k + ': ' + m.closedCalls + ' calls, ' + (m.meanRAfterFunding === null ? 'no result yet' : m.meanRAfterFunding + 'R after funding, edge ' + (m.edgeVsControl === null ? 'n/a' : m.edgeVsControl) + 'R vs random coins') + ' [' + m.health + ']');
    return lines.join('\n');
  }
  async function dailyTick() {
    const t = new Date(now()); const day = t.toISOString().slice(0, 10);
    if (t.getUTCHours() < 7 || st.lastSummaryDay === day) return false;
    await load(); if (st.lastSummaryDay === day) return false;
    st.lastSummaryDay = day; await save(); alert(dailyText()); return true;
  }

  // Arm or disarm from the Ecosystem page. Arming needs V3_LIVE=on on the server (the permission); disarming is always allowed. The choice survives restarts.
  async function setArmed(on) {
    await load();
    if (on && !allowed) return { ok: false, message: 'Arming is locked: set V3_LIVE=on in the Render environment once, then redeploy.' };
    const was = isArmed(); st.armChoice = !!on; await save();
    if (isArmed() !== was) alert(isArmed() ? '🟢 V3 server lane ARMED from the Ecosystem page: new calls will place real trades.' : '⚪ V3 server lane switched to DRY RUN from the Ecosystem page. Open trades keep their stops and are still managed.');
    return { ok: true, armed: isArmed() };
  }
  async function setPaused(on) { await load(); st.paused = !!on; await save(); return st.paused; }
  async function resumeAndResetPeak() { await load(); st.paused = false; st.health = { stage: 0, checked: st.health.checked, by: Object.fromEntries(Object.entries(st.health.by || {}).map(([k, v]) => [k, { stage: 0, checked: v.checked }])) }; try { const eq = await d.equity(); if (eq > 0) st.peak = eq; } catch { /* keep */ } await save(); return { peak: st.peak }; }

  function summary() {
    const done = st.history.filter(h => Number.isFinite(h.R)), mean = done.length ? done.reduce((t, h) => t + h.R, 0) / done.length : null;
    return { armed: isArmed(), canArm: allowed, otherLanesHolding: st.others || [], ownDayPnlUsd: r2(ownDayPnl()), health: st.health.stage === 0 ? 'full size' : st.health.stage === 1 ? 'half size: behind random coins' : 'switched off: behind random coins twice', tradeMode: d.mode ? d.mode() : null, modules: cfg.MODULES, paused: st.paused, peakEquity: r2(st.peak), lastError: st.lastError,
      limits: { riskPerTradePct: cfg.RISK_PCT, maxOpen: cfg.MAX_OPEN, maxOpenRiskPct: cfg.MAX_OPEN_RISK_PCT, maxOneDirectionRiskPct: cfg.MAX_DIR_RISK_PCT, maxStopPct: cfg.MAX_STOP_PCT, leverageRule: 'floor(' + cfg.LEV_BUDGET + ' / stop %), 1x to ' + cfg.MAX_LEV + 'x', maxMarginPct: cfg.MAX_MARGIN_PCT, dailyLossPct: cfg.DAILY_LOSS_PCT, drawdownPausePct: cfg.DD_PAUSE_PCT, holdBars: cfg.HOLD_BARS + ' bars for combo, 84 for trend (trailing stop)' },
      openTrades: st.live.filter(x => x.status === 'open').map(x => ({ module: x.module, trailing: !!x.trail, trailMoves: x.trailMoves || 0, trailNote: x.trailNote || '', symbol: x.symbol, dir: x.dir > 0 ? 'long' : 'short', margin: r2(x.margin), lev: x.lev, riskUsd: r2(x.riskUsd), stop: x.stop, target: x.tgt, openedAt: new Date(x.openedAt).toISOString() })),
      closedTrades: done.length, meanR: mean === null ? null : Math.round(mean * 1000) / 1000, recentClosed: st.history.slice(-10).map(h => ({ symbol: h.symbol, dir: h.dir > 0 ? 'long' : 'short', R: h.R === undefined ? null : h.R, pnlUsd: h.pnlUsd === undefined ? null : h.pnlUsd })),
      recentDecisions: st.decisions.slice(-20).map(x => ({ ...x, at: new Date(x.at).toISOString() })) };
  }
  return { onNewCalls, onBar, owns, warm, tick, dailyTick, dailyText, checkHealth, decide, summary, setPaused, setArmed, resumeAndResetPeak, cfg, state: st, get enabled() { return isArmed(); }, get allowed() { return allowed; } };
}
module.exports = { create, sanitizeConfig, LIMITS, size, roundTick, decimalsOf, DEF };
