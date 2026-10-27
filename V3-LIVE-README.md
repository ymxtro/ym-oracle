# v2.9.21: shadow modules and the v3 live layer

What runs, and what each switch does. Nothing here changes how the ESP32 bots trade.

| Part | Default | Switch | Read it at |
|---|---|---|---|
| Limit-order shadow (`limitshadow.js`) | OFF | `LIMIT_SHADOW=on` | `/api/limit-shadow` |
| Funding + momentum shadow (`fundmom.js`) | ON (places no orders) | `FUNDMOM=off` stops it | `/api/fundmom` |
| V3 live layer (`v3live.js`) | OFF = dry run only (writes what it would do) | `V3_LIVE=on` arms it | `/api/v3live` |

## Arming the live layer
1. Leave `V3_LIVE` unset first. After the next 4h candle, read `/api/v3live`: `recentDecisions` shows each call, the margin, leverage and risk it would use, or why it skipped.
2. Use a DEMO key first (`BYBIT_DEMO=true` or `TRADE_MODE=paper`) and let it place at least 100 trades.
3. Only then set `V3_LIVE=on` on a live key. Start small: it risks 0.5% of equity per trade.
4. `V3_MODULES=trend,combo` (default). `trendbtc`, `fundtrend` and `mom` are shadow only. To run only the swing rule: `V3_MODULES=trend`.

## Rules it enforces (all printed in /api/v3live "limits")
Risk 0.5% of equity per trade (stop-out = 0.5% of the account); leverage floor(13 / stop %), 1x-10x; margin per trade at most 20% of equity; coin in the top 100 by turnover with a 4h ATR of at least 2% of price (quiet coins lose to fees; low-volume coins showed no edge in the tests); stop no wider than 15% (so even at 1x a stop-out costs at most 15% of the margin); at most 8 open; total open risk at most 4% of equity, one direction at most 2.5%; no new trades after a 3% daily loss; pause when equity is 10% under its peak (POST `/api/v3live/resume` to resume); price within 0.3% of the signal and spread under 0.1%; exit: `combo` has an exchange-side stop (1.5 ATR) and target (3 ATR), market close after 5 days; `trend` has an exchange-side stop 2 ATR away and NO target, and after each 4h bar the stop is moved up behind the best price (see below), market close after 14 days.

POST `/api/v3live/pause` with `{"on":true}` stops new trades at once; open trades keep their exchange stops.

## The swing rebuild: `trend` (v2.9.23)
Built from the 3.8-year study (143 coins, 4h candles, Jan 2023 to Oct 2026), because the old ESP32 swing gates had no edge in that data (about -0.005R against random coins).
- **Entry (checked after each 4h close, entered at the next open):** long if the coin is in the top 10% of the 14-day return across the ~120 most-traded perpetuals AND its close is above the highest high of the previous 50 days; short is the mirror image. BTC itself is never traded by this rule. `trendbtc` is the same with a BTC filter (longs only while BTC is 1.5% above its 30-bar average, shorts only while 1.5% below): fewer trades, smaller drawdown, shadow only.
- **Exit:** stop 2 ATR(4h) away, no target. Once the trade is 1 ATR in profit, the stop is kept 1.5 ATR behind the best price reached (it only ever moves in the trade's favour). The relay updates the exchange stop after every 4h bar. Closed at market after 84 bars (14 days). Fixed targets were tested and lost money on the same entries: the profit comes from the few trades that run far.
- **Portfolio test (fees 0.11% + slippage 0.10% + real funding, one position per coin, up to 8 open, 5 per direction, 0.5% risk, stop up to 15%):** about 500 trades a year, +0.115R per trade, +32% a year on equity, worst drawdown -13%, positive in the first 60% (+87%), the last 40% (+48%) and in all four quarters (+25%, +33%, +45%, +15%). Three random seeds agreed. Combined with `combo`, about the same return with a similar drawdown.
- **What is NOT proven:** this is a back-test on Binance data, with next-open entries, a flat 0.10% slippage and funding taken from history. Most of the profit comes from a minority of big winners (the top 1% of trades is about 65% of the total R), so expect long losing stretches (about half the trades lose) and a result that depends on a few trending weeks. The edge over random coins is about +0.14R per trade; the 90% range of that is positive but not tight. The shadow log runs the same rule with matched random coins, and the health monitor halves the size if the live results fall behind them. Run it dry first and read `/ecosystem` ("Trend watch" shows each strong coin and how far it is from breaking its 50-day range).

## How it stays out of the other systems' way (v2.9.23 audit)
- **One position per coin on the account:** the server checks what the account holds before it orders; the relay also refuses a second open on a coin. A bot refused because the server holds the coin keeps its own record, as for any refusal.
- **Profit Guard, Sentinel, the swing manager, the profit controller and re-entry skip the server lane's trades.** Their rules (breakeven at 0.3R, early partial exits) are built for 15-minute fast trades and would cut the long runs the trailing stop rides. The manual close-all, the kill switch and the exposure views still see them.
- **Stop-width limit:** the relay's `MAX_STOP_PCT` (default 10) refuses bot trades with wider stops; the server lane (bot name `v3`) is held to its own 15% limit instead. Note the bots' swing engine now allows stops up to 15% but the relay still refuses over 10% unless you set `MAX_STOP_PCT=15` on Render; until then a bot swing trade with a 10-15% stop is refused by the relay and stays only in the bot's own record.
- **Health monitor is per rule:** `combo` falling behind its random coins halves or stops only `combo`, never `trend`.
- **Daily loss:** the server lane's own 3% limit counts only its trades; a second account-wide limit at 6% stops it if the whole account (bots included) is in trouble.

## What is not proven
The combo rule is the best candidate found, not a proven winner (about +0.05R per trade before funding payments in tests; weak in 2023-2024, stronger since). It shares the master account with the ESP32 bots; its limits count only its own trades.

## Added in the full build
- **Loss cap (all bots, all users):** `LOSS_CAP_MARGIN_PCT` (default 13, 0 = off). Before any order, if the stop is S% from price, leverage is cut to floor(cap / S) so a stop-out costs under that share of the trade's margin. It applies to the fast bots, the swing bots and v3, with no firmware change. The cap leaves a little room under your 15% for slippage.
- **Health monitor:** every 50 closed shadow calls, a rule more than 0.05R behind its matched random coins halves the live size; behind again at the next check it is switched off; recovering restores it. Telegram says so.
- **Telegram:** every v3 trade opened, refused and closed, plus one daily summary after 07:00 UTC.
- **Dashboard page:** `/ecosystem` (same password as the dashboard). Shows market state (share of coins up over 24h, 3 days and 14 days, BTC moves, funding skew; information only, nothing is gated on it), v3 status and limits, open trades, the coins closest to a trigger, recent decisions with reasons, every shadow rule against random coins, and the limit-order shadow.
- **Settings without code changes:** `V3_CFG` env var, JSON, e.g. `{"RISK_PCT":0.25,"MAX_OPEN":3}`. Only known keys inside safe limits are accepted; the rest is ignored with a warning in the log. `V3_MODULES=trend,combo` chooses live rules (any of combo, fundtrend, mom, trend, trendbtc).
- **Run tests with** `RELAY_DIR=$PWD node tests/server.test.js` (the default path points at an old folder).
- **Bot shortlists:** `POST /api/bot-shortlist` (device key) takes `{bot, kind:"fast"|"swing", items:[{symbol, side, score, note}]}`; `GET /api/bot-shortlists` and the `/ecosystem` page show them together. Nothing trades on it. The bots do not send them yet: that needs a small firmware change, so the page says so until a bot posts.
- **Own lane (parallel run with the bots):** the module skips a coin the account already holds ("held by another lane"), judges its 3% daily loss limit on its own closed trades only, and has a second account-wide limit at 6%. Details in `firmware/V3-FIRMWARE-NOTES.md`.
