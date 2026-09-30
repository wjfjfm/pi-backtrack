export const backtrackDescription = `By default, backtrack automatically preserves all context through the selected checkpoint, removes subsequent thinking, tool calls, and tool results, and retains only basic user/assistant dialogue with appropriate trimming.

Without keep_after_checkpoint, checkpoint 0 establishes a new native context baseline. It keeps only this interval’s trimmed dialogue and your handoff, not earlier baselines or handoffs. Carry forward everything still needed. Original session history remains archived.

When to use backtrack:
- Trim the tail proactively and frequently. Preserving the prefix enables KV-cache reuse at low cost. Use when switching topics, returning from a completed side task, correcting misguided exploration, or finishing an exploration direction; carry forward key findings.
- Compact context preemptively. Target context usage: 0–20% for simple tasks, 0–40% for complex tasks, and 0–80% for difficult tasks.`;

export const parameterDescriptions = {
  checkpoint: "A currently visible checkpoint number. The prefix is preserved, except ordinary checkpoint 0 resets the native baseline to retained dialogue and the new handoff.",
  keep_after_checkpoint: "checkpoint: a, keep_after_checkpoint: b — keep raw context through a and after b; fold a–b. For difficult, long tasks near the context limit when recent context matters more. Costlier, but worthwhile.",
  message: "Handoff for the work after the target checkpoint: what you did, what you examined, what you learned, failed attempts and their lessons, and what you plan to do next after returning to it.",
} as const;
