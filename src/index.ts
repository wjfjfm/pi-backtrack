import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { backtrackParameters } from "./schema.js";
import { backtrackDescription } from "./tool-description.js";

export default function registerBacktrack(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "backtrack",
    label: "Backtrack",
    description: backtrackDescription,
    parameters: backtrackParameters,
    async execute() {
      // Throw so Pi marks the tool result as an error, rather than reporting
      // success for an operation that has not changed the context.
      throw new Error("Backtracking is not implemented yet. No context was changed. Continue on the current path.");
    },
  });
}
