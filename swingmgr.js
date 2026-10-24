'use strict';
// SWING MANAGER (v2.9.12). A swing trade lives for days, so it is judged on hours-and-days evidence, not on the seconds-and-minutes reads the fast engines use.
// Pure decisions only (no network, no database): the relay feeds in the trade, the closed 4-hour candles and the clock, and gets back what to do.
//   grace      the first hours after entry: the Sentinel / Profit Guard leave the stop alone (only the original stop and emergencies)
//   breakeven  the stop goes to breakeven only after a CLOSED 4h candle has closed at least holdR in profit (a wick that touched +1R does not count)
//   thesis     a CLOSED 4h candle that closes `depth` of the way to the original stop ends the trade early (a wick does not; the real stop stays on the exchange)
//   time       old and going nowhere (no `minR` peak after `afterH` hours): tighten to breakeven / -0.5R, or exit, because funding costs build up
// Modes: off | shadow (log what it would do, touch nothing) | live. Default shadow.

const MODES = ['off', 'shadow', 'live'];
const H4 = 4 * 3600000;

function defaults() {
  return {
    mode: 'shadow', graceH: 5, beOffsetPct: 0.1, gapPct: 1.2,
    be: { on: true, holdR: 1.0 },
    thesis: { on: true, depth: 0.6 },
    time: { on: true, afterH: 72, minR: 0.5, action: 'tighten' },
  };
}
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const obj = v => (v && typeof v === 'object' ? v : {});
function normalize(raw) {
  const d = defaults(), r = obj(raw), be = obj(r.be), th = obj(r.thesis), tm = obj(r.time);
  return {
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    graceH: num(r.graceH, 0, 48, d.graceH), beOffsetPct: num(r.beOffsetPct, 0, 1, d.beOffsetPct), gapPct: num(r.gapPct, 0.1, 5, d.gapPct),
    be: { on: be.on === undefined ? d.be.on : be.on === true, holdR: num(be.holdR, 0.3, 3, d.be.holdR) },
    thesis: { on: th.on === undefined ? d.thesis.on : th.on === true, depth: num(th.depth, 0.3, 0.95, d.thesis.depth) },
    time: { on: tm.on === undefined ? d.time.on : tm.on === true, afterH: num(tm.afterH, 6, 720, d.time.afterH), minR: num(tm.minR, 0.1, 3, d.time.minR), action: tm.action === 'exit' ? 'exit' : 'tighten' },
  };
}

const graceActive = (entryAtMs, nowMs, graceH) => Number(entryAtMs) > 0 && Number(graceH) > 0 && nowMs - entryAtMs < graceH * 3600000;
// The newest candle that has fully closed AND opened after the trade started. bars: [{t,o,h,l,c}] oldest first, t = open time in ms.
function lastClosedAfter(bars, nowMs, entryAtMs, frameMs = H4) {
  for (let i = (bars || []).length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.t + frameMs <= nowMs) return b.t >= entryAtMs ? b : null;
  }
  return null;
}
const roundTo = (v, tick) => (tick > 0 ? Math.round(v / tick) * tick : v);
const fixTick = (v, tick) => (tick > 0 ? Number(v.toFixed(Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 1)))) : v);

// Common finishing: stay at least gapPct from the price, round to the tick, move by at least 0.05R, tighter than the current stop only.
function finish(i, target, label) {
  const long = i.side === 'Buy', mark = Number(i.mark), cur = Number(i.curSl) > 0 ? Number(i.curSl) : 0, tick = Number(i.tick) || 0;
  const risk = Math.abs(Number(i.entry) - Number(i.initialSl));
  const limit = long ? mark * (1 - i.gapPct / 100) : mark * (1 + i.gapPct / 100);
  if (long ? target > limit : target < limit) { target = limit; label += ' (held back from the price)'; }
  target = roundTo(target, tick);
  if (tick > 0) { if (long && target > limit) target -= tick; if (!long && target < limit) target += tick; }
  target = fixTick(target, tick);
  const baseline = cur > 0 ? cur : Number(i.initialSl);
  if (!(long ? target >= baseline + Math.max(0.05 * risk, tick) : target <= baseline - Math.max(0.05 * risk, tick))) return { action: 'none', why: 'the stop is already as tight or tighter' };
  return { action: 'raise', newSl: target, label };
}
function badRisk(i) {
  const long = i.side === 'Buy', entry = Number(i.entry), init = Number(i.initialSl);
  return !(entry > 0) || !(init > 0) || !(Number(i.mark) > 0) || (long ? init >= entry : init <= entry);
}
const sideR = (i, px) => ((i.side === 'Buy' ? px - Number(i.entry) : Number(i.entry) - px) / Math.abs(Number(i.entry) - Number(i.initialSl)));

// i: { side, entry, initialSl, curSl, mark, peakR, now, entryAt, bars4h, tick, cfg }
function breakeven(i) {
  const cfg = i.cfg;
  if (!cfg.be.on) return { action: 'none', why: 'breakeven rule is off' };
  if (badRisk(i)) return { action: 'none', why: 'no original stop to measure the risk from' };
  const b = lastClosedAfter(i.bars4h, i.now, i.entryAt);
  if (!b) return { action: 'none', why: 'no closed 4h candle since entry yet' };
  const r = sideR(i, b.c);
  if (r < cfg.be.holdR) return { action: 'none', why: 'the last closed 4h candle closed at ' + r.toFixed(2) + 'R (needs ' + cfg.be.holdR + 'R)' };
  const long = i.side === 'Buy', entry = Number(i.entry);
  const target = long ? entry * (1 + cfg.beOffsetPct / 100) : entry * (1 - cfg.beOffsetPct / 100);
  return finish({ ...i, gapPct: cfg.gapPct }, target, 'breakeven: a 4h candle closed at ' + r.toFixed(2) + 'R');
}
function thesis(i) {
  const cfg = i.cfg;
  if (!cfg.thesis.on) return { action: 'none', why: 'thesis exit is off' };
  if (badRisk(i)) return { action: 'none', why: 'no original stop to measure the risk from' };
  const b = lastClosedAfter(i.bars4h, i.now, i.entryAt);
  if (!b) return { action: 'none', why: 'no closed 4h candle since entry yet' };
  const r = sideR(i, b.c);
  if (r <= -cfg.thesis.depth) return { action: 'exit', why: 'a closed 4h candle ended at ' + r.toFixed(2) + 'R, past ' + (-cfg.thesis.depth) + 'R: the setup has failed', label: 'thesis exit' };
  return { action: 'none', why: 'last closed 4h candle at ' + r.toFixed(2) + 'R' };
}
function timeRule(i) {
  const cfg = i.cfg;
  if (!cfg.time.on) return { action: 'none', why: 'time rule is off' };
  if (badRisk(i)) return { action: 'none', why: 'no original stop to measure the risk from' };
  const ageH = Number(i.entryAt) > 0 ? (i.now - i.entryAt) / 3600000 : 0;
  if (ageH < cfg.time.afterH) return { action: 'none', why: 'only ' + ageH.toFixed(0) + 'h old' };
  if (Number(i.peakR) >= cfg.time.minR) return { action: 'none', why: 'it did reach ' + Number(i.peakR).toFixed(2) + 'R' };
  const nowR = sideR(i, Number(i.mark));
  if (cfg.time.action === 'exit') return { action: 'exit', why: ageH.toFixed(0) + 'h old and never reached ' + cfg.time.minR + 'R (peak ' + Number(i.peakR).toFixed(2) + 'R)', label: 'time exit' };
  const long = i.side === 'Buy', entry = Number(i.entry), risk = Math.abs(entry - Number(i.initialSl));
  const target = nowR >= 0.15 ? (long ? entry * (1 + cfg.beOffsetPct / 100) : entry * (1 - cfg.beOffsetPct / 100)) : (long ? entry - 0.5 * risk : entry + 0.5 * risk);
  return finish({ ...i, gapPct: cfg.gapPct }, target, 'time rule: ' + ageH.toFixed(0) + 'h old, peak only ' + Number(i.peakR).toFixed(2) + 'R, stop to ' + (nowR >= 0.15 ? 'breakeven' : '-0.5R'));
}

module.exports = { MODES, defaults, normalize, graceActive, lastClosedAfter, breakeven, thesis, timeRule, sideR };
