import { randomUUID } from "node:crypto";
import { buildSessionContext, sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { DYNAMIC_CONTEXT, messageKey, skillContextService, type ContextMessage } from "pi-dynamic-skill/context";
import { BLOCK, STATE, REQUEST, CANCELLED, COMPACT_BOUNDARY, type BacktrackState, type Checkpoint, type PreparedBacktrack } from "./contracts.js";
import { HISTORY_HEADER, historyBetween, renderHistory } from "./history.js";
import { estimateMessages, formatCount } from "./tokens.js";

const isMarker = (message: ContextMessage) => message.role === "custom" && message.customType === "backtrack:checkpoint";
const compactionId = (branch: SessionEntry[]) => branch.findLast((entry) => entry.type === "compaction")?.id ?? null;
export function latestState(ctx: ExtensionContext): BacktrackState | undefined {
  const branch = ctx.sessionManager.getBranch();
  const entry = branch.findLast((item) => item.type === "custom" && item.customType === STATE);
  if (entry?.type !== "custom") return;
  const data = entry.data as BacktrackState;
  if (data.version !== 1 || !Array.isArray(data.view) || !Array.isArray(data.checkpoints)) throw new Error("Unsupported or corrupt backtrack state.");
  return structuredClone(data);
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
  private capture(ctx: ExtensionContext, messages: ContextMessage[], known: string[] = []): string[] {
    const ids = new Map<string, string[]>();
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      const content = entry.type === "custom" && entry.customType === BLOCK
        ? [(entry.data as { message: ContextMessage }).message] : sessionEntryToContextMessages(entry);
      if (content.length === 1) {
        const key = messageKey(content[0]!);
        ids.set(key, [...ids.get(key) ?? [], entry.id]);
      }
    }
    const used = new Map<string, number>();
    return messages.map((message) => {
      const key = messageKey(message), index = used.get(key) ?? 0;
      used.set(key, index + 1);
      const existing = ids.get(key);
      const preferred = known.filter((id) => existing?.includes(id))[index];
      return preferred ?? existing?.[index] ?? this.block(ctx, message);
    });
  }
  private skills(ctx: ExtensionContext, state: BacktrackState): void {
    const service = skillContextService(this.pi);
    if (!service) return;
    state.view = this.capture(ctx, service.project(ctx, this.messages(ctx, state)), state.view);
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
    const usage = tokens === null || !window ? "unknown" : `~${formatCount(tokens)}/${formatCount(window)} ~${Math.round(tokens / window * 100)}%`;
    const message: ContextMessage = { role: "custom", customType: "backtrack:checkpoint", content: `[checkpoint ${id} | context ${usage}]`, display: false, timestamp: 0,
      details: { epoch: state.epoch, id, boundary, accuracy: tokens === null ? "unknown" : "estimated" } };
    const ref = this.block(ctx, message);
    state.view.push(ref);
    state.checkpoints.push({ id, ref, boundary });
  }
  private save(ctx: ExtensionContext, state: BacktrackState): void {
    this.append(ctx, STATE, state);
  }
  /** Changes history only by appending immutable projection records. */
  sync(ctx: ExtensionContext, input = buildSessionContext(ctx.sessionManager.getBranch()).messages, allocate = true): BacktrackState {
    const skillCommands = this.pi.getCommands?.().filter((command) => command.source === "extension" && /^dynamic-skill(?::\d+)?$/.test(command.name)) ?? [];
    if (skillCommands.length > 1 || (skillCommands.length && !skillContextService(this.pi))) {
      throw new Error("Load exactly one compatible dynamic-skill extension (the companion package exports context-service:v1). An older header-replacing extension cannot be combined with backtrack.");
    }
    // Dynamic skill composition is explicitly delegated, never dependent on hook order.
    const wire = input.filter((message) => !isMarker(message)
      && !(message.role === "custom" && message.customType === DYNAMIC_CONTEXT)
      // Pi may remove a failed reply from Agent state before overflow recovery,
      // while keeping it in the session. It must not become a new boundary or
      // make the two representations appear to have incompatible prefixes.
      && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")));
    const keys = wire.map(messageKey);
    const branch = ctx.sessionManager.getBranch();
    const base = compactionId(branch);
    let state = latestState(ctx);
    const reset = !state || state.base !== base;
    if (reset) {
      state = { version: 1, epoch: randomUUID(), revision: randomUUID(), base, next: 1, inputKeys: [], view: [], checkpoints: [] };
      const firstUser = wire.findIndex((message) => message.role === "user");
      const prefixLength = firstUser < 0 ? wire.length : firstUser;
      state.view = this.capture(ctx, wire.slice(0, prefixLength));
      state.inputKeys = keys.slice(0, prefixLength);
      const firstSource = firstUser < 0 ? -1 : branch.findIndex((entry) => entry.type === "message" && messageKey(entry.message) === keys[firstUser]);
      const boundary = firstSource < 0 ? base : branch.slice(0, firstSource).findLast((entry) => entry.type !== "label")?.id ?? null;
      this.checkpoint(ctx, state, boundary, true);
    }
    if (!state) throw new Error("Failed to initialize context.");
    if (state.inputKeys.length > keys.length || state.inputKeys.some((key, i) => key !== keys[i])) {
      throw new Error("The host context changed outside backtrack/compact. Refusing to resurrect removed history; reload or compact the session.");
    }
    // A user navigating an older path must not reuse numbers already allocated in this epoch.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const old = entry.data as BacktrackState;
      if (old.epoch === state.epoch) state.next = Math.max(state.next, old.next);
    }
    const before = JSON.stringify(state);
    const refs = this.capture(ctx, wire);
    const pending = new Set<string>();
    const cancelled = new Set(branch.flatMap((entry) => entry.type === "custom" && entry.customType === CANCELLED
      ? [(entry.data as { id: string }).id] : []));
    const abandoned = new Map(branch.flatMap((entry) => entry.type === "custom" && entry.customType === REQUEST
      && cancelled.has((entry.data as PreparedBacktrack).id)
      ? [[(entry.data as PreparedBacktrack).assistantId, (entry.data as PreparedBacktrack).callId] as const] : []));
    // Reconstruct pairing even when the new messages start with tool results.
    for (let i = 0; i < wire.length; i++) {
      const message = wire[i]!;
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
      const abandonedCall = abandoned.get(refs[i]!);
      const nextAssistant = abandonedCall ? wire.findIndex((item, index) => index > i && item.role === "assistant") : -1;
      const needsRecovery = abandonedCall && !wire.slice(i + 1, nextAssistant < 0 ? undefined : nextAssistant)
        .some((item) => item.role === "toolResult" && item.toolCallId === abandonedCall);
      if (needsRecovery) pending.delete(abandonedCall);
      const hadPending = pending.size > 0;
      if (message.role === "toolResult") pending.delete(message.toolCallId);
      if (i < state.inputKeys.length) continue;
      state.view.push(refs[i]!);
      if (needsRecovery && abandonedCall) state.view.push(this.block(ctx, { role: "toolResult", toolName: "backtrack", toolCallId: abandonedCall,
        isError: true, timestamp: 0, content: [{ type: "text", text: "Interrupted backtrack was cancelled during session recovery; it was not replayed." }] }));
      if (allocate && !pending.size && (message.role === "user" || (message.role === "toolResult" && hadPending))) {
        this.checkpoint(ctx, state, refs[i]!);
      }
    }
    state.inputKeys = keys;
    this.skills(ctx, state);
    if (reset && base && state.checkpoints.length === 1 && allocate) this.checkpoint(ctx, state, base);
    if (reset || before !== JSON.stringify(state)) {
      state.revision = randomUUID();
      this.save(ctx, state);
    }
    return state;
  }
  current(ctx: ExtensionContext): ContextMessage[] {
    const state = latestState(ctx);
    return state && state.base === compactionId(ctx.sessionManager.getBranch()) ? this.messages(ctx, state)
      : structuredClone(buildSessionContext(ctx.sessionManager.getBranch()).messages);
  }
  project(ctx: ExtensionContext, messages: ContextMessage[]): ContextMessage[] {
    const state = this.sync(ctx, messages);
    const view = this.messages(ctx, state);
    skillContextService(this.pi)?.shown(ctx, view);
    return view;
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
    const initial = this.validate(ctx, request.target);
    if (initial.state.revision !== request.revision || initial.state.epoch !== request.epoch) throw new Error("Context changed while backtrack was pending.");
    const branch = ctx.sessionManager.getBranch();
    const assistantIndex = branch.findIndex((entry) => entry.id === request.assistantId);
    if (assistantIndex < 0 || branch.slice(assistantIndex + 1).some((entry) => entry.type === "message" && entry.message.role !== "toolResult")) {
      throw new Error("Session advanced while backtrack was pending.");
    }
    const from = branch.findLast((entry) => entry.type === "message")?.id;
    if (!from) throw new Error("Missing completed tool batch.");
    const history = renderHistory(historyBetween(branch, initial.target.boundary, from));
    // Pi serializes custom messages as user messages and drops customType.
    // Keep provenance visible rather than promoting quoted assistant text to new instructions.
    history.content = [{ type: "text", text: HISTORY_HEADER },
      ...(typeof history.content === "string" ? [{ type: "text" as const, text: history.content }] : history.content)];
    // Do not allocate a checkpoint for the batch being removed.
    const state = this.sync(ctx, undefined, false);
    const position = state.view.indexOf(initial.target.ref);
    state.view = state.view.slice(0, position + 1);
    state.checkpoints = state.checkpoints.filter((item) => state.view.includes(item.ref));
    const prepared = skillContextService(this.pi)?.prepare(ctx, this.messages(ctx, state), request.id, request.target === 0);
    if (request.target === 0) { state.epoch = randomUUID(); state.next = 1; }
    this.commitStarted = true;
    prepared?.commit();
    for (const message of prepared?.messages ?? []) state.view.push(this.block(ctx, message));
    state.view.push(this.block(ctx, history));
    state.view.push(this.block(ctx, { role: "custom", customType: "backtrack:continuation", content: `[Backtrack continuation — agent handoff]\n${request.message}`, display: true, timestamp: 0 }));
    this.checkpoint(ctx, state, from);
    state.revision = randomUUID();
    state.lastTransaction = request.id;
    this.save(ctx, state);
  }
  prepareCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
    const state = this.sync(ctx, undefined, false);
    const messages = this.messages(ctx, state).filter((message) => !isMarker(message));
    // SDK 0.85.1 retains raw entries by firstKeptEntryId; that can resurrect removed tools.
    // Summarize the complete *effective* view, retaining no raw tail. Still exactly the host's
    // one default compaction request, with its normal cancellation/retry/usage handling.
    const anchor = this.append(ctx, COMPACT_BOUNDARY, { revision: state.revision });
    const preparation = event.preparation;
    preparation.messagesToSummarize = messages;
    preparation.turnPrefixMessages = [];
    preparation.isSplitTurn = false;
    delete preparation.previousSummary;
    preparation.firstKeptEntryId = anchor;
    preparation.tokensBefore = estimateMessages(messages, ctx.getSystemPrompt());
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
