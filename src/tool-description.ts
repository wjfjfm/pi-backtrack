export const backtrackDescription = `By default, backtrack automatically preserves all context through the selected checkpoint, removes subsequent thinking, tool calls, and tool results, and retains only basic user/assistant dialogue with appropriate trimming.

When to use backtrack:
- Manage context proactively: use 0-20% of the context window for short tasks, 0-40% for standard tasks, and 0-80% for difficult tasks.
- When the user clearly changes topics, or when returning to the main task after completing a detour, use backtrack first to compress the context.
- When a long task is nearing the context limit and recent information matters more, use checkpoint: a with keep_after_checkpoint: b to compact context from a to b.`;

export const parameterDescriptions = {
  checkpoint: "A currently visible checkpoint number. Context through this checkpoint is preserved intact.",
  keep_after_checkpoint: "Optionally preserve context after this checkpoint intact.",
  message: "Handoff for the work after the target checkpoint: what you did, what you examined, what you learned, failed attempts and their lessons, and what you plan to do next after returning to it.",
} as const;
