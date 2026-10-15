# Alerts from Render, not from the bots (v2.3)

## The design in one picture
bot  --(small HTTPS report, queued + retried)-->  Render  --> Telegram (+ email where you want it)
- A bot never talks to Telegram or Gmail again. It only talks to Render (it already does, for the ledger).
- Render STORES each alert before sending, retries up to 8 times, and ignores a repeat (so no duplicates).
- Two kinds of alert:
  1. Trade alerts: the full detailed text the bot already writes (entry, stop, target, RRR, trail, runtime; and the result). Zone found, trade management, circuit breaker, daily summary: also forwarded as written.
  2. Safety net: Render's own short "trade opened / closed" message from the ledger events. It is only sent if the bot's detailed text did not arrive within 45 s. So you never get two, and you never get none.
- Console -> Bots & alerts -> "Recent alerts from the bots" shows each alert and whether it was delivered or is retrying.

## What changes in each bot (firmware/oracle1..4_lf.ino, made from your files)
One switch near the top: `#define ALERTS_VIA_RENDER 1`. Set it to 0 and reflash to get the old behaviour back exactly.
With it on:
- sendTelegramMessage() hands the alert to Render. If it cannot (no memory) it falls back to the old direct way, so an alert is never lost.
- sendEmailWithRetry() does nothing (the same alert already went to Render, which can email it).
- The daily summary was EMAIL-ONLY. Its text now goes to Render (which emails it if email is set up there). Without this change the daily summary would have stopped.
- The SMTP login at boot is skipped. The worked-near-miss archive email (the CSV that then clears the log) still uses Gmail, connecting only when it needs to. Untouched.
- The bot's "Test alert" button now sends a test through Render, so it tests the real route.
- No standing memory: an alert's text is allocated when queued and freed when Render accepts it (3 slots, 1100 bytes each, at most). The big email-queue Strings and the 24 KB heap needed for the SMTP handshake are no longer needed.
Not touched: scanning, entries, exits, relay to the manager, the ledger reports, the screens.

## Render settings
Telegram (already set): ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID.
Private chat (the bots' private zone alerts): ALERT_TELEGRAM_PRIVATE_CHAT_ID  (if unset, they go to the main chat)
Email (optional): RESEND_API_KEY, ALERT_EMAIL_TO, optional ALERT_EMAIL_FROM. The daily summary is emailed when this is set. ALERT_EMAIL_ALL=true emails every alert.
Other: TRADE_ALERT_HOLD_S (default 45), TRADE_ALERTS=off silences the Render alerts.
IMPORTANT: leave each bot's "Telegram alerts" toggle ON. With this firmware that toggle means "send alerts via Render". (Turning it off silences the bot's forwarded alerts; the short safety-net alert still comes.) The Email toggle only matters for the daily summary.
If you ever set DEVICE_KEY_MODE=enforce on Render, put the device key into each bot first, or Render will refuse the bot's reports.

## Rollout (one bot first)
1. Deploy v2.3 on Render, set the settings above. Console -> Bots & alerts -> Send test alert: it must arrive.
2. Flash ONE bot (suggest Oracle IV, the swing bot, quietest) with its file from /firmware. Open its Control page, press Test alert: the page answers at once, in plain words, with what Render replied, and the test arrives in Telegram. Serial shows "[i] SMTP not opened at boot".
3. Watch that bot for a day: zone alerts, an entry, a result. Each arrives once, and the console list shows "Delivered".
4. Flash the other three the same way.
Rollback any time: set ALERTS_VIA_RENDER to 0, reflash.

## Honest limits
- The new bot code (firmware-tools/webmsg_block.cpp) was compiled and tested on a computer with stand-ins for the ESP32 parts (JSON escaping, emoji-safe cutting, retries, refusal, full queue, expiry). The complete sketches were NOT compiled with the ESP32 toolchain here: that is your first flash. Your host simulator should still compile the unchanged blocks, since the macro is off there.
- Alerts longer than about 1000 characters are cut with "..." (the daily summary with many examples can be).
- The Control page's "alert delivery log" on a bot stays empty with this firmware, because delivery is now shown in the console.

## Added in the full audit (v2.4)
- Delivery safety: bot alerts are stored first, then retried by a sweep every ALERT_SWEEP_MS (default 20000 ms), up to 8 tries within 2 hours, so a Telegram outage delays an alert but does not lose it.
- Abuse limits (matter while DEVICE_KEY_MODE=warn): max 40 stored messages per bot and 120 in total per 10 minutes, at most 200 new ledger signals per 10 minutes, one test alert per 15 s. Over the limit the relay answers 429; the bots treat that as "try later" and keep the message.
- Authenticator (ADMIN_TOTP_SECRET) on: the password alone no longer opens the controls; only a signed-in console session does. The manager still reads /api/balance and /api/positions with the password. The OLD /dashboard/classic page and the home page status line stop working in this mode (use the console).
- Bot memory: alerts need about 22 KB free heap (ledger reports 30 KB). Check "free heap" per bot in Console -> Bots after flashing; if it sits near the floor, alerts are delayed, not lost.
- A bot that has never sent a detailed message in the last 24 h (very first trade after flashing) may produce the short alert AND the detailed one for that single trade.
- Pin bybit-api in package.json once you are happy with a version (the lockfile is included; use `npm ci` on Render).
- Test-only switches (ignored unless NODE_ENV=test): YM_TEST_ALERT_URL, YM_TEST_TIMERS, YM_TEST_BYBIT_URL.
- Full pipeline test: `TEST_DATABASE_URL=... node tests/server.test.js` (26 checks incl. bot -> relay -> fake Bybit -> fake Telegram).


## Scan-protection changes (v2.4.1, all four bots)
- Render posts now give up after 6 s at most (connect 2.5 s + read 3.5 s, was 8 s), so they can never hold the shared network lock longer than the scan is willing to wait (8 s). A timed-out post is retried with backoff; the relay ignores repeats of the same key, so nothing is lost or doubled.
- New log line once per scan: "[i] Health: free heap, lowest ever, largest free block, scan-task stack headroom". Failed-fetch lines also show the largest free block. Log only, no behaviour change.
- Healthy numbers: largest free block above ~45000 (TLS needs ~40 KB in one piece); stack headroom above ~2000 bytes.

## Test button (v2.4.2)
The bot's Send test alert button posts to Render immediately and the page shows Render's actual answer in plain words plus the HTTP code. If it says the relay is an older version, deploy the current relay on Render first (older relays refuse the test message with HTTP 400).

## Telegram control (v2.5)
Where each alert goes (group, your DM, both, off), plus Dev and Off modes with timers, is now controlled from the console: see TELEGRAM-CONTROL.md.
