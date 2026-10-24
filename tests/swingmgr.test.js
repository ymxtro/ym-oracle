'use strict';
const assert = require('assert');
const SW = require('../swingmgr.js'), SN = require('../sentinel.js');
let n = 0; const ok = m => console.log('  ok ' + (++n) + ' ' + m);
const H = 3600000, now = 1800000000000, cfg = SW.normalize(null);
assert.strictEqual(cfg.mode, 'shadow'); ok('default is shadow');
assert.strictEqual(SW.normalize({ mode: 'weird', graceH: 999, thesis: { depth: 5 }, time: { action: 'x' } }).graceH, 5);
assert.strictEqual(SW.normalize({ thesis: { depth: 5 } }).thesis.depth, 0.6); assert.strictEqual(SW.normalize({ time: { action: 'x' } }).time.action, 'tighten'); ok('garbage settings fall back');
// short: entry 100, stop 110 (risk 10)
const entryAt = now - 30 * H, bar = (ageH, c) => ({ t: now - ageH * H, o: c, h: c + 1, l: c - 1, c });
const base = { side: 'Sell', entry: 100, initialSl: 110, curSl: 110, mark: 91, peakR: 1, now, entryAt, tick: 0.01, cfg };
// breakeven needs a CLOSED 4h candle at >= 1R
let d = SW.breakeven({ ...base, bars4h: [bar(8, 99), bar(4, 90)] });                      // the 4h candle opened 4h ago has just closed at 90 = +1R
assert.strictEqual(d.action, 'raise'); assert(d.newSl < 100 && d.newSl > 99.8, d.newSl); ok('a closed 4h candle at +1R moves the stop to breakeven');
d = SW.breakeven({ ...base, bars4h: [bar(8, 99), bar(4, 95), bar(1, 85)] });                // the +1.5R candle is still forming: does not count
assert.strictEqual(d.action, 'none'); ok('a candle that has not closed yet (or a wick) does not count');
d = SW.breakeven({ ...base, bars4h: [bar(40, 80), bar(8, 99)] });                           // an old +2R candle from BEFORE the entry does not count
assert.strictEqual(d.action, 'none'); ok('candles from before the entry are ignored');
d = SW.breakeven({ ...base, mark: 100.2, bars4h: [bar(4, 90)] });                           // price already back near entry: a stop at breakeven would sit inside the 1.2% gap
assert.strictEqual(d.action, 'raise'); assert(Math.abs(d.newSl - 101.4) < 0.02 && /held back/.test(d.label), d.newSl + ' ' + d.label); ok('never closer to the price than 1.2%: the stop is held back to price + 1.2% (still much tighter than the original)');
d = SW.breakeven({ ...base, curSl: 99.5, bars4h: [bar(4, 90)] }); assert.strictEqual(d.action, 'none'); ok('tighter-only: a stop already at breakeven stays');
// thesis exit
d = SW.thesis({ ...base, mark: 107, bars4h: [bar(8, 103), bar(4, 106.5)] }); assert.strictEqual(d.action, 'exit'); ok('a closed 4h candle 0.65R against the trade ends it');
d = SW.thesis({ ...base, mark: 104, bars4h: [bar(8, 103), bar(4, 105)] }); assert.strictEqual(d.action, 'none'); ok('0.5R against: it keeps running');
d = SW.thesis({ ...base, mark: 104, bars4h: [bar(8, 103), bar(1, 109)] }); assert.strictEqual(d.action, 'none'); ok('a forming candle that spiked is a wick, not a close: no exit');
d = SW.thesis({ ...base, cfg: SW.normalize({ thesis: { on: false } }), mark: 107, bars4h: [bar(4, 108)] }); assert.strictEqual(d.action, 'none'); ok('rule can be switched off');
// time rule
const old = { ...base, entryAt: now - 80 * H, peakR: 0.3, mark: 97, bars4h: [] };
d = SW.timeRule(old); assert.strictEqual(d.action, 'raise'); assert(d.newSl < 100, 'stop to breakeven when in profit ' + d.newSl); ok('80h old, peaked 0.3R, a little in profit: stop to breakeven');
d = SW.timeRule({ ...old, mark: 104 }); assert.strictEqual(d.action, 'raise'); assert(d.newSl > 105 && d.newSl < 105.3, 'in loss: -0.5R = 105, held to price+1.2% = 105.25: ' + d.newSl); ok('80h old and underwater: stop to -0.5R (held 1.2% from the price)');
d = SW.timeRule({ ...old, peakR: 0.8 }); assert.strictEqual(d.action, 'none'); ok('it did reach 0.8R: the time rule leaves it alone');
d = SW.timeRule({ ...old, entryAt: now - 20 * H }); assert.strictEqual(d.action, 'none'); ok('20h old: too early');
d = SW.timeRule({ ...old, cfg: SW.normalize({ time: { action: 'exit' } }) }); assert.strictEqual(d.action, 'exit'); ok('time action "exit" closes it');
// grace + sentinel
assert.strictEqual(SW.graceActive(now - 2 * H, now, 5), true); assert.strictEqual(SW.graceActive(now - 6 * H, now, 5), false); assert.strictEqual(SW.graceActive(0, now, 5), false); ok('grace period');
const sc = SN.normalize(null);
assert.strictEqual(sc.swing.graceH, 5); assert.strictEqual(sc.swing.actOn, 'danger'); assert.strictEqual(sc.swing.startR, 1); assert.strictEqual(sc.fast.stallMin, 30); ok('Sentinel swing defaults');
const si = { side: 'Sell', entry: 100, mark: 99.8, peak: 99.8, curSl: 110, initialSl: 110, tick: 0.01, atr: 0.4, state: 'alert', cfg: sc };
const fastD = SN.decide({ ...si, profile: 'fast' }), swingD = SN.decide({ ...si, profile: 'swing' });
assert(/-0.6R/.test(fastD.label) && /-0.85R/.test(swingD.label), fastD.label + ' | ' + swingD.label); ok('loss-side alert: fast goes to -0.6R, swing only to -0.85R');
const dg = SN.decide({ ...si, state: 'danger', mark: 99, peak: 99, atr: 0.5, profile: 'swing' }), dgf = SN.decide({ ...si, state: 'danger', mark: 99, peak: 99, atr: 0.5, profile: 'fast' });
assert(dg.newSl > dgf.newSl, 'swing danger stop sits farther from the price: ' + dg.newSl + ' vs ' + dgf.newSl); ok('danger gap: swing uses 1.2% / hourly ATR, fast 0.25%');
const prof = SN.decide({ ...si, mark: 92, peak: 92, profile: 'swing' }), profF = SN.decide({ ...si, mark: 92, peak: 92, profile: 'fast' });
assert(/breakeven/.test(profF.label) && !/breakeven/.test(prof.label), profF.label + ' | ' + prof.label); ok('"in profit" starts at 1R for swing (0.7R for fast)');
console.log('ALL ' + n + ' SWING MANAGER CHECKS PASSED');
