import { calculateContextTokens, compact, findCutPoint, prepareBranchEntries, shouldCompact, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { messageKey } from "./context.js";
import { completeBatchEnd, sourceNodes, type SourceNode } from "./projection.js";
import { BacktrackEngine, latestState, operations } from "./engine.js";
import { estimateRequestTokens } from "./usage.js";

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
  const folds = operations(ctx);
  if (!folds.length) return;
  if (!ctx.model) throw new Error("No model selected for compaction.");
  const nodes = engine.nodes(ctx), raw = sourceNodes(ctx.sessionManager.buildSessionProjection().entries);
  const settings = event.preparation.settings;
  if (event.reason === "threshold" && ctx.model.contextWindow > 0) {
    const branch = ctx.sessionManager.getBranch();
    const end = folds.map(({ policy }) => completeBatchEnd(branch, policy.assistantId)).filter(id => id !== undefined).at(-1);
    const at = end ? branch.findIndex(entry => entry.id === end) : -1;
    const freshUsage = branch.slice(at + 1).some(entry => entry.type === "message" && entry.message.role === "assistant"
      && !["error", "aborted"].includes(entry.message.stopReason) && calculateContextTokens(entry.message.usage) > 0);
    // The host checks its raw context before our request projection. Recheck only
    // stale pre-fold usage; manual/overflow and fresh provider measurements win.
    if (at >= 0 && !freshUsage) {
      const messages = [...nodes.map(node => node.message), ...latestState(ctx)?.checkpoints.map(point => point.marker) ?? []];
      if (!shouldCompact(estimateRequestTokens(messages, ctx, pi), ctx.model.contextWindow, settings)) return { cancel: true };
    }
  }
  const entries = virtualEntries(nodes);
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
  // ModelRuntime owns routing, credentials, headers and provider streams, including virtual models.
  const stream: NonNullable<Parameters<typeof compact>[7]> = (model, context, options) =>
    ctx.modelRegistry.streamSimple(model, context, options);
  const result = await compact({ settings, tokensBefore: prepareBranchEntries(entries).totalTokens,
    firstKeptEntryId: nodes[cut]?.id ?? "pending-boundary",
    messagesToSummarize: nodes.slice(0, historyEnd).map(node => node.message),
    turnPrefixMessages: split ? nodes.slice(historyEnd, cut).map(node => node.message) : [],
    isSplitTurn: split, fileOps,
  }, ctx.model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel, stream);
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
