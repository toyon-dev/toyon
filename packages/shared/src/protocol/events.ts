// Agent stream events: the daemon's ACP session maps session/update notifications onto these, and
// the transcript JSONL stores them, so the shape is the ACP one with the fields the shell renders.

import type { LandMark, PermissionMode } from "../model.ts";

/** the tool name on a command the person ran from the composer (`!ls`): the daemon records it on
 * the transcript as a tool call so it renders where the agent's own commands do, and the shell
 * keys on the name to open the row, since its output is the reason it was run */
export const SHELL_TOOL = "shell";

/** the tool name on the repo's check, run by the daemon after a finished turn: the same row as a
 * `!` command (its output belongs in the conversation, and rides into the next message the same
 * way), but toyon's to run rather than the person's, so the shell does not open it as theirs */
export const CHECK_TOOL = "check";

/** the input on a SHELL_TOOL row. `landing` marks a git step the daemon ran for a landing rather
 * than a command the person typed: the same row, with the same stop and the same fix offer, but
 * the landed row that follows is what says it went well, so the shell's mark for a clean exit
 * stays on the typed ones */
export interface ShellInput {
  command: string;
  landing?: true;
}

/** Claude loading the schemas of tools it had deferred. The adapter knows no kind for it, so the
 * daemon files it as a search and the row reads as one: the search glyph, the loader's name, and
 * the names or words it searched for. The shell keys on the name to keep it on the row, since the
 * words alone under that glyph read as a search of the code. */
export const TOOL_SEARCH = "ToolSearch";

/** Claude asking the person a question. The call has no kind of its own, and the card takes the
 * row's place once the question is in, so the row is only ever seen while the agent writes it: the
 * shell keys on the name to say so, under the glyph the ask itself wears. */
export const ASK_TOOL = "AskUserQuestion";

/** The MCP server the daemon serves each agent, carrying Toyon's own tools. Adapters prefix a
 * tool's name with it (Claude: `mcp__toyon__split`), so the daemon folds every spelling back to
 * the bare name and the shell keys rows on that. */
export const TOYON_MCP_SERVER = "toyon";

/** Toyon's one tool of its own: the agent hands Toyon the pieces of the work it is planning, or
 * one piece it came across. Each goes on this worktree, a new one here or in another open
 * project, or an open worktree already on that part, and the person decides on the list. */
export const SPLIT_TOOL = "split";

/** where one piece of a plan goes: the agent proposes one of the first three, the person may
 * change it, and `skip` is theirs alone */
export type PieceFate = "here" | "worktree" | "send" | "skip";

/** one piece of work the agent handed Toyon beside its plan */
export interface Piece {
  /** unique within its proposal (`p1`, `p2`, ...) */
  id: string;
  title: string;
  /** markdown that stands on its own: the plan its worktree is born with, or what is sent */
  brief: string;
  /** what this chat attached that the piece needs: named by the agent as the prompt captions
   * them ("Image 2", "Paste 1"), resolved to the refs when proposed, so the shell can draw them */
  attachments: AttachmentRef[];
  /** what the agent proposed; never `skip` */
  fate: Exclude<PieceFate, "skip">;
  /** `worktree`: what it waits for before it starts, resolved when proposed; absent to start at
   * once. A worktree already open, or another piece of the same list by its id. */
  after?: { id: string; branch: string; title: string } | { piece: string };
  /** `send`: the open worktree the text goes to */
  to?: { id: string; branch: string; title: string };
  /** another open project the piece goes to: its worktree is made there, or `to` is one of its
   * rows. Absent for the origin's own project. */
  project?: { id: string; name: string };
}

/** what became of one piece when the person pressed go */
export interface PieceOutcome {
  pieceId: string;
  fate: PieceFate;
  /** the sibling made, or the worktree sent to */
  worktreeId?: string;
  title?: string;
  /** the project the worktree is in, when it is not the origin's */
  repoName?: string;
  /** queued until this branch lands */
  after?: string;
  /** in the daemon's words, when the piece could not be acted on */
  error?: string;
}

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
   * is already that line, and when the component is mounted by the root render (the `<App />` in
   * main.tsx). */
  callFile: string | null;
  callLine: number | null;
  tag: string;
  selector: string;
}

/** an image the user attached. The bytes live in the daemon's attachment store; the shell fetches
 * them by worktree id + file. `n` counts per kind across the worktree session (see nextNumbers). */
export interface ImageRef {
  kind: "image";
  n: number;
  name: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  /** basename under the store's <worktreeId>/ directory */
  file: string;
}

/** a picture a tool call returned: a read of a screenshot, a command that printed an image. The
 * bytes live in the attachment store beside the message images, under a name made from the bytes
 * themselves, so the transcript keeps a ref and the same picture read twice is one file. */
export interface ToolImage {
  /** basename under the store's <worktreeId>/ directory */
  file: string;
  mimeType: string;
  bytes: number;
}

/** where a paste was copied from, when the shell's own editor copied it: the lines as they were
 * numbered at the moment of the copy, which later edits to the file do not move */
export interface PasteSource {
  /** relative to the worktree */
  path: string;
  startLine: number;
  endLine: number;
  /** the commit whose copy of the file it was; absent for the working tree */
  ref?: string;
}

/** a long paste the shell collapsed into a chip rather than dropping into the textarea. The text
 * lives in the daemon's attachment store like an image, so a 100k paste does not ride in every
 * backfill; `n` counts per kind, same rule as ImageRef. */
export interface PasteRef {
  kind: "paste";
  n: number;
  /** set when the paste came from a file rather than a text selection */
  name?: string;
  /** set when the paste is a selection copied in the editor, from either of its views */
  source?: PasteSource;
  chars: number;
  lines: number;
  /** first non-empty line, trimmed and capped: the chip's label and the prompt's header */
  preview: string;
  /** basename under the store's <worktreeId>/ directory */
  file: string;
}

/** a file the user attached, of any type. The agent is told where the stored copy is and reads it
 * there; the prompt never carries its bytes. `n` counts per kind, same rule as ImageRef. */
export interface FileRef {
  kind: "file";
  n: number;
  name: string;
  bytes: number;
  /** the bytes read as text, so the chip can show them */
  text: boolean;
  /** basename under the store's <worktreeId>/ directory */
  file: string;
}

/** an element picked in the preview. Nothing is stored for it, so the ref is the whole of it. Its
 * paths are relative to the checkout it was picked in, which makes them read the same in any
 * worktree of the repo the message goes to. `text` and `html` are what the bridge captured, at the
 * bridge's own caps. */
export interface PickRef extends PickMeta {
  kind: "pick";
  n: number;
  text: string;
  html: string;
}

/** what a sent message carried, in the order it was attached */
export type AttachmentRef = ImageRef | PasteRef | FileRef | PickRef;

/** one slash command the worktree's agent session advertises. `name` is verbatim as the agent
 * gave it: the Claude adapter re-expands `/mcp:server:cmd` on the way back, so normalising it
 * here would break MCP prompts. */
export interface AgentCommand {
  name: string;
  description: string;
  /** what the arguments are, when the command takes any */
  hint?: string;
  /** where the person wrote it, when the daemon found it on disk under that name: a skill or
   * command file in the project, in their home folder, or in a plugin folder their agents.json
   * loads. Absent for what the agent brings of its own (built-ins, bundled and marketplace skills,
   * a command a mod registers at runtime), which the agent never says apart. The `/` menu leads
   * with these before anything else. */
  origin?: CommandOrigin;
}

export type CommandOrigin = "project" | "user" | "plugin";

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

/** Why Toyon sent the agent a message nobody typed: something failed that the agent can fix, or
 * the person pressed to send it on after a turn that was stopped or that failed */
export interface Asked {
  /** `preview` is a dev server that will not come up */
  kind: "hook" | "conflict" | "check" | "command" | "preview" | "stopped" | "failed" | "pieces";
  why: string;
  /** the row of the command that failed, when the failure was one: what it printed went to the
   * agent with this message, and its row is not offered or attached again */
  toolId?: string;
}

/** A command's row that ended in something the agent can be asked to fix: a `!` command or the
 * repo's check that failed on its own exit, or a landing step a hook refused. Written by the
 * daemon on the rows it ran itself, never on an agent's own call. */
export interface Fixable {
  kind: "command" | "check" | "hook";
  /** the hook that refused the step, for kind `hook` */
  hook?: string;
}

/** The worktree whose agent wrote what another chat was handed, as it was then: kept whole,
 * since the row outlives it. `project` names the origin's project when it is not this one. */
export interface HandedOrigin {
  id: string;
  repoId: string;
  branch: string;
  title: string;
  project?: string;
}

export type AgentEvent =
  | { type: "user-message"; text: string; ts: number; attachments?: AttachmentRef[] }
  /** A message Toyon sent the agent on another agent's behalf, which the chat draws as a row of
   * Toyon's own and never as the person's words. `plan`: this worktree's first message, which
   * points the agent at the plan it was born with, at `path`; `message`: a piece of another
   * chat's work sent into this one, whose own markdown is `body`. `text` is what the agent was
   * sent, `note` what the person added when they approved it. */
  | {
      type: "handed";
      via: "plan" | "message";
      text: string;
      body?: string;
      path?: string;
      note?: string;
      origin: HandedOrigin;
      /** what the origin's chat attached for the piece, carried on this message */
      attachments?: AttachmentRef[];
      ts: number;
    }
  /** A message Toyon sent the agent itself, to fix what `why` names. It opens a turn the way a
   * person's message does, but it is its own event so that nothing reading what the person said
   * ever takes it for their words: `text` is what the agent was told, and the chat shows `why`. */
  | ({ type: "fix-asked"; text: string; ts: number } & Asked)
  | { type: "turn-start"; ts: number }
  /** `messageId` names the agent's message the chunk belongs to, when it says. A message sent
   * mid-reply lands in the transcript between that reply's chunks, and the id is what tells the
   * rest of the reply apart from the answer to the message. */
  | { type: "text-delta"; text: string; messageId?: string }
  | { type: "thinking-delta"; text: string }
  /** `parentToolId` is the call that spawned this one: a subagent's own tools arrive in the same
   * session as everything else, and only the id ties them to the row that started them. `subagent`
   * marks that spawning row itself. Both are absent for an agent that does not report either. */
  | {
      type: "tool-start";
      toolId: string;
      name: string;
      input: unknown;
      kind?: ToolKind;
      title?: string;
      parentToolId?: string;
      subagent?: boolean;
    }
  /** the agent refined a running tool call (a placeholder title became the real one, input arrived).
   * `background`: the call's own process has exited and what it started (a server put in the
   * background with `&`) is still running, so the row stays open for that, and its stop kills it. */
  | {
      type: "tool-update";
      toolId: string;
      name?: string;
      title?: string;
      input?: unknown;
      kind?: ToolKind;
      background?: boolean;
    }
  /** prose a subagent wrote, going to the row that spawned it rather than the transcript. It reads
   * as the main agent's own writing anywhere else, and the panel is where the rest of that call's
   * work already is. Superseded by the `tool-end` output, which is the report it finished with. */
  | { type: "tool-delta"; toolId: string; text: string }
  /** `images` are the pictures the call returned, which the row shows in place of output it has
   * none of: a read of a png says nothing in words. `detached` is a spawn whose call returned with
   * its subagent launched and still to do its work. `fixable` is the daemon's word that the
   * failure can be handed to the agent. `cut` says the call never ran: a message steered into
   * the turn pre-empted the agent while it was writing the call, and the daemon ended it once
   * the agent moved on (acp/map.ts). It carries no output, and the shell draws no row for it. */
  | {
      type: "tool-end";
      toolId: string;
      output?: string;
      isError?: boolean;
      images?: ToolImage[];
      detached?: boolean;
      fixable?: Fixable;
      cut?: true;
    }
  /** The turn's last event, always: one per turn-start. `stopReason` is the agent's (ACP's
   * end_turn, max_tokens, refusal, ...) or the daemon's: `interrupted` for a stop, `failed` when
   * the turn ended in an error (the agent-error row before it says what), `auth` when it was
   * refused for want of a credential (the card before it says which), `lost` when the daemon
   * went away under the turn (written when the transcript is next opened). */
  | { type: "turn-end"; stopReason: string; ts: number }
  /** the agent's running figures after a reply: context tokens in use of the window's size, and
   * the session's spend so far when the agent prices itself (Claude does; a rate-limit notice
   * carries no cost). Cumulative on purpose: a turn's cost is the difference from the last one. */
  | { type: "usage"; used: number; size: number; cost?: number; ts: number }
  | { type: "session-info"; sessionId: string; model?: string; effort?: string }
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
      /** a method the agent offered is not in the list: the managed policy turned the plan sign-in
       * off, and the card says so rather than leaving a person to wonder where the button went */
      withheld?: boolean;
      /** the credential that lapsed is the agent's AWS session (Claude on Bedrock), so the methods
       * are the daemon's own, an `aws sso login` and the setting that makes the next one the
       * agent's job, not the agent's advertised logins */
      provider?: "aws";
      /** the provider's own words for the lapse, read off the failed turn; on the card rather than
       * an error row of their own, since the card's title already says what happened */
      detail?: string;
      /** the refresh command the agent's settings already carry: the agent ran it and still had
       * no session, so the card names it instead of offering to set it */
      refresh?: string;
      ts: number;
    }
  | { type: "agent-auth-ok"; ts: number }
  | { type: "agent-blocked"; tool: string; path: string; reason: string; ts: number }
  /** a graft appended another worktree's transcript here: what follows, up to the next marker or
   * the next message someone types, was said in that worktree before it was merged in and removed */
  | { type: "grafted"; title: string; branch: string; ts: number }
  /** a land put this worktree's work on main: the daemon's word on it, kept on the transcript so
   * the row reads back after a reload. `mark` is the landing as the record keeps it, what landed
   * included; absent on a row written before marks said so */
  | { type: "landed"; message: string; mark?: LandMark; ts: number }
  /** a worktree made from a piece of this one's work has landed; `url` is its pull request when
   * the landing was one. Kept on the transcript so the row reads back after a reload, and read by
   * the next prompt so the agent here hears it too. `same`: a sibling of this project, not work in
   * another one. `again`: the branch this worktree waited for before it started landed once more,
   * with follow-up commits; written on the waiting worktree's own transcript. */
  | {
      type: "handoff-landed";
      worktreeId: string;
      repoName: string;
      title: string;
      url?: string;
      same?: true;
      again?: true;
      ts: number;
    }
  /** the agent handed Toyon the pieces of its plan. `held`: proposed in plan mode, so the list
   * shows beside the next plan card of the turn (`agent-permission.pieces`) and the person answers
   * it with the plan; without it the proposal is Toyon's own card at once. Open until a
   * `pieces-go`, `pieces` or `pieces-declined` with the same id. `plan` is the file the section
   * sits on: the agent's plan when held, else the page Toyon wrote for the list. */
  | {
      type: "pieces-proposed";
      id: string;
      pieces: Piece[];
      mode: PermissionMode;
      held?: true;
      plan?: string;
      /** read off the plan by Toyon on the quick model, when the agent handed nothing over */
      by?: "toyon";
      /** a Toyon-read list: a hash of the plan text it was read from, which a later change to
       * the file is measured against (the card's own text is the agent's proposal, which a list
       * read again has already moved past) */
      read?: string;
      ts: number;
    }
  /** a held proposal whose turn ended with no plan card: Toyon's own card from here */
  | { type: "pieces-shown"; id: string; plan?: string; ts: number }
  /** the plan file moved under an open list: the rows were read off a plan that is no longer
   * the one on disk. A list Toyon read is read again after this; the agent's is only marked. */
  | { type: "pieces-stale"; id: string; ts: number }
  /** the person moved a piece; the last one per piece stands when go is pressed */
  | { type: "pieces-fate"; id: string; pieceId: string; fate: PieceFate; ts: number }
  /** the plan was approved, or go pressed: the card closes here and Toyon acts */
  | { type: "pieces-go"; id: string; ts: number }
  /** what became of each piece */
  | { type: "pieces"; id: string; outcomes: PieceOutcome[]; ts: number }
  /** the card closed with nothing done: the plan was sent back, or `outcome` says what failed */
  | { type: "pieces-declined"; id: string; outcome?: "failed"; reason?: string; ts: number }
  /** a queued piece's sibling landed and its worktree was made */
  | { type: "piece-made"; id: string; pieceId: string; worktreeId: string; title: string; ts: number }
  /** a queued piece will never be made: the sibling it waited for is gone */
  | { type: "piece-dropped"; id: string; pieceId: string; reason: string; ts: number }
  /** a restore brought this worktree back from the archive: the daemon's word on it, kept on the
   * transcript so the chat reads why it stops and picks up again. `archivedAt` is when it went,
   * `branch` what the commits came back on (a new name when the old one was taken meanwhile), and
   * `uncommitted` whether kept changes were put back over them */
  | { type: "restored"; archivedAt: number; branch: string; uncommitted: boolean; ts: number }
  /** toyon took over a worktree it did not make: the daemon's word on it, the first thing on the
   * transcript, so the chat says how the row came to be here and on whose `branch` */
  | { type: "adopted"; branch: string; ts: number }
  /** the agent asked something and its turn is blocked until the answer goes back. `toolId` ties
   * the card to the tool row the agent emitted just before it, which the card then replaces.
   * Always followed by an agent-ask-end. */
  | { type: "agent-question"; id: string; message: string; questions: AskQuestion[]; toolId?: string; ts: number }
  /** The agent wants a decision it will not make for itself. `title` is always prose: the agent's
   * own sentence for a command where it wrote one, the call's name otherwise. `command` is the
   * command a yes would run, kept apart from the title so the card can set it in the code face
   * under the sentence, the way the call's row does once it ran. `detail` is markdown (the plan,
   * an edit's diff). `plan` is where that markdown was written in the worktree, so the card hands
   * it to the editor pane to be read as a document instead of scrolled inside itself. A plan whose
   * file could not be written carries none and is read from `detail` on the card, as every plan
   * was before. */
  | {
      type: "agent-permission";
      id: string;
      title: string;
      command?: string;
      detail?: string;
      plan?: string;
      /** the `pieces-proposed` this plan card carries beside it: the list the yes also answers */
      pieces?: string;
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

/** one line of a worktree's transcript: the daemon numbers each event as it lands, and the number
 * is what a backfill, a live frame and a chat search all name a row by */
export type TranscriptEntry = { seq: number; event: AgentEvent };

/** the entries with each run of adjacent text or thinking deltas folded into one, keeping the run's
 * first seq. A streamed reply is a delta per token, so a whole long session sent raw is a frame of
 * tens of thousands of entries and a fold in the shell that copies the chat once per token; the
 * shell joins adjacent deltas into one row anyway, so what it renders is the same. The first seq is
 * the row's name: the shell stamps it when the run's first delta lands, a chat search names the row
 * by it, and it stays put while the run is still streaming. The shell runs the same fold over the
 * tail it keeps of a chat, so a cap on that tail counts rows and not tokens. */
export function coalesce(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    const { event } = entry;
    if (event.type === "text-delta" && last?.event.type === "text-delta" && last.event.messageId === event.messageId) {
      // a run is one message: the shell opens a row per message id, and a fold across two ids
      // would hand it back one row on reload
      out[out.length - 1] = { seq: last.seq, event: { ...last.event, text: last.event.text + event.text } };
    } else if (event.type === "thinking-delta" && last?.event.type === "thinking-delta") {
      out[out.length - 1] = { seq: last.seq, event: { type: "thinking-delta", text: last.event.text + event.text } };
    } else if (event.type === "tool-delta" && last?.event.type === "tool-delta" && last.event.toolId === event.toolId) {
      // a watched command's output arrives a chunk at a time the same way
      out[out.length - 1] = { seq: last.seq, event: { ...event, text: last.event.text + event.text } };
    } else {
      out.push(entry);
    }
  }
  return out;
}
