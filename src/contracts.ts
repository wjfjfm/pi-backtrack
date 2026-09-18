import type { ContextMessage } from "pi-dynamic-skill/context";
export type { BacktrackArguments } from "./schema.js";
export const STATE = "backtrack:state:v1";
export const BLOCK = "backtrack:block:v1";
export const REQUEST = "backtrack:request:v1";
export const CANCELLED = "backtrack:cancelled:v1";
export const COMPACT_BOUNDARY = "backtrack:compact-boundary:v1";
export interface Checkpoint {
  id: number;
  ref: string;
  /** Original session entry after which the history interval starts. null = start. */
  boundary: string | null;
}
export interface BacktrackState {
  version: 1;
  epoch: string;
  revision: string;
  base: string | null;
  next: number;
  inputKeys: string[];
  /** Immutable session-entry references; raw tool outputs are not copied into snapshots. */
  view: string[];
  checkpoints: Checkpoint[];
  lastTransaction?: string;
}
export interface PreparedBacktrack {
  id: string;
  callId: string;
  assistantId: string;
  revision: string;
  epoch: string;
  target: number;
  message: string;
}
export type Message = ContextMessage;
