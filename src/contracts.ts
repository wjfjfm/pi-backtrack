/** Design contracts only; no host integration or tool registration yet. */
export type CheckpointId = `cp-${number}`;

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

export interface BacktrackArguments {
  checkpoint: CheckpointId;
  /** Current goal, conclusions, external effects, validation and next action. */
  summary: string;
}
