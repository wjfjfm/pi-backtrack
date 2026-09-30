import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "./context.js";
import { STATE, POLICY, LEGACY_STATE, type BacktrackState, type Checkpoint, type BacktrackDetails, type BacktrackPolicy, type StoredState } from "./contracts.js";
import { storeState, restoreStates, isStateEntry } from "./state.js";
import { HISTORY_HEADER, historyBetween, renderHistory } from "./history.js";
import { applyFolds, bindSources, completeBatchEnd, sourceNodes, type FoldOperation, type SourceNode } from "./projection.js";
import { boundaryLocation } from "./render.js";
import { formatCount } from "./tokens.js";
import { estimateAfterFold } from "./usage.js";
import type { BacktrackArguments } from "./schema.js";

const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();
const baseOf = (ctx: ExtensionContext) => branchOf(ctx).findLast(e => e.type === "compaction")?.id ?? null;
export function policyOf(entry: SessionEntry): BacktrackPolicy | undefined {
  if (entry.type !== "custom" || entry.customType !== POLICY) return;
  const data = entry.data as BacktrackPolicy;
  if (!data || typeof data.assistantId !== "string" || !Array.isArray(data.messages) || !data.details?.state) throw new Error("Corrupt backtrack policy.");
  return data;
}
export function operations(ctx: ExtensionContext): FoldOperation[] {
  const branch = branchOf(ctx), base = branch.findLastIndex(e => e.type === "compaction");
  return branch.slice(base + 1).flatMap(entry => {
    const policy = policyOf(entry);
    return policy ? [{ id: entry.id, policy }] : [];
  });
}
/** Select as before, then follow explicit bases: a later batch completion cannot rebase a saved state. */
function stateRevision(ctx: ExtensionContext): { id: string; state: BacktrackState } | undefined {
  const branch = branchOf(ctx);
  const base = branch.findLastIndex(entry => entry.type === "compaction");
  const positions = new Map(branch.slice(base + 1).map((entry, i) => [entry.id, base + 1 + i]));
  const stored = (entry: SessionEntry): StoredState | undefined => {
    if (entry.type === "custom" && isStateEntry(entry)) return entry.data as StoredState;
    const policy = policyOf(entry);
    if (policy && completeBatchEnd(branch, policy.assistantId)) return { ...policy.details.state,
      cursor: policy.keepAfterId === undefined ? entry.id : policy.assistantId, lastTransaction: entry.id };
  };
  for (let i = branch.length - 1; i > base; i--) {
    let saved = stored(branch[i]!);
    if (!saved) continue;
    const id = branch[i]!.id, records = [saved];
    let position = i;
    while (saved.version === 3 && saved.parent !== null) {
      const parent = positions.get(saved.parent);
      if (parent === undefined || parent >= position) throw new Error("Missing backtrack checkpoint delta base.");
      saved = stored(branch[parent]!);
      if (!saved) throw new Error("Missing backtrack checkpoint delta base.");
      records.push(saved); position = parent;
    }
    return { id, state: restoreStates(records.reverse())! };
  }
}
export function latestState(ctx: ExtensionContext): BacktrackState | undefined {
  return stateRevision(ctx)?.state;
}

export class BacktrackEngine {
  constructor(private pi: ExtensionAPI) {}
  assertCompatible(ctx: ExtensionContext): void {
    const branch = branchOf(ctx);
    if (branch.some(e => e.type === "custom" && e.customType === LEGACY_STATE)) {
      throw new Error("Legacy backtrack view session: continue with the previous extension or start a new session. Automatic migration is not supported.");
    }
    if (branch.some(e => (e as { type: string }).type === "backtrack")) {
      throw new Error("Native backtrack session: continue with the previous host or start a new session. Automatic migration is not supported.");
    }
  }
  nodes(ctx: ExtensionContext, input?: ContextMessage[]): SourceNode[] {
    this.assertCompatible(ctx);
    const entries = ctx.sessionManager.buildSessionProjection().entries;
    return applyFolds(branchOf(ctx), input ? bindSources(entries, input) : sourceNodes(entries), operations(ctx));
  }
  private usage(ctx: ExtensionContext) {
    const branch = branchOf(ctx), last = operations(ctx).at(-1);
    if (last) {
      const end = completeBatchEnd(branch, last.policy.assistantId);
      const at = branch.findIndex(e => e.id === end);
      if (at >= 0 && !branch.slice(at + 1).some(e => e.type === "message" && e.message.role === "assistant"
        && !["error", "aborted"].includes(e.message.stopReason))) return;
    }
    return ctx.getContextUsage();
  }
  private checkpoint(ctx: ExtensionContext, state: BacktrackState, boundary: string | null, historyBoundary = boundary, zero = false): void {
    const id = zero ? 0 : state.next++;
    if (!Number.isSafeInteger(id)) throw new Error("Checkpoint number exhausted.");
    const nativeUsage = zero ? undefined : this.usage(ctx), tokens = nativeUsage?.tokens ?? null;
    const window = nativeUsage?.contextWindow;
    const usage = tokens === null || !window ? "unknown" : `${formatCount(tokens)}/${formatCount(window)} ${Math.round(nativeUsage!.percent ?? tokens / window * 100)}%`;
    state.checkpoints.push({ id, boundary, historyBoundary, tokens, marker: {
      role: "custom", customType: "backtrack:checkpoint", content: `backtrack-checkpoint ${id} context ${usage}`, display: false, timestamp: 0,
      details: { epoch: state.epoch, id, boundary, accuracy: tokens === null ? "unknown" : "estimated" },
    } });
  }
  sync(ctx: ExtensionContext): BacktrackState {
    const nodes = this.nodes(ctx).filter(node => !(node.message.role === "assistant" && ["error", "aborted"].includes(node.message.stopReason)));
    const branch = branchOf(ctx);
    const revision = stateRevision(ctx);
    let state = revision?.state;
    const previous = revision && structuredClone(revision);
    const before = JSON.stringify(state);
    if (!state) {
      const firstUser = nodes.findIndex(node => node.message.role === "user");
      const prefix = nodes.slice(0, firstUser < 0 ? nodes.length : firstUser);
      const boundary = prefix.at(-1)?.id ?? null;
      const rawIndex = firstUser < 0 ? -1 : branch.findIndex(e => e.id === nodes[firstUser]!.id);
      const historyBoundary = rawIndex < 0 ? boundary : branch.slice(0, rawIndex).findLast(e => e.type !== "label")?.id ?? null;
      state = { version: 2, epoch: randomUUID(), base: baseOf(ctx), next: 1, cursor: boundary, checkpoints: [] };
      this.checkpoint(ctx, state, boundary, historyBoundary, true);
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      const old = entry.type === "custom" && isStateEntry(entry) ? entry.data as StoredState : policyOf(entry)?.details.state;
      if (old?.epoch === state.epoch) state.next = Math.max(state.next, old.next);
    }
    const visible = new Set(nodes.map(node => node.id));
    state.checkpoints = state.checkpoints.filter(c => c.boundary === null || visible.has(c.boundary));
    const cursorIndex = state.cursor === null ? -1 : nodes.findLastIndex(node => node.id === state.cursor);
    if (state.cursor !== null && cursorIndex < 0) throw new Error("Checkpoint cursor is not in effective context.");
    let start = cursorIndex + 1;
    const reduction = branch.find(e => e.id === state!.lastTransaction);
    const policy = reduction && policyOf(reduction);
    if (policy && policy.keepAfterId === undefined && reduction && !state.usage) {
      let boundary = reduction.id;
      while (nodes[start]?.message.role === "custom") boundary = nodes[start++]!.id!;
      this.checkpoint(ctx, state, boundary, completeBatchEnd(branch, policy.assistantId)!);
    }
    const pending = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const { message } = nodes[i]!;
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
      const hadPending = pending.size > 0;
      if (message.role === "toolResult") pending.delete(message.toolCallId);
      if (i < start || pending.size || !(message.role === "user" || (message.role === "toolResult" && hadPending))) continue;
      while (nodes[i + 1]?.message.role === "custom") i++;
      const boundary = nodes[i]!.id;
      if (!state.checkpoints.some(c => c.boundary === boundary)) this.checkpoint(ctx, state, boundary);
    }
    if (policy && !state.usage) {
      const target = state.checkpoints.find(point => point.id === policy.details.target)!;
      state.usage = { before: policy.details.before, after: estimateAfterFold(nodes, target, state.checkpoints, ctx, this.pi),
        afterEstimated: true, ...(ctx.model ? { window: ctx.model.contextWindow } : {}) };
    }
    state.cursor = nodes.at(-1)?.id ?? null;
    if (before !== JSON.stringify(state)) this.pi.appendEntry(STATE, storeState(state, previous));
    return state;
  }
  project(ctx: ExtensionContext, input: ContextMessage[]): ContextMessage[] {
    const state = this.sync(ctx), nodes = this.nodes(ctx, input);
    const anchors = new Map<string, number>();
    nodes.forEach((node, i) => { if (node.id !== null) anchors.set(node.id, i); });
    const first = nodes.findIndex(node => node.id !== null);
    const after = new Map<number, ContextMessage[]>();
    for (const checkpoint of state.checkpoints) {
      const index = checkpoint.boundary === null ? (first < 0 ? nodes.length : first) - 1 : anchors.get(checkpoint.boundary);
      if (index === undefined) continue;
      after.set(index, [...after.get(index) ?? [], checkpoint.marker]);
    }
    return structuredClone([...(after.get(-1) ?? []), ...nodes.flatMap((node, index) => [node.message, ...after.get(index) ?? []])]);
  }
  validate(ctx: ExtensionContext, checkpoint: number): { state: BacktrackState; target: Checkpoint; revision: string } {
    this.assertCompatible(ctx);
    const saved = stateRevision(ctx), state = saved?.state;
    if (!state || state.base !== baseOf(ctx)) throw new Error("No current checkpoints. Use a checkpoint shown in the current context.");
    const target = state.checkpoints.find(c => c.id === checkpoint);
    if (!target || (target.boundary !== null && !this.nodes(ctx).some(node => node.id === target.boundary))) throw new Error(`Checkpoint ${checkpoint} is not active on this path.`);
    return { state, target, revision: saved!.id };
  }
  register(ctx: ExtensionContext, callId: string, args: BacktrackArguments): void {
    const { state, target, revision } = this.validate(ctx, args.checkpoint);
    const previous = { id: revision, state: structuredClone(state) };
    const branch = branchOf(ctx), nodes = this.nodes(ctx);
    const assistant = branch.findLast(e => e.type === "message" && e.message.role === "assistant");
    if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Missing tool-calling assistant message.");
    const calls = assistant.message.content.filter(part => part.type === "toolCall").filter(part => part.name === "backtrack");
    if (calls.length !== 1 || calls[0]!.id !== callId) throw new Error("Only one backtrack is allowed per tool batch.");
    if (operations(ctx).some(op => op.policy.assistantId === assistant.id)) throw new Error("Backtrack is already registered for this tool batch.");
    let keepAfterId: string | undefined, end = assistant.id;
    if (args.keep_after_checkpoint !== undefined) {
      const tail = this.validate(ctx, args.keep_after_checkpoint).target;
      const left = target.boundary === null ? -1 : nodes.findLastIndex(n => n.id === target.boundary);
      const right = tail.boundary === null ? -1 : nodes.findLastIndex(n => n.id === tail.boundary);
      if (right <= left) throw new Error("keep_after_checkpoint must follow checkpoint in the effective context.");
      if (nodes.findLastIndex(n => n.id === assistant.id) <= right) throw new Error("The retained tail must include the current tool call.");
      keepAfterId = tail.boundary!; end = tail.historyBoundary ?? keepAfterId;
      state.checkpoints = state.checkpoints.filter(c => c.id <= target.id || c.id > tail.id);
      state.cursor = assistant.id;
    } else {
      state.checkpoints = state.checkpoints.slice(0, state.checkpoints.indexOf(target) + 1);
      if (target.id === 0) {
        state.epoch = randomUUID(); state.next = 1;
        target.marker.details = { ...target.marker.details as object, epoch: state.epoch };
      }
    }
    delete state.usage;
    const history = renderHistory(historyBetween(branch, target.historyBoundary, end));
    const messages: BacktrackPolicy["messages"] = [];
    if (history.content.length) {
      history.content = [{ type: "text", text: HISTORY_HEADER }, ...(typeof history.content === "string" ? [{ type: "text" as const, text: history.content }] : history.content)];
      messages.push(history);
    }
    if (args.keep_after_checkpoint === undefined) messages.push({ role: "custom", customType: "backtrack:continuation", content: `[Backtrack message — agent handoff]\n${args.message ?? ""}`, display: true, timestamp: 0 });
    const details: BacktrackDetails = { kind: "backtrack:v2", callId, target: args.checkpoint,
      ...(args.keep_after_checkpoint === undefined ? {} : { keepAfter: args.keep_after_checkpoint }),
      location: boundaryLocation(branch, target.boundary, target.id), before: this.usage(ctx)?.tokens ?? null, state: storeState(state, previous) };
    this.pi.appendEntry(POLICY, { anchorId: target.boundary, assistantId: assistant.id, ...(keepAfterId ? { keepAfterId } : {}), messages, details } satisfies BacktrackPolicy);
  }
}
