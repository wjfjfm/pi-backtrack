import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";

export const backtrackParameters = Type.Object({
  checkpoint: Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: "Checkpoint number from an injected context marker. Use an existing checkpoint on the current path.",
  }),
  summary: Type.String({
    minLength: 1,
    pattern: "\\S",
    description: "Handoff for continuing after backtracking: current goal, findings, decisions, external changes, validation status, and the next step. Include failed approaches that should not be repeated.",
  }),
}, { additionalProperties: false });

export type BacktrackArguments = Static<typeof backtrackParameters>;

export default function registerBacktrack(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "backtrack",
    label: "Backtrack",
    description: "Return to a checkpoint with a handoff summary, replacing the active context after it. This changes conversation context only; files, processes, and external actions are not rolled back. Call this tool alone in its tool batch. Currently unavailable: checkpoint injection and backtracking execution are not implemented yet.",
    parameters: backtrackParameters,
    async execute() {
      // Throw so Pi marks the tool result as an error, rather than reporting
      // success for an operation that has not changed the context.
      throw new Error("Backtracking is not implemented yet. No context was changed. Continue on the current path.");
    },
  });
}
