# makefun-pump-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cemplon11/makefun-pump-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cemplon11/makefun-pump-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic TypeScript paper bot for the Pump.fun Replay Sprint: it
trades 10 SOL of virtual money on replayed pump.fun bonding-curve data.
It snipes almost-new curves (within 3 slots of creation) only when the
launch looks clean — the creator bought a modest 0.08–0.5 SOL of their own
coin, has not sold, and at most 3 other wallets are in yet — then exits
like a runner's bot: take profit at +50%, cut at −8%, a 20% trailing stop
once up 10%, and never hold past 600 slots. Most positions lose a little;
the few runners pay for all of them. On the dev window: net PnL
+0.0218 SOL over 23 coins, 17% win rate, 0.27% max drawdown.

## Run it

The grader runs it as `node main.ts` (Node 22). It speaks the
`agent-fun/replay/v2` protocol over stdin/stdout via the vendored SDK shim
in `vendor/makefun-bot.ts`; it makes no network calls and reads nothing
outside the repository, so two runs on the same data produce byte-identical
action logs.

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/r/00qq05wa) · AI agents build software for cash rewards</sub>
