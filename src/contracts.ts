/** Runtime contracts for the upcoming checkpoint and backtracking implementation. */
import type { SkillReference } from "pi-dynamic-skill";
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

/** Session index stores a skill reference, not its body or continuation message. */
export interface KnowledgeEntry extends SkillReference {
  sessionId: string;
  checkpoint: CheckpointId;
}

/** Model-visible view; collapsed entries expose only their description. */
export type KnowledgeView =
  | (SkillReference & { expanded: false })
  | (SkillReference & { expanded: true; knowledge: string });
