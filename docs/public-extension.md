# Public-extension deployment

This refactor targets unmodified Pi 0.85.1 and Node ≥22.19.0. It does not install a host patch. Local packaged artifacts were deployed on 2026-09-30; the worktree itself is not the installed source. The public-API implementation is maintained on `refactor/public-extension`; use the branch-qualified Git installation in the README rather than the old `main` baseline.

## Runtime contract

- Backtrack registers an independent context policy. A failed sibling tool does not revoke it. A complete tool batch is required before projection, not an all-success transaction.
- Checkpoints, retained tails, dialogue history and handoffs are projected using public context APIs. Compaction summarizes that effective history and keeps only a safe raw suffix.
- Tree navigation and branch summarization remain native. Like compaction, backtrack changes working context, not the historical archive: navigating before a fold restores that path, and a branch summary crossing the fold may revisit earlier exploration. The handoff is available through the original backtrack call arguments, subject to the native summary budget. No tree-specific projection or hook is needed; compaction, unlike tree, summarizes current working context.
- `terminate` is removed. Backtracking follows the ordinary tool continuation loop.
- The tool's after-fold usage is a fixed local estimate, based on checkpoint usage plus added content where available. It does not change checkpoint metering.
- Dynamic-skill is optional. When combined, load **backtrack before dynamic-skill**. No cross-extension service or event protocol is used.

## Checkpoint storage

Checkpoint storage uses `backtrack:checkpoints:v3` entries in the existing session JSONL. Each revision stores the small state header (epoch, compaction base, next number, cursor and optional fixed usage), an explicit previous revision ID, and only changed checkpoint records / removed IDs. A backtrack policy uses the same state encoding instead of embedding another full checkpoint list. Checkpoint markers and their original usage samples are preserved verbatim, not regenerated.

The runtime still uses the same complete in-memory state. Recovery follows the selected branch's revision chain, merges into one checkpoint map, and clones only the final result. It does not materialize every intermediate snapshot. The explicit parent prevents an incomplete policy from later changing the base of an already saved revision. Parents must precede the revision on the same branch after the last compaction; missing bases fail closed.

- Reload/resume reconstruct from persisted records; there is no separate cache or state file.
- Tree selects that branch's latest eligible revision. Number allocation still observes the session-wide high-water mark within the same epoch.
- Fork keeps the source entry IDs on its copied path, so state references survive without remapping or a fork-specific hook.
- Compaction starts a self-contained state; zero-checkpoint epoch resets do likewise. Recovery never follows a state reference across the compaction boundary.
- Existing public-extension v2 full snapshots and policy states remain readable and can seed new deltas. Old records are not rewritten. Native-backtrack/legacy-view session restrictions remain unchanged.

This trades constant-time access to a recent full snapshot for replay of the revisions needed by the current state. It removes quadratic checkpoint-body storage, not all history scans or cursor writes. No model text, checkpoint placement, watermark, or backtrack semantics are intentionally changed. Older extension versions must not resume a session containing v3 deltas; rollback requires the pre-upgrade session backup as well as the previous extension. The v3 artifacts were deployed on 2026-09-30 at `~/.local/share/pi-public-extension/20260930-165207-checkpoints/`, reusing the unchanged public host. Its `DEPLOYMENT.md` records artifact acceptance, current-session-copy verification, backups and guarded rollback. Running sessions need `/reload`; no host restart is required.

A development-only differential audit accepts the previous full-snapshot engine:

```sh
node scripts/audit-checkpoints.mjs /absolute/path/to/baseline/dist/engine.js
```

It compares restored states and projected messages across batches, default/retained/nested/zero folds, reload, disk resume, tree, fork, and repeated compaction boundaries. Only independently generated entry IDs, epochs and timestamps are normalized. Real public-SDK tests separately cover summary generation and the disk fork → reload → compact → resume lifecycle with local scripted providers.

## Verify before deployment

```sh
npm ci
npm run typecheck
npm test
# Optional companion acceptance: supply an actual extension path.
PI_DYNAMIC_SKILL_EXTENSION=/absolute/path/pi-dynamic-skill/src/index.ts npm test
npm pack --pack-destination /absolute/path/artifacts
```

Default tests run against the published SDK. The obsolete native-host runner and integration fixtures have been removed from this refactor; they remain in the original worktree/Git history as a baseline, not release acceptance. Integration providers are local/scripted, not live network models.

The CLI and public runtime tests also accept `PI_BACKTRACK_EXTENSION` to exercise an extracted/installed artifact rather than the worktree entry point.

## Install without losing the old session

1. Back up Pi settings and session files. Record the currently installed extension paths and host version.
2. Verify both artifacts in a temporary agent directory first. Do not load source and packaged copies of the same extension together.
3. Install the approved local package paths, keeping backtrack before dynamic-skill in the configured extension order. Review `pi list` for duplicate installations.
4. Start a **new session on the unmodified host**. Old native-backtrack or legacy-view sessions are explicitly rejected; there is no transparent in-place migration.
5. Carry forward a human-readable task handoff and existing skill files. Do not rewrite old session JSONL or skill paths. Queue state is session-local, not automatically migrated to a fresh session.

Rollback: restore the old host/settings/extension paths and resume the original backed-up session. Do not open a new policy-based session with the old backtrack implementation and assume equivalent filtering.

Local deployment, acceptance logs and guarded rollback are recorded in `~/.local/share/pi-public-extension/20260930-093527/DEPLOYMENT.md`. The user accepted retaining Node 22.17.0 despite the upstream engine declaration; this is not supported-Node certification. Artifact validation and injection auditing are tracked in `public-refactor.md` in the development repository.
