# Optional skill context protocol

Backtrack and dynamic-skill are independently installed packages. Neither requires the other at runtime, as a peer, or as a development dependency. Backtrack does not import companion code, bundle a companion snapshot, or activate the companion extension.

They cooperate through the Pi event bus. Each package owns its local types and implementation; compatibility is defined by the versioned wire contract below, not by matching package releases.

## Discovery

Discovery is synchronous. The event payload is `{ accept(service) }`; an enabled extension invokes `accept` during the callback. An absent service is normal. Only discovery uses the event bus: actual method calls return or throw directly so errors are not swallowed by Pi's event dispatch.

| Channel | Provider | Value |
| --- | --- | --- |
| `dynamic-skill:context-service:v1` | dynamic-skill | Skill context service |
| `pi:context-owner:v1` | backtrack | `{ current(ctx): ContextMessage[] }` |

`ContextMessage` is a message from Pi's `ContextEvent`. `ctx` is Pi's `ExtensionContext`. The owner returns the current effective view without allocating checkpoints or generating a response. This lets the skill extension attach reload updates to retained context rather than discarded raw history.

## Skill service v1

```ts
interface SkillContextService {
  project(ctx, messages): ContextMessage[];
  prepare(ctx, retained, transactionId: string, full: boolean): {
    messages: ContextMessage[];
    commit(): void;
  };
  shown(ctx, messages): void;
  compact(ctx): void;
}
```

- `project` composes skill metadata with the effective view, preserving existing prefixes. It may persist fixed projection anchors; repeated projection must not duplicate blocks. Manual additions can appear here on the next model turn.
- `prepare` computes a skill update without persisting settlement. `full` requests a directory rebuild; otherwise only missing descriptions are appended. Preparation failure must propagate, not be treated as an absent service.
- `commit` synchronously persists the prepared update. It is idempotent for the transaction ID. A full rebuild resets old directory overlays only on commit.
- `shown` records pending notices actually present in model context. Repeated calls are idempotent.
- `compact` settles and rebuilds once per native compaction entry, regardless of extension load order.

Regenerable skill metadata uses custom message type `dynamic-skill:context`. Backtrack excludes those messages from the host's compaction input; skill bodies read through tools remain ordinary conversation content.

Private session entries, LRU state, directory layout, menu state, and message-key implementations are not shared APIs. Each extension persists and restores its own state. Existing v1 behavior must remain compatible; a breaking change requires a new channel version (optionally served alongside v1), not coordinated package upgrades.

## Tests

Standalone checks require only the backtrack checkout:

```sh
npm ci
npm run typecheck
npm test
```

Companion-specific SDK tests are explicitly skipped unless an independently installed extension is supplied. Core backtrack tests still run, including reload, compaction, overflow, and external injections.

For integration testing, install dependencies in a separate dynamic-skill checkout, then run from backtrack:

```sh
PI_DYNAMIC_SKILL_EXTENSION=/absolute/path/to/pi-dynamic-skill/src/index.ts npm test
```

A supplied but missing or incompatible extension fails the tests; it is not silently skipped. Tests cover both load orders, backtrack, reload, compact, manual selection, and skill-body retention. There is no fallback to a vendored copy.
