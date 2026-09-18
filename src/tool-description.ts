export const backtrackDescription = `Reduce the active model context to a currently visible checkpoint and continue with the supplied message. Session history remains continuous. Files and external actions are NOT rolled back.

Proactively manage context usage according to task difficulty:
- Short tasks: keep context usage within 0%-20% of the context window.
- Standard tasks: keep context usage within 20%-50%.
- Difficult tasks: keep context usage within 40%-80%.
These are target ranges, not minimums to fill or hard invocation thresholds. Use the latest host context reading, respecting estimated or unknown usage. Do not wait until the context window is nearly exhausted.

Before backtracking, preserve useful findings from the discarded exploration with dynamic-skill if enabled. Save or update relevant skills and confirm success first. Then call backtrack ALONE, with no other tool calls in the same batch. No skill is required when there is nothing useful to preserve.

Supply the current task state, external changes, and next action in message. Saved skill bodies are read on demand, not automatically reloaded. User/assistant conversation text from the removed range is retained in a tiered history (5K full text, then 3K/1K/1K head-and-tail excerpts); older turns are omitted. The latest user text and user images are retained. Tool calls/results and thinking are removed from the active context.

Checkpoint 0 is the start anchor before dynamic skills; returning to it rebuilds skills and restarts numbering at 1. Other backtracks continue numbering without reuse. Use only checkpoints in the current context, never numbers mentioned in quoted history.`;

export const parameterDescriptions = {
  checkpoint: "An active host checkpoint number. 0 rebuilds from the start; not a session entry ID.",
  message: "Concise task state and next action for automatic continuation. Include external changes and relevant skill paths, not a duplicate knowledge document.",
} as const;
