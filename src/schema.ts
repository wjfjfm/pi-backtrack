import { Type, type Static } from "@earendil-works/pi-ai";
import { parameterDescriptions } from "./tool-description.js";

const requiredText = (description: string) => Type.String({
  minLength: 1,
  pattern: "\\S",
  description,
});

export const backtrackParameters = Type.Object({
  // Pi's integer coercion truncates fractional numbers. A numeric schema
  // with multipleOf preserves the value so validation rejects fractions.
  checkpoint: Type.Number({
    multipleOf: 1,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: parameterDescriptions.checkpoint,
  }),
  message: requiredText(parameterDescriptions.message),
}, { additionalProperties: false });

export type BacktrackArguments = Static<typeof backtrackParameters>;

/** Revalidate after extension tool_call hooks, which can mutate validated arguments. */
export function validateArguments(value: unknown): asserts value is BacktrackArguments {
  if (!value || typeof value !== "object") throw new Error("Invalid backtrack arguments.");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "checkpoint" && key !== "message")
    || !Number.isSafeInteger(args.checkpoint) || (args.checkpoint as number) < 0
    || typeof args.message !== "string" || !args.message.trim()) {
    throw new Error("backtrack requires only a non-negative safe-integer checkpoint and a nonblank message. Save knowledge with dynamic-skill before calling backtrack.");
  }
}
