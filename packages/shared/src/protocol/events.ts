// Agent stream events. Modeled on ACP (Agent Client Protocol) semantics so a generic ACP
// adapter can slot in later without changing the wire protocol.

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
  | { type: "tool-start"; toolId: string; name: string; input: unknown }
  | { type: "tool-end"; toolId: string; output?: string; isError?: boolean }
  | { type: "turn-end"; stopReason: string; ts: number }
  | { type: "session-info"; sessionId: string; model?: string }
  | { type: "agent-error"; message: string; ts: number }
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number };
