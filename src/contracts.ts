/** Runtime contracts for the upcoming checkpoint and backtracking implementation. */
export type { BacktrackArguments } from "./schema.js";

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

/** Stored knowledge excludes the one-time continuation message. */
export interface KnowledgeEntry {
  id: number;
  sessionId: string;
  checkpoint: CheckpointId;
  description: string;
  knowledge: string;
}

/** Model-visible view; collapsed entries expose only their description. */
export type KnowledgeView =
  | { id: number; description: string; expanded: false }
  | { id: number; description: string; expanded: true; knowledge: string };
