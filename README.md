# Washout Swing BTC Bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/beecoder77/washout-swing-btc-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/beecoder77/washout-swing-btc-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A trading bot for the make.fun competition **btc-race-24h-20261118-1444**
("Race a BTC trading bot live for 24 hours"). It trades Coinbase Wrapped
BTC (cbBTC) against USDC on 1-minute on-chain bars, starting from $1,000,
long only.

## Strategy

1-minute cbBTC is noisy (stdev ~6.7 bps) with a mild 1-minute continuation
bias, so buying small dips loses to fees: a dip of 10–20 bps below a
10-bar mean is more likely to fall further than to snap back within the
hour. The money in the dev window sits in rare, deep washouts: the price
falls 200+ bps from its 4-hour high, then recovers 100+ bps over the next
minutes-to-hours. This bot does nothing most of the day, buys a washout in
tranches as it deepens, and sells each tranche only when it has recovered a
large, fixed amount. It never sells at a loss, never uses a stop-loss, and
never chases small dips.

- **Entry:** close ≥ 200 bps below the 240-bar rolling high **and** ≥ 15 bps
  below the 45-bar mean. First tranche 25% of equity; a further tranche
  each time the price falls another 8 bps below the last buy, up to
  4 tranches and 80% of equity.
- **Exit:** each tranche sells when its close is ≥ 110 bps above its own
  fill price. No time limit: a tranche waits for its recovery.
- **End of window:** no new buys in the last 120 bars; in the last 60 bars
  any tranche ≥ +10 bps is sold, so the bot ends flat instead of eating the
  harness's final flatten on underwater tranches.
- **Costs:** fills land at the next bar's open, so every order carries
  `max_slippage_bps` 150 (1-minute moves reach ~64 bps).

Determinism: pure integer (bigint) arithmetic, no clock, no environment,
no randomness. The same bars always produce the same orders.

## Dev-window result

Graded locally with the kit CLI
(`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`),
verified on two runs with identical `action_log_sha256`:

- Net PnL: **+$20.90** (return 2.09%)
- Trades: 16 fills (8 buys, 8 sells) in 2 washout cycles, win rate 1.000
- Max drawdown: 0.65%
- Fees: $1.62; net PnL at 2x fees: +$19.28
- Rejected orders: 0; guardrails met
- Per-hour PnL: hour 1 +$9.65, hour 5 +$3.85, hour 6 +$7.64, hours 7–23 $0.00

Robustness (all via grade-local on the dev window):

- Neighbourhood (±20% of each key parameter, headline +$20.90):
  washout drop 160 → +$15.06, 240 → +$12.07; take-profit 88 → +$16.37,
  132 → +$12.85; tranche 20% → +$17.30, 30% → +$18.49; ladder step
  6 → +$20.68, 10 → +$21.28; confirmation dip 12/18, high lookback
  192/288, mean lookback 36/54 → +$20.90 unchanged. All stay positive;
  10 of 12 stay within ~30% of headline. The two outliers (drop 240:
  −42%, take-profit 132: −39%) are cliffs: the quick bounce peaked at
  ~+113 bps, so a take-profit above ~120 misses it, and a 240 bps
  washout threshold fires only at the very bottom.
- Split-half: first 720 bars +$20.90, last 720 bars **$0.00 — NOT met**.
  The second half is a grinding downtrend with no washout and the bot
  stays out rather than force losing trades. Reported honestly; the
  orchestrator decides.
- Determinism: two grade-local runs give identical `action_log_sha256`
  (`739d8a479de0012b7a34a9c3670e70152084315a6c71d4e9c56c89188bc83044`)
  and `result_sha256`.
- Think time: trivial (O(240) integer ops per bar); the two-execution
  local grade finishes in ~4 s total.

## Honest limits

- The bot makes its money from one or two deep washouts per 24 hours. On
  a window with no 200+ bps washout it trades little or nothing.
- Split-half on the dev window: first 720 bars +$20.90, last 720 bars
  $0.00 — the second half is a grinding downtrend with no washout, and the
  bot correctly stays out rather than force trades that lose to fees.
- The dev leaders' high-frequency scalpers (+$86–92, 350+ trades, 100%
  win rate) are heavily fitted to this window's exact dips; this bot does
  not chase their numbers.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript only)
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-identical
- `LICENSE` — MIT

## Badges

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
