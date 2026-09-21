import { Type, type Static } from "@earendil-works/pi-ai";
import { parameterDescriptions } from "./tool-description.js";

export const backtrackParameters = Type.Object({
  // Pi's integer coercion truncates fractional numbers. A numeric schema
  // with multipleOf preserves the value so validation rejects fractions.
  checkpoint: Type.Number({
    multipleOf: 1,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: parameterDescriptions.checkpoint,
  }),
  message: Type.Optional(Type.String({ description: parameterDescriptions.message })),
  keep_after_checkpoint: Type.Optional(Type.Number({
    multipleOf: 1, minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    description: parameterDescriptions.keep_after_checkpoint,
  })),
}, { additionalProperties: false });

export type BacktrackArguments = Static<typeof backtrackParameters>;

/** Revalidate after extension tool_call hooks, which can mutate validated arguments. */
export function validateArguments(value: unknown): asserts value is BacktrackArguments {
  if (!value || typeof value !== "object") throw new Error("Invalid backtrack arguments.");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "checkpoint" && key !== "message" && key !== "keep_after_checkpoint")
    || !Number.isSafeInteger(args.checkpoint) || (args.checkpoint as number) < 0
    || (args.keep_after_checkpoint !== undefined && (!Number.isSafeInteger(args.keep_after_checkpoint) || (args.keep_after_checkpoint as number) < 0))
    || (args.message !== undefined && typeof args.message !== "string")) {
    throw new Error("backtrack requires non-negative safe-integer checkpoints and, if provided, a string message.");
  }
}
