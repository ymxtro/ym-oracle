// Unit checks for the funding + momentum shadow module (fundmom.js). Run: node tests/fundmom.test.js
const assert = require('assert');
const F = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/fundmom.js' : '../fundmom.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const BAR = F.BAR_MS, T0 = 1700000000000 - (1700000000000 % BAR);
// a coin: slow random-ish walk, optionally drifting; 100 closed bars ending just before `bar`
function coin(sym, drift, funding, bars = 100, bar = T0 + 100 * BAR) {
  const cs = []; let p = 100;
  for (let i = 0; i < bars; i++) { const o = p; p = p * (1 + drift + (((i * 7 + sym.length * 13) % 11) - 5) * 0.0004); cs.push({ t: bar - (bars - i) * BAR, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p }); }
  return { symbol: sym, funding, turnover: 1e7, cs, cur: { t: bar, o: p, h: p, l: p, c: p } };
}
const bar = T0 + 100 * BAR;
// 60 flat coins with mid funding, one strong riser with the highest funding, one strong faller with the lowest funding
const items = []; for (let i = 0; i < 60; i++) items.push(coin('C' + i + 'USDT', 0, 0.0001 + i * 1e-6));
items.push(coin('UPUSDT', 0.004, 0.002)); items.push(coin('DNUSDT', -0.004, -0.002));
let t = 1; const mk = o => F.create({ enabled: true, now: () => t, random: () => 0.5, ...o });

// ranking
assert.deepStrictEqual(F.rankPct([3, 1, 2, 2]).map(x => +x.toFixed(3)), [1, 0.25, 0.625, 0.625]);
ok('percentile ranks match the pandas rank(pct=True) used in the tests, ties averaged');

// signals
let m = mk(); const { out } = m.signals(items);
const has = (mod, sym, dir) => out.some(o => o.module === mod && o.symbol === sym && o.dir === dir);
assert(has('combo', 'UPUSDT', 1) && has('combo', 'DNUSDT', -1) && has('fundtrend', 'UPUSDT', 1) && has('mom', 'UPUSDT', 1) && has('mom', 'DNUSDT', -1));
assert(!out.some(o => o.symbol === 'C5USDT' && o.module === 'combo'));
ok('a strong riser with top funding is a combo long, a strong faller with bottom funding a combo short, a flat coin is neither');

const w = m.signals(items).watch; assert(w[0].met === 3 && ['UPUSDT', 'DNUSDT'].includes(w[0].symbol) && w[0].missing.length === 0 && w.length === items.length);
const flat = w.find(x => x.symbol === 'C5USDT'); assert(flat.met < 3 && flat.missing.length > 0);
ok('the watch list ranks coins by how close they are to a combo trigger and names what each one is still missing');
const mk0 = m.signals(items).market; assert(mk0.universe === items.length && mk0.breadth14dPct > 0 && ['RISING', 'FALLING', 'MIXED', 'SHOCK'].includes(mk0.state), JSON.stringify(mk0));
ok('market state block: breadth over 24h, 3 days and 14 days across the whole universe, funding skew, BTC moves, and a plain label');
{ const m2 = F.create({ enabled: true, random: () => 0.5, store: null, fetchUniverse: async () => ({ items }) }); m2.cycle({ bar: 1e12, items }); const sm = m2.summary(); assert(sm.watching.all.length === items.length && sm.watching.all[0].turnoverRank >= 1 && sm.watching.all.every(x => x.symbol && x.met >= 0 && x.met <= 3), JSON.stringify(sm.watching.all[0])); ok('the whole universe is listed (every coin it looks at, with turnover rank, rule progress and ranks)'); }
// cycle opens calls plus a matched control, never two real calls on one coin and module
t = bar + 100000; m = mk();
let made = m.cycle({ bar, items }); assert(made >= 4, 'made ' + made);
const real = m.state.open.filter(c => !c.ctl), ctl = m.state.open.filter(c => c.ctl);
assert(real.length === made && ctl.length === made && real.every(c => c.entry > 0 && c.riskPct > 0 && c.stop !== c.entry));
assert(real.find(c => c.module === 'combo' && c.symbol === 'UPUSDT').stop < real.find(c => c.module === 'combo' && c.symbol === 'UPUSDT').entry);
const again = m.cycle({ bar, items }); assert.strictEqual(again, 0);
ok('each real call gets one random-coin control in the same direction; the same coin is not called twice while open');

// resolve: target, stop, timeout
const call = { dir: 1, entry: 100, stop: 97, tgt: 106, riskPct: 3, entryBar: bar, funding: 0.001 };
const cs = (arr) => arr.map((a, i) => ({ t: bar + i * BAR, o: 100, h: a[0], l: a[1], c: a[2] }));
t = bar + 50 * BAR;
let r = m.resolve(call, cs([[101, 99, 100], [107, 100, 106]]), bar + 50 * BAR); assert(r.why === 'target' && Math.abs(r.R - (6 - 0.11) / 3) < 1e-9, JSON.stringify(r));
r = m.resolve(call, cs([[101, 96, 98]]), bar + 50 * BAR); assert(r.why === 'stop' && Math.abs(r.R - (-3 - 0.11) / 3) < 1e-9);
r = m.resolve(call, cs([[107, 96, 98]]), bar + 50 * BAR); assert(r.why === 'stop');   // both inside one bar: stop first
r = m.resolve(call, cs(Array.from({ length: 29 }, () => [101, 99, 100])), bar + 100 * BAR); assert(r === null);
r = m.resolve(call, cs(Array.from({ length: 30 }, () => [101, 99, 100.5])), bar + 100 * BAR); assert(r.why === 'timeout' && r.fundR < 0);
ok('target and stop hit at their prices, stop wins when both sit inside one bar, timeout comes after 30 bars, and funding paid is charged to the side that pays');

// next cycle settles the open calls, and the summary reports controls and edge
t = bar + 10 * BAR; const bar2 = bar + 10 * BAR;
const items2 = items.map(it => { const last = it.cs[it.cs.length - 1]; const drift = it.symbol === 'UPUSDT' ? 1.03 : it.symbol === 'DNUSDT' ? 0.97 : 1; const cs2 = it.cs.slice(); let p = last.c; for (let i = 0; i < 10; i++) { const o = p; p = p * (drift ** 0.5); cs2.push({ t: bar + i * BAR, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p }); } return { ...it, cs: cs2, cur: { t: bar2, o: p, h: p, l: p, c: p } }; });
m.cycle({ bar: bar2, items: items2 });
const s = m.summary(); assert(s.modules.combo.closedCalls >= 2 && s.modules.combo.winPct === 100, JSON.stringify(s.modules.combo));
assert(s.modules.combo.health.includes('too few') && s.enabled === true && Array.isArray(s.openCalls));
ok('open calls settle on the next bar, and the summary shows win rate, control and says "too few calls" until 50');

// v2.9.23 trend rules: top/bottom 10% momentum AND a break of the previous 50 days (300 bars); BTC itself never; trendbtc needs BTC more than 1.5% above/below its 30-bar average
{ const mk2 = (sym, f, fund) => { const cs2 = []; let p = 100; for (let i = 0; i < 320; i++) { const o = p; p = f(i, p); cs2.push({ t: bar - (320 - i) * BAR, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p }); } return { symbol: sym, funding: fund, turnover: 1e8, cs: cs2, cur: { t: bar, o: cs2[319].c, h: cs2[319].c, l: cs2[319].c, c: cs2[319].c } }; };
  const flat = (i, p) => 100 + Math.sin(i / 3) * 0.3;
  const uni = [];
  for (let k = 0; k < 40; k++) uni.push(mk2('F' + k + 'USDT', (i, p) => 100 + Math.sin((i + k) / 3) * 0.3, 0.0001));
  uni.push(mk2('BTCUSDT', (i, p) => i < 300 ? 100 + Math.sin(i / 3) * 0.3 : p * 1.004, 0.0001));                      // BTC rising: above its 30-bar average
  uni.push(mk2('BRKUSDT', (i, p) => i < 300 ? 100 + Math.sin(i / 3) * 0.3 : p * 1.006, 0.0001));                       // breaks the 50-day high with the best 14d return
  uni.push(mk2('OLDUSDT', (i, p) => i < 60 ? p * 1.01 : 100 + Math.sin(i / 3) * 0.3, 0.0001));                         // ran long ago: not momentum now, no break
  uni.push(mk2('DIPUSDT', (i, p) => i < 300 ? 100 + Math.sin(i / 3) * 0.3 : p * 0.994, 0.0001));                       // breaks the 50-day low with the worst 14d return
  const tm = F.create({ enabled: true, now: () => bar + 100000 }); const sg = tm.signals(uni).out;
  const tr = sg.filter(x => x.module === 'trend'), tb = sg.filter(x => x.module === 'trendbtc');
  assert(tr.some(x => x.symbol === 'BRKUSDT' && x.dir === 1) && tr.some(x => x.symbol === 'DIPUSDT' && x.dir === -1), JSON.stringify(tr.map(x => [x.symbol, x.dir])));
  assert(!tr.some(x => x.symbol === 'BTCUSDT' || x.symbol === 'OLDUSDT'), 'BTC and stale runners are not trend calls');
  assert(tb.some(x => x.symbol === 'BRKUSDT') && !tb.some(x => x.dir === -1), 'BTC is rising: only longs pass the BTC filter');
  const twl = tm.signals(uni).trendWatch; assert(twl.some(x => x.symbol === 'BRKUSDT' && x.broken && x.side === 'long') && twl.every(x => x.symbol !== 'BTCUSDT'));
  // opening a trend call: stop 2 ATR, no target, trailing spec, 84 bars; its control uses the same exit
  tm.cycle({ bar, items: uni });
  const op = tm.state.open.filter(c => c.module === 'trend'); assert(op.length >= 2 && op.every(c => c.tgt === null && c.trail && c.hold === 84 && Math.abs(c.riskPct - 2 * c.atr / c.entry * 100) < 1e-9));
  assert(op.some(c => c.ctl) && op.some(c => !c.ctl));
  // a short history (under 301 bars) never makes a trend call
  const young = uni.map(it => it.symbol === 'BRKUSDT' ? { ...it, cs: it.cs.slice(-200) } : it); assert(!tm.signals(young).out.some(x => x.symbol === 'BRKUSDT' && x.module === 'trend'));
  ok('trend rules: top/bottom 10% momentum plus a 50-day range break, never BTC, BTC filter for trendbtc, 301+ bars needed, stop 2 ATR with no target and a trailing spec'); }
// trailing exit: stop trails 1.5 ATR behind the best price once 1 ATR in profit; checked before it moves; timeout at 84 bars
{ const tm = F.create({ enabled: true, now: () => bar + 1e9 }); const call = { dir: 1, entry: 100, stop: 96, tgt: null, riskPct: 4, atr: 2, entryBar: bar, trail: { start: 1, k: 1.5 }, hold: 84, funding: 0 };
  const c = (k, h, l, cl) => ({ t: bar + k * BAR, o: cl, h, l, c: cl });
  let r = tm.resolve(call, [c(0, 103, 99, 102), c(1, 108, 101, 107), c(2, 107, 104, 106)], bar + 10 * BAR);   // stops: 96, 100, 105 ; bar2 low 104 <= 105 -> out at 105
  assert(r && r.why === 'trail' && Math.abs(r.R - (5 - 0.11) / 4) < 1e-9, JSON.stringify(r));
  r = tm.resolve(call, [c(0, 103, 99, 102), c(1, 108, 101, 107), c(2, 107, 105.5, 106)], bar + 10 * BAR); assert.strictEqual(r, null);
  r = tm.resolve(call, [c(0, 101, 95, 99)], bar + 10 * BAR); assert(r.why === 'stop' && Math.abs(r.R - (-4 - 0.11) / 4) < 1e-9);
  const flatc = Array.from({ length: 84 }, (_, k) => c(k, 100.5, 99.5, 100.2)); r = tm.resolve(call, flatc, bar + 100 * BAR); assert(r.why === 'timeout' && r.closedAt === bar + 84 * BAR);
  assert.strictEqual(tm.resolve(call, flatc.slice(0, 83), bar + 100 * BAR), null);
  const sh = { ...call, dir: -1, stop: 104 }; r = tm.resolve(sh, [c(0, 101, 97, 98), c(1, 99, 94, 95), c(2, 98.5, 96, 97)], bar + 10 * BAR); assert(r.why === 'trail' && Math.abs(r.R - (3 - 0.11) / 4) < 1e-9, JSON.stringify(r));   // best 94 -> stop 97 after bar1; bar2 high 98.5 >= 97 -> out at 97
  ok('trailing exit: stop checked before it moves, trails 1.5 ATR behind the best price after +1 ATR, shorts mirrored, 84-bar timeout, R after fees'); }
// tick respects the bar timing and a failing data source
(async () => {
  let calls = 0; const tm = F.create({ enabled: true, now: () => bar + 1000, fetchUniverse: async () => { calls++; return { items }; } });
  await tm.tick(); assert.strictEqual(calls, 0);                                   // 1 s after the bar: waits for the delay
  const t2 = F.create({ enabled: true, now: () => bar + 100000, fetchUniverse: async () => { calls++; return { items }; } });
  await t2.tick(); await t2.tick(); assert.strictEqual(calls, 1); assert(t2.state.open.length > 0);   // once per bar
  const bad = F.create({ enabled: true, now: () => bar + 100000, fetchUniverse: async () => { throw new Error('net'); } });
  await bad.tick(); assert(/net/.test(bad.summary().lastError));
  const off = F.create({ enabled: false, now: () => bar + 100000, fetchUniverse: async () => { calls++; return { items }; } }); await off.tick(); assert.strictEqual(calls, 1);
  const small = F.create({ enabled: true, now: () => bar + 100000, fetchUniverse: async () => ({ items: items.slice(0, 10) }) }); await small.tick(); assert(/too small/.test(small.summary().lastError));
  ok('it waits for the bar to settle, runs once per bar, survives a failing data source, a tiny universe and FUNDMOM=off');
  // persistence
  let saved = null; const a = F.create({ enabled: true, now: () => bar + 100000, store: { load: async () => null, save: async s => { saved = JSON.parse(JSON.stringify(s)); } }, fetchUniverse: async () => ({ items }) });
  await a.tick(); assert(saved && saved.open.length > 0 && saved.lastBar === bar);
  const b = F.create({ enabled: true, now: () => bar + 100000, store: { load: async () => saved, save: async () => {} }, fetchUniverse: async () => { throw new Error('should not refetch'); } });
  await b.tick(); assert.strictEqual(b.state.open.length, saved.open.length); assert.strictEqual(b.summary().lastError, null);
  ok('state is saved after a cycle and restored after a restart without repeating the bar');
  console.log('fundmom: all ' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
