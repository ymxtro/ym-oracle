# Deploying YM Oracle v2.0 (Standard v1) — step by step

Nothing here touches your ESP32 bots or the manager. The same firmware keeps working.

## Before you start (2 minutes)
1. In Neon, make a backup branch of your database (Branches → Create branch). This is your undo button.
2. In GitHub, note which commit is live now (that is your rollback point).

## Deploy
1. Replace these files in your GitHub repo with the ones in this folder: server.js, multiuser.js, package.json, HANDOFF.md, and everything in public/ and tests/. (security.js and package-lock.json are unchanged.)
2. Commit. Render redeploys by itself. The first start does the one-time migration (watch the Render log for: `Standard v1 migration done`).
3. Optional Render settings (all have safe defaults, you do not need to add any):
   - MIN_LIVE_BALANCE (default 50; 0 = no minimum for live sign-ups)
   - SIGNAL_ALARM_SECONDS (default 60)
   - MASTER_FOLLOWS_PLAN (default off; "true" makes the master account use the same 20% rule)

## What changes for people when it goes live
- Users who were on "match" sizing move to 10% of their own balance × their old multiplier, and see a short notice on their page. Fixed-amount users are unchanged.
- Everyone gets the safety rails: max 3 open trades, stop for the day at −10% of the day's starting balance, pause at −30% from the peak, no trade above $500 margin.
- The admin Plan page and user "Trade size" page are new. Autopilot/Manual is gone.
- Admin → Activity now starts with a Signals list. If a bot says it sent a trade and nothing reaches the relay within 60 seconds, you get a Telegram alert.

## Check it worked (5 minutes)
1. Open /admin → Plan: you should see 20%, max 3 open, 10% daily loss, 30% drawdown, $500 cap.
2. Open /admin → Users: each person shows their trade size ("20% / trade" etc.).
3. Open /join as a test user: the Trade size card shows the size, a preview, and the safety rails.
4. Turn on Dry run (admin top bar), wait for the next signal, and read Activity: every user should be "would trade" or have a plain reason. Turn Dry run off.
5. Admin → Activity → Signals: after the next bot signal you should see a row with "Reached the relay".

## If something looks wrong
Redeploy the previous commit in Render. New tables and columns are additive so the old code still starts. The migration already changed users' size settings; if you want those back exactly, restore the Neon backup branch.

## Leverage note
Leverage is now whatever each signal says. The old plan "max leverage" setting is ignored. Bybit can still lower it for a coin where its own limit is smaller. If you ever want a hard cap, set MAX_USER_LEVERAGE in Render (it is not set by default).
