// Washout-swing cbBTC bot for make.fun btc-race-24h-20261118-1444.
//
// Idea (from the dev window's own data, not from any other entrant):
// 1-minute cbBTC is noisy (stdev ~6.7 bps) with a mild 1-minute continuation
// bias, so buying small dips loses to fees: a dip of 10-20 bps below a
// 10-bar mean is more likely to fall further than to snap back within the
// hour. The money in the dev window sits in rare, deep washouts: the price
// falls 200+ bps from its 4-hour high, then recovers 100+ bps over the next
// minutes-to-hours. So this bot does nothing most of the day, buys a
// washout in tranches as it deepens, and sells each tranche only when it
// has recovered a large, fixed amount. It never sells at a loss, never
// uses a stop-loss, and never chases small dips.
//
// Design (parameters fitted on the dev window's own statistics):
// - Entry: close >= 200 bps below the 240-bar rolling high AND >= 15 bps
//   below the 45-bar mean. First tranche 25% of equity; further tranches
//   each time the price falls another 8 bps below the last buy, up to
//   4 tranches and 80% of equity in this layer.
// - Exit: each tranche sells when its close is >= 110 bps above its own
//   fill price. No time limit: a tranche waits for its recovery.
// - End of window: no new buys in the last 120 bars; in the last 60 bars
//   any tranche >= +10 bps is sold, so the bot ends flat instead of
//   eating the harness's final flatten on underwater tranches.
// - Fills land at the next bar's open, so every order carries a generous
//   max_slippage_bps of 150 (1-minute moves reach ~64 bps); nothing else
//   about the fill is assumed.
//
// Determinism: pure integer (bigint) arithmetic, no clock, no environment,
// no randomness. The same bars always produce the same orders.
//
// Dev-window result (kit grade-local, process driver, verified twice with
// identical action_log_sha256): net PnL +$20.90, 16 fills, win rate 1.000,
// max drawdown 0.65%, fees $1.62 (net PnL at 2x fees +$19.28). See README.md.

import { runBars } from './vendor/makefun-bars.ts';
import type { OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// RULES.txt: both the dev window and the race window are 1,440 one-minute
// bars. The count is used only to stop buying near the end of the window.
const TOTAL_BARS = 1440;
const BPS = 10000n; // basis points per unit (for price thresholds)
const PCT = 100n; // percent divisor (for sizing: 25% of equity, not 25 bps)

// --- entry ---
const HIGH_LOOKBACK = 240; // bars for the rolling high
const MEAN_LOOKBACK = 45; // bars for the confirmation mean
const WASHOUT_DROP_BPS = 200n; // close this far below the rolling high
const CONFIRM_DIP_BPS = 15n; // ...and this far below the 45-bar mean
const TRANCHE_PCT = 25n; // each buy spends this % of equity
const LADDER_STEP_BPS = 8n; // next tranche each further fall of this much
const MAX_LOTS = 4;
const LAYER_BUDGET_PCT = 80n; // open tranches' value <= this % of equity
const MAX_EXPOSURE_PCT = 95n; // total position value <= this % of equity
// --- exit ---
const TAKE_PROFIT_BPS = 110n; // sell a tranche this far above its fill
const MAX_SLIPPAGE_BPS = 150;
const NO_BUY_LAST_BARS = 120;
const SWEEP_BARS = 60; // in the last bars, take any profit >= this
const SWEEP_TP_BPS = 10n;
const MIN_NOTIONAL = 1000000n; // 1 USDC, the harness minimum

interface Lot {
  id: number;
  qty: bigint;
  entry: bigint; // fill price (raw units, same scale as the closes)
  bar: number; // batch seq of the fill bar
}

const closes: bigint[] = [];
const lots: Lot[] = [];
let nextLotId = 1;
let nextBuyId = 1;
let lastBuyPrice: bigint | null = null;

function meanOf(n: number): bigint | null {
  if (closes.length < n) return null;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(n);
}

function rollingHigh(n: number): bigint | null {
  if (closes.length === 0) return null;
  let high = 0n;
  const from = Math.max(0, closes.length - n);
  for (let i = from; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

function bpsBelow(price: bigint, ref: bigint): bigint {
  // (price / ref - 1) * 10000, truncated toward zero; negative when below.
  return ((price - ref) * BPS) / ref;
}

function valueAt(qty: bigint, price: bigint): bigint {
  // qty at qty_scale 8, price at price_scale 5 -> micro-USDC.
  return (qty * price) / 10000000n;
}

await runBars({
  onBatch(state, batch) {
    // 1) Fold in this batch's fills: a buy fill opens a lot, a sell fill
    //    closes the lot its client id names.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && f.client_id.startsWith('b')) {
        lots.push({
          id: nextLotId++,
          qty: BigInt(f.qty),
          entry: BigInt(f.price),
          bar: state.seq,
        });
        lastBuyPrice = BigInt(f.price);
      } else if (f.side === 'sell' && f.client_id.startsWith('s')) {
        const id = Number(f.client_id.slice(1));
        const idx = lots.findIndex((l) => l.id === id);
        if (idx >= 0) lots.splice(idx, 1);
      }
    }
    if (state.warmingUp) return [];

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);

    // 2) Indicators from closes BEFORE this bar (the current close is the
    //    signal bar, not part of its own reference).
    const mean45 = meanOf(MEAN_LOOKBACK);
    const high240 = rollingHigh(HIGH_LOOKBACK);
    const barsLeft = TOTAL_BARS - 1 - state.seq;
    const orders: OrderInput[] = [];

    // 3) Exits: a lot sells when its close is far enough above its fill.
    //    Near the end of the window, take any small profit instead.
    if (mean45 !== null) {
      const tpNow = barsLeft <= SWEEP_BARS ? SWEEP_TP_BPS : TAKE_PROFIT_BPS;
      for (const lot of [...lots]) {
        const ret = bpsBelow(close, lot.entry);
        if (ret >= tpNow) {
          orders.push({
            side: 'sell',
            symbol: SYMBOL,
            qty: lot.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            client_id: `s${lot.id}`,
          });
        }
      }
    }

    // 4) Entries: washout + confirmation, in tranches down the ladder.
    if (mean45 !== null && high240 !== null && high240 > 0n) {
      const drop = bpsBelow(close, high240); // negative when below the high
      const dip = bpsBelow(close, mean45);
      const posVal = lots.reduce((s, l) => s + valueAt(l.qty, close), 0n);
      const equity = state.equity;
      const layerVal = posVal; // single layer: every lot is a washout lot
      const canBuy =
        barsLeft > NO_BUY_LAST_BARS &&
        lots.length < MAX_LOTS &&
        posVal < (equity * MAX_EXPOSURE_PCT) / PCT &&
        layerVal < (equity * LAYER_BUDGET_PCT) / PCT &&
        -drop >= WASHOUT_DROP_BPS &&
        -dip >= CONFIRM_DIP_BPS;
      if (canBuy) {
        const tranche = (equity * TRANCHE_PCT) / PCT;
        const first = lots.length === 0;
        const ladder =
          lots.length > 0 &&
          lastBuyPrice !== null &&
          -bpsBelow(close, lastBuyPrice) >= LADDER_STEP_BPS;
        if ((first || ladder) && tranche >= MIN_NOTIONAL && state.cash >= tranche) {
          orders.push({
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: tranche,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            client_id: `b${nextBuyId++}`,
          });
        }
      }
    }

    // 5) Record this close for the next bar's indicators.
    closes.push(close);
    return orders;
  },
});
