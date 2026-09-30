import type { ContextMessage } from "./context.js";
import type { FoldPolicy } from "./projection.js";
type ReplacementMessage = Extract<ContextMessage, { role: "custom" }>;
export const POLICY = "backtrack:policy:v1";
export interface BacktrackPolicy extends FoldPolicy { details: BacktrackDetails }
export type { BacktrackArguments } from "./schema.js";
export const STATE = "backtrack:checkpoints:v3";
export const SNAPSHOT_STATE = "backtrack:checkpoints:v2";
export const LEGACY_STATE = "backtrack:state:v1";
export interface Checkpoint {
  id: number;
  /** Effective native entry boundary, not a private context projection. */
  boundary: string | null;
  /** Raw dialogue extraction boundary; compaction can reorder its retained tail. */
  historyBoundary: string | null;
  marker: ReplacementMessage;
  /** Unrounded host meter at creation; display fallback only. */
  tokens?: number | null;
}
export interface BacktrackState {
  version: 2;
  epoch: string;
  base: string | null;
  next: number;
  cursor: string | null;
  checkpoints: Checkpoint[];
  lastTransaction?: string;
  usage?: BacktrackUsage;
}
export type StoredState = Omit<BacktrackState, "version" | "checkpoints"> & {
  version: 3;
  /** Exact previous state revision on this branch; null starts a self-contained state. */
  parent: string | null;
  checkpoints: Checkpoint[];
  removed: number[];
};
export interface BacktrackUsage { before: number | null; after: number | null; afterEstimated?: boolean; window?: number }
export interface BacktrackDetails {
  kind: "backtrack:v2";
  callId: string;
  target: number;
  keepAfter?: number;
  location: string[];
  before: number | null;
  state: StoredState;
}
