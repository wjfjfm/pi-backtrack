import type { ReplacementMessage } from "./native.js";
export type { BacktrackArguments } from "./schema.js";
export const STATE = "backtrack:checkpoints:v2";
export const LEGACY_STATE = "backtrack:state:v1";
export interface Checkpoint {
  id: number;
  /** Effective native entry boundary, not a private context projection. */
  boundary: string | null;
  /** Raw dialogue extraction boundary; compaction can reorder its retained tail. */
  historyBoundary: string | null;
  marker: ReplacementMessage;
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
export interface BacktrackUsage { before: number; after: number; window?: number }
export interface BacktrackDetails {
  kind: "backtrack:v2";
  callId: string;
  target: number;
  keepAfter?: number;
  location: string[];
  before: number;
  state: BacktrackState;
}
