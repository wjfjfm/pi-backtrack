import { randomUUID } from "node:crypto";
import { buildSessionContext, sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { DYNAMIC_CONTEXT, messageKey, skillContextService, type ContextMessage } from "./context.js";
import { BLOCK, STATE, REQUEST, CANCELLED, COMPACT_BOUNDARY, type BacktrackState, type Checkpoint, type PreparedBacktrack } from "./contracts.js";
import { HISTORY_HEADER, historyBetween, renderHistory } from "./history.js";
import { estimateMessages, formatCount } from "./tokens.js";

const isMarker = (message: ContextMessage) => message.role === "custom" && message.customType === "backtrack:checkpoint";
const compactionId = (branch: SessionEntry[]) => branch.findLast((entry) => entry.type === "compaction")?.id ?? null;
const isSource = (message: ContextMessage) => !isMarker(message)
  && !(message.role === "custom" && message.customType === DYNAMIC_CONTEXT)
  && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
const sources = (ctx: ExtensionContext) => ctx.sessionManager.buildContextEntries()
  .flatMap((entry) => sessionEntryToContextMessages(entry).filter(isSource).map((message) => ({ id: entry.id, message })));

export function latestState(ctx: ExtensionContext): BacktrackState | undefined {
  const branch = ctx.sessionManager.getBranch();
  const entry = branch.findLast((item) => item.type === "custom" && item.customType === STATE);
  if (entry?.type !== "custom") return;
  const data = entry.data as BacktrackState;
  if (data.version !== 1 || !Array.isArray(data.view) || !Array.isArray(data.checkpoints)) throw new Error("Unsupported or corrupt backtrack state.");
  // Upgrade old fingerprint snapshots by their position in the source path.
  // No old messages or records need rewriting, and no request equality test is needed.
  let cursor = data.cursor;
  if (!("cursor" in data)) {
    const preceding = new Set(branch.slice(0, branch.indexOf(entry)).map((item) => item.id));
    cursor = sources(ctx).findLast((node) => preceding.has(node.id))?.id ?? null;
  }
  const { epoch, base, next, view, checkpoints, lastTransaction } = data;
  return structuredClone({ version: 1, epoch, base, next, cursor, view, checkpoints,
    ...(lastTransaction ? { lastTransaction } : {}) });
}

export class BacktrackEngine {
  commitStarted = false;
  constructor(private pi: ExtensionAPI) {}
  private append(ctx: ExtensionContext, type: string, data: unknown): string {
    this.pi.appendEntry(type, structuredClone(data));
    const id = ctx.sessionManager.getLeafId();
    if (!id) throw new Error("Host did not persist the backtrack record.");
    return id;
  }
  private block(ctx: ExtensionContext, message: ContextMessage): string { return this.append(ctx, BLOCK, { message }); }
  messages(ctx: ExtensionContext, state: BacktrackState): ContextMessage[] {
    return structuredClone(state.view.flatMap((id) => {
      const entry = ctx.sessionManager.getEntry(id);
      if (!entry) throw new Error(`Backtrack context references missing entry ${id}.`);
      if (entry.type === "custom" && entry.customType === BLOCK) return [(entry.data as { message: ContextMessage }).message];
      return sessionEntryToContextMessages(entry);
    }));
  }
  private skills(ctx: ExtensionContext, state: BacktrackState): void {
    const service = skillContextService(this.pi);
    if (!service) return;
    const messages = this.messages(ctx, state);
    const refs = new Map<string, string[]>();
    messages.forEach((message, i) => {
      const key = messageKey(message);
      refs.set(key, [...refs.get(key) ?? [], state.view[i]!]);
    });
    state.view = service.project(ctx, messages).map((message) =>
      refs.get(messageKey(message))?.shift() ?? this.block(ctx, message));
  }
  private checkpoint(ctx: ExtensionContext, state: BacktrackState, boundary: string | null, zero = false): void {
    if (!zero) this.skills(ctx, state);
    const id = zero ? 0 : state.next++;
    if (!Number.isSafeInteger(id)) throw new Error("Checkpoint number exhausted.");
    const window = ctx.model?.contextWindow;
    const active = this.pi.getActiveTools?.();
    const tools = this.pi.getAllTools().filter((tool) => !active || active.includes(tool.name));
    const tokens = zero ? null : estimateMessages(this.messages(ctx, state), ctx.getSystemPrompt(),
      JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    const usage = tokens === null || !window ? "unknown" : `${formatCount(tokens)}/${formatCount(window)} ${Math.round(tokens / window * 100)}%`;
    const message: ContextMessage = { role: "custom", customType: "backtrack:checkpoint", content: `[checkpoint ${id} | context ${usage}]`, display: false, timestamp: 0,
      details: { epoch: state.epoch, id, boundary, accuracy: tokens === null ? "unknown" : "estimated" } };
    const ref = this.block(ctx, message);
    state.view.push(ref);
    state.checkpoints.push({ id, ref, boundary });
  }
  private save(ctx: ExtensionContext, state: BacktrackState): void { this.append(ctx, STATE, state); }

  /** Consume source nodes once. Never compare an extension projection with raw history. */
  sync(ctx: ExtensionContext): BacktrackState {
    const nodes = sources(ctx);
    const branch = ctx.sessionManager.getBranch();
    const base = compactionId(branch);
    let state = latestState(ctx);
    const reset = !state || state.base !== base;
    if (reset) {
      const firstUser = nodes.findIndex((node) => node.message.role === "user");
      const prefix = nodes.slice(0, firstUser < 0 ? nodes.length : firstUser);
      state = { version: 1, epoch: randomUUID(), base, next: 1, cursor: prefix.at(-1)?.id ?? null,
        view: prefix.map((node) => node.id), checkpoints: [] };
      // Native compaction can place a summary before a retained tail whose raw
      // entries precede that summary. History boundaries use raw node positions.
      const firstSource = firstUser < 0 ? -1 : branch.findIndex((entry) => entry.id === nodes[firstUser]!.id);
      const boundary = firstSource < 0 ? base : branch.slice(0, firstSource).findLast((entry) => entry.type !== "label")?.id ?? null;
      this.checkpoint(ctx, state, boundary, true);
    }
    if (!state) throw new Error("Failed to initialize context.");
    const start = state.cursor === null ? 0 : nodes.findIndex((node) => node.id === state.cursor) + 1;
    if (state.cursor !== null && start === 0) throw new Error(`Source node ${state.cursor} is not on the current context path.`);
    const before = JSON.stringify(state);
    // Navigating an older path must not reuse numbers already allocated in this epoch.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE) {
        const old = entry.data as BacktrackState;
        if (old.epoch === state.epoch) state.next = Math.max(state.next, old.next);
      }
    }
    const pending = new Set<string>();
    const cancelled = new Set(branch.flatMap((entry) => entry.type === "custom" && entry.customType === CANCELLED
      ? [(entry.data as { id: string }).id] : []));
    const abandoned = new Map(branch.flatMap((entry) => entry.type === "custom" && entry.customType === REQUEST
      && cancelled.has((entry.data as PreparedBacktrack).id)
      ? [[(entry.data as PreparedBacktrack).assistantId, (entry.data as PreparedBacktrack).callId] as const] : []));
    for (let i = 0; i < nodes.length; i++) {
      const { id, message } = nodes[i]!;
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
      const abandonedCall = abandoned.get(id);
      const nextAssistant = abandonedCall ? nodes.findIndex((node, index) => index > i && node.message.role === "assistant") : -1;
      const needsRecovery = abandonedCall && !nodes.slice(i + 1, nextAssistant < 0 ? undefined : nextAssistant)
        .some(({ message: item }) => item.role === "toolResult" && item.toolCallId === abandonedCall);
      if (needsRecovery) pending.delete(abandonedCall);
      const hadPending = pending.size > 0;
      if (message.role === "toolResult") pending.delete(message.toolCallId);
      if (i < start) continue;
      state.view.push(id);
      if (needsRecovery && abandonedCall) state.view.push(this.block(ctx, { role: "toolResult", toolName: "backtrack", toolCallId: abandonedCall,
        isError: true, timestamp: 0, content: [{ type: "text", text: "Interrupted backtrack was cancelled during session recovery; it was not replayed." }] }));
      if (!pending.size && (message.role === "user" || (message.role === "toolResult" && hadPending))) this.checkpoint(ctx, state, id);
    }
    state.cursor = nodes.at(-1)?.id ?? null;
    this.skills(ctx, state);
    if (reset && base && state.checkpoints.length === 1) this.checkpoint(ctx, state, base);
    if (reset || before !== JSON.stringify(state)) this.save(ctx, state);
    return state;
  }
  recoverFailure(ctx: ExtensionContext, transactionId: string, reason: string): void {
    const branch = ctx.sessionManager.getBranch();
    const notices = new Set(branch.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== BLOCK) return [];
      const message = (entry.data as { message: ContextMessage }).message;
      return message.role === "custom" && message.customType === "backtrack:commit-failed"
        && (message.details as { transactionId?: string } | undefined)?.transactionId === transactionId ? [entry.id] : [];
    }));
    // A block alone is not a committed notice. A saved view must reference it.
    // Once compacted, the status belongs to the summary, not another injection.
    if (branch.some((entry) => entry.type === "custom" && entry.customType === STATE
      && (entry.data as BacktrackState).view.some((id) => notices.has(id)))) return;
    const state = this.sync(ctx);
    state.view.push(this.block(ctx, { role: "custom", customType: "backtrack:commit-failed", display: true, timestamp: 0,
      details: { transactionId },
      content: `[Backtrack recovery — host status]\nThe previous backtrack commit did not finish cleanly: ${reason}. Resuming from the last persisted effective context without replay. Partial changes may remain; no rollback of files or external actions is implied.` }));
    this.save(ctx, state);
  }
  current(ctx: ExtensionContext): ContextMessage[] {
    const state = latestState(ctx);
    return state && state.base === compactionId(ctx.sessionManager.getBranch()) ? this.messages(ctx, state)
      : structuredClone(buildSessionContext(ctx.sessionManager.getBranch()).messages);
  }
  project(ctx: ExtensionContext, input: ContextMessage[]): ContextMessage[] {
    const state = this.sync(ctx);
    // Earlier context hooks may inject messages without persisting them. Keep
    // those request-local additions outside the source cursor. Interior additions
    // follow their preceding source node; prefix/suffix additions remain at the edges.
    const queues = new Map<string, string[]>();
    for (const node of sources(ctx)) {
      const key = messageKey(node.message);
      queues.set(key, [...queues.get(key) ?? [], node.id]);
    }
    // Fingerprint-era snapshots may contain captured request-local custom
    // messages. Recognize those existing blocks instead of injecting them twice;
    // keep the saved prefix and its immutable references intact.
    for (const id of state.view) {
      const entry = ctx.sessionManager.getEntry(id);
      if (entry?.type !== "custom" || entry.customType !== BLOCK) continue;
      const message = (entry.data as { message: ContextMessage }).message;
      if (message.role !== "custom" || !isSource(message) || message.customType.startsWith("backtrack:")) continue;
      const key = messageKey(message);
      queues.set(key, [...queues.get(key) ?? [], id]);
    }
    const received = new Map<string, ContextMessage>();
    const after = new Map<string, ContextMessage[]>();
    const prefix: ContextMessage[] = [];
    let previous: string | undefined, additions: ContextMessage[] = [];
    for (const message of input.filter(isSource)) {
      const id = queues.get(messageKey(message))?.shift();
      if (!id) { additions.push(message); continue; }
      if (previous) after.set(previous, additions);
      else prefix.push(...additions);
      additions = [];
      received.set(id, message);
      previous = id;
    }
    if (!previous) { prefix.push(...additions); additions = []; }
    const managed = this.messages(ctx, state);
    const view = [...prefix, ...state.view.flatMap((id, i) => {
      const message = ctx.sessionManager.getEntry(id)?.type === "custom" ? managed[i] : received.get(id);
      return message ? [message, ...after.get(id) ?? []] : [];
    }), ...additions];
    skillContextService(this.pi)?.shown(ctx, view);
    return structuredClone(view);
  }
  validate(ctx: ExtensionContext, checkpoint: number): { state: BacktrackState; target: Checkpoint } {
    const state = latestState(ctx);
    if (!state || state.base !== compactionId(ctx.sessionManager.getBranch())) throw new Error("No current checkpoints. Use a checkpoint shown in the current context.");
    const target = state.checkpoints.find((item) => item.id === checkpoint);
    if (!target || !state.view.includes(target.ref)) throw new Error(`Checkpoint ${checkpoint} is not active on this path.`);
    return { state, target };
  }
  apply(ctx: ExtensionContext, request: PreparedBacktrack): void {
    this.commitStarted = false;
    const { state, target } = this.validate(ctx, request.target);
    if (state.epoch !== request.epoch) throw new Error("Checkpoint belongs to a previous epoch.");
    if (state.lastTransaction === request.id) throw new Error("Backtrack transaction already completed.");
    const branch = ctx.sessionManager.getBranch();
    const assistantIndex = branch.findIndex((entry) => entry.id === request.assistantId);
    if (assistantIndex < 0 || branch.slice(assistantIndex + 1).some((entry) => entry.type === "message" && entry.message.role !== "toolResult")) {
      throw new Error("Session advanced while backtrack was pending.");
    }
    const from = branch.findLast((entry) => entry.type === "message")?.id;
    if (!from) throw new Error("Missing completed tool batch.");
    const history = renderHistory(historyBetween(branch, target.boundary, from));
    const hasHistory = history.content.length > 0;
    if (hasHistory) history.content = [{ type: "text", text: HISTORY_HEADER },
      ...(typeof history.content === "string" ? [{ type: "text" as const, text: history.content }] : history.content)];
    // /tree-like semantics: select the saved node, append the handoff, continue.
    // Unlike /tree, only the effective view moves; the session leaf never rewinds.
    state.view = state.view.slice(0, state.view.indexOf(target.ref) + 1);
    state.checkpoints = state.checkpoints.filter((item) => state.view.includes(item.ref));
    const prepared = skillContextService(this.pi)?.prepare(ctx, this.messages(ctx, state), request.id, request.target === 0);
    if (request.target === 0) { state.epoch = randomUUID(); state.next = 1; }
    this.commitStarted = true;
    prepared?.commit();
    for (const message of prepared?.messages ?? []) state.view.push(this.block(ctx, message));
    if (hasHistory) state.view.push(this.block(ctx, history));
    state.view.push(this.block(ctx, { role: "custom", customType: "backtrack:continuation", content: `[Backtrack message — agent handoff]\n${request.message}`, display: true, timestamp: 0 }));
    this.checkpoint(ctx, state, from);
    state.cursor = from;
    state.lastTransaction = request.id;
    this.save(ctx, state);
  }
  prepareCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
    // Consume complete boundaries normally. If summarization is cancelled, their
    // checkpoints remain usable; there is no separate "consume without numbering" mode.
    const state = this.sync(ctx);
    const effective = this.messages(ctx, state).filter((message) => !isMarker(message));
    // Skill directories are regenerated, not conversation facts. Their cost
    // still belongs to the pre-compaction context, not to the summary request.
    const messages = effective.filter((message) => !(message.role === "custom" && message.customType === DYNAMIC_CONTEXT));
    // SDK 0.85.1 retains raw entries by firstKeptEntryId. Summarize the effective
    // view with the host's one default request, retaining no raw tail to resurrect.
    const anchor = this.append(ctx, COMPACT_BOUNDARY, { epoch: state.epoch, cursor: state.cursor });
    const preparation = event.preparation;
    preparation.messagesToSummarize = messages;
    preparation.turnPrefixMessages = [];
    preparation.isSplitTurn = false;
    delete preparation.previousSummary;
    preparation.firstKeptEntryId = anchor;
    preparation.tokensBefore = estimateMessages(effective, ctx.getSystemPrompt());
    preparation.fileOps = { read: new Set(), written: new Set(), edited: new Set() };
    for (const message of messages) if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall" && typeof part.arguments.path === "string") {
        if (part.name === "read") preparation.fileOps.read.add(part.arguments.path);
        if (part.name === "write") preparation.fileOps.written.add(part.arguments.path);
        if (part.name === "edit") preparation.fileOps.edited.add(part.arguments.path);
      }
    }
  }
}
