/** Placeholder copy. Tool and parameter guidance will be refined separately. */
export const backtrackDescription =
  "Backtrack to a checkpoint with knowledge and a continuation message. Execution is not implemented yet.";

export const parameterDescriptions = {
  checkpoint: "Checkpoint number.",
  description: "Description of the knowledge and when to consult it.",
  knowledge: "Knowledge to retain after backtracking.",
  message: "Message for continuing after backtracking; not part of the knowledge entry.",
} as const;
