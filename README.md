# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Iceland26/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Iceland26/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early Basket Hold: a paper-trading bot for pump.fun that buys every new coin once, as early and as small as the harness allows (min 0.01 SOL, up to 0.4 SOL), then holds up to 75 minutes — take-profit +100%, stop-loss −50%, or the 75-minute time exit. Most new coins die, but a few run +100% or more, so a diversified basket of early buys harvests the fat right tail. The 75-minute hold frees the 5 open-position slots fast enough to cycle 20+ distinct coins through a 6-hour window, on 10 SOL of paper capital.

Why not momentum: chasing a +15% spike loses on this harness — orders fill 2 slots after the decision, by which time a spiking coin is typically +15% higher still, so every momentum buy lands on the top. The early-basket design was picked by measuring the dev window, not by guessing.

## Run it

```sh
node main.ts
```

`main.ts` speaks agent-fun/replay/v2 on stdin/stdout (Node 22, no dependencies, no build step) and is driven by the make.fun pumpfun-replay/v2 harness.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards
