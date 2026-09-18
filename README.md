# ⏪ pi-backtrack

### Let agents own their context—and explore recursively.

**English** · [简体中文](README.zh-CN.md) · [Design & implementation](docs/design.md)

Explore a branch. Bring back the findings. Fold away the process. Continue the main task.

Instead of waiting for a full context window to trigger compression, let the agent decide **what to carry forward, when to return, and where to resume.**

```text
Main task ──●────────────────────────────────────▶ Continue
            │                                    ▲
            └─ Explore ──●─ Go deeper ── Findings ─┘
                         └─ Try → Learn → Return ↗
            checkpoint                  backtrack
```

**Context awareness · Agent-led backtracking · Automatic continuation · Reusable knowledge**

## 01 / How it works: a map of the context

After each **user input** and **tool result boundary**, the extension injects a checkpoint and a context gauge. The agent can see its context usage and decide whether—and where—to backtrack. Parallel tool calls receive one checkpoint after the **complete tool batch**, not after each individual result.

```text
user input
  └─ [checkpoint 1 | context 12K/200K 6%]

Agent → tool calls → tool results
  └─ [checkpoint 2 | context 48K/200K 24%]

Agent → keep exploring, or backtrack(checkpoint: 1)
```

*Illustrative values. The gauge estimates tokens; it is not an exact measurement of the final request.*

Backtracking preserves the **current effective context** through the target checkpoint, folds away subsequent tool activity, appends tiered dialogue history and the agent's handoff, then continues automatically in the same agent loop:

```text
Before   Retained prefix │ File reads, searches, tool output, trial and error
After    Retained prefix │ Compact dialogue + handoff → New checkpoint → Continue
```

- **The agent chooses the route.** Explore and return at multiple levels, without waiting for overflow.
- **No extra summarizer call.** Backtrack retains and truncates dialogue deterministically; the agent writes its own handoff.
- **Fold context, not work.** Raw session history stays continuous. No branching, file rollback, or external-action rollback.

## 02 / The tool: one call to return

```js
backtrack({
  checkpoint: 1,
  message: "Read the pool implementation and added diagnostics. The pool is not the bottleneck; increasing its size did not help. Keep the diagnostic changes and inspect retry logic next."
})
```

Just two arguments: `checkpoint` selects the return point; `message` hands off what was done and examined, findings, failed attempts and lessons, and the next step. Call it alone in its tool batch; successful backtracking continues automatically. Returning to `0` rebuilds from the fixed starting point and restarts checkpoint numbering.

## 03 / Install: better with dynamic-skill

Requires a Pi 0.85.1-compatible environment. Node.js 22.19+ or 24+ is recommended.

**Install both: one manages context, the other preserves reusable knowledge.**

```sh
pi install git:github.com/wjfjfm/pi-backtrack
pi install git:github.com/wjfjfm/pi-dynamic-skill
```

Run `/reload` in an existing session, or start a new one. For context backtracking alone, use only the first command; backtrack works independently.

<details>
<summary>Run from local source</summary>

```sh
git clone https://github.com/wjfjfm/pi-backtrack.git
cd pi-backtrack
npm ci

# Load backtrack and the bundled dynamic-skill snapshot
pi -e ./src/index.ts -e ./node_modules/pi-dynamic-skill/src/index.ts
```

Backtrack only: `pi -e ./src/index.ts`. Installing the npm dependency does not activate its extension. If dynamic-skill is already enabled globally, do not load another copy.

</details>

## 04 / Together: fold the context, keep the lessons

[**pi-dynamic-skill**](https://github.com/wjfjfm/pi-dynamic-skill) stores reusable knowledge as skill files, so exploration produces more than an answer to today's task.

| | pi-backtrack | pi-dynamic-skill |
| --- | --- | --- |
| Focus | What context the model should carry now | What knowledge to preserve and rediscover |
| Mechanism | Checkpoint → backtrack → handoff | SKILL.md → LRU management → on-demand reading |
| Retains | An effective prefix and a path forward | Knowledge files reusable across sessions |

```text
Explore → Distill lessons → Save skill with write / edit → backtrack
                                                              ↓
Continue ← Read skill body on demand ← Active skill names, descriptions, paths
```

With both enabled, the agent receives guidance to **save knowledge before backtracking**. A successful backtrack settles skill accesses and adds descriptions not already visible in the retained context. Skill bodies are never expanded automatically: restate critical findings in `message`, or explicitly direct the agent to read a named skill.

You can also curate skills with `/dynamic-skill`: view **LRU** by default, press **Tab** for the hierarchical **All** tree, **Space** to toggle, and **Enter** to apply. Additions appear on the next model turn. Removals silently await the next backtrack, compact, or reload settlement. **Eviction never deletes skill files.**

---

<details>
<summary>Boundaries and implementation details</summary>

- Checkpoint 0 is the fixed starting point. Ordinary backtracks continue numbering; returning to 0 rebuilds the skill directory and restarts at 1. Previously folded raw tool activity is not resurrected.
- Dialogue uses newest-first retention budgets: 5K full text, 3K first/last 100 tokens, 1K first/last 20, 1K first/last 10, then omitted turns. The latest user input stays complete. Images survive only with intact source messages.
- Context estimates include the effective view, system prompt, and active tools, excluding other extensions' temporary injections. A backtrack need not reduce token count; actual overflow still uses host compaction.
- **Pi 0.85.1 compaction adapter:** the host summarizes the effective conversation without retaining a raw tail, preventing removed tool activity from resurfacing. This changes native `keepRecentTokens` tail retention, and original images are not retained after compaction. Backtrack itself adds no summarizer call.
- New input, cancellation, or invalid targets prevent uncommitted backtracks. Persistence failures stop execution and report the failure without claiming rollback. Both extension load orders are supported; arbitrary third-party context reordering is not guaranteed.

See [design & implementation](docs/design.md) and the [dependency snapshot notes](vendor/README.md).

</details>

<details>
<summary>Development & tests</summary>

```sh
npm ci
npm run typecheck
npm test
```

Tests cover real Pi SDK tool loops, continuation, both load orders, skill cooperation, cancellation, recovery, compaction, and overflow retries. A scripted provider requires no model credentials.

</details>
