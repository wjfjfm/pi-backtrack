import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];

// Optional wire protocol, not a package dependency. See docs/skill-context-protocol.md.
export const DYNAMIC_CONTEXT = "dynamic-skill:context";
export const SERVICE_CHANNEL = "dynamic-skill:context-service:v1";
export const OWNER_CHANNEL = "pi:context-owner:v1";
export interface PreparedSkills {
  messages: ContextMessage[];
  commit(): void;
}
export interface SkillContextService {
  project(ctx: ExtensionContext, messages: ContextMessage[]): ContextMessage[];
  prepare(ctx: ExtensionContext, retained: ContextMessage[], transactionId: string, full: boolean): PreparedSkills;
  shown(ctx: ExtensionContext, messages: ContextMessage[]): void;
  compact(ctx: ExtensionContext): void;
}

/** Discover only an enabled v1 service. Absence is valid; method errors propagate. */
export function skillContextService(pi: Pick<ExtensionAPI, "events">): SkillContextService | undefined {
  let service: SkillContextService | undefined;
  pi.events?.emit(SERVICE_CHANNEL, { accept(value: SkillContextService) { service = value; } });
  return service;
}

/** Local message identity; independent of any companion implementation. */
export function messageKey(message: ContextMessage): string {
  // Persisted custom messages use entry timestamps rather than their original
  // in-memory timestamps. Hash semantic fields in canonical order instead.
  const value = message.role === "custom" ? { role: message.role, customType: message.customType,
    content: message.content, display: message.display, details: message.details } : message;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
