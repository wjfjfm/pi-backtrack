import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { compact, findCutPoint, prepareBranchEntries, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { messageKey } from "./context.js";
import { sourceNodes, type SourceNode } from "./projection.js";
import { BacktrackEngine, operations } from "./engine.js";

const FENCE = "backtrack:compaction-boundary:v1";
/** Virtual entries are local preparation input, never written as a second session. */
function virtualEntries(nodes: readonly SourceNode[]): SessionEntry[] {
  return nodes.map((node, index) => ({ type: "message", id: `effective:${index}`, parentId: index ? `effective:${index - 1}` : null,
    timestamp: new Date(node.message.timestamp).toISOString(), message: node.message }));
}

/** Only a suffix identical to the public raw context can be retained without policies. */
export function safeSuffixStart(effective: readonly SourceNode[], raw: readonly SourceNode[]): number {
  let left = effective.length - 1, right = raw.length - 1;
  while (left >= 0 && right >= 0 && effective[left]!.id === raw[right]!.id
    && messageKey(effective[left]!.message) === messageKey(raw[right]!.message)) { left--; right--; }
  return left + 1;
}

export async function compactEffective(
  pi: ExtensionAPI, engine: BacktrackEngine, event: SessionBeforeCompactEvent, ctx: ExtensionContext,
) {
  engine.assertCompatible(ctx);
  if (!operations(ctx).length) return;
  if (!ctx.model) throw new Error("No model selected for compaction.");
  const nodes = engine.nodes(ctx), raw = sourceNodes(ctx.sessionManager.buildContextEntries());
  const entries = virtualEntries(nodes);
  const settings = event.preparation.settings;
  const nativeCut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
  let cut = Math.max(nativeCut.firstKeptEntryIndex, safeSuffixStart(nodes, raw));
  // A safe suffix must also begin at a message boundary acceptable to the provider.
  while (cut < nodes.length && nodes[cut]!.message.role === "toolResult") cut++;
  if (cut <= 0) throw new Error("Nothing to compact in effective context.");
  const split = cut === nativeCut.firstKeptEntryIndex && nativeCut.isSplitTurn && nativeCut.turnStartIndex >= 0;
  const historyEnd = split ? nativeCut.turnStartIndex : cut;
  const fileOps = prepareBranchEntries(entries.slice(0, cut)).fileOps;
  for (const node of nodes.slice(0, cut)) {
    const entry = node.id ? ctx.sessionManager.getEntry(node.id) : undefined;
    if (entry?.type !== "compaction") continue;
    const details = entry.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
    for (const path of details?.readFiles ?? []) fileOps.read.add(path);
    for (const path of details?.modifiedFiles ?? []) fileOps.edited.add(path);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  const requestModel = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
  // Adapt the public registry completion API, retaining Pi's public summary generator.
  const stream: NonNullable<Parameters<typeof compact>[7]> = (model, context, options) => {
    const events = createAssistantMessageEventStream();
    void ctx.modelRegistry.complete(model, context, { ...options, ...(auth.headers ? { headers: auth.headers } : {}) }).then(message => {
      if (message.stopReason === "error" || message.stopReason === "aborted") events.push({ type: "error", reason: message.stopReason, error: message });
      else if (message.stopReason === "pending") throw new Error("Summary response is incomplete.");
      else events.push({ type: "done", reason: message.stopReason, message });
      events.end();
    }).catch(error => {
      events.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, stopReason: "error", errorMessage: String(error), timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      events.end();
    });
    return events;
  };
  const result = await compact({ settings, tokensBefore: prepareBranchEntries(entries).totalTokens,
    firstKeptEntryId: nodes[cut]?.id ?? "pending-boundary",
    messagesToSummarize: nodes.slice(0, historyEnd).map(node => node.message),
    turnPrefixMessages: split ? nodes.slice(historyEnd, cut).map(node => node.message) : [],
    isSplitTurn: split, fileOps,
  }, requestModel, auth.apiKey, undefined, event.customInstructions, event.signal, ctx.thinkingLevel, stream, auth.env);
  if (event.signal.aborted) throw new Error("Compaction cancelled");
  if (cut === nodes.length) {
    // Public compaction requires an existing firstKeptEntryId even for an empty raw tail.
    // One non-model entry supplies that boundary; a cancelled commit leaves a harmless fence.
    pi.appendEntry(FENCE, {});
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.type !== "custom" || leaf.customType !== FENCE) throw new Error("Compaction boundary was not saved.");
    result.firstKeptEntryId = leaf.id;
  }
  return { compaction: result };
}
