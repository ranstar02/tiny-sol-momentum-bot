// Tiny momentum bot — EMA(8)/EMA(24) crossover, long-only, per symbol.
// Speaks agent-fun/bars-replay/v1: hello, batch..., done on stdin;
// exactly one {"type":"reply","seq":N,"orders":[...]} per batch on stdout.
// Deterministic: no clock, no env, no Math.random. All amounts are u64
// decimal strings; prices/quantities are converted to numbers via their
// scales for EMA math, while order sizes are computed in quote units.
import * as readline from "node:readline";

const FAST = 8;
const SLOW = 24;
const TARGET_W = 0.15; // 15% of equity per symbol
const MAX_W = 0.2; // never let a position exceed 20% of equity
const DRIFT_PP = 0.07; // rebalance when >7pp off target (cuts fee churn)
const MIN_NOTIONAL = 2_000_000; // 2 USDC in quote units (scale 6)
const MAX_ORDERS = 7;
const SLIPPAGE_BPS = 100;
const DD_TRIGGER = 0.9; // sell all if equity < 90% of peak
const DD_PAUSE_BARS = 12;

type Bar = { symbol: string; c: string };
type Pos = { symbol: string; qty: string };

interface SymState {
  priceScale: number;
  qtyScale: number;
  closes: number[];
  fast: number | null;
  slow: number | null;
  prevLong: boolean | null;
}

const syms = new Map<string, SymState>();
let warmupBars = 0;
let quoteScale = 6;
let peakEquity = 0;
let pauseUntil = -1;

function ema(prev: number | null, price: number, period: number): number {
  if (prev === null) return price;
  const k = 2 / (period + 1);
  return price + k * (prev - price);
}

function decide(seq: number, bars: Bar[], account: {
  cash_quote_units: string;
  positions: Pos[];
  equity_quote_units: string;
}): Array<Record<string, string | number>> {
  const orders: Array<Record<string, string | number>> = [];
  if (seq < warmupBars) return orders;
  const equity = Number(account.equity_quote_units);
  const cash0 = Number(account.cash_quote_units);
  if (equity <= 0) return orders;

  // Drawdown guard: track peak, liquidate + pause on a 10% drawdown.
  if (equity > peakEquity) peakEquity = equity;
  const inDrawdown = peakEquity > 0 && equity < DD_TRIGGER * peakEquity;
  if (inDrawdown) {
    pauseUntil = seq + DD_PAUSE_BARS;
    peakEquity = equity; // reset peak so we do not retrigger every bar
  }

  const posBySym = new Map<string, Pos>();
  for (const p of account.positions) posBySym.set(p.symbol, p);

  let cashLeft = cash0;

  for (const bar of bars) {
    if (orders.length >= MAX_ORDERS) break;
    const st = syms.get(bar.symbol);
    if (!st) continue;
    const close = Number(bar.c) / 10 ** st.priceScale;
    if (!(close > 0)) continue;
    // Position value in quote units: qty * price-in-quote-units.
    const closeQuote = Number(bar.c) * 10 ** (quoteScale - st.priceScale);
    const n = st.closes.length;
    const prevLong = st.prevLong;
    st.closes.push(close);
    st.fast = ema(st.fast, close, FAST);
    st.slow = ema(st.slow, close, SLOW);
    const isLong = st.fast !== null && st.slow !== null && st.fast > st.slow;
    const wasLong = prevLong === true;
    st.prevLong = isLong;

    const pos = posBySym.get(bar.symbol);
    const qty = pos ? Number(pos.qty) / 10 ** st.qtyScale : 0;
    const value = qty * closeQuote; // quote units, same scale as equity
    const weight = value / equity;

    // Exit: signal turned flat -> sell the whole position.
    if (wasLong && !isLong && pos && qty > 0) {
      orders.push({
        side: "sell",
        client_id: `s-${seq}-${bar.symbol}`,
        symbol: bar.symbol,
        qty: pos.qty,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      continue;
    }

    // Drawdown guard: liquidate everything, no new entries.
    if (inDrawdown) {
      if (pos && qty > 0) {
        orders.push({
          side: "sell",
          client_id: `s-${seq}-${bar.symbol}`,
          symbol: bar.symbol,
          qty: pos.qty,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
      continue;
    }
    if (seq <= pauseUntil) continue;

    // Need 24 bars of history for the momentum filter.
    if (n < SLOW) continue;
    const momentumOk = close > st.closes[n - SLOW];
    if (!isLong || !momentumOk) continue;

    const targetValue = TARGET_W * equity;
    if (qty === 0) {
      // Fresh entry only on the bar the signal TURNS long (not every bar
      // while long): avoids re-buying straight after a guard exit and
      // cuts fee churn from repeated entries.
      if (!wasLong) {
        const notional = Math.min(targetValue, MAX_W * equity, cashLeft);
      if (notional >= MIN_NOTIONAL) {
        orders.push({
          side: "buy",
          client_id: `b-${seq}-${bar.symbol}`,
          symbol: bar.symbol,
          notional_quote_units: String(Math.floor(notional)),
          max_slippage_bps: SLIPPAGE_BPS,
        });
        cashLeft -= notional;
        }
      }
    } else {
      // Rebalance while long: top up or trim back toward target.
      if (weight < TARGET_W - DRIFT_PP && weight < MAX_W) {
        const notional = Math.min(targetValue - value, MAX_W * equity - value, cashLeft);
        if (notional >= MIN_NOTIONAL) {
          orders.push({
            side: "buy",
            client_id: `b-${seq}-${bar.symbol}`,
            symbol: bar.symbol,
            notional_quote_units: String(Math.floor(notional)),
            max_slippage_bps: SLIPPAGE_BPS,
          });
          cashLeft -= notional;
        }
      } else if (weight > TARGET_W + DRIFT_PP) {
        // Trim the excess over target back toward target weight.
        const excessValue = value - targetValue;
        const trimQty = Math.floor((excessValue / closeQuote) * 10 ** st.qtyScale);
        if (trimQty > 0 && excessValue >= MIN_NOTIONAL) {
          orders.push({
            side: "sell",
            client_id: `s-${seq}-${bar.symbol}`,
            symbol: bar.symbol,
            qty: String(trimQty),
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
      }
    }
  }
  return orders;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    warmupBars = typeof msg.warmup_bars === "number" ? msg.warmup_bars : 0;
    quoteScale = typeof msg.capital?.quote_scale === "number" ? msg.capital.quote_scale : 6;
    peakEquity = Number(msg.capital?.quote_units ?? 0);
    for (const s of msg.symbols ?? []) {
      syms.set(s.symbol, {
        priceScale: s.price_scale,
        qtyScale: s.qty_scale,
        closes: [],
        fast: null,
        slow: null,
        prevLong: null,
      });
    }
    return;
  }
  if (msg.type === "batch") {
    const orders = decide(msg.seq, msg.bars ?? [], msg.account);
    process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
});
