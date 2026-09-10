// Agent stream events: the daemon's ACP session maps session/update notifications onto these, and
// the transcript JSONL stores them, so the shape is the ACP one with the fields the shell renders.

/** the tool name on a command the person ran from the composer (`!ls`): the daemon records it on
 * the transcript as a tool call so it renders where the agent's own commands do, and the shell
 * keys on the name to open the row, since its output is the reason it was run */
export const SHELL_TOOL = "shell";

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
  /** the JSX the element itself was rendered from */
  file: string | null;
  line: number | null;
  /** where the component holding it is written: for a `<button>` from a shared `<Button>`, `file`
   * is ui/Button.tsx and this the surface that writes `<Button>`. Null when the element's own JSX
   * is already in the file that renders it. */
  callFile: string | null;
  callLine: number | null;
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

/** one choice in a question the agent asked */
export interface AskOption {
  /** what goes back to the agent. The agent's own enum names it, so it is not always the label */
  value: string;
  label: string;
  description?: string;
  /** a longer sample the agent attached to this option (a mockup, a snippet) */
  preview?: string;
}

/** one question inside an ask card. A single AskUserQuestion call carries up to four of them and
 * they are answered together, because the wire is one request with one response. */
export interface AskQuestion {
  /** unique within the card; an answer's position refers to it */
  id: string;
  /** empty when the card's own message is already the question */
  text: string;
  /** the short label the agent gave it ("Approach"), when it gave one */
  header?: string;
  options: AskOption[];
  multi?: boolean;
  /** the agent will take typed text for this question; `label` is what it called that field */
  note?: { label: string };
  required?: boolean;
}

/** what a person answered one question with */
export interface AskAnswer {
  /** option values, never labels */
  selected: string[];
  note?: string;
}

/** one button on a permission ask. Mirrors ACP's PermissionOption, redeclared because `shared`
 * runs in the browser and must not pull in the ACP SDK. */
export interface AskChoice {
  id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type AskOutcome = "answered" | "skipped" | "cancelled" | "expired";

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
  /** the agent's running figures after a reply: context tokens in use of the window's size, and
   * the session's spend so far when the agent prices itself (Claude does; a rate-limit notice
   * carries no cost). Cumulative on purpose: a turn's cost is the difference from the last one. */
  | { type: "usage"; used: number; size: number; cost?: number; ts: number }
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
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number }
  /** a graft appended another worktree's transcript here: what follows, up to the next marker or
   * the next message someone types, was said in that worktree before it was merged in and removed */
  | { type: "grafted"; title: string; branch: string; ts: number }
  /** the agent asked something and its turn is blocked until the answer goes back. `toolId` ties
   * the card to the tool row the agent emitted just before it, which the card then replaces.
   * Always followed by an agent-ask-end. */
  | { type: "agent-question"; id: string; message: string; questions: AskQuestion[]; toolId?: string; ts: number }
  /** the agent wants a decision it will not make for itself; `detail` is markdown (the plan) */
  | {
      type: "agent-permission";
      id: string;
      title: string;
      detail?: string;
      choices: AskChoice[];
      toolId?: string;
      ts: number;
    }
  /** the card closed. "cancelled": the turn was stopped, or the agent's process went away.
   * "expired": the daemon restarted under an open card, so nothing is listening for an answer */
  | {
      type: "agent-ask-end";
      id: string;
      outcome: AskOutcome;
      answers?: AskAnswer[];
      choiceId?: string;
      ts: number;
    };
