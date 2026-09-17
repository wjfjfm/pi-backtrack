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
  description: requiredText(parameterDescriptions.description),
  knowledge: requiredText(parameterDescriptions.knowledge),
  message: requiredText(parameterDescriptions.message),
}, { additionalProperties: false });

export type BacktrackArguments = Static<typeof backtrackParameters>;
