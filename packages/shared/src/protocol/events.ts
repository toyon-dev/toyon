// Agent stream events: the daemon's ACP session maps session/update notifications onto these, and
// the transcript JSONL stores them, so the shape is the ACP one with the fields the shell renders.

/** ACP's tool categories; what the shell keys "did this turn edit anything" on */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

/** display metadata for a picked element attached to a message */
export interface PickMeta {
  component: string | null;
  file: string | null;
  line: number | null;
  tag: string;
  selector: string;
}

export type AgentEvent =
  | { type: "user-message"; text: string; ts: number; pick?: PickMeta }
  | { type: "turn-start"; ts: number }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolId: string; name: string; input: unknown; kind?: ToolKind; title?: string }
  | { type: "tool-end"; toolId: string; output?: string; isError?: boolean }
  | { type: "turn-end"; stopReason: string; ts: number }
  | { type: "session-info"; sessionId: string; model?: string }
  | { type: "agent-error"; message: string; ts: number }
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number };
