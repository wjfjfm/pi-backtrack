# pi-backtrack

**English** | [简体中文](README.zh-CN.md)

Agent-controlled context backtracking with checkpoints and handoffs.

Let an agent fold away exploration it has already processed, return to an earlier checkpoint with its findings, and continue a long-running task.

## Design references

- [Kimi CLI / SendDMail](https://github.com/MoonshotAI/kimi-cli/tree/main/src/kimi_cli/tools/dmail): enables agents to write handoffs, backtrack, and resume execution, with checkpoint IDs injected into context.
- [pi-context](https://github.com/ttttmr/pi-context): provides a history timeline so agents can locate nodes and actively fold context without checkpoint IDs injected at every step.
- [KorenKrita/pi-context](https://github.com/KorenKrita/pi-context): extends the upstream project with context usage indicators to help agents decide when to fold.

## Status

The Pi extension entry point and `backtrack` tool registration are implemented. Checkpoint injection and backtracking execution are still pending. Tool calls currently return an explicit error without changing context.

## Planned interaction

Before the first model generation, and before the next generation after each completed tool batch, the host automatically creates a checkpoint and appends a model-visible status marker:

```text
[checkpoint 20 | context 100K/300K 33%]
```

Once the agent decides an exploration is complete or has taken the wrong direction, it calls:

```js
backtrack({
  checkpoint: 20,
  description: "Database investigation findings and evidence for later review.",
  knowledge: "Database issues ruled out. Diagnostic logging has been added but not committed.",
  message: "Inspect the retry loop in retry.ts."
})
```

The host keeps the history before the target and replaces the active suffix with a knowledge entry. The new entry is expanded; older entries collapse to their descriptions. The separate `message` is appended to the continuation context, not stored in the knowledge entry. The original suffix remains available for recovery.

```text
Before: prefix → 20 → extensive exploration → backtrack call
After:  prefix (older knowledge collapsed) → new knowledge expanded → message → new checkpoint → continued execution
```

A single user input can drive many tool rounds. No further user input or advance checkpoint call by the agent is required.

## Initial scope

- Multiple tool calls in one model response form a single batch. The next checkpoint is created only after all results arrive.
- Backtrack must be the only tool call in its batch. The host enforces this constraint rather than relying on prompting alone.
- Only context is rewound. Files, processes, and external actions are not rolled back; the handoff must account for their state.
- The current agent writes the summary, with no separate summarizer request.
- Knowledge entries store `description` and `knowledge`. On-demand reading is planned; the next backtrack will collapse older entries and their read copies again. The continuation `message` is not returned when reading an entry.
- Existing markers stay unchanged to preserve the prefix. Backtracking can still invalidate cached content after the target.
- Inexact usage is explicitly marked as an estimate. UI readings or previous-request usage must not be presented as exact current occupancy.
- The first version handles suffix backtracking only. Arbitrary range compression, history search, and recovery tools are left for later design.

See the [design notes (Chinese)](docs/design.md) for implementation constraints and open validation questions.

## Development

```sh
npm install
npm run typecheck
```

Development targets Pi SDK 0.85.1. To load the extension locally:

```sh
pi -e ./src/index.ts
```

Loading registers the tool only; it does not yet enable context backtracking.
