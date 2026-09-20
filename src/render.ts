import type { ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { CANCELLED, REQUEST, STATE, type BacktrackState, type PreparedBacktrack, type BacktrackUsage } from "./contracts.js";
import { formatCount } from "./tokens.js";

// Labels are display-only. Never change the stored handoff or model context.
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const inline = (text: string) => clean(text).replace(/\s+/g, " ").trim();
const short = (text: string) => truncateToWidth(inline(text), 90);

export function boundaryLocation(branch: SessionEntry[], boundary: string | null, checkpoint: number): string[] {
  if (checkpoint === 0) return ["context start"];
  const index = branch.findIndex((entry) => entry.id === boundary);
  const entry = branch[index];
  if (entry?.type === "compaction") return ["after compaction"];
  if (entry?.type !== "message") return [];
  const message = entry.message;
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
    return [`after user: ${short(text) || "[image]"}`];
  }
  if (message.role !== "toolResult") return [];
  const assistant = branch.slice(0, index).findLast((item) => item.type === "message" && item.message.role === "assistant");
  if (assistant?.type !== "message" || assistant.message.role !== "assistant") return [];
  const calls = assistant.message.content.filter((part) => part.type === "toolCall");
  return calls.map((call) => {
    const value = call.arguments.path ?? call.arguments.command ?? call.arguments.checkpoint;
    return inline(`${call.name}${value === undefined ? "" : ` ${String(value)}`}`);
  });
}

interface Display {
  request: PreparedBacktrack;
  usage?: BacktrackUsage;
  applied?: boolean;
  error?: string;
}

/** Presentation follows persisted transactions, not the tool's prepared result. */
export class BacktrackRenderer {
  private records = new Map<string, Display>();
  private redraw = new Map<string, () => void>();
  refresh(ctx: ExtensionContext): void {
    const transactions = new Map<string, Display>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === REQUEST) {
        const request = entry.data as PreparedBacktrack;
        transactions.set(request.id, { request });
      } else if (entry.customType === STATE) {
        const state = entry.data as BacktrackState;
        const record = state.lastTransaction && transactions.get(state.lastTransaction);
        if (record) {
          record.applied = true;
          if (state.usage) record.usage = state.usage;
        }
      } else if (entry.customType === CANCELLED) {
        const data = entry.data as { id: string; reason: string; phase?: string };
        const record = transactions.get(data.id);
        if (record) record.error = `${data.phase === "commit-failed" ? "Commit incomplete; partial changes may remain" : "Not applied"}: ${data.reason}`;
      }
    }
    this.records = new Map([...transactions.values()].map((record) => [record.request.callId, record]));
    for (const invalidate of this.redraw.values()) {
      // A detached or faulty UI must never fail the backtrack transaction.
      try { invalidate(); } catch { /* Rebuilt from persisted records on next render. */ }
    }
  }
  clear(): void { this.records.clear(); this.redraw.clear(); }

  renderCall: NonNullable<ToolDefinition["renderCall"]> = (rawArgs, theme, context) => {
    const args = (rawArgs ?? {}) as { checkpoint?: number; message?: string };
    this.redraw.set(context.toolCallId, context.invalidate);
    const record = this.records.get(context.toolCallId);
    const location = record?.request.location ?? [];
    const expanded = context.expanded;
    let title = theme.fg("toolTitle", theme.bold("backtrack")) + " "
      + theme.fg("accent", `checkpoint ${args.checkpoint ?? "…"}`);
    if (location.length === 1) {
      const label = /^(after |context start)/.test(location[0]!) ? location[0]! : `after ${location[0]}`;
      title += theme.fg("muted", ` · ${expanded ? label : short(label)}`);
    } else if (location.length > 1) {
      title += theme.fg("muted", expanded ? `\nafter tools:\n${location.map((line) => `  ${line}`).join("\n")}`
        : ` · after tools: ${location.slice(0, 2).map(short).join(", ")}${location.length > 2 ? ` (+${location.length - 2})` : ""}`);
    }
    if (typeof args.message === "string" && args.message) {
      const lines = clean(args.message).split("\n");
      if (!expanded && lines.length > 10) {
        title += "\n\n" + theme.fg("toolOutput", lines.slice(0, 5).join("\n"));
        title += theme.fg("muted", `\n... (${lines.length - 10} ${lines.length === 11 ? "line" : "lines"} omitted, ${keyHint("app.tools.expand", "to expand")})`);
        title += "\n" + theme.fg("toolOutput", lines.slice(-5).join("\n"));
      } else {
        title += "\n\n" + theme.fg("toolOutput", lines.join("\n"));
      }
    }
    return new Text(title, 0, 0);
  };

  renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, _options, theme, context) => {
    const record = this.records.get(context.toolCallId);
    const error = context.isError ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "Backtrack failed." : record?.error;
    let text: string;
    if (error) text = theme.fg("error", clean(error));
    else if (record?.usage) {
      const { before, after, window } = record.usage;
      text = theme.fg("muted", `context ${formatCount(before)} → ${formatCount(after)}${window ? ` / ${formatCount(window)} (${Math.round(after / window * 100)}%)` : ""} · estimated`);
    } else text = theme.fg("muted", record?.applied ? "Applied; context usage unavailable." : "Prepared; waiting for tool batch.");
    return new Text(`\n${text}`, 0, 0);
  };
}
