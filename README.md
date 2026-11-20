# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lsd157733627-web/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lsd157733627-web/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP (protocol v2/v0), the REST v3 API, GraphQL, and MCP, all backed by a deterministic in-memory store. No dependencies, no git binary, no database — just the standard library.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env-url> node main.ts
```

The process binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the env reports done, then exits 0. Requires Node 22.18+ (type stripping runs the `.ts` sources directly).

---

<sub>Entered on [make.fun](https://make.fun/?ref=kjbhpbb1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
