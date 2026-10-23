// Run: node tests/crashguard.test.js
const assert = require('assert'); const CG = require('../crashguard');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // uncaught exception: logs, alerts once, exits 1
  { const ev = []; const g = CG.create({ log: () => {}, alert: async t => ev.push(['alert', t]), exit: c => ev.push(['exit', c]) });
    g.onException(new Error('boom')); g.onException(new Error('second')); await sleep(30);
    assert.deepStrictEqual(ev.map(e => e[0]), ['alert', 'exit']); assert(/boom/.test(ev[0][1])); assert.strictEqual(ev[1][1], 1);
    ok('an uncaught exception sends one alert and exits with 1 (a second one does not repeat)'); }
  // a failing or hanging alert never blocks the exit
  { let exited = 0; const g = CG.create({ log: () => {}, alert: () => { throw new Error('tg down'); }, exit: () => exited++ }); g.onException(new Error('x')); await sleep(30); assert.strictEqual(exited, 1);
    let ex2 = 0; const g2 = CG.create({ log: () => {}, alert: () => new Promise(() => {}), exit: () => ex2++ }); g2.onException(new Error('y')); await sleep(2800); assert.strictEqual(ex2, 1);
    ok('a broken or hanging alert cannot stop the restart'); }
  // rejections: alert rate-limited, keep running; restart only when it repeats
  { let t = 1e6; const al = []; let exited = 0;
    const g = CG.create({ log: () => {}, now: () => t, alert: async x => al.push(x), exit: () => exited++ });
    g.onRejection(new Error('a')); t += 1000; g.onRejection(new Error('b')); await sleep(10);
    assert.strictEqual(al.length, 1, 'one alert inside 5 minutes'); assert.strictEqual(exited, 0);
    t += 6 * 60 * 1000; g.onRejection(new Error('c')); await sleep(10); assert.strictEqual(al.length, 2);
    ok('a lone unhandled rejection is logged and alerted (at most every 5 minutes) and the relay keeps running');
    const g2 = CG.create({ log: () => {}, now: () => t, alert: async x => al.push(x), exit: () => exited++ });
    for (let i = 0; i < 20; i++) { t += 1000; g2.onRejection(new Error('loop' + i)); } await sleep(10);
    assert.strictEqual(exited, 1); ok('20 unhandled rejections in 10 minutes = something is stuck: restart');
    const g3 = CG.create({ log: () => {}, now: () => t, alert: async () => {}, exit: () => exited++ });
    for (let i = 0; i < 19; i++) { t += 60 * 1000; g3.onRejection(new Error('slow' + i)); } await sleep(10);
    assert.strictEqual(exited, 1); ok('the same errors spread over more than 10 minutes do not trigger a restart'); }
  console.log('\nALL ' + n + ' CRASH GUARD CHECKS PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
