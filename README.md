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
  message: "Since checkpoint 2, inspected the connection pool implementation and timeout logs, added diagnostics, and reproduced the issue. The pool is healthy; increasing its size did not fix timeouts, so stop pursuing that approach. Diagnostic changes remain uncommitted. After returning, inspect retry.ts for retry/cancellation interactions."
})
```

The tool description recommends backtracking proactively, when the user changes topics, or when returning from a detour to the main task. At startup and reload, the host includes the skill-saving guidance only if the dynamic-skill context service is enabled; installing its dependency alone does not add this paragraph.

Only `checkpoint` and `message` are accepted:

- `checkpoint`: the target number. The current effective context through that checkpoint is preserved intact, without rewriting it or resurrecting previously folded raw history.
- `message`: what you did and examined after that checkpoint, what you learned, failed attempts and their lessons, and what you plan to do next after returning.

Legacy `description`/`knowledge` arguments are rejected. When dynamic-skill is enabled, save reusable knowledge and lessons **before** backtracking. Its directory does not automatically load skill bodies, so restate essential information in `message` or direct the agent to read a named skill for it. Backtrack no longer creates its own skill files.

## Behavior

```text
stable prefix → checkpoint 0 → skills → user → checkpoint 1
→ assistant(tool calls) → complete tool batch → checkpoint 2
→ assistant(final reply) → next user → checkpoint 3
```

- Checkpoints follow real user inputs and complete tool batches, not individual tool results or assistant-only replies. Request retries do not allocate duplicate IDs.
- Ordinary backtracks continue numbering within the current epoch. Returning to 0 folds everything after zero, replaces old skill overlays with one full directory, and restarts at 1, like compaction. The stable prefix remains unchanged; system prompts, tools, and native skills are not reloaded. No extra KV-cache management is performed. Internal epoch identities reject stale requests.
- Backtrack must be the only tool call in its batch. The tool reports preparation; the host commits after the complete batch is persisted. The same agent loop continues automatically.
- New/queued input, cancellation, or invalid targets prevent uncommitted backtracks. Partial commit failures stop continuation and are reported, not blindly replayed. Recovery appends one model-visible failure status per failed transaction, without claiming rollback.

The resulting model context is:

```text
retained prefix → skill diff/rebuild → tiered dialogue → continuation message → new checkpoint
```

Like `/tree`, backtracking selects a saved node, retains its effective prefix, and appends its own handoff input. Unlike `/tree` or `/fork`, it never moves the session leaf or creates another session. A source-node cursor tracks new history separately from request-local extension injections; no whole-request equality check approves or rejects navigation. Immutable blocks and entry references avoid copying raw tool results into snapshots. In-memory sessions are supported.

## Dialogue budget

Dialogue comes from the original session interval, including conversations hidden by earlier backtracks, not from an already shortened projection. It is displayed chronologically after newest-first allocation:

| Estimated output tokens | Per-message retention |
| --- | --- |
| 5K | Full text |
| 3K | First/last 100 tokens |
| 1K | First/last 20 tokens |
| 1K | First/last 10 tokens |
| Older | Omitted-turn notice |

Whole messages move to a smaller tier when they do not fit. The latest user text is always complete, even over budget. Images are retained only with intact source messages, preserving their text/image block order; truncated or omitted messages lose their images. Retained images are estimated separately. No extra summarizer call is made by backtrack. Empty intervals produce no history block or empty history heading.

```text
[12 turns omitted]
user: beginning[800 tokens omitted]ending
assistant: beginning[2.4K tokens omitted]ending
```

Token estimates distinguish CJK, Latin/digits, punctuation, and whitespace. Truncation preserves grapheme boundaries. Omission counts above 2000 use K.

Tool guidance targets 0-20% context usage for short tasks, 0-40% for standard tasks, and 0-80% for difficult tasks. Checkpoint readings use `context …`: estimates of the effective view, system prompt and active tools, excluding other extensions' request-local injections—not final request measurements. These are advisory, not hard gates. Backtracks may increase tokens; actual overflow uses native compaction.

## Dynamic-skill cooperation

Successful backtracking settles accesses once from raw session history. Descriptions already visible anywhere in the retained context are not printed again. Visible overflow candidates remain active beyond configured capacity, rather than becoming hidden pending entries. Only actually displayed pending notices count as announced. Returning to zero rebuilds the directory without clearing LRU or deleting files. Only active/pending metadata is injected; root children are discovered by reading the dynamic-skill root's index.

The versioned `pi-dynamic-skill/context` service uses the event bus only for synchronous discovery. Prepare/commit calls propagate errors directly and work in either extension load order.

## SDK limitation

Pi 0.85.1 prepares native compaction from raw session entries and retains a raw tail by entry ID. To avoid resurrecting removed tools, this extension supplies the **effective conversation, excluding regenerable checkpoints and skill directories**, to the host's existing summarizer and retains no raw tail. It still uses the host's single compaction request, cancellation, retry, and usage accounting, then regenerates checkpoints.

Consequently native `keepRecentTokens` does not preserve a raw tail while this adapter is enabled. The host summarizes text; with no verbatim tail retained, compaction also retains no original images. Images have no independent retention area. Supporting a materialized effective tail requires a suitable host API. See [design and implementation decisions](docs/design.md).

Missing/corrupt node references and persistence failures stop requests instead of falling back to raw history. Fixed prefix/suffix injections from other context hooks are covered in both load orders; arbitrary third-party rewriting or reordering is not a tested compatibility guarantee. Cancelled compaction preserves newly completed checkpoint boundaries instead of consuming them without numbering. Captured external custom prefixes in older snapshots are matched by occurrence, avoiding duplicate reinjection without rewriting the saved prefix.

## Development and dependency snapshot

The companion package snapshot is included in `vendor/` so this unreleased integration installs independently of a sibling checkout or unpublished remote commit. See `vendor/README.md` for rebuilding it. A future release can replace it with an immutable Git dependency.

```sh
npm ci
npm run typecheck
npm test
```

Tests compile TypeScript first and use real Pi SDK sessions with a scripted provider; no model credentials or native TypeScript stripping flags are required.
