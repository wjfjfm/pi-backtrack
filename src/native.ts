import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "./context.js";

// Public experimental host API. Keep this bridge until the published SDK includes it.
export type ReplacementMessage = Extract<ContextMessage, { role: "custom" }>;
export interface BacktrackOptions {
  keepThroughEntryId: string | null;
  firstKeptEntryId?: string;
  messages: ReplacementMessage[];
  details?: unknown;
}
export interface NativeBacktrackEntry extends BacktrackOptions {
  type: "backtrack";
  id: string;
  parentId: string | null;
  timestamp: string;
}
export type NativeEntry = SessionEntry | NativeBacktrackEntry;
export function nativeContext(ctx: ExtensionContext): ContextMessage[] {
  return (ctx.sessionManager as typeof ctx.sessionManager & {
    buildSessionContext(): { messages: ContextMessage[] };
  }).buildSessionContext().messages;
}
export function requestBacktrack(ctx: ExtensionContext, callId: string, options: BacktrackOptions): void {
  const host = ctx as ExtensionContext & { requestBacktrack?: (id: string, options: BacktrackOptions) => void };
  if (!host.requestBacktrack) throw new Error("Backtrack requires a host with native backtrack support.");
  host.requestBacktrack(callId, options);
}
export function onBacktrack(pi: ExtensionAPI, handler: (event: { backtrackEntry: NativeBacktrackEntry }, ctx: ExtensionContext) => void): void {
  (pi as ExtensionAPI & { on(event: "session_backtrack", listener: typeof handler): void }).on("session_backtrack", handler);
}
