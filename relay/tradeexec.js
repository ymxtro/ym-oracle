'use strict';
// Server-side trade execution: everything the manager ESP32 used to do AFTER a bot had decided to trade.
//
// The bot sends ONE request (POST /api/trade) with its decision. This module then does, next to Bybit instead of over a
// hobby-board TLS link: balance check, one-position-per-symbol check, instrument rules, leverage, quantity, the order,
// the wait for the position to appear, and the trailing stop. It mirrors the manager's rules (tradeexec_test.js checks them).
//
// Dependency-injected (no require of the server) so it can be tested alone, like alertroute.js:
//   rest()              -> the Bybit REST client (bybit-api RestClientV5)
//   mode()              -> 'live' | 'paper'
//   halted()            -> true while the circuit breaker is tripped
//   placeOrder(body)    -> the server's processOrder (fan-out to users, master sizing, idempotency, trade log) -> Bybit response
//   fanOutLeverage(b) / fanOutTradingStop(b) -> copy to every user's account (fire and forget)
//   report(rec)         -> the dashboard's execution report (same record the manager used to post to /api/exec-report)
//
// Result codes are the manager's: OK DUP PAPER SCALED LEVCLMP NOTRL (landed) / BAL MINQ PAIR LEV BYBIT NET HELD SIDE NOPOS HALT BAD (not).

const BAL_USABLE_FRACTION = 0.97;     // leave ~3% of the free balance for fees and price movement (same as the manager)
const BAL_MIN_SCALE_FRACTION = 0.5;   // never open smaller than half of what the bot asked for (same as the manager)
const DONE_TTL_MS = 15 * 60 * 1000;   // a retransmitted id inside this window gets the stored answer, never a second order
const TRAIL_POLL_MS = 250;            // wait for the new position to show up: first look is immediate, then every 250 ms...
const TRAIL_POLL_MAX = 16;            // ...up to ~4 s (the manager allowed 6 x 700 ms)
const CALL_TIMEOUT_MS = 8000;         // one Bybit read/write may not hang the whole trade
const ORDER_TIMEOUT_MS = 15000;
const KIND_REPORT = { open: 'TRADE', sltp: 'SLTP', close: 'CLOSE' };

class TradeFail extends Error { constructor(code, detail) { super(detail); this.code = code; this.detail = detail; } }
const fail = (code, detail) => { throw new TradeFail(code, detail); };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

// '' = not given, null = given but not a positive number, otherwise the value as text (passed to Bybit unchanged)
const numStr = v => { if (v === undefined || v === null || v === '') return ''; const n = Number(v); return Number.isFinite(n) && n > 0 ? String(v).trim() : null; };

function decimalsOf(step) {
  const s = String(step);
  const e = s.match(/e-(\d+)$/i);
  if (e) return Number(e[1]);
  return (s.split('.')[1] || '').length;
}

// What the bot asked for -> a clean command, or { error }.
function parse(b) {
  b = (b && typeof b === 'object') ? b : {};
  const kind = String(b.kind || '').toLowerCase();
  if (!KIND_REPORT[kind]) return { error: 'kind must be open, sltp or close' };
  const id = String(b.id || '');
  if (!/^[A-Za-z0-9]{1,20}$/.test(id)) return { error: 'id is required (letters and digits, up to 20)' };
  const side = String(b.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return { error: 'side must be BUY or SELL' };
  const symbol = String(b.symbol || '').toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return { error: 'symbol is required' };
  const tp = numStr(b.tp), sl = numStr(b.sl), activePrice = numStr(b.trailActivePrice);
  if (tp === null || sl === null || activePrice === null) return { error: 'tp, sl and trailActivePrice must be positive numbers when given' };
  const cmd = { kind, id, side, symbol, bot: clip(b.bot || '?', 30), bybitSide: side === 'BUY' ? 'Buy' : 'Sell', tp, sl, activePrice, usdMargin: 0, leverage: 0, trailPct: 0 };
  if (kind === 'open') {
    cmd.usdMargin = Number(b.usdMargin);
    cmd.leverage = Math.floor(Number(b.leverage));
    cmd.trailPct = (b.trailPct === undefined || b.trailPct === null || b.trailPct === '') ? 0 : Number(b.trailPct);
    if (!(cmd.usdMargin > 0 && cmd.usdMargin <= 1e6)) return { error: 'usdMargin must be a positive number' };
    if (!(cmd.leverage >= 1 && cmd.leverage <= 200)) return { error: 'leverage must be 1 to 200' };
    if (!(Number.isFinite(cmd.trailPct) && cmd.trailPct >= 0 && cmd.trailPct <= 50)) return { error: 'trailPct must be 0 to 50' };
  }
  if (kind === 'sltp' && !tp && !sl) return { error: 'nothing to update (give tp and/or sl)' };
  return { cmd, reportable: { id, bot: cmd.bot, kind: KIND_REPORT[kind], side, symbol } };
}

// Bybit's answer (passed through by processOrder / setTradingStop) -> { ok, code, detail }. Same codes as the manager.
function classify(res) {
  if (!res || typeof res !== 'object') return { ok: false, code: 'NET', detail: 'unreadable reply from Bybit' };
  if (res.paper === true) return { ok: true, code: 'PAPER', detail: 'paper mode: nothing was sent to Bybit', paper: true };
  const rc = Number(res.retCode);
  if (res.retCode === undefined || res.retCode === null || !Number.isFinite(rc)) {
    return { ok: false, code: 'NET', detail: res && res.error ? 'backend error: ' + clip(res.error, 100) : 'no usable reply from Bybit' };
  }
  if (rc === 0) return { ok: true, code: 'OK', detail: 'accepted' };
  if (rc === 110072) return { ok: true, code: 'DUP', detail: 'already placed (same orderLinkId)' };
  if (rc === 34040) return { ok: true, code: 'NOCHG', detail: 'already at that value' };
  const msg = String(res.retMsg || 'no message'), low = msg.toLowerCase();
  let code = 'BYBIT';
  if ([110007, 110004, 110012, 110045].includes(rc) || low.includes('insufficient') || low.includes('not enough')) code = 'BAL';
  else if (rc === 110094 || (low.includes('min') && (low.includes('qty') || low.includes('value') || low.includes('notional') || low.includes('size')))) code = 'MINQ';
  else if (low.includes('symbol') && (low.includes('invalid') || low.includes('not exist') || low.includes('not found'))) code = 'PAIR';
  return { ok: false, code, detail: clip('Bybit ' + rc + ': ' + msg, 160) };
}

function create(deps) {
  const d = Object.assign({ now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), log: () => {}, fanOutLeverage: () => {}, fanOutTradingStop: () => {}, report: () => {} }, deps);
  const done = new Map();      // "kind:id" -> { at, body }
  const inflight = new Map();  // "kind:id" -> Promise<{ http, body, cache }>
  const locks = new Map();     // symbol -> tail of a promise chain

  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(what + ' timed out')), ms); if (t.unref) t.unref(); })]);
  async function retry(fn, tries = 2, gapMs = 250) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await withTimeout(Promise.resolve().then(fn), CALL_TIMEOUT_MS, 'Bybit call'); }
      catch (e) { last = e; if (i < tries - 1) await d.sleep(gapMs); }
    }
    throw last;
  }
  // One trade per symbol at a time. The manager did everything one-by-one, so two bots signalling the same pair could never
  // race; now that bots call the server directly, this lock is what keeps "one position per symbol" true.
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return next;
  }
  function prune() { const cutoff = d.now() - DONE_TTL_MS; for (const [k, v] of done) if (v.at < cutoff) done.delete(k); }

  // ---- Bybit reads ----
  async function getAvailable() {
    const r = await retry(() => d.rest().getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' }));
    if (!r || r.retCode !== 0 || !r.result || !(r.result.list || []).length) throw new Error('balance: ' + (r && r.retMsg));
    const acct = r.result.list[0];
    const coinData = (acct.coin || []).find(c => c.coin === 'USDT');
    let available = parseFloat(acct.totalAvailableBalance);   // same rule as GET /api/balance
    if (!Number.isFinite(available)) {
      const wallet = parseFloat(coinData && coinData.walletBalance);
      available = Number.isFinite(wallet) ? Math.max(0, wallet - (parseFloat(coinData && coinData.totalPositionIM) || 0) - (parseFloat(coinData && coinData.totalOrderIM) || 0))
        : parseFloat((coinData && (coinData.equity || coinData.walletBalance)) || 0);
    }
    return available;
  }
  async function getHeld(symbol) {
    const r = await retry(() => d.rest().getPositionInfo({ category: 'linear', symbol }));
    if (!r || r.retCode !== 0) throw new Error('positions: ' + (r && r.retMsg));
    const p = ((r.result && r.result.list) || []).find(x => parseFloat(x.size) > 0);
    return p ? { side: p.side, size: String(p.size), markPrice: parseFloat(p.markPrice) } : null;
  }
  async function getInstrument(symbol) {
    const r = await retry(() => d.rest().getInstrumentsInfo({ category: 'linear', symbol }));
    if (!r || r.retCode !== 0 || !r.result || !(r.result.list || []).length) fail('PAIR', symbol + ' is not listed on Bybit (pair not available)');
    const inst = r.result.list[0], lot = inst.lotSizeFilter || {}, lev = inst.leverageFilter || {};
    if (inst.status && inst.status !== 'Trading') fail('PAIR', symbol + ' is not tradable right now (status ' + inst.status + ')');
    let qtyStep = parseFloat(lot.qtyStep); const minQty = parseFloat(lot.minOrderQty);
    if (!(qtyStep > 0)) qtyStep = minQty > 0 ? minQty : 0.001;
    return { qtyStep, minQty, minNotional: parseFloat(lot.minNotionalValue) || 0, maxLeverage: parseFloat(lev.maxLeverage) || 0 };
  }
  async function getPrice(symbol) {
    const r = await retry(() => d.rest().getTickers({ category: 'linear', symbol }));
    if (!r || r.retCode !== 0 || !r.result || !(r.result.list || []).length) fail('PAIR', symbol + ' has no price on Bybit (pair not available)');
    const p = parseFloat(r.result.list[0].lastPrice);
    if (!(p > 0)) fail('PAIR', symbol + ' has no price on Bybit (pair not available)');
    return p;
  }
  // unwrap one result of Promise.allSettled: a TradeFail keeps its code, anything else is a network problem
  const unwrap = (s, netMsg) => { if (s.status === 'fulfilled') return s.value; if (s.reason instanceof TradeFail) throw s.reason; fail('NET', netMsg); };

  function calcQty(positionUsd, leverage, price, inst) {
    const lev = leverage > 0 ? leverage : 1;
    if (inst.minNotional > 0 && positionUsd < inst.minNotional) fail('MINQ', 'position $' + positionUsd.toFixed(2) + " is under Bybit's $" + inst.minNotional.toFixed(2) + ' minimum; need >= $' + (inst.minNotional / lev).toFixed(2) + ' margin at ' + lev + 'x');
    const raw = positionUsd / price;
    if (raw < inst.minQty) fail('MINQ', 'min order ' + inst.minQty + ' (~$' + (inst.minQty * price).toFixed(2) + '); need >= $' + ((inst.minQty * price) / lev).toFixed(2) + ' margin at ' + lev + 'x');
    const rounded = Math.floor(raw / inst.qtyStep + 1e-9) * inst.qtyStep;   // round DOWN to a multiple of the step
    if (rounded < inst.minQty) fail('MINQ', "after rounding to the step the size is under Bybit's minimum " + inst.minQty);
    return rounded.toFixed(decimalsOf(inst.qtyStep));
  }

  async function setLeverage(symbol, lev) {
    const body = { category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev) };
    Promise.resolve().then(() => d.fanOutLeverage(body)).catch(() => {});   // users' accounts: never waited on
    if (d.mode() === 'paper') return;
    let r;
    try { r = await retry(() => d.rest().setLeverage(body)); } catch (e) { fail('NET', 'could not reach Bybit to set the leverage'); }
    const rc = r && r.retCode;
    if (rc === 0 || rc === 110043) return;   // 110043 = already at that leverage
    fail('LEV', 'Bybit rejected ' + lev + 'x: ' + clip(r && r.retMsg || 'no message', 100));
  }

  // setTradingStop with the manager's "try three times on a non-answer" rule. Returns { ok, code, detail }.
  async function tradingStop(body) {
    Promise.resolve().then(() => d.fanOutTradingStop(body)).catch(() => {});
    if (d.mode() === 'paper') return { ok: true, code: 'PAPER', detail: 'paper mode: nothing was sent to Bybit', paper: true };
    let c = { ok: false, code: 'NET', detail: 'no reply from Bybit' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { c = classify(await withTimeout(Promise.resolve().then(() => d.rest().setTradingStop(body)), CALL_TIMEOUT_MS, 'Bybit call')); }
      catch (e) { c = { ok: false, code: 'NET', detail: 'no reply from Bybit: ' + clip(e.message, 80) }; }
      if (c.ok || c.code !== 'NET') return c;
      if (attempt < 3) await d.sleep(400 * attempt);
    }
    return c;
  }

  // Waits for the freshly opened position to exist on Bybit, then sets the trailing stop. Returns { ok, detail }.
  async function setTrailing(cmd) {
    let pos = null;
    for (let i = 0; i < TRAIL_POLL_MAX; i++) {
      const h = await getHeld(cmd.symbol).catch(() => null);
      if (h && h.side === cmd.bybitSide) { pos = h; break; }
      await d.sleep(TRAIL_POLL_MS);
    }
    if (!pos) return { ok: false, detail: 'position not confirmed in time; trailing stop not set' };
    let price = pos.markPrice;   // the position read already carries the price: no extra round trip
    if (!(price > 0)) price = await getPrice(cmd.symbol).catch(() => 0);
    if (!(price > 0)) return { ok: false, detail: 'could not read the price for the trailing stop' };
    const distStr = (price * (cmd.trailPct / 100)).toFixed(4);   // same 4-decimal distance the manager sent
    if (!(Number(distStr) > 0)) return { ok: false, detail: 'trail distance rounds to zero at this price; trailing stop not set' };
    const body = { category: 'linear', symbol: cmd.symbol, trailingStop: distStr };
    if (cmd.activePrice) body.activePrice = cmd.activePrice;
    const c = await tradingStop(body);
    return c.ok ? { ok: true, detail: '' } : { ok: false, detail: 'trailing stop refused: ' + c.detail };
  }

  // Places an order through the server's own pipeline. If the reply is lost, asks Bybit whether it landed (same as the manager).
  async function placeAndConfirm(payload, symbol, wantHeldSide, T) {
    T.orderTried = true;
    let c;
    try { c = classify(await withTimeout(Promise.resolve().then(() => d.placeOrder(payload)), ORDER_TIMEOUT_MS, 'order')); }
    catch (e) { c = { ok: false, code: 'NET', detail: 'order call failed: ' + clip(e.message, 80) }; }
    if (!c.ok && c.code === 'NET') {
      const h = await getHeld(symbol).then(x => ({ x }), () => null);
      if (h && ((wantHeldSide && h.x && h.x.side === wantHeldSide) || (!wantHeldSide && h.x === null))) c = { ok: true, code: 'OK', detail: 'confirmed on Bybit after a lost reply' };
      else c.detail = 'no usable reply and Bybit does not show it: ' + c.detail;
    }
    return c;
  }

  // ---- the three commands. Each returns { ok, code, detail }. ----
  async function execOpen(cmd, T) {
    let t = d.now();
    const [bal, held, inst, px] = await Promise.allSettled([getAvailable(), getHeld(cmd.symbol), getInstrument(cmd.symbol), getPrice(cmd.symbol)]);
    T.read = d.now() - t;
    const available = unwrap(bal, 'could not read the Bybit balance');
    let margin = cmd.usdMargin, scaled = false;
    const usable = available * BAL_USABLE_FRACTION;
    if (margin > usable) {
      if (usable > 0 && usable >= margin * BAL_MIN_SCALE_FRACTION) { margin = usable; scaled = true; }   // open smaller, never larger
      else fail('BAL', 'wanted $' + cmd.usdMargin.toFixed(2) + ' margin, only $' + available.toFixed(2) + ' free');
    }
    // Unlike the manager (which carried on when it could not read positions), this refuses: a second order on a held pair
    // would net against the first in Bybit's one-way mode and overwrite its TP/SL.
    const h = unwrap(held, 'could not check the open positions');
    if (h) fail('HELD', 'already in a ' + h.side + ' position on ' + cmd.symbol);
    const rules = unwrap(inst, 'could not read the instrument rules for ' + cmd.symbol);
    let lev = cmd.leverage;
    if (rules.maxLeverage >= 1 && lev > Math.floor(rules.maxLeverage)) lev = Math.floor(rules.maxLeverage);   // clamp to the pair's cap
    t = d.now(); await setLeverage(cmd.symbol, lev); T.lev = d.now() - t;
    const price = unwrap(px, 'could not read the price for ' + cmd.symbol);
    const qty = calcQty(margin * lev, lev, price, rules);

    const payload = { category: 'linear', symbol: cmd.symbol, side: cmd.bybitSide, orderType: 'Market', qty, orderLinkId: 'ym-' + cmd.id };
    if (cmd.tp) payload.takeProfit = cmd.tp;
    if (cmd.sl) payload.stopLoss = cmd.sl;
    t = d.now(); let c = await placeAndConfirm(payload, cmd.symbol, cmd.bybitSide, T); T.order = d.now() - t;
    if (!c.ok) return c;
    if (c.code === 'OK' && (scaled || lev !== cmd.leverage)) {   // opened, but not exactly as asked: say so
      const notes = [];
      if (scaled) notes.push('margin $' + cmd.usdMargin.toFixed(2) + '->$' + margin.toFixed(2) + ' (only $' + available.toFixed(2) + ' free)');
      if (lev !== cmd.leverage) notes.push('leverage ' + cmd.leverage + 'x->' + lev + 'x (pair cap)');
      c = { ok: true, code: scaled ? 'SCALED' : 'LEVCLMP', detail: notes.join('; ') };
    }
    if (cmd.trailPct > 0 && !c.paper) {
      t = d.now(); const tr = await setTrailing(cmd); T.trail = d.now() - t;
      if (!tr.ok) c = { ok: true, code: 'NOTRL', detail: tr.detail };
    }
    return c;
  }

  async function execSltp(cmd) {
    const h = await getHeld(cmd.symbol).then(x => ({ x }), () => fail('NET', 'could not read the open positions'));
    if (!h.x) return { ok: false, code: 'NOPOS', detail: 'no open position on ' + cmd.symbol + ' to update' };
    if (h.x.side !== cmd.bybitSide) return { ok: false, code: 'SIDE', detail: 'open position is ' + h.x.side + ', not ' + cmd.bybitSide + ' -- left alone' };
    const body = { category: 'linear', symbol: cmd.symbol };
    if (cmd.tp) body.takeProfit = cmd.tp;
    if (cmd.sl) body.stopLoss = cmd.sl;
    return tradingStop(body);
  }

  async function execClose(cmd, T) {
    const h = await getHeld(cmd.symbol).then(x => ({ x }), () => fail('NET', 'could not read the open positions'));
    if (!h.x) return { ok: true, code: 'NOPOS', detail: 'no open position on ' + cmd.symbol + ' (already closed)' };
    if (h.x.side !== cmd.bybitSide) return { ok: false, code: 'SIDE', detail: 'open position on ' + cmd.symbol + ' is ' + h.x.side + ', not ' + cmd.bybitSide + ' -- left alone' };
    const closeSide = h.x.side === 'Buy' ? 'Sell' : 'Buy';
    const payload = { category: 'linear', symbol: cmd.symbol, side: closeSide, orderType: 'Market', qty: h.x.size, reduceOnly: true, orderLinkId: 'ymc-' + cmd.id };
    return placeAndConfirm(payload, cmd.symbol, null, T);   // null = "confirmed" means the position is gone
  }

  async function execute(cmd) {
    const T = { orderTried: false };
    const t0 = d.now();
    let c;
    try {
      if (d.halted()) c = { ok: false, code: 'HALT', detail: 'trading is halted on the dashboard' };
      else c = await withLock(cmd.symbol, () => (cmd.kind === 'open' ? execOpen(cmd, T) : cmd.kind === 'sltp' ? execSltp(cmd) : execClose(cmd, T)));
    } catch (e) {
      c = e instanceof TradeFail ? { ok: false, code: e.code, detail: e.detail } : { ok: false, code: 'NET', detail: 'unexpected error: ' + clip(e && e.message, 100) };
      if (!(e instanceof TradeFail)) d.log('[trade] unexpected error', cmd.kind, cmd.symbol, e && e.stack);
    }
    T.total = d.now() - t0;
    const detail = clip(c.detail, 160);
    try { d.report({ id: cmd.id, bot: cmd.bot, kind: KIND_REPORT[cmd.kind], side: cmd.side, symbol: cmd.symbol, ok: c.ok, code: c.code, detail }); } catch (e) { d.log('[trade] report failed:', e.message); }
    const ms = {}; for (const k of ['total', 'read', 'lev', 'order', 'trail']) if (T[k] !== undefined) ms[k] = T[k];
    d.log('[trade] ' + cmd.kind + ' ' + cmd.symbol + ' ' + cmd.side + ' id=' + cmd.id + ' -> ' + c.code + (c.ok ? '' : ' FAILED') + ' ' + Object.keys(ms).map(k => k + '=' + ms[k] + 'ms').join(' '));
    // A pre-order network failure changed nothing at Bybit, so a retransmit may try again; every other answer is final for this id.
    const cache = !(c.code === 'NET' && !T.orderTried);
    return { http: 200, cache, body: { success: true, ok: c.ok, code: c.code, detail, id: cmd.id, ms } };
  }

  // Entry point for POST /api/trade. Returns { http, body }. Never throws for a bad request.
  async function run(raw) {
    const p = parse(raw);
    if (p.error) {
      if (raw && /^[A-Za-z0-9]{1,20}$/.test(String(raw.id || '')) && KIND_REPORT[String(raw.kind || '').toLowerCase()]) {
        const r = String(raw.kind).toLowerCase();
        try { d.report({ id: String(raw.id), bot: clip(raw.bot || '?', 30), kind: KIND_REPORT[r], side: String(raw.side || '').toUpperCase().slice(0, 4), symbol: String(raw.symbol || '').toUpperCase().slice(0, 20), ok: false, code: 'BAD', detail: p.error }); } catch (e) { /* the 400 below is what matters */ }
      }
      return { http: 400, body: { success: false, ok: false, code: 'BAD', message: p.error } };
    }
    const cmd = p.cmd, key = cmd.kind + ':' + cmd.id;
    prune();
    if (done.has(key)) return { http: 200, body: { ...done.get(key).body, replayed: true } };
    if (inflight.has(key)) { const r = await inflight.get(key); return { http: 200, body: { ...r.body, replayed: true } }; }
    const work = execute(cmd);
    inflight.set(key, work);
    let r;
    try { r = await work; } finally { inflight.delete(key); }
    if (r.cache) done.set(key, { at: d.now(), body: r.body });
    return { http: r.http, body: r.body };
  }

  return { run, _parse: parse };
}

module.exports = { create, parse, classify, decimalsOf, BAL_USABLE_FRACTION, BAL_MIN_SCALE_FRACTION };
