import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Checkpoint } from "./contracts.js";
import type { ContextMessage } from "./context.js";

/** Older checkpoints only persisted the formatted meter. Keep them usable. */
export function checkpointTokens(point: Checkpoint): number | null {
  if (point.tokens !== undefined) return point.tokens;
  if (typeof point.marker.content !== "string") return null;
  const match = / context (\d+(?:\.\d+)?)(K?)\//.exec(point.marker.content);
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : null;
}

/** Content-only estimate: saved assistant usage may describe a pre-fold request. */
export function estimateRequestTokens(
  messages: readonly ContextMessage[],
  ctx: Pick<ExtensionContext, "getSystemPrompt">,
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
): number {
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().filter(tool => active.has(tool.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  return Math.ceil((ctx.getSystemPrompt().length + (tools.length ? JSON.stringify(tools).length : 0)) / 4)
    + messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Display-only estimate; assistant usage belongs to the old request, not this view. */
export function estimateAfterFold(
  nodes: readonly { id: string | null; message: ContextMessage }[],
  target: Checkpoint,
  checkpoints: readonly Checkpoint[],
  ctx: Pick<ExtensionContext, "getSystemPrompt">,
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
): number {
  const at = target.boundary === null ? -1 : nodes.findLastIndex(node => node.id === target.boundary);
  const baseline = target.boundary !== null && at < 0 ? null : checkpointTokens(target);
  const messages = baseline === null ? nodes : nodes.slice(at + 1);
  const markers = baseline === null ? checkpoints : checkpoints.slice(checkpoints.indexOf(target) + 1);
  let total = baseline ?? 0;
  if (baseline === null) total += estimateRequestTokens([], ctx, pi);
  for (const node of messages) total += estimateTokens(node.message);
  for (const point of markers) total += estimateTokens(point.marker);
  return Math.ceil(total);
}
