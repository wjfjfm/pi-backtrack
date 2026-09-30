# Public-extension injection audit

## Baseline and method

Compared the isolated refactor with the unchanged dynamic-skill runtime in the original worktree (`73dbb717da5e3e00601f6be251d3f44d280d57d6`; audited `dist/runtime.js` SHA256 `d94b4d889e8819e78733ffa568871750bfdc763d7fd3d30446edb1bf787c5419`).

Reproduce from the refactored dynamic-skill repository:

```sh
npm run build
node scripts/audit-injection.mjs /absolute/path/to/baseline/dist/runtime.js
```

The audit constructs equivalent session histories, executes each runtime, then compares public `convertToLlm()` output: exact message roles, content and ordering, excluding timestamps. This is a runtime-level differential audit, not a claim that the modified host's lifecycle is unchanged.

All ten stages pass: initial request; root read; child read; write; edit; manual selection; next user; reload settlement; compact rebuild; runtime recreation.

## Frozen model text

Byte-for-byte comparisons with the original worktrees pass for:

- backtrack `src/history.ts`, `src/tool-description.ts`, `src/schema.ts`;
- dynamic-skill `src/prompt.ts`.

The baseline here includes the user's later removal of `terminate`; it must not be restored. History headers, handoff formatting, ON marker, active/pending/discovery descriptions and skill XML are not rewritten. Source identities, delivery records and contraction hashes are internal entries, not additional instruction messages.

## Intentional mechanism differences

| Area | Current contract |
| --- | --- |
| Tool batch | Independent backtrack policy; completed sibling failures do not revoke it. Incomplete tool batches are not cut. Approved semantic change. |
| Description delivery | Public context hook replaces before-agent-start/sendMessage/host refresh. Backtrack runs first, then dynamic-skill reconciles actual retained context. |
| Reload/compact | Visibility-dependent queue settlement occurs at the next actual request, not eagerly against raw history. |
| Stable descriptions | Replay immutable blocks at valid anchors. Raw anchors verify source entry identity; shared anchors preserve creation order. |
| No safe anchor | Record delivery without authorizing replay. Previously delivered discovery is not treated as an undelivered old read; active descriptions may be rebuilt. |
| Compaction | Use the public summary function over effective context; preserve only a safe raw suffix. Hidden tool bodies do not enter summaries or reappear afterward. |
| Usage | Fixed after-fold display estimate; checkpoint injection/meters unchanged. |
| Termination | Removed at the user's request; normal tool continuation remains. |

No arbitrary third-party rewriting/byte-identical synthetic-message replacement is promised. Provider delivery is not transactional: a description is marked shown during context construction.

## Actual public-host acceptance

The public AgentSession and CLI tests cover ordinary continuation, sequential/parallel sibling errors, nested and retained-tail folds, queued user input, intact user images, summary failure/retry, tree navigation without mutating old entries, reload and disk reopen. Combined skill tests verify exact-once descriptions and absent folded tool bodies after manual and automatic-overflow compaction. These run on the published SDK and scripted providers; no live provider/network overflow is claimed.

Initial public-refactor backtrack suite: 52 passed with the companion explicitly enabled. Dynamic-skill: 86 passed, including persistence failures, read discovery, queue visibility, navigation/fork, unanchored delivery and source collision regressions. Tests are retained for the new contract, not obsolete native transactions. The original native-host suite remains available in the original worktrees/Git history; its entire assertion set is not claimed to be equivalent.

## Deployment gate

Source and artifact tests use this machine's Node 22.17.0. Pi 0.85.1 requires Node ≥22.19.0. A temporary official 22.19.0 binary cannot run on the system's old glibc/libstdc++; no system libraries or installed runtime were changed. Re-run acceptance on a supported Node/OS before production deployment. This was the pre-deployment gate; subsequent local deployments and the v3 checkpoint storage audit are recorded in [public-refactor.md](public-refactor.md). No native-backtrack session migration is supported.
