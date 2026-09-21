import { randomUUID } from "node:crypto";
import { sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageKey, type ContextMessage } from "./context.js";
import { STATE, LEGACY_STATE, type BacktrackState, type Checkpoint, type BacktrackDetails } from "./contracts.js";
import { HISTORY_HEADER, historyBetween, renderHistory } from "./history.js";
import { nativeContext, type NativeEntry, type BacktrackOptions, type ReplacementMessage } from "./native.js";
import { boundaryLocation } from "./render.js";
import { estimateMessages, formatCount } from "./tokens.js";
import type { BacktrackArguments } from "./schema.js";

const branchOf = (ctx: ExtensionContext): NativeEntry[] => ctx.sessionManager.getBranch();
const effective = (ctx: ExtensionContext): NativeEntry[] => ctx.sessionManager.buildContextEntries();
const baseOf = (ctx: ExtensionContext) => branchOf(ctx).findLast(e => e.type === "compaction")?.id ?? null;
const messagesOf = (entry: NativeEntry): ContextMessage[] => entry.type === "backtrack" ? entry.messages : sessionEntryToContextMessages(entry);
const nodesOf = (ctx: ExtensionContext) => effective(ctx).flatMap(entry => messagesOf(entry).map(message => ({ id: entry.id, message })))
  .filter(({ message }) => !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")));
export function backtrackDetails(entry: NativeEntry): BacktrackDetails | undefined {
  if (entry.type !== "backtrack") return;
  const details = entry.details as BacktrackDetails | undefined;
  return details?.kind === "backtrack:v2" ? details : undefined;
}

/** Only checkpoint metadata is restored here. Native context is never reconstructed by this extension. */
export function latestState(ctx: ExtensionContext): BacktrackState | undefined {
  for (const entry of branchOf(ctx).toReversed()) {
    if (entry.type === "compaction") return;
    if (entry.type === "custom" && entry.customType === STATE) {
      const state = entry.data as BacktrackState;
      if (state.version !== 2 || !Array.isArray(state.checkpoints)) throw new Error("Corrupt backtrack checkpoint state.");
      return structuredClone(state);
    }
    const details = backtrackDetails(entry);
    if (entry.type === "backtrack" && !details) return;
    if (details) {
      const state = structuredClone(details.state);
      if (details.keepAfter === undefined) state.cursor = entry.id;
      state.lastTransaction = entry.id;
      return state;
    }
  }
}

export class BacktrackEngine {
  constructor(private pi: ExtensionAPI) {}
  assertCompatible(ctx: ExtensionContext): void {
    // A v1 view may hide arbitrary raw entries. Never silently discard that projection.
    if (branchOf(ctx).some(e => e.type === "custom" && e.customType === LEGACY_STATE)) {
      throw new Error("Legacy backtrack view session: continue with the previous extension or start a new session. Automatic migration is not supported.");
    }
  }
  private estimate(ctx: ExtensionContext, messages: ContextMessage[]): number {
    const active = this.pi.getActiveTools?.();
    const tools = this.pi.getAllTools().filter(tool => !active || active.includes(tool.name));
    return estimateMessages(messages, ctx.getSystemPrompt(), JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
  }
  private checkpoint(ctx: ExtensionContext, state: BacktrackState, boundary: string | null, historyBoundary = boundary, zero = false): void {
    const id = zero ? 0 : state.next++;
    if (!Number.isSafeInteger(id)) throw new Error("Checkpoint number exhausted.");
    const tokens = zero ? null : this.estimate(ctx, nativeContext(ctx));
    const window = ctx.model?.contextWindow;
    const usage = tokens === null || !window ? "unknown" : `${formatCount(tokens)}/${formatCount(window)} ${Math.round(tokens / window * 100)}%`;
    state.checkpoints.push({ id, boundary, historyBoundary, marker: {
      role: "custom", customType: "backtrack:checkpoint", content: `backtrack-checkpoint ${id} context ${usage}`, display: false, timestamp: 0,
      details: { epoch: state.epoch, id, boundary, accuracy: tokens === null ? "unknown" : "estimated" },
    } });
  }
  sync(ctx: ExtensionContext): BacktrackState {
    this.assertCompatible(ctx);
    const nodes = nodesOf(ctx), entries = effective(ctx), branch = branchOf(ctx);
    let state = latestState(ctx);
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
    // /tree must not recycle an ID already issued on another path in this epoch.
    for (const entry of ctx.sessionManager.getEntries() as NativeEntry[]) {
      const old = entry.type === "custom" && entry.customType === STATE ? entry.data as BacktrackState : backtrackDetails(entry)?.state;
      if (old?.epoch === state.epoch) state.next = Math.max(state.next, old.next);
    }
    const visible = new Set(entries.map(e => e.id));
    state.checkpoints = state.checkpoints.filter(c => c.boundary === null || visible.has(c.boundary));
    const cursorIndex = state.cursor === null ? -1 : entries.findIndex(e => e.id === state.cursor);
    if (state.cursor !== null && cursorIndex < 0) throw new Error("Checkpoint cursor is not in native effective context.");
    let start = state.cursor === null ? 0 : nodes.findIndex(n => entries.findIndex(e => e.id === n.id) > cursorIndex);
    if (start < 0) start = nodes.length;
    const reduction = branch.findLast(e => e.id === state!.lastTransaction);
    const details = reduction && backtrackDetails(reduction);
    if (details && details.keepAfter === undefined && reduction && !state.usage) {
      // Anchor the continuation before later conversation, including only adjacent observer messages.
      let boundary = reduction.id;
      while (nodes[start]?.message.role === "custom") boundary = nodes[start++]!.id;
      this.checkpoint(ctx, state, boundary, reduction.id);
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
    if (details && !state.usage) {
      state.usage = { before: details.before, after: this.estimate(ctx, nativeContext(ctx)), ...(ctx.model ? { window: ctx.model.contextWindow } : {}) };
    }
    state.cursor = nodes.at(-1)?.id ?? null;
    if (before !== JSON.stringify(state)) this.pi.appendEntry(STATE, structuredClone(state));
    return state;
  }
  /** Annotate the received native context; never replace, reorder or reinsert its messages. */
  project(ctx: ExtensionContext, input: ContextMessage[]): ContextMessage[] {
    const state = this.sync(ctx);
    const queues = new Map<string, string[]>();
    for (const { id, message } of nodesOf(ctx)) {
      const key = messageKey(message);
      queues.set(key, [...queues.get(key) ?? [], id]);
    }
    const anchors = new Map<string, number>();
    let first = -1;
    input.forEach((message, index) => {
      const id = queues.get(messageKey(message))?.shift();
      if (id !== undefined) { anchors.set(id, index); if (first < 0) first = index; }
    });
    const after = new Map<number, ReplacementMessage[]>();
    for (const checkpoint of state.checkpoints) {
      const index = checkpoint.boundary === null ? (first < 0 ? input.length : first) - 1 : anchors.get(checkpoint.boundary);
      if (index === undefined) continue;
      after.set(index, [...after.get(index) ?? [], checkpoint.marker]);
    }
    return structuredClone([...(after.get(-1) ?? []), ...input.flatMap((message, index) => [message, ...after.get(index) ?? []])]);
  }
  validate(ctx: ExtensionContext, checkpoint: number): { state: BacktrackState; target: Checkpoint } {
    this.assertCompatible(ctx);
    const state = latestState(ctx);
    if (!state || state.base !== baseOf(ctx)) throw new Error("No current checkpoints. Use a checkpoint shown in the current context.");
    const target = state.checkpoints.find(c => c.id === checkpoint);
    if (!target || (target.boundary !== null && !effective(ctx).some(e => e.id === target.boundary))) throw new Error(`Checkpoint ${checkpoint} is not active on this path.`);
    return { state, target };
  }
  prepare(ctx: ExtensionContext, callId: string, args: BacktrackArguments): BacktrackOptions {
    const { state, target } = this.validate(ctx, args.checkpoint);
    const branch = branchOf(ctx), entries = effective(ctx);
    const assistant = branch.findLast(e => e.type === "message" && e.message.role === "assistant");
    if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Missing tool-calling assistant message.");
    let firstKeptEntryId: string | undefined;
    let end = assistant.id;
    if (args.keep_after_checkpoint !== undefined) {
      const tail = this.validate(ctx, args.keep_after_checkpoint).target;
      const left = target.boundary === null ? -1 : entries.findIndex(e => e.id === target.boundary);
      const right = tail.boundary === null ? -1 : entries.findIndex(e => e.id === tail.boundary);
      if (right <= left) throw new Error("keep_after_checkpoint must follow checkpoint in the effective context.");
      firstKeptEntryId = entries[right + 1]?.id;
      if (!firstKeptEntryId || entries.findIndex(e => e.id === assistant.id) <= right) throw new Error("The retained tail must include the current tool call.");
      end = tail.historyBoundary ?? tail.boundary!;
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
    const history = renderHistory(historyBetween(branch as SessionEntry[], target.historyBoundary, end));
    const messages: ReplacementMessage[] = [];
    if (history.content.length) {
      history.content = [{ type: "text", text: HISTORY_HEADER }, ...(typeof history.content === "string" ? [{ type: "text" as const, text: history.content }] : history.content)];
      messages.push(history);
    }
    if (args.keep_after_checkpoint === undefined) messages.push({ role: "custom", customType: "backtrack:continuation", content: `[Backtrack message — agent handoff]\n${args.message ?? ""}`, display: true, timestamp: 0 });
    const details: BacktrackDetails = { kind: "backtrack:v2", callId, target: args.checkpoint,
      ...(args.keep_after_checkpoint === undefined ? {} : { keepAfter: args.keep_after_checkpoint }),
      location: boundaryLocation(branch as SessionEntry[], target.boundary, target.id), before: this.estimate(ctx, nativeContext(ctx)), state };
    return { keepThroughEntryId: target.boundary, ...(firstKeptEntryId ? { firstKeptEntryId } : {}), messages, details };
  }
}
