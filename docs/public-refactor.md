# Public extension refactor — deployed local artifacts

## Checkpoint storage update — 2026-09-30

The later extension-only release is `~/.local/share/pi-public-extension/20260930-165207-checkpoints/`; the public host is unchanged. Backtrack now stores v3 checkpoint deltas with explicit parent revisions, while reading old public v2 snapshots. Source and extracted-artifact acceptance: **65/65** backtrack/combined tests, **86/86** dynamic-skill tests. Checkpoint state/context differential audit: **31/31** stages against the previous full-snapshot engine; skill injection audit: **10/10**. An isolated copy of the current session also restored identical state/context. No model-facing text was changed by the storage update.

Current public-v2 sessions can `/reload` into the new extension. Older extensions must not resume v3 sessions; backups and guarded rollback are recorded in the release's `DEPLOYMENT.md`. The sections below retain the initial public-extension deployment history and its earlier test counts.

## Deployment update — 2026-09-30

At the user's explicit request, activated public npm Pi 0.85.1 and the two packaged extensions, accepting the existing Node 22.17 compatibility risk. The global Pi entry now points into `~/.local/share/pi-public-extension/20260930-093527/runtime/`. Settings install backtrack before dynamic-skill; idealab and unrelated settings are unchanged. Actual-config loading and a local scripted fold/continuation passed before and after activation. No live model call was made. Old runtimes/worktrees and session files were retained; start a new session, not a reload of the native-backtrack session.

Deployment record, manifest, acceptance logs and guarded rollback script are in `~/.local/share/pi-public-extension/20260930-093527/`. Settings/entry backup: `~/.pi/agent/backups/public-extension-20260930-093527/`. The remaining sections record pre-deployment acceptance and its scope.

## Contract

Both extensions use public Pi 0.85.1 APIs. No modified host, private SessionManager calls, cross-extension service or batch transaction. Backtrack independently registers a policy; complete tool batches are structural boundaries, including failed sibling results. Combined order is **backtrack → dynamic-skill**. Both work independently.

User-approved later changes: remove `terminate`; estimate after-fold usage for tool display from checkpoint baseline plus increments (local full estimate only for unknown baseline). Checkpoint injection/metering and skill prompt formatter are unchanged.

## Implementation

- Backtrack: minimal policy records, request-local provenance, effective-context projection, nested/retained-tail folds, native public summary generation over effective history, safe raw suffix, source-aware checkpoints and immutable display snapshots.
- Dynamic-skill: continuous queues, immutable description records, request-time missing-description loading, raw entry identity verification, stable shared-anchor order, persisted non-replayable delivery when no safe anchor exists. No guessed source matching or resurrection of delivered discovery from an old read.
- Projection metadata is internal persistence, not extra model instructions. No full request view is stored. Arbitrary indistinguishable third-party synthetic-message rewriting is not supported provenance.
- Build cleans `dist` first, preventing the deleted `native.js` from leaking into artifacts. Package allowlists exclude tests, old host scripts and historical investigation documents.
- Obsolete native-host runners/configs/integration fixtures are removed from these refactor worktrees. Original worktrees and Git history retain the baseline. The public lifecycle test was retained and renamed. Superseded native transaction/foreign-fold/any-load-order assertions are not part of the new contract.

## Verification

- Both typechecks pass.
- Backtrack default public-SDK suite with companion explicitly enabled: **52/52**, zero skips.
- Dynamic-skill default suite: **86/86**, zero skips.
- Runtime differential injection audit: **10/10 stages** against the original dynamic-skill runtime; exact public LLM-converted roles/content/order match. See [audit](public-injection-audit.md) for method, baseline hash and scope.
- Frozen `history.ts`, `tool-description.ts`, `schema.ts`, and dynamic-skill `prompt.ts` compare equal to the original worktrees (including the approved terminate removal).
- Public CLI text/JSON/RPC; read → retained tail → nested fold → manual/overflow compact → disk reopen; descriptions once, hidden bodies absent; queued user input; image handling; tree navigation; summary failure/retry all pass with scripted providers.

## Installed artifacts

Built using `npm pack`, then installed with the published SDK in a fresh temporary project, not a symlink to the development node_modules. An initial offline attempt lacked cached registry metadata; one network install populated it. Final installation was offline. The installed-artifact tests import packaged dist files and load packaged src entry points; they do not execute worktree extension code.

Final acceptance directory: `/tmp/pi-public-final-KjGV58`.

- Installed backtrack/combined/CLI tests: **52/52**.
- Installed dynamic-skill tests: **86/86**.
- Artifacts in `/tmp/pi-public-release-artifacts/`:
  - `pi-backtrack-0.0.0.tgz` SHA256 `5c77dce98631e9177644107e51281ceefd2eea748a15c2b0f7d6a54f37031b65`
  - `pi-dynamic-skill-0.0.0.tgz` SHA256 `e760be96ead20fa92c0023aae410214d5f517580f940366e243212b12c9f49a7`
- Logs: `/tmp/pi-final-backtrack-artifacts.log`, `/tmp/pi-final-dynamic-artifacts.log`, `/tmp/pi-public-final-install.log`.

## Remaining deployment gate

Tests ran on this machine's Node 22.17.0. Pi requires **Node ≥22.19.0**. An official 22.19.0 binary installed only inside a temporary test directory could not launch because the system glibc/libstdc++ are too old. No Docker/Podman executable is available. Do not call this supported-platform certification or silently replace system libraries. Re-run typecheck/tests and artifact acceptance on a supported Node/OS before production deployment.

No live network model, human TUI or arbitrary third-party extension composition certification is claimed. At candidate acceptance time, no installed version had been replaced. The deployment update above supersedes that state. The already-running process still uses its loaded old host until restarted; no commit/push occurred.

See [deployment and rollback](public-extension.md). Moving from the modified host requires a new session with an explicit handoff; native-backtrack/legacy-view sessions are rejected rather than silently converted. Queue state is session-local; skill files remain in their existing dedicated directory.
