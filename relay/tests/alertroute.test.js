// Unit checks for the Telegram routing rules (alertroute.js). Run: node tests/alertroute.test.js
const assert = require('assert');
const R = require(process.env.RELAY_DIR ? process.env.RELAY_DIR + '/alertroute.js' : '../alertroute.js');
let n = 0; const ok = m => console.log('  ok', ++n, m);
const ENV = { groupChat: '-100111', dmChat: '777' };
const NOW = 1_800_000_000_000;
const kinds = rt => rt.targets.map(t => t.kind).join('+');

// defaults reproduce today's behaviour: signals/updates to the group, the private things to the DM
let c = R.defaults();
assert.strictEqual(kinds(R.resolve(c, 'signals', NOW, ENV)), 'group'); assert.strictEqual(kinds(R.resolve(c, 'updates', NOW, ENV)), 'group');
for (const k of ['zones', 'daily', 'ops', 'tests']) assert.strictEqual(kinds(R.resolve(c, k, NOW, ENV)), 'dm', k);
ok('defaults: signals and updates go to the group; zones, daily summary, warnings and tests go to your DM');

// no DM set up: live mode falls back to the main chat exactly like before this feature (nothing is lost)
assert.strictEqual(kinds(R.resolve(c, 'zones', NOW, { groupChat: '-100111', dmChat: '' })), 'group');
ok('live mode with no DM chat: private alerts fall back to the main chat (same as before)');

// per-category routes: group / dm / both / off
c = R.normalize({ routes: { signals: 'both', updates: 'off', zones: 'group' } });
assert.strictEqual(kinds(R.resolve(c, 'signals', NOW, ENV)), 'group+dm');
const off = R.resolve(c, 'updates', NOW, ENV); assert(off.muted && off.targets.length === 0);
assert.strictEqual(kinds(R.resolve(c, 'zones', NOW, ENV)), 'group');
ok('each category can go to the group, the DM, both, or nowhere');
// same chat for both: one message, not two
assert.strictEqual(R.resolve(R.normalize({ routes: { signals: 'both' } }), 'signals', NOW, { groupChat: '5555', dmChat: '5555' }).targets.length, 1);
ok('group and DM being the same chat does not double-send');

// dev mode: nothing reaches the group; group-bound alerts go to the DM with a tag; DM-bound alerts are unchanged
c = R.fromRequest({ mode: 'dev', hours: 2 }, NOW, R.defaults());
let rt = R.resolve(c, 'signals', NOW + 1000, ENV);
assert.strictEqual(kinds(rt), 'dm'); assert(/DEV/.test(rt.prefix));
assert.strictEqual(kinds(R.resolve(c, 'ops', NOW + 1000, ENV)), 'dm'); assert.strictEqual(R.resolve(c, 'ops', NOW + 1000, ENV).prefix, '');
assert.strictEqual(R.resolve(R.normalize({ mode: 'dev', routes: { signals: 'both' } }), 'signals', NOW, ENV).targets.some(t => t.kind === 'group'), false);
ok('dev mode: nothing reaches the group; what was meant for the group arrives in your DM, tagged DEV');
// dev mode with no DM: never falls back to the group
const nodm = R.resolve(c, 'signals', NOW + 1000, { groupChat: '-100111', dmChat: '' });
assert(nodm.muted && nodm.targets.length === 0);
ok('dev mode with no DM chat: nothing is sent to the group (it stays quiet instead)');

// timer: dev mode lapses back to live by itself
assert.strictEqual(c.until, NOW + 2 * 3600000);
assert.strictEqual(R.effectiveMode(c, NOW + 3600000), 'dev'); assert.strictEqual(R.effectiveMode(c, NOW + 2 * 3600000), 'live');
assert.strictEqual(kinds(R.resolve(c, 'signals', NOW + 3 * 3600000, ENV)), 'group');
assert.strictEqual(R.fromRequest({ mode: 'dev' }, NOW, R.defaults()).until, 0, 'no hours = until changed');
assert.strictEqual(R.fromRequest({ mode: 'live', hours: 5 }, NOW, c).until, 0);
assert.strictEqual(R.fromRequest({ routes: { signals: 'dm' } }, NOW + 5, c).until, c.until, 'editing a route keeps the running timer');
assert.strictEqual(R.fromRequest({ mode: 'dev', hours: 4 }, NOW + 5, c).until, NOW + 5 + 4 * 3600000, 'picking a new timer restarts it');
ok('the timer ends dev mode by itself (no hours = stays until you change it back); live mode never has a timer');

// off mode: silent, but warnings can still reach the DM
c = R.normalize({ mode: 'off' });
assert(R.resolve(c, 'signals', NOW, ENV).muted); assert(R.resolve(c, 'zones', NOW, ENV).muted);
assert.strictEqual(kinds(R.resolve(c, 'ops', NOW, ENV)), 'dm');
assert(R.resolve(R.normalize({ mode: 'off', keepOps: false }), 'ops', NOW, ENV).muted);
assert(R.resolve(R.normalize({ mode: 'off' }), 'ops', NOW, { groupChat: '-1001', dmChat: '' }).muted, 'off never falls back to the group');
ok('off mode: everything silent; warnings still reach your DM unless you turn that off too');

// stored chat ids win over the environment; bad values are rejected, junk config cannot break anything
c = R.normalize({ groupChat: '-100999', dmChat: '@mychannel' });
assert.strictEqual(R.resolve(c, 'signals', NOW, ENV).targets[0].chat, '-100999'); assert.strictEqual(R.resolve(c, 'zones', NOW, ENV).targets[0].chat, '@mychannel');
assert.strictEqual(R.normalize({ groupChat: 'hello world', dmChat: '12' }).groupChat, ''); assert.strictEqual(R.normalize({ dmChat: '12' }).dmChat, '');
for (const junk of [null, undefined, 5, 'x', [], { mode: 'banana', routes: { signals: 'moon', nope: 'dm' }, until: 'abc' }]) { const z = R.normalize(junk); assert.strictEqual(z.mode, 'live'); assert.strictEqual(z.routes.signals, 'group'); }
assert.strictEqual(R.resolve(R.defaults(), 'whatever', NOW, ENV).targets[0].kind, 'group', 'an unknown category is treated as a trade update');
ok('chat ids saved here win over Render settings; bad ids and junk settings are ignored safely');
console.log('\nALL ' + n + ' ROUTING CHECKS PASSED');
