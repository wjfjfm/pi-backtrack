import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageKey, type ContextMessage } from "./context.js";

/** A policy is an independent tool side effect, not a transaction over sibling tools. */
export interface FoldPolicy {
  anchorId: string | null;
  assistantId: string;
  keepAfterId?: string;
  /** Preserve the actual backtrack call/result instead of injecting custom user messages. */
  retainCall?: boolean;
  messages: Extract<ContextMessage, { role: "custom" }>[];
}
export interface FoldOperation { id: string; policy: FoldPolicy }
export interface SourceNode { id: string | null; message: ContextMessage }

/** Ephemeral provenance. No full view or message bodies are persisted here. */
export function sourceNodes(entries: readonly ProjectedSessionEntry[]): SourceNode[] {
  // Pi owns system/tool loadout replay and native context edits. Neither is a foldable conversation entry.
  return entries.flatMap(entry => entry.messages.filter(message => message.role !== "system")
    .map(message => ({ id: entry.sourceEntry.id, message })));
}

/** Associate cloned request messages by occurrence, not by content-set membership. */
export function bindSources(entries: readonly ProjectedSessionEntry[], messages: readonly ContextMessage[]): SourceNode[] {
  const queues = new Map<string, SourceNode[]>();
  for (const node of sourceNodes(entries)) {
    const key = messageKey(node.message);
    const queue = queues.get(key);
    if (queue) queue.push(node); else queues.set(key, [node]);
  }
  return messages.map(message => ({ id: queues.get(messageKey(message))?.shift()?.id ?? null, message }));
}

/** A later assistant cannot complete a cancelled/incomplete earlier batch. */
export function completeBatchEnd(branch: readonly SessionEntry[], assistantId: string): string | undefined {
  const at = branch.findIndex(entry => entry.id === assistantId);
  const caller = branch[at];
  if (caller?.type !== "message" || caller.message.role !== "assistant") return;
  const calls = caller.message.content.filter(part => part.type === "toolCall");
  if (!calls.length || new Set(calls.map(call => call.id)).size !== calls.length) return;
  const next = branch.findIndex((entry, index) => index > at && entry.type === "message" && entry.message.role === "assistant");
  const results = branch.slice(at + 1, next < 0 ? undefined : next).flatMap(entry =>
    entry.type === "message" && entry.message.role === "toolResult" ? [{ id: entry.id, message: entry.message }] : []);
  if (results.length !== calls.length || calls.some(call => results.filter(result =>
    result.message.toolCallId === call.id && result.message.toolName === call.name).length !== 1)) return;
  // Errors are complete results too. They do not roll back an independent policy.
  return results.at(-1)?.id;
}

/** Keep the real call unchanged, but not sibling calls or discarded reasoning. */
export function backtrackPair(branch: readonly SessionEntry[], policy: FoldPolicy): [
  { id: string; message: Extract<ContextMessage, { role: "assistant" }> },
  { id: string; message: Extract<ContextMessage, { role: "toolResult" }> },
] {
  const caller = branch.find(entry => entry.id === policy.assistantId);
  if (caller?.type !== "message" || caller.message.role !== "assistant") throw new Error("Missing backtrack caller.");
  const call = caller.message.content.find(part => part.type === "toolCall" && part.name === "backtrack");
  if (call?.type !== "toolCall") throw new Error("Missing backtrack call.");
  const end = completeBatchEnd(branch, policy.assistantId);
  const batch = branch.slice(branch.indexOf(caller) + 1, branch.findIndex(entry => entry.id === end) + 1);
  const result = batch.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
  if (result?.type !== "message" || result.message.role !== "toolResult") throw new Error("Missing backtrack result.");
  return [{ id: caller.id, message: { ...caller.message, content: [call] } }, { id: result.id, message: result.message }];
}

/** One reducer for ordinary requests and compaction preparation. */
export function applyFolds(
  branch: readonly SessionEntry[], input: readonly SourceNode[], operations: readonly FoldOperation[],
): SourceNode[] {
  let nodes = [...input];
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  for (const { id, policy } of operations) {
    const end = completeBatchEnd(branch, policy.assistantId);
    if (!end) continue;
    const left = policy.anchorId === null ? -1 : nodes.findLastIndex(node => node.id === policy.anchorId);
    if (policy.anchorId !== null && left < 0) throw new Error("Backtrack anchor is not in effective context.");
    const endIndex = positions.get(end)!;
    // Interrupted native publication may already have omitted sibling results.
    const finish = policy.retainCall ? nodes.findLastIndex(node => {
      const position = node.id === null ? undefined : positions.get(node.id);
      return position !== undefined && position >= positions.get(policy.assistantId)! && position <= endIndex;
    }) : nodes.findLastIndex(node => node.id === end);
    const right = policy.keepAfterId === undefined ? finish : nodes.findLastIndex(node => node.id === policy.keepAfterId);
    if (right <= left || finish < right || (policy.keepAfterId !== undefined && finish === right)) {
      throw new Error("Backtrack interval is not in effective context.");
    }
    // Never delete unrelated request-local additions whose provenance we do not own.
    const foreign = nodes.slice(left + 1, right + 1).filter(node => node.id === null);
    const replacement = policy.retainCall && policy.keepAfterId === undefined ? backtrackPair(branch, policy)
      : policy.messages.map(message => ({ id, message }));
    nodes = [...nodes.slice(0, left + 1), ...replacement, ...foreign, ...nodes.slice(right + 1)];
  }
  return nodes;
}
