# pi-backtrack

**English** | [简体中文](README.zh-CN.md)

Agent-controlled context backtracking with checkpoints and handoffs.

Let an agent fold away exploration it has already processed, return to an earlier checkpoint with its findings, and continue a long-running task.

## Design references

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail): enables agents to write handoffs, backtrack, and resume execution, with checkpoint IDs injected into context.
- [pi-context](https://github.com/ttttmr/pi-context): provides a history timeline so agents can locate nodes and actively fold context without checkpoint IDs injected at every step.
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context): extends the upstream project with context usage indicators to help agents decide when to fold.

## Status

Initial scaffold. This repository contains a design and draft TypeScript interfaces. The Pi extension has not been implemented or registered yet; this is not a usable plugin.

## Planned interaction

Before the first model generation, and before the next generation after each completed tool batch, the host automatically creates a checkpoint and appends a model-visible status marker:

```text
[checkpoint 20 | ctx 100K/300K | 33%]
```

Once the agent decides an exploration is complete or has taken the wrong direction, it calls a tool (proposed name):

```js
backtrack({
  checkpoint: 20,
  summary: "Database issues ruled out. Diagnostic logging has been added but not committed. Next, inspect the retry loop in retry.ts."
})
```

The host keeps the history before the target, replaces the active suffix after it with the handoff, and automatically resumes execution. The original suffix remains available for recovery.

```text
Before: prefix → 20 → extensive exploration → backtrack call
After:  prefix → handoff → new checkpoint → continued execution
```

A single user input can drive many tool rounds. No further user input or advance checkpoint call by the agent is required.

## Initial scope

- Multiple tool calls in one model response form a single batch. The next checkpoint is created only after all results arrive.
- Backtrack must be the only tool call in its batch. The host enforces this constraint rather than relying on prompting alone.
- Only context is rewound. Files, processes, and external actions are not rolled back; the handoff must account for their state.
- The current agent writes the summary, with no separate summarizer request.
- Existing markers stay unchanged to preserve the prefix. Backtracking can still invalidate cached content after the target.
- Inexact usage is explicitly marked as an estimate. UI readings or previous-request usage must not be presented as exact current occupancy.
- The first version handles suffix backtracking only. Arbitrary range compression, history search, and recovery tools are left for later design.

See the [design notes (Chinese)](docs/design.md) for implementation constraints and open validation questions.

## Development

```sh
npm install
npm run typecheck
```

The Pi SDK version is not pinned yet. Host integration will follow verification of Pi's event ordering, branch navigation, and automatic continuation APIs.
