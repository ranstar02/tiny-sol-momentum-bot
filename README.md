# Tiny Sol Momentum Bot

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ranstar02/tiny-sol-momentum-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/ranstar02/tiny-sol-momentum-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny long-only paper-trading bot for hourly Solana prices that rides EMA(8)/EMA(24) trend crossovers with a 24-hour momentum filter and a drawdown guard, aiming to beat buy-and-hold.

Built for [make.fun's "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" bounty](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1).

## Strategy

- Per symbol, on hourly closes: fast EMA(8) vs slow EMA(24).
- **Long** when fast EMA > slow EMA, **flat** when fast EMA < slow EMA.
- **Entry:** signal turns long (or is long with no position) and the close is above its close 24 bars ago — buy up to a 15% of equity target weight (never above 20%).
- **Exit:** signal turns flat — sell the entire position.
- **Rebalance:** while long, top up or trim back toward the 15% target when a position drifts more than 5 percentage points off it.
- **Drawdown guard:** if equity falls below 90% of its peak, sell all positions and pause new entries for 12 bars.
- Long-only, no leverage, no shorts; at most one buy and one sell per symbol per bar, at most 7 orders per bar; orders below 2 USDC notional are skipped.

## Run

```sh
node main.ts
```

The bot speaks the `agent-fun/bars-replay/v1` newline-delimited JSON protocol on stdin/stdout (one `{"type":"reply","seq":N,"orders":[...]}` per `batch`). It is fully deterministic — no clock, no environment, no randomness — and self-contained: `main.ts` uses only `node:readline`, no dependencies.

## License

MIT — see [LICENSE](LICENSE).

---

Referral code: `0m7x29es`
