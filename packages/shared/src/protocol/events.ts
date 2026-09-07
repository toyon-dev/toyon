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

/** an image the user attached. The bytes live in the daemon's attachment store; the shell fetches
 * them by worktree id + file. `n` counts per worktree session, not per message: the model keeps
 * earlier images in context, so "image 2" two turns later must still mean the same image. */
export interface ImageRef {
  n: number;
  name: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  /** basename under the store's <worktreeId>/ directory */
  file: string;
}

/** a long paste the shell collapsed into a chip rather than dropping into the textarea. The text
 * lives in the daemon's attachment store like an image, so a 100k paste does not ride in every
 * backfill; `n` counts per worktree session, same rule as ImageRef. */
export interface PasteRef {
  n: number;
  /** set when the paste came from a file rather than a text selection */
  name?: string;
  chars: number;
  lines: number;
  /** first non-empty line, trimmed and capped: the chip's label and the prompt's header */
  preview: string;
  /** basename under the store's <worktreeId>/ directory */
  file: string;
}

/** one slash command the worktree's agent session advertises. `name` is verbatim as the agent
 * gave it: the Claude adapter re-expands `/mcp:server:cmd` on the way back, so normalising it
 * here would break MCP prompts. */
export interface AgentCommand {
  name: string;
  description: string;
  /** what the arguments are, when the command takes any */
  hint?: string;
}

/** one way to log the agent in, as it advertised over ACP */
export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string;
  /** terminal: toyon runs a command in the worktree's terminal pane; agent: the adapter does it
   * itself (opens a browser, takes a pasted key) */
  kind: "terminal" | "agent";
  /** the adapter wants an API key with the request */
  needsKey?: boolean;
}

export type AgentEvent =
  | { type: "user-message"; text: string; ts: number; pick?: PickMeta; images?: ImageRef[]; pastes?: PasteRef[] }
  | { type: "turn-start"; ts: number }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolId: string; name: string; input: unknown; kind?: ToolKind; title?: string }
  /** the agent refined a running tool call (a placeholder title became the real one, input arrived) */
  | { type: "tool-update"; toolId: string; name?: string; title?: string; input?: unknown; kind?: ToolKind }
  | { type: "tool-end"; toolId: string; output?: string; isError?: boolean }
  | { type: "turn-end"; stopReason: string; ts: number }
  | { type: "session-info"; sessionId: string; model?: string }
  | { type: "agent-error"; message: string; ts: number }
  /** the turn was refused for want of credentials; the shell offers the methods as buttons.
   * `rejected` distinguishes "the credential it has was refused" from "it has none" — the second
   * comes from ACP's auth_required code, the first from reading the provider's 401 */
  | {
      type: "agent-auth-required";
      agent: string;
      agentName: string;
      methods: AuthMethodInfo[];
      rejected?: boolean;
      ts: number;
    }
  | { type: "agent-auth-ok"; ts: number }
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number };
