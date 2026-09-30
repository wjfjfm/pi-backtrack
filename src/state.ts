import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { STATE, SNAPSHOT_STATE, type BacktrackState, type Checkpoint, type StoredState } from "./contracts.js";

export function isStateEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && (entry.customType === STATE || entry.customType === SNAPSHOT_STATE);
}

/** Keep the runtime state unchanged; only its persisted checkpoint list is incremental. */
export function storeState(state: BacktrackState, previous?: { id: string; state: BacktrackState }): StoredState {
  const { version: _version, checkpoints, ...head } = state;
  const reset = !previous || previous.state.epoch !== state.epoch || previous.state.base !== state.base;
  const old = new Map((reset ? [] : previous!.state.checkpoints).map(point => [point.id, point]));
  const current = new Set(checkpoints.map(point => point.id));
  return structuredClone({ ...head, version: 3, parent: reset ? null : previous!.id,
    checkpoints: checkpoints.filter(point => JSON.stringify(old.get(point.id)) !== JSON.stringify(point)),
    removed: [...old.keys()].filter(id => !current.has(id)),
  });
}

/** One map, one final clone: replay never materializes intermediate full snapshots. */
export function restoreStates(records: readonly StoredState[]): BacktrackState | undefined {
  const points = new Map<number, Checkpoint>();
  let previous: StoredState | undefined;
  for (const saved of records) {
    if (!Array.isArray(saved.checkpoints)) throw new Error("Corrupt backtrack checkpoint state.");
    if (saved.version === 2) points.clear();
    else {
      if (saved.version !== 3 || !Array.isArray(saved.removed) || (saved.parent !== null && typeof saved.parent !== "string")) {
        throw new Error("Corrupt backtrack checkpoint delta.");
      }
      if (saved.parent === null) points.clear();
      else if (!previous || previous.epoch !== saved.epoch || previous.base !== saved.base) {
        throw new Error("Missing backtrack checkpoint delta base.");
      }
      for (const id of saved.removed) points.delete(id);
    }
    for (const point of saved.checkpoints) points.set(point.id, point);
    previous = saved;
  }
  if (!previous) return;
  const { version: _version, checkpoints: _points, ...head } = previous;
  const { parent: _parent, removed: _removed, ...runtime } = head as typeof head & { parent?: string | null; removed?: number[] };
  return structuredClone({ ...runtime, version: 2, checkpoints: [...points.values()].sort((a, b) => a.id - b.id) });
}
