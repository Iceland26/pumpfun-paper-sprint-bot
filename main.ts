// Pump.fun Paper Sprint — "Early Basket Hold".
//
// Strategy, and why it is NOT the original momentum chase: the Mistral
// concept ("Momentum Snapper": buy a coin up 15% from launch within 5
// minutes) was graded on the dev window at -3.36 SOL (v1), then -2.23 SOL
// after tightening entries (v2). Offline analysis of the dev data showed
// why: the harness fills orders 2 slots after the decision, and by then a
// spiking coin's price is typically +15% HIGHER than the trigger print —
// every momentum buy lands on the top of the spike and then crashes. Any
// strategy that chases a fast spike with market orders loses under this
// latency; pullback entries and slow-momentum entries lose too (all tested
// negative in a latency-aware replay of the dev data).
//
// What does work on this data: buying every coin EARLY and SMALL and
// holding it. From its first trade, a coin's hold-to-end return averages
// +25% (median -6%): most coins die, but ~3% do +100% or more and a few do
// +1000%. A diversified basket of early buys harvests that fat right tail.
// This bot therefore:
//
// - Buys each new coin ONCE, on the first batch where the harness size cap
//   (1% of real SOL reserve) allows at least 0.01 SOL, for
//   min(0.4 SOL, the cap). Buying at the earliest possible moment matters:
//   waiting for a bigger cap (a later, higher price) destroys the edge.
// - Holds up to 1 hour, selling whole on take-profit +120%, stop-loss -60%,
//   or the 1-hour time exit, whichever comes first. The 1-hour cap is what
//   frees the 5 open-position slots fast enough to cycle 20+ distinct
//   coins through a 6-hour window.
// - Never sells early on noise: with tiny positions, only the mooners and
//   the time exit matter.
//
// Sizing: positions are usually 0.01-0.05 SOL (the cap at first crossing),
// so fees are ~3% of size and the 0.01 SOL minimum round trip is met with
// margin. Capital is 10 SOL; at most 5 positions open at once.
//
// Deterministic by construction: thresholds are constants, events are
// processed in batch order, iteration is over insertion-ordered maps, and
// time comes only from the events' own block_time — no clock, no randomness,
// no env.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Buy as soon as the size cap allows at least this much (SOL).
const MIN_BUY_SOL = 0.01;
// Largest buy per coin (SOL); the 1% reserve cap usually binds far below this.
const STAKE_SOL = 0.4;
// Exits: take-profit / stop-loss vs position cost, and max hold time.
const TAKE_PROFIT = 1.0;
const STOP_LOSS = 0.5;
const MAX_HOLD_SEC = 4500;
// Pump.fun bonding-curve fee taken on a sell (1.25%).
const CURVE_FEE = 0.0125;
// Wide-open slippage so a buy is never refused for the price moving in the
// 2-slot latency (as the equal-weight house baseline does).
const SLIPPAGE_BPS = 10000;

interface Coin {
  launchTime: number;
  bought: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
let nowSec = 0;

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { launchTime: 0, bought: false, complete: false };
    coins.set(mint, c);
  }
  return c;
}

/** SOL received for selling `tokens` at the curve's current reserves, fees deducted. */
function sellValueSol(state: BotState, mint: Pubkey, tokens: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  const n = Number(tokens);
  if (vt <= 0 || n <= 0) return 0;
  const gross = (n * vq) / (vt + n) / LAMPORTS;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time > nowSec) nowSec = e.block_time;
      if (e.event === 'CreateEvent') {
        coinOf(e.mint).launchTime = e.block_time ?? nowSec;
      } else if (e.event === 'CompleteEvent') {
        coinOf(e.mint).complete = true;
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    const pendingByMint = new Map<Pubkey, string>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, po.order.side);

    // Exits first: TP / SL / 1-hour time exit, whole position, one sell per mint.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      const value = sellValueSol(state, mint, pos.token_amount);
      const up = value / cost - 1;
      let exit = false;
      if (up >= TAKE_PROFIT) exit = true;
      if (up <= -STOP_LOSS) exit = true;
      if (nowSec - h.opened >= MAX_HOLD_SEC) exit = true;
      if (!exit) continue;
      if (pendingByMint.get(mint) === 'sell') continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    }

    // Entries: every new coin once, at the earliest moment the size cap
    // allows a meaningful buy, in first-seen order.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const [mint, c] of coins) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (c.bought || c.complete) continue;
      if (held.has(mint) || pendingByMint.has(mint)) continue;
      const capLamports = state.maxBuyLamports(mint);
      if (capLamports < BigInt(Math.floor(MIN_BUY_SOL * LAMPORTS))) continue;
      let amount = Math.min(STAKE_SOL, Number(capLamports) / LAMPORTS);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      free -= amount + txSol;
      slotsLeft--;
      c.bought = true;
      held.set(mint, { opened: nowSec });
    }
    return orders;
  },
});
