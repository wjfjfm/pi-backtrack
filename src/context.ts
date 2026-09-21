import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];

/** Local message identity; independent of any companion implementation. */
export function messageKey(message: ContextMessage): string {
  // Persisted custom messages use entry timestamps rather than their original
  // in-memory timestamps. Hash semantic fields in canonical order instead.
  const value = message.role === "custom" ? { role: message.role, customType: message.customType,
    content: message.content, display: message.display, details: message.details } : message;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
