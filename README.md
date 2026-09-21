# pi-backtrack

Agent-controlled context backtracking for recursive thinking and exploration.

**English** · [简体中文](README.zh-CN.md)

```text
  │
  │◀── backtrack ───────╮
  │                     │
  │◀── backtrack ─╮     │
  ├──▶ explore ───╯     │
  │                     │
  │◀── backtrack ─╮     │
  ├──▶ explore ───╯     │
  │                     │
  ├──▶ explore ─────────╯
  │
  ▼
```

## How it works

Injects a checkpoint and context usage after each user input and complete tool-result batch:

```text
[checkpoint 3 | context 48K/200K 24%]
```

The agent monitors context usage and chooses a checkpoint to return to based on the current task. It preserves the preceding effective context intact for KV cache reuse, carrying knowledge gained during exploration into the work ahead.

```js
backtrack({
  checkpoint: 1,
  message: "Read the pool implementation and added diagnostics. Ruled out the pool; increasing its size did not help. Keep the diagnostic changes and inspect retry logic next."
})
```

`checkpoint` selects the return point. `message` records work done, material examined, findings, failed attempts and lessons, and next steps.

## Install

Developed with Pi SDK 0.85.1 and Node.js 22.17.0.

```sh
pi install git:github.com/wjfjfm/pi-backtrack
```

Run `/reload` or start a new session.

<details>
<summary>Run locally</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci
pi -e ./src/index.ts
```

</details>

## Design reference

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail): enables agents to write handoffs, backtrack, and resume execution, with checkpoint IDs injected into context.
- [pi-context](https://github.com/ttttmr/pi-context): provides a history timeline so agents can locate nodes and actively fold context without checkpoint IDs injected at every step.
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context): extends the upstream project with context usage indicators to help agents decide when to fold.
