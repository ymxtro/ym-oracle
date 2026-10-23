'use strict';
// Crash guard (v2.9.7). Before, ANY unexpected error was logged and the relay kept running, possibly half-updated: trades still open on Bybit while the
// code that manages them (Profit Guard, Sentinel) was no longer doing its job, and nobody was told. Now:
//   - an uncaught exception = the process is in an unknown state -> log it, send ONE alert, exit(1). Render restarts the relay at once; Profit Guard and
//     Sentinel state live in the database, so a restart is safe, and the real stops stay on Bybit meanwhile.
//   - an unhandled promise rejection is usually one failed fire-and-forget call, so it is logged and alerted (at most once per 5 minutes), and the relay
//     keeps running, unless it happens over and over (20 in 10 minutes), which means something is stuck: then it restarts the same way.
function create(d) {
  const log = d.log || console.error, now = d.now || Date.now;
  const exit = d.exit || (code => process.exit(code));
  const alert = d.alert || (async () => {});
  const REJ_WINDOW = 10 * 60 * 1000, REJ_MAX = 20, ALERT_GAP = 5 * 60 * 1000;
  let rej = [], lastAlert = 0, dying = false;
  const brief = e => String((e && (e.stack || e.message)) || e).split('\n').slice(0, 3).join(' | ').slice(0, 300);
  async function safeAlert(text) { try { await Promise.race([Promise.resolve(alert(text)), new Promise(r => setTimeout(r, 2500))]); } catch { /* alert failed: nothing more to do */ } }
  function die(why) {
    if (dying) return; dying = true;
    log('[crash-guard] ' + why + ' -- exiting so the host restarts the relay');
    safeAlert('🛑 Relay crashed and is restarting: ' + why).then(() => exit(1), () => exit(1));
  }
  return {
    onException(err) { log('Uncaught Exception thrown:', err); die(brief(err)); },
    onRejection(reason) {
      log('Unhandled Rejection, reason:', reason);
      const t = now(); rej = rej.filter(x => t - x < REJ_WINDOW); rej.push(t);
      if (rej.length >= REJ_MAX) { die(rej.length + ' unhandled errors in 10 minutes, last: ' + brief(reason)); return; }
      if (t - lastAlert >= ALERT_GAP) { lastAlert = t; safeAlert('⚠️ Relay hit an unhandled error (still running): ' + brief(reason)); }
    },
    _state: () => ({ dying, rej: rej.length }),
  };
}
module.exports = { create };
