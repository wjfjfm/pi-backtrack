# pi-backtrack

**English** | [简体中文](README.zh-CN.md)

Agent-controlled context backtracking with automatic checkpoints and continuation. **Session history remains continuous: no branching, file rollback, or external-action rollback.**

## Use

Targets Pi SDK 0.85.1; Node 22.19+ or 24+ is recommended.

```sh
npm ci
pi -e ./src/index.ts
# Enable the companion skill extension as well:
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

Installing the package dependency does not automatically activate its extension. A separately installed compatible dynamic-skill extension also works; do not load two copies.

```js
backtrack({
  checkpoint: 2,
  message: "Database issues ruled out. Diagnostic logging is uncommitted. Inspect retry.ts next."
})
```

Only `checkpoint` and `message` are accepted. Legacy `description`/`knowledge` arguments are rejected. Save useful knowledge with ordinary dynamic-skill write/edit operations **before** backtracking. Backtrack no longer creates its own skill files.

## Behavior

```text
stable prefix → checkpoint 0 → skills → user → checkpoint 1
→ assistant(tool calls) → complete tool batch → checkpoint 2
→ assistant(final reply) → next user → checkpoint 3
```

- Checkpoints follow real user inputs and complete tool batches, not individual tool results or assistant-only replies. Request retries do not allocate duplicate IDs.
- Ordinary backtracks continue numbering within the current epoch. Returning to 0 rebuilds skills and restarts at 1; internal epoch identities reject stale requests.
- Backtrack must be the only tool call in its batch. The tool reports preparation; the host commits after the complete batch is persisted. The same agent loop continues automatically.
- New/queued input, cancellation, or invalid targets prevent uncommitted backtracks. Partial commit failures stop continuation and are reported, not blindly replayed.

The resulting model context is:

```text
retained prefix → skill diff/rebuild → tiered dialogue → continuation message → new checkpoint
```

Raw history remains in the same session. Versioned custom entries persist immutable blocks and effective-view references, without copying large raw tool results into each snapshot. In-memory sessions are supported without filesystem persistence.

## Dialogue budget

Dialogue comes from the original session interval, including conversations hidden by earlier backtracks, not from an already shortened projection. It is displayed chronologically after newest-first allocation:

| Estimated output tokens | Per-message retention |
| --- | --- |
| 5K | Full text |
| 3K | First/last 100 tokens |
| 1K | First/last 20 tokens |
| 1K | First/last 10 tokens |
| Older | Omitted-turn notice |

Whole messages move to a smaller tier when they do not fit. The latest user text is always complete, even over budget. Original user images are retained and estimated separately. No extra summarizer call is made by backtrack.

```text
[12 turns omitted]
user: beginning[800 tokens omitted]ending
assistant: beginning[2.4K tokens omitted]ending
```

Token estimates distinguish CJK, Latin/digits, punctuation, and whitespace. Truncation preserves grapheme boundaries. Omission counts above 2000 use K.

Tool guidance targets 0%-20% context usage for short tasks, 20%-50% for standard tasks, and 40%-80% for difficult tasks. These are advisory, not hard gates or minimums to fill. Backtracks may increase tokens; actual overflow uses native compaction.

## Dynamic-skill cooperation

Successful backtracking settles accesses once from raw session history. Descriptions already visible anywhere in the retained context are not printed again. Visible overflow candidates remain active beyond configured capacity, rather than becoming hidden pending entries. Only actually displayed pending notices count as announced. Returning to zero rebuilds the directory without clearing LRU or deleting files.

The versioned `pi-dynamic-skill/context` service uses the event bus only for synchronous discovery. Prepare/commit calls propagate errors directly and work in either extension load order.

## SDK limitation

Pi 0.85.1 prepares native compaction from raw session entries and retains a raw tail by entry ID. To avoid resurrecting removed tools, this extension supplies the **entire effective context** to the host's existing summarizer and retains no raw tail. It still uses the host's single compaction request, cancellation, retry, and usage accounting, then regenerates checkpoints.

Consequently native `keepRecentTokens` does not preserve a raw tail while this adapter is enabled. Supporting a materialized effective tail requires a suitable host API. See [design and implementation decisions](docs/design.md).

Projection failures stop requests instead of falling back to raw history. Extensions that rewrite an already saved message prefix trigger this protection; ordinary append-only messages are supported.

## Development and dependency snapshot

The companion package snapshot is included in `vendor/` so this unreleased integration installs independently of a sibling checkout or unpublished remote commit. See `vendor/README.md` for rebuilding it. A future release can replace it with an immutable Git dependency.

```sh
npm ci
npm run typecheck
npm test
```

Tests compile TypeScript first and use real Pi SDK sessions with a scripted provider; no model credentials or native TypeScript stripping flags are required.
