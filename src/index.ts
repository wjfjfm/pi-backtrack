import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backtrackParameters, validateArguments } from "./schema.js";
import { backtrackDescription } from "./tool-description.js";
import { BacktrackEngine } from "./engine.js";
import { BacktrackRenderer } from "./render.js";
import { onBacktrack, requestBacktrack } from "./native.js";

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
  // Native compaction owns preparation. The only guard is refusing unsafe legacy input.
  pi.on("session_before_compact", (_event, ctx) => {
    try { engine.assertCompatible(ctx); }
    catch (error) { warn(ctx, error); return { cancel: true }; }
  });
  onBacktrack(pi, (_event, ctx) => renderer.refresh(ctx));
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
    name: "backtrack", label: "Backtrack", supportsBacktrack: true,
    description: backtrackDescription,
    parameters: backtrackParameters,
    renderCall: renderer.renderCall,
    renderResult: renderer.renderResult,
    async execute(callId: string, args: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      validateArguments(args);
      if (signal?.aborted || ctx.hasPendingMessages()) throw new Error("Backtrack is unavailable while cancelled or user input is pending.");
      requestBacktrack(ctx, callId, engine.prepare(ctx, callId, args));
      // The host publishes this result only after committing; failure replaces it in place.
      const text = args.keep_after_checkpoint === undefined ? "Backtrack applied."
        : `Backtrack to checkpoint ${args.checkpoint} succeeded. No separate handoff message was injected because raw context after checkpoint ${args.keep_after_checkpoint} is preserved. Refer to this tool call’s message argument.`;
      return { content: [{ type: "text" as const, text }], details: { status: "applied" } };
    },
  };
  pi.registerTool(tool);
}
