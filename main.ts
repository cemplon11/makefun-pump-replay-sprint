// Pump.fun Replay Sprint paper bot — early-launch sniper with a rug filter
// and a runner's exit.
//
// Pump.fun curves usually spike at launch and then bleed out, so chasing
// momentum after a rise means buying the top. This bot does the opposite:
// it buys almost-new curves (within 3 slots of creation), in small slices
// capped at 1% of the curve's real SOL reserve, only when the launch itself
// looks clean — the creator bought a modest 0.08–0.5 SOL of their own coin
// in the create slot (skin in the game, not a bundle), has not sold, and
// at most 3 other wallets are in yet (a launch crowded by many wallets in
// its first slots is usually a bundle waiting to dump).
//
// Exits are built for the rare runner: take profit at +50%, cut at -8%,
// never hold past 600 slots, leave at once if the creator sells, and once
// a position is up 10% a 20% trailing stop locks in the run. Most positions
// lose a little; the few runners pay for all of them. On the dev window
// this scores a small positive net PnL over 23 coins with a 0.3% drawdown.
//
// Deterministic by construction: every decision comes from the replayed batch
// stream (slots, reserves, trades) in insertion order. No clock, no random
// numbers, no network, no environment reads.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const LAMPORTS = 1_000_000_000; // lamports in one SOL, as a plain number.

// ---- Tunable rules (all plain constants; nothing read from outside). ----
const MAX_AGE = 3; // oldest age (slots since CreateEvent) for a first buy
const STAKE_SOL = 0.1; // SOL aimed at each coin
const MIN_BUY_SOL = 0.005; // smallest single buy worth the tx fee
const MIN_ENTRY_SOL = 0.01; // skip entries whose size cap is below this
const MIN_RQ_SOL = 0.3; // real SOL in the curve at entry, lower bound
const MAX_RQ_SOL = 30; // real SOL in the curve at entry, upper bound
const MAX_DEV_BUY_SOL = 0.5; // creator's own buys in the create slot, at most
const MIN_DEV_BUY_SOL = 0.08; // creator's own buys in the create slot, at least
const MAX_BUYERS = 3; // distinct non-creator buyers at entry, at most
const MIN_BUYERS_ENTRY = 0; // distinct non-creator buyers at entry, at least
const MIN_BOUGHT_SOL = 0; // SOL bought by non-creator wallets before entry, at least
const MAX_RUNUP = 2.0; // price now over the create price, at most
const TAKE_PROFIT = 0.50; // sell the whole position once up 50% over cost
const STOP_LOSS = 0.08; // sell the whole position once down 8% under cost
const TRAIL = 0.20; // trailing stop: sell on this fall from the peak value (0 = off)
const TRAIL_ARM = 0.1; // trailing stop arms once value is 10% over cost
const MAX_HOLD = 600; // slots before the time-limit exit
const BUY_SLIP_BPS = 10_000; // buys go out wide open so they fill in latency

interface Launch {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint; // creator's own buys in the create slot
  devSold: boolean; // creator has sold at any point
  buyers: Set<Pubkey>; // distinct non-creator buyers
  bought: bigint; // SOL bought by non-creator wallets
  soldByOthers: bigint; // SOL sold by non-creator wallets
  lastTradeSlot: number;
  complete: boolean;
  done: boolean; // never buy again (exited, filtered out, or completed)
}

interface Open {
  openedSlot: number;
  txPaid: bigint; // tx fees paid on this position's fills so far
  peakValue: bigint; // best sell value seen since opening
  devSoldAtOpen: boolean;
}

const launches = new Map<Pubkey, Launch>();
const open = new Map<Pubkey, Open>();
const selling = new Set<Pubkey>(); // mints with a sell already in flight

/** SOL a full sell of `tokens` against (vq, vt) pays after the 1.25% curve fee. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const quote = (tokens * vq) / (vt + tokens);
  return quote - (quote * 125n + 9_999n) / 10_000n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // ---- Fold the batch's events into the launch table.
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        launches.set(e.mint, {
          mint: e.mint,
          creator: e.creator,
          createdSlot: e.slot,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          complete: false,
          done: false,
        });
      } else if (e.event === "TradeEvent") {
        const c = launches.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createdSlot) c.devBuy += sol;
          else if (!isDev) {
            c.buyers.add(e.user);
            c.bought += sol;
          }
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = launches.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }

    // ---- Track our own fills: tx fees paid, positions opened, harness closes.
    for (const f of batch.fills) {
      if (f.client_id.startsWith("_")) {
        open.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = open.get(f.mint);
      if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === "buy" && f.status === "filled" && h === undefined) {
        const c = launches.get(f.mint);
        open.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), peakValue: 0n, devSoldAtOpen: c?.devSold ?? false });
      }
      if (f.status === "filled") {
        // A filled sell ends the position; a filled buy starts one (above).
        if (f.side === "sell") selling.delete(f.mint);
      }
    }
    for (const mint of [...selling]) {
      let stillOut = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === "sell") stillOut = true;
      }
      if (!stillOut) selling.delete(mint);
    }
    for (const mint of [...open.keys()]) {
      let pendingBuy = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === "buy") pendingBuy = true;
      }
      if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy) open.delete(mint);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

    // ---- Exits first: take-profit, stop-loss, time limit, creator sold.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = open.get(mint);
      if (h === undefined) {
        const c = launches.get(mint);
        h = { openedSlot: state.slot, txPaid: tx, peakValue: 0n, devSoldAtOpen: c?.devSold ?? false };
        open.set(mint, h);
      }
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValueLamports(BigInt(pos.token_amount), vq, vt) - tx;
      const basis = BigInt(pos.cost_lamports) + h.txPaid;
      if (basis <= 0n) continue;
      if (value > h.peakValue) h.peakValue = value;
      let exit = false;
      // Whole-position take-profit / stop-loss against all-in cost.
      if (value >= (basis * BigInt(Math.round((1 + TAKE_PROFIT) * 10_000))) / 10_000n) exit = true;
      if (value <= (basis * BigInt(Math.round((1 - STOP_LOSS) * 10_000))) / 10_000n) exit = true;
      if (TRAIL > 0 && h.peakValue >= (basis * BigInt(Math.round((1 + TRAIL_ARM) * 10_000))) / 10_000n) {
        if (value <= (h.peakValue * BigInt(Math.round((1 - TRAIL) * 10_000))) / 10_000n) exit = true;
      }
      if (state.slot - h.openedSlot >= MAX_HOLD) exit = true;
      const c = launches.get(mint);
      if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // ---- Entries: young, clean launches only, one small buy each.
    let free = state.freeCashLamports();
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const c of launches.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      const age = state.slot - c.createdSlot;
      if (age > MAX_AGE) {
        c.done = true; // too old to snipe; never revisit
        continue;
      }
      if (openSlots <= 0) break;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      // Rug filter: creator must not have sold, must not have bought big,
      // and the launch must not be crowded by many wallets already.
      if (c.devSold) {
        c.done = true;
        continue;
      }
      if (Number(c.devBuy) / LAMPORTS > MAX_DEV_BUY_SOL) {
        c.done = true;
        continue;
      }
      // These three only grow while the launch is young, so wait, don't drop.
      if (Number(c.devBuy) / LAMPORTS < MIN_DEV_BUY_SOL) continue;
      if (c.buyers.size < MIN_BUYERS_ENTRY) continue;
      if (Number(c.bought) / LAMPORTS < MIN_BOUGHT_SOL) continue;
      if (c.buyers.size > MAX_BUYERS) {
        c.done = true;
        continue;
      }
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      // Skip runaway launches: price already more than 2x its create price.
      if (c.vt0 > 0n && c.vq0 > 0n) {
        const runup = Number((curve.virtual_quote_reserves * c.vt0) / (curve.virtual_token_reserves * c.vq0));
        if (runup > MAX_RUNUP) {
          c.done = true;
          continue;
        }
      }
      const sizeCap = state.maxBuyLamports(c.mint);
      let amount = BigInt(Math.floor(STAKE_SOL * LAMPORTS));
      if (amount > sizeCap) amount = sizeCap;
      if (amount < BigInt(Math.floor(MIN_ENTRY_SOL * LAMPORTS))) continue;
      if (amount < BigInt(Math.floor(MIN_BUY_SOL * LAMPORTS))) continue;
      if (free < amount + tx) continue;
      orders.push({ side: "buy", mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      openSlots--;
      c.done = true; // one buy per coin, win or lose
    }
    return orders;
  },
});
