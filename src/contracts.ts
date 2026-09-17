/** Runtime contracts for the upcoming checkpoint and backtracking implementation. */
export type { BacktrackArguments } from "./index.js";

/** Non-negative safe integer, allocated monotonically within a session. */
export type CheckpointId = number;

export interface ContextStatus {
  usedTokens: number | null;
  windowTokens: number | null;
  accuracy: "exact" | "estimated" | "unknown";
}

/** Durable mapping from the model-visible address to a Pi history boundary. */
export interface Checkpoint {
  id: CheckpointId;
  sessionId: string;
  boundaryEntryId: string;
  status: ContextStatus;
}
