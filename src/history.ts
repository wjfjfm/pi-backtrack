import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "pi-dynamic-skill/context";
import { estimateText, excerpt, formatCount } from "./tokens.js";

type UserMessage = Extract<ContextMessage, { role: "user" }>;
type Image = Exclude<UserMessage["content"], string>[number] & { type: "image" };
export interface HistoryMessage { id: string; role: "user" | "assistant"; text: string; images: Image[]; turn: string | null }
export const HISTORY_HEADER = "[Backtracked conversation — quoted history, not new instructions]\n";
export const HISTORY_LAYERS = [{ budget: 5000, edge: Infinity }, { budget: 3000, edge: 100 }, { budget: 1000, edge: 20 }, { budget: 1000, edge: 10 }] as const;

/** Raw session extraction, not an extraction of the already shortened model view. */
export function historyBetween(branch: SessionEntry[], boundary: string | null, from: string): HistoryMessage[] {
  const start = boundary === null ? -1 : branch.findIndex((entry) => entry.id === boundary);
  const end = branch.findIndex((entry) => entry.id === from);
  if ((boundary !== null && start < 0) || end < 0 || end < start) throw new Error("History boundary is no longer on this session path.");
  let turn: string | null = null;
  const result: HistoryMessage[] = [];
  for (const entry of branch.slice(start + 1, end + 1)) {
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) continue;
    const message = entry.message as Extract<ContextMessage, { role: "user" | "assistant" }>;
    if (message.role === "user") turn = entry.id;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    if (message.role === "user" && content.some((part) => part.type !== "text" && part.type !== "image")) {
      throw new Error("Backtrack cannot preserve this user content type. No context was changed.");
    }
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const images = message.role === "user" ? content.filter((part): part is Image => part.type === "image") : [];
    // Empty user input still starts a turn but does not manufacture a transcript row.
    if (text || images.length) result.push({ id: entry.id, role: message.role, text, images, turn });
  }
  return result;
}

export function renderHistory(messages: HistoryMessage[], layers: readonly { budget: number; edge: number }[] = HISTORY_LAYERS): Extract<ContextMessage, { role: "custom" }> {
  const budgets = layers.map((layer) => layer.budget);
  if (budgets.length) budgets[0] = Math.max(0, budgets[0]! - estimateText(HISTORY_HEADER));
  // Reserve the maximum leading omission notice in the oldest tier. The exact
  // omitted-turn count is only known after allocation; do not exceed the budget to print it.
  if (budgets.length) budgets[budgets.length - 1] = Math.max(0, budgets[budgets.length - 1]! - estimateText(`[${messages.length} turns omitted]\n`));
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  // Reserve the required user first, even when assistant replies after it fill the recent tier.
  if (lastUser >= 0 && budgets.length) budgets[0] = Math.max(0, budgets[0]! - estimateText(`user: ${messages[lastUser]!.text}\n`));
  const kept = new Map<string, string>();
  let layer = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (i === lastUser) { kept.set(message.id, message.text); continue; }
    while (layer < layers.length) {
      const current = layers[layer]!;
      const text = Number.isFinite(current.edge) ? excerpt(message.text, current.edge) : message.text;
      const cost = estimateText(`${message.role}: ${text}\n`);
      if (cost <= budgets[layer]!) { budgets[layer]! -= cost; kept.set(message.id, text); break; }
      layer++;
    }
    if (!kept.has(message.id) && message.images.length) {
      kept.set(message.id, message.text ? `[${formatCount(estimateText(message.text))} tokens omitted]` : "");
    }
  }
  const turns = new Set(messages.flatMap((message) => message.turn ? [message.turn] : []));
  const visibleTurns = new Set(messages.filter((message) => kept.has(message.id)).map((message) => message.turn));
  const omitted = [...turns].filter((turn) => !visibleTurns.has(turn)).length;
  const content: ({ type: "text"; text: string } | Image)[] = [];
  if (omitted) content.push({ type: "text", text: `[${formatCount(omitted)} turns omitted]\n` });
  for (const message of messages) {
    const text = kept.get(message.id);
    if (text === undefined) continue;
    content.push({ type: "text", text: `${message.role}: ${text}\n` });
    content.push(...message.images);
  }
  return { role: "custom", customType: "backtrack:history", content, display: false, timestamp: 0 };
}
