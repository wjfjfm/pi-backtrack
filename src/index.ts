import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OWNER_CHANNEL, skillContextService } from "./context.js";
import { backtrackParameters, validateArguments } from "./schema.js";
import { backtrackDescription, backtrackSkillDescription } from "./tool-description.js";
import { BacktrackEngine } from "./engine.js";
import { CANCELLED, REQUEST, type PreparedBacktrack } from "./contracts.js";
import { BacktrackRenderer, boundaryLocation } from "./render.js";

export default function registerBacktrack(pi: ExtensionAPI): void {
  const engine = new BacktrackEngine(pi);
  const renderer = new BacktrackRenderer();
  let pending: PreparedBacktrack | undefined;
  let inputVersion = 0;
  let requestedInputVersion = 0;
  let stopped = false;
  const warn = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    else process.stderr.write(text + "\n");
  };
  const cancel = (ctx: ExtensionContext, reason: string) => {
    if (!pending) return;
    const id = pending.id;
    pending = undefined;
    try { pi.appendEntry(CANCELLED, { id, reason }); }
    catch (error) {
      stopped = true;
      ctx.abort();
      warn(ctx, `[backtrack] Could not persist cancellation: ${String(error)}. Stopped without replay.`);
      return;
    }
    renderer.refresh(ctx);
    warn(ctx, `[backtrack] ${reason}`);
    pi.sendMessage({ customType: "backtrack:cancelled", content: `Backtrack was not applied: ${reason}. Continue on the current path.`, display: true });
  };
  const unsubscribe = pi.events.on(OWNER_CHANNEL, (request) => {
    const value = request as { accept?: (owner: { current(ctx: ExtensionContext): ReturnType<BacktrackEngine["current"]> }) => void } | undefined;
    value?.accept?.({ current: (ctx) => engine.current(ctx) });
  });
  pi.on("session_shutdown", () => { unsubscribe(); pending = undefined; renderer.clear(); });
  pi.on("input", () => { inputVersion++; });
  pi.on("session_start", (_event, ctx) => {
    // All extensions have loaded: resolve the optional service in either order.
    registerTool();
    pending = undefined; stopped = false;
    // Prepared calls are never blindly replayed after a crash/reload.
    const branch = ctx.sessionManager.getBranch();
    const request = branch.findLast((entry) => entry.type === "custom" && entry.customType === REQUEST);
    if (request?.type === "custom") {
      const data = request.data as PreparedBacktrack;
      const completed = branch.some((entry) => entry.type === "custom" && entry.customType === "backtrack:state:v1"
        && (entry.data as { lastTransaction?: string }).lastTransaction === data.id);
      const cancelled = branch.findLast((entry) => entry.type === "custom" && entry.customType === CANCELLED && (entry.data as { id: string }).id === data.id);
      if (cancelled?.type === "custom" && (cancelled.data as { phase?: string }).phase === "commit-failed") {
        try {
          engine.recoverFailure(ctx, data.id, (cancelled.data as { reason: string }).reason);
        } catch (error) {
          stopped = true;
          ctx.abort();
          warn(ctx, `[backtrack] Could not persist recovery status: ${String(error)}. Stopped without replay.`);
        }
      }
      if (!completed && !cancelled) { pending = data; cancel(ctx, "Prepared backtrack interrupted by session restart; no automatic replay"); }
    }
    renderer.refresh(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    try {
      cancel(ctx, "Compaction started before backtrack was applied");
      engine.prepareCompact(event, ctx);
    } catch (error) {
      warn(ctx, `[backtrack] Compaction cancelled: effective context could not be prepared: ${String(error)}`);
      return { cancel: true };
    }
  });
  pi.on("session_before_tree", (_event, ctx) => { cancel(ctx, "Session tree navigation interrupted backtrack"); });
  pi.on("session_tree", (_event, ctx) => { stopped = false; renderer.refresh(ctx); });
  pi.on("session_compact", (_event, ctx) => {
    try {
      // The shared compaction entry ID makes this safe in either extension order.
      skillContextService(pi)?.compact(ctx);
      engine.sync(ctx);
      stopped = false;
    } catch (error) {
      stopped = true;
      warn(ctx, `[backtrack] Compaction completed but checkpoint rebuild failed: ${String(error)}. Reload before continuing.`);
    }
  });
  pi.on("context", (event, ctx) => {
    try {
      if (stopped) throw new Error("Backtrack stopped after a partial failure; inspect the session and reload before continuing.");
      return { messages: engine.project(ctx, event.messages) };
    } catch (error) {
      // Pi logs context-hook errors and would otherwise send the unfiltered raw history.
      // Abort and return an empty view instead of silently resurrecting that history.
      ctx.abort();
      warn(ctx, `[backtrack] Context projection failed: ${String(error)}`);
      return { messages: [] };
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (!pending) return;
    const request = pending;
    const assistant = ctx.sessionManager.getBranch().find((entry) => entry.id === request.assistantId);
    const calls = assistant?.type === "message" && assistant.message.role === "assistant"
      ? assistant.message.content.filter((part) => part.type === "toolCall") : [];
    const batchSucceeded = calls.length > 0 && event.toolResults.length === calls.length
      && calls.every((call) => event.toolResults.filter((result) => result.toolCallId === call.id
        && result.toolName === call.name && !result.isError).length === 1);
    if (ctx.signal?.aborted || inputVersion !== requestedInputVersion || ctx.hasPendingMessages() || !batchSucceeded) {
      cancel(ctx, "Cancelled, new input queued, or tool batch failed before commit");
      return;
    }
    try {
      engine.apply(ctx, request);
      pending = undefined;
    } catch (error) {
      if (!engine.commitStarted) { cancel(ctx, String(error)); return; }
      // Never claim rollback of partially persisted records or external skill writes.
      stopped = true;
      pending = undefined;
      ctx.abort();
      try { pi.appendEntry(CANCELLED, { id: request.id, reason: String(error), phase: "commit-failed" }); }
      catch (recordError) { warn(ctx, `[backtrack] Could not persist failure details: ${String(recordError)}`); }
      warn(ctx, `[backtrack] Commit did not finish: ${String(error)}. No automatic replay; inspect and reload.`);
    } finally {
      renderer.refresh(ctx);
    }
  });
  const registerTool = () => pi.registerTool({
    name: "backtrack", label: "Backtrack",
    description: backtrackDescription + (skillContextService(pi) ? `\n\n${backtrackSkillDescription}` : ""),
    parameters: backtrackParameters,
    renderCall: renderer.renderCall,
    renderResult: renderer.renderResult,
    async execute(callId, args, signal, _onUpdate, ctx) {
      validateArguments(args);
      if (signal?.aborted) throw new Error("Backtrack cancelled.");
      if (pending || stopped || ctx.hasPendingMessages()) throw new Error("Backtrack is unavailable while another operation or user input is pending.");
      const branch = ctx.sessionManager.getBranch();
      const assistant = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Missing tool-calling assistant message.");
      const calls = assistant.message.content.filter((part) => part.type === "toolCall");
      const backtracks = calls.filter((call) => call.name === "backtrack");
      if (backtracks.length !== 1 || backtracks[0]?.id !== callId) throw new Error("At most one backtrack is allowed per tool batch. No context was changed.");
      if (branch.some((entry) => entry.type === "custom" && entry.customType === REQUEST
        && (entry.data as PreparedBacktrack).assistantId === assistant.id && (entry.data as PreparedBacktrack).callId === callId)) {
        throw new Error("This backtrack invocation has already been prepared or completed; it will not be replayed.");
      }
      const { state, target } = engine.validate(ctx, args.checkpoint);
      const request: PreparedBacktrack = { id: randomUUID(), callId, assistantId: assistant.id,
        epoch: state.epoch, target: args.checkpoint, message: args.message,
        location: boundaryLocation(branch, target.boundary, args.checkpoint) };
      requestedInputVersion = inputVersion;
      pi.appendEntry(REQUEST, request);
      pending = request;
      renderer.refresh(ctx);
      return { content: [{ type: "text", text: "Backtrack prepared. The host will apply it after this complete tool batch, then continue automatically. Files and external actions are unchanged." }],
        details: { transactionId: request.id, status: "prepared" } };
    },
  });
  registerTool();
}
