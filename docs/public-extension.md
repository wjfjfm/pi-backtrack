# Public-extension runtime and deployment

Targets unmodified Pi **0.99.1**, Node **≥22.19.0**. No host patch is installed. Development and release packaging use the primary checkout on `main`.

## Runtime contract

- Pi's `buildSessionProjection()` supplies canonical messages and source IDs, respecting native context edits. System/tool declarations remain owned by Pi and are not foldable conversation entries.
- Backtrack is `model-only`: nested tool execution has no transcript boundary to anchor a fold. It follows the ordinary tool continuation loop without terminate/abort/restart orchestration.
- A fold is an independent tool side effect. Projection requires a complete tool batch, not an all-success transaction; a failed sibling does not revoke a fold.
- Nonzero and retained-tail folds remain request-local projections. Native context edits cannot insert arbitrary multi-message/image content at an interior position, so replacing this layer with native edits would change existing semantics.
- Ordinary **backtrack(0) resets the native working-context baseline** at `turn_end`, after all sibling results. No summary model, abort/restart sequence, or additional continuation is needed. The new root contains only the current interval's trimmed dialogue/images and handoff; older summaries, handoffs and policies are not inherited. Archive history is unchanged.
- Compaction summarizes effective history and retains only a safe raw suffix. `ModelRuntime.streamSimple()` owns routing, credentials, headers and virtual-model resolution; no manual completion-to-stream adapter is used. The custom-compaction hook still requires an existing string `firstKeptEntryId`, so an empty retained suffix uses a fence entry (unlike boundary compaction drafts, whose ID can be null).
- Tree navigation and branch summarization remain native archive operations. Navigating before a fold restores that path; a branch summary crossing it may revisit earlier exploration. Compaction instead summarizes the current working context.
- After-fold usage is a fixed local estimate. For automatic threshold compaction with stale provider usage, backtrack checks effective content, markers, system prompt and active tool definitions and cancels below-threshold attempts before summarization. Manual compaction, overflow recovery, fresh usage and genuinely over-threshold context are not suppressed. Later context hooks can affect the estimate.
- Dynamic-skill is optional. Load **backtrack before dynamic-skill** when combined. There is no cross-extension service or private host protocol.

## Zero-reset publication

Pi boundary drafts are ordered writes, not a transaction. Backtrack therefore publishes one native `backtrack:baseline` custom message containing dialogue/images and handoff **before** appending its native compaction commit. Both refer to the existing policy ID; no second journal, snapshot format or in-memory recovery flag is introduced. The compaction retains the newly published payload, starting at the invisible checkpoint-state entry saved immediately before it, rather than retaining any old conversation. A retain-none compaction written first would risk losing the payload if a later write failed.

Until the commit exists, the payload is excluded from backtrack's projection and the registered policy remains authoritative. If a session resumes with a published payload but no commit, the next complete turn commits that payload and preserves work appended after it, without duplicating content or forcing another response. A newer fold supersedes recovery of that pending reset. Failure before payload publication leaves the ordinary registered fold intact; no reset commit is claimed.

The reset does not change the session/cache identity or cache-retention settings. Its summary is constant; policy IDs, epochs and usage metadata are not included in that summary or payload text. Checkpoint markers are persisted snapshots, not rewritten each turn. Tests verify unchanged system/tool content and an identical new request prefix across subsequent tools, user turns, reload and resume. The initial reset still changes conversation layout; actual provider cache hits are not guaranteed.

After commit, Pi's projection, compaction and context meter use the new baseline directly. Checkpoint zero anchors the new summary, while history extraction starts at its native retained boundary so a recovered retained tail is not skipped. Subsequent zero resets do not copy the previous materialized payload. Other boundary drafts and queued input retain their host scheduling semantics. Boundary commits do not emit `session_compact`; consumers must observe the canonical projection rather than depend solely on that notification.

## Checkpoint storage and recovery

`backtrack:checkpoints:v3` entries in the session JSONL store a small header, explicit previous revision ID, changed checkpoints and removed IDs. Policies use the same delta encoding. Recovery follows the selected branch's revision chain and materializes one checkpoint map; no separate cache or state file exists.

- Explicit parents prevent incomplete policies from changing already saved revision bases. Missing/corrupt bases fail closed.
- Reload/resume restores persisted records. Tree uses branch-local state and the epoch's session-wide numbering high-water mark. Fork preserves source entry IDs.
- Compaction and zero-checkpoint epoch changes begin self-contained checkpoint state. State references do not cross compaction boundaries.
- Only v3 persisted checkpoint state is supported. Obsolete v2 full snapshots and native-backtrack/legacy-view sessions are rejected, not silently migrated. Current v3 sessions can resume after verification on a backed-up copy.

This removes quadratic checkpoint-body storage, not all history scanning. Older extensions must not open newer records and assume equivalent behavior. Rollback restores the previous host, packages/settings **and the pre-upgrade session backup**.

## Verification and installation

```sh
npm ci
npm run typecheck
npm test
PI_DYNAMIC_SKILL_EXTENSION=/absolute/path/pi-dynamic-skill/src/index.ts npm test
npm pack --pack-destination /absolute/path/artifacts
```

`PI_BACKTRACK_EXTENSION` selects an extracted artifact for CLI/public-runtime tests. Tests cover native context edits, nested-call exposure, system declarations, images, compaction and disk/fork/reload recovery with local scripted providers; they do not certify every live network provider.

1. Back up settings and sessions; record host/package paths.
2. Test extracted packages and a copy of the actual session before switching.
3. Install packages in backtrack → dynamic-skill order, preserving unrelated settings and avoiding duplicate extensions.
4. **Restart Pi after a host upgrade. `/reload` only reloads extensions.** Resume verified v3 sessions; start a new session with a handoff for unsupported old formats.

`scripts/audit-checkpoints.mjs` is an optional historical differential audit requiring an explicitly supplied baseline engine, not a release dependency or old-host adapter. Dated deployment/audit documents preserve historical evidence; their old runtime paths and engine exceptions are not current requirements.
