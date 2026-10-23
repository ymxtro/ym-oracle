// Run: node tests/reentrybrain.test.js
const assert = require('assert'); const B = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/reentrybrain.js' : '../reentrybrain.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
// deterministic candles: a drift, a wobble, a range of about 0.4% per bar
function bars(len, start, drift, o = {}) {
  const out = []; let prev = start;
  for (let i = 0; i < len; i++) {
    const c = start * (1 + drift * i) * (1 + (o.wobble || 0.002) * Math.sin(i * 0.9)); const op = prev; prev = c;
    out.push({ o: op, h: Math.max(op, c) * 1.002, l: Math.min(op, c) * 0.998, c, v: (o.v || 100) * (1 + 0.2 * Math.cos(i)) * (i === len - 2 ? (o.lastV || 1) : 1) });
  }
  return out;
}
const up15 = bars(60, 100, 0.0015), up60 = bars(60, 100, 0.004), dn15 = bars(60, 100, -0.0015), dn60 = bars(60, 100, -0.004);
const btcUp = bars(30, 60000, 0.004), btcDn = bars(30, 60000, -0.004);
const base = { side: 'Buy', price: 108.9, stop: 107.9, peak: 109.9, entry: 107, src: 'winner', c15: up15, c60: up60, btc: btcUp, turnover: 30e6, pair: null };
const S = o => B.score({ ...base, ...o });

assert.strictEqual(Object.values(B.W).reduce((a, b) => a + b, 0), 100, 'weights add up to 100');
const good = S({}); assert(good.ok && good.score >= 70 && good.score <= 100, JSON.stringify(good.score));
assert.deepStrictEqual(Object.keys(good.parts).sort(), ['btc', 'liquidity', 'pair', 'pullback', 'resume', 'stop', 'trend']);
for (const k of Object.keys(good.parts)) assert(good.parts[k].pts >= 0 && good.parts[k].pts <= good.parts[k].max && good.parts[k].note, k);
assert(Math.abs(Object.values(good.parts).reduce((t, p) => t + p.pts, 0) - good.score) < 0.11, 'the score is the sum of its visible parts');
ok('an aligned long in an up-trend with BTC rising and a liquid pair scores strongly; every part is visible, bounded and explained');

const against = S({ c15: dn15, c60: dn60 }); assert(against.ok && against.score < good.score - 15, against.score + ' vs ' + good.score); assert(against.parts.trend.pts < good.parts.trend.pts - 10);
assert(/against/.test(against.parts.trend.note));
const pretty = S({ c15: dn15, c60: dn60, price: 108.9 }); assert(pretty.capped && pretty.capped.at === 55 && pretty.score <= 55 && /against the trade/.test(pretty.capped.why), 'a clean pullback in a wrong-way trend is capped: ' + pretty.score);
assert(/capped/.test(B.summary(pretty)) && pretty.flags.some(f => /capped at 55/.test(f)));
assert(!good.capped, 'a healthy setup is not capped');
const flat15 = bars(60, 100, 0, { wobble: 0.004 }), flat60 = bars(60, 100, 0, { wobble: 0.004 });
const midTrend = S({ c15: flat15, c60: flat60, btc: btcDn }), midUp = S({ c15: flat15, c60: flat60, btc: btcUp });
assert(midTrend.ok && midUp.ok && midUp.score > midTrend.score + 8, 'a flat pair with BTC against scores below the same pair with BTC rising: ' + midTrend.score + ' vs ' + midUp.score);
if (midTrend.score > 58) assert.fail('a flat pair with BTC clearly against must not pass 58: ' + midTrend.score);
assert(midTrend.capped ? midTrend.capped.at === 58 : midTrend.score <= 58, JSON.stringify(midTrend.capped));
ok('the same long against a falling pair scores much lower (the trend part), and a clean pullback in a wrong-way market is capped below the minimum');

const btcBad = S({ btc: btcDn }); assert(btcBad.score < good.score - 6 && btcBad.parts.btc.pts < 5, btcBad.parts.btc.pts); assert(/against the trade/.test(btcBad.parts.btc.note));
const sBtc = B.score({ ...base, side: 'Sell', price: 91, stop: 92, peak: 90, entry: 93, c15: dn15, c60: dn60, btc: btcDn }); assert(sBtc.ok && sBtc.score >= 65, 'a short with everything falling: ' + sBtc.score);
const sBad = B.score({ ...base, side: 'Sell', price: 91, stop: 92, peak: 90, entry: 93, c15: dn15, c60: dn60, btc: btcUp }); assert(sBad.score < sBtc.score - 6);
ok('BTC moving against the trade costs points; a short is judged with the directions flipped');

const thin = S({ turnover: 2.17e6 }); assert(thin.parts.liquidity.pts < 3 && thin.score < good.score && /thin/.test(thin.parts.liquidity.note), thin.parts.liquidity.note);
assert.strictEqual(S({ turnover: 0.3e6 }).parts.liquidity.pts, 0); assert.strictEqual(S({ turnover: 50e6 }).parts.liquidity.pts, 6);
ok('a thin pair (like SOON at $2M a day) loses liquidity points; very thin scores 0, deep scores full');

const deep = S({ stop: 100, peak: 112, entry: 107 }); assert(deep.parts.pullback.pts < good.parts.pullback.pts - 5, 'a collapse is not a pullback: ' + deep.parts.pullback.pts);
const noise = S({ stop: 108.7, peak: 109.0 }); assert(noise.parts.stop.pts < 5 && noise.parts.pullback.pts < good.parts.pullback.pts, 'a stop inside the noise scores low: ' + noise.parts.stop.pts);
const shake = S({ src: 'shake', entry: 108, peak: 108.3, stop: 107.9, price: 108.8 }); assert(shake.ok && /shake-out/.test(shake.parts.pullback.note));
const winnerSame = S({ src: 'winner', entry: 108, peak: 108.3, stop: 107.9, price: 108.8 }); assert(shake.parts.pullback.pts > winnerSame.parts.pullback.pts, 'a shake-out is not marked down for a small earlier run');
ok('pullback and stop parts: a collapse or a stop inside the noise scores low; a shake-out is judged by size only');

const weakResume = S({ price: 108.0 }); assert(weakResume.parts.resume.pts < good.parts.resume.pts, 'price below the fast average');
const lowVol = B.score({ ...base, c15: bars(60, 100, 0.0015, { lastV: 0.2 }) }); assert(lowVol.parts.resume.pts < good.parts.resume.pts, 'weak volume on the last candle');
ok('the resume part falls when price is back under the fast average or the resume has no volume');

const pairGood = S({ pair: { n: 4, avgR: 1.2 } }), pairBad = S({ pair: { n: 4, avgR: -1 } }), pairFew = S({ pair: { n: 1, avgR: -1 } });
assert(pairGood.parts.pair.pts > 2 && pairBad.parts.pair.pts < 2 && pairFew.parts.pair.pts > pairBad.parts.pair.pts && pairFew.parts.pair.pts < 2, [pairGood, pairBad, pairFew].map(x => x.parts.pair.pts).join('/'));
ok('the pair record moves the score a little, and less while there are few results');

// fail closed
for (const [bad, why] of [[{ c15: up15.slice(0, 20) }, /15-minute/], [{ c60: up60.slice(0, 10) }, /1-hour/], [{ c15: null }, /15-minute/], [{ stop: 110 }, /protective side/], [{ price: 0 }, /protective side/], [{ c15: up15.map(b => ({ ...b, h: 0 })) }, /15-minute/]]) {
  const r = S(bad); assert.strictEqual(r.ok, false); assert(why.test(r.reason), r.reason);
}
const flat = bars(60, 100, 0); const fr = S({ c15: flat.map(b => ({ ...b, o: 100, h: 100, l: 100, c: 100 })) }); assert.strictEqual(fr.ok, false);
const noBtc = S({ btc: null, turnover: null }); assert(noBtc.ok && noBtc.flags.length === 2 && noBtc.parts.btc.pts === 7.5 && noBtc.parts.liquidity.pts === 3, JSON.stringify(noBtc.flags));
ok('missing or broken candles make the score "unreadable" (so no live order); missing BTC or turnover is neutral and flagged');

assert.strictEqual(B.sizeFactor(60, 60), 0.6); assert.strictEqual(B.sizeFactor(100, 60), 1.1); assert.strictEqual(B.sizeFactor(80, 60), 0.85); assert.strictEqual(B.sizeFactor(30, 60), 0.6); assert.strictEqual(B.sizeFactor(120, 60), 1.1);
assert(/^\d/.test(B.summary(good)) && /trend/.test(B.summary(good)) && /unreadable/.test(B.summary({ ok: false, reason: 'x' })));
ok('size factor runs from 0.6x at the minimum score to 1.1x at 100; the one-line summary names every part');
console.log('\nALL ' + n + ' RE-ENTRY BRAIN CHECKS PASSED');
