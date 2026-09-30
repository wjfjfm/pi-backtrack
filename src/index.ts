import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backtrackParameters, validateArguments } from "./schema.js";
import { backtrackDescription } from "./tool-description.js";
import { BacktrackEngine } from "./engine.js";
import { compactEffective } from "./compaction.js";
import { BacktrackRenderer } from "./render.js";

export default function registerBacktrack(pi: ExtensionAPI): void {
  const engine = new BacktrackEngine(pi);
  const renderer = new BacktrackRenderer();
  const warn = (ctx: ExtensionContext, error: unknown) => {
    const text = `[backtrack] ${String(error)}`;
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    else process.stderr.write(text + "\n");
  };
  pi.on("session_shutdown", () => renderer.clear());
  pi.on("session_start", (_event, ctx) => {
    try { engine.assertCompatible(ctx); renderer.refresh(ctx); }
    catch (error) { ctx.abort(); warn(ctx, error); }
  });
  pi.on("session_tree", (_event, ctx) => renderer.refresh(ctx));
  pi.on("session_compact", (_event, ctx) => renderer.refresh(ctx));
  pi.on("session_before_compact", async (event, ctx) => {
    try { return await compactEffective(pi, engine, event, ctx); }
    catch (error) { warn(ctx, error); return { cancel: true }; }
  });
  pi.on("turn_end", (event, ctx) => {
    try {
      engine.sync(ctx); renderer.refresh(ctx);
      const entries = engine.resetBoundary(ctx, event);
      if (entries) return { entries };
    }
    catch (error) { ctx.abort(); warn(ctx, error); }
  });
  pi.on("context", (event, ctx) => {
    try {
      const messages = engine.project(ctx, event.messages);
      renderer.refresh(ctx);
      return { messages };
    } catch (error) {
      // Host context hooks catch errors: explicitly abort rather than sending unsafe legacy raw history.
      ctx.abort(); warn(ctx, error);
      return { messages: [] };
    }
  });
  const tool = {
    name: "backtrack", label: "Backtrack",
    // A backtrack owns a transcript boundary; nested calls have no transcript entry.
    exposure: "model-only" as const,
    description: backtrackDescription,
    parameters: backtrackParameters,
    renderCall: renderer.renderCall,
    renderResult: renderer.renderResult,
    async execute(callId: string, args: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      validateArguments(args);
      if (signal?.aborted) throw new Error("Backtrack cancelled.");
      engine.register(ctx, callId, args);
      // Success means the independent policy is registered, not that sibling tools succeeded.
      const text = args.keep_after_checkpoint === undefined ? "Backtrack applied."
        : `Backtrack to checkpoint ${args.checkpoint} succeeded. No separate handoff message was injected because raw context after checkpoint ${args.keep_after_checkpoint} is preserved. Refer to this tool call’s message argument.`;
      return { content: [{ type: "text" as const, text }], details: { status: "applied" } };
    },
  };
  pi.registerTool(tool);
}
