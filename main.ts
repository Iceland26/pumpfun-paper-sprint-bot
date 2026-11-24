// Pump.fun Paper Sprint — "Momentum Snapper with Hard Stops".
//
// Concept (Mistral): snap early momentum on freshly launched pump.fun coins —
// buy when the price is up >=15% from launch inside 5 minutes with >2 SOL of
// 5-minute trade volume — then exit hard: take-profit +30%, stop-loss -15%,
// or a 30-minute time exit, whichever comes first.
//
// Sizing fix (mine, not Mistral's): Mistral's 2 SOL per trade can only reach
// ~12 coins in a 6-hour window, below the 20-coin guardrail. This bot risks
// 0.4 SOL per trade instead, so it can cycle 30+ distinct mints through the
// 5-open-position cap while every round trip stays far above the 0.01 SOL
// minimum. Capital is 10 SOL; at most 5 positions open at once.
//
// v2 (after dev grading v1 at -3.36 SOL): entries now require net buy inflow
// and a price still near its 5-minute high, with a tighter stop (-10%),
// take-profit +25%, a 12% trailing stop, and a 15-minute max hold.
//
// Deterministic by construction: thresholds are constants, events are processed
// in batch order, iteration is over insertion-ordered maps, and time comes
// only from the events' own block_time — no clock, no randomness, no env.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Entry: price up this much vs launch price, within this many seconds of CreateEvent.
const ENTRY_MIN_UP = 0.12;
const ENTRY_WINDOW_SEC = 300;
// Entry: buy volume and net inflow (buys minus sells, SOL) over the trailing 5 minutes.
const ENTRY_BUY_VOL_MIN_SOL = 2;
const ENTRY_NET_MIN_SOL = 1;
const ENTRY_VOL_WINDOW_SEC = 300;
// Entry: price must still be near its 5-minute high — never buy a spike that
// already rolled over (the v1 leak: entries at +15% while the price was
// already falling from a +40% peak).
const ENTRY_NEAR_HIGH = 0.97;
// Size per trade (SOL) — small on purpose, see header.
const SIZE_SOL = 0.4;
const MIN_BUY_SOL = 0.05;
// Exits: take-profit / stop-loss vs position cost, trailing stop from the
// position's best value, and max hold time.
const TAKE_PROFIT = 0.25;
const STOP_LOSS = 0.10;
const TRAIL = 0.12;
const MAX_HOLD_SEC = 900;
// Pump.fun bonding-curve fee taken on a sell (1.25%).
const CURVE_FEE = 0.0125;
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10000;
const MAX_ENTRIES_PER_MINT = 2;
const COOLDOWN_SEC = 600;

interface Trade {
  t: number;
  sol: number;
  buy: boolean;
  price: number;
}

interface Coin {
  launchPrice: number;
  launchTime: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  complete: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
let nowSec = 0;

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { launchPrice: 0, launchTime: 0, trades: [], entries: 0, lastExit: -1e12, complete: false };
    coins.set(mint, c);
  }
  return c;
}

function priceOf(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0) return 0;
  return vq / vt;
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
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time > nowSec) nowSec = e.block_time;
      if (e.event === 'CreateEvent') {
        const c = coinOf(e.mint);
        const vt = Number(e.virtual_token_reserves);
        const vq = Number(e.virtual_quote_reserves);
        c.launchPrice = vt > 0 ? vq / vt : 0;
        c.launchTime = e.block_time ?? nowSec;
      } else if (e.event === 'TradeEvent') {
        const c = coinOf(e.mint);
        const vt = Number(e.virtual_token_reserves);
        const vq = Number(e.virtual_quote_reserves);
        c.trades.push({
          t: e.block_time ?? nowSec,
          sol: Number(e.sol_amount) / LAMPORTS,
          buy: e.is_buy,
          price: vt > 0 ? vq / vt : 0,
        });
        traded.add(e.mint);
      } else {
        coinOf(e.mint).complete = true;
      }
    }
    // Prune each touched coin's tape to the volume window.
    for (const mint of traded) {
      const c = coins.get(mint)!;
      let cut = 0;
      while (cut < c.trades.length && c.trades[cut]!.t <= nowSec - ENTRY_VOL_WINDOW_SEC) cut++;
      if (cut > 0) c.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    const pendingByMint = new Map<Pubkey, string>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, po.order.side);

    // Exits first: TP / SL / time-out, whole position, one sell per mint.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          coinOf(mint).lastExit = nowSec;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      const value = sellValueSol(state, mint, pos.token_amount);
      if (value > h.peakValue) h.peakValue = value;
      const up = value / cost - 1;
      let exit = h.exiting;
      if (!exit && up >= TAKE_PROFIT) exit = true;
      if (!exit && up <= -STOP_LOSS) exit = true;
      if (!exit && h.peakValue > cost && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && nowSec - h.opened >= MAX_HOLD_SEC) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.get(mint) === 'sell') continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // Entries: fresh coins snapping up with real volume, in batch order.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (held.has(mint) || pendingByMint.has(mint)) continue;
      const c = coins.get(mint)!;
      if (c.complete || c.launchPrice <= 0) continue;
      if (c.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (nowSec - c.lastExit < COOLDOWN_SEC) continue;
      const age = nowSec - c.launchTime;
      if (age < 0 || age > ENTRY_WINDOW_SEC) continue;
      const price = priceOf(state, mint);
      if (price < c.launchPrice * (1 + ENTRY_MIN_UP)) continue;
      let buyVol = 0;
      let netVol = 0;
      let high = 0;
      for (const tr of c.trades) {
        if (tr.buy) buyVol += tr.sol;
        netVol += tr.buy ? tr.sol : -tr.sol;
        if (tr.price > high) high = tr.price;
      }
      if (buyVol < ENTRY_BUY_VOL_MIN_SOL) continue;
      if (netVol < ENTRY_NET_MIN_SOL) continue;
      if (high > 0 && price < high * ENTRY_NEAR_HIGH) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(SIZE_SOL, capSol);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txSol;
      slotsLeft--;
      c.entries++;
      held.set(mint, { opened: nowSec, peakValue: 0, exiting: false });
    }
    return orders;
  },
});
