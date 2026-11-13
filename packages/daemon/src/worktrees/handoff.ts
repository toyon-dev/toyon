// Handoff: a plan's work across worktrees. The agent hands Toyon a list of pieces through its own
// tool (`handoff`), beside its plan or during a reply, and each piece goes on this worktree, a new
// worktree of this project or of another open one, or an open worktree already working on that
// part. Nothing starts until the person says so: in plan mode the list rides beside the next plan
// card and the plan's yes is its yes; otherwise it is a card of Toyon's own. A piece's text is the
// plan its worktree is born with. The list's whole state lives on the origin's transcript: a
// proposal is open from its `handoff-proposed` until a `handoff-go`, `handoff` or `handoff-declined`
// with the same id, and the fates the person pressed are `handoff-fate` events, the last one per
// piece standing. A piece that waits for a sibling to land is held on the origin's record, so it
// survives a restart and leaves with the origin. A piece sent to an open worktree leaves its
// sender on that worktree's record, for the landing there to tell.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  AttachmentInput,
  AttachmentRef,
  HandedOrigin,
  LandMark,
  Piece,
  PieceFate,
  PieceOutcome,
  QueuedPiece,
  RepoInfo,
  WorktreeInfo,
} from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, HANDOFF_TOOL, isBusy, pieceDoc } from "@toyon/shared";
import type { AgentAdapter } from "../agent/adapter.ts";
import type { AttachmentStore } from "../agent/attachments.ts";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { listDoc, planEdited, writePlanDocNow } from "../agent/planDoc.ts";
import {
  handedPrompt,
  handoffActedPrompt,
  handoffDeclinedPrompt,
  type PieceOrigin,
  pieceAskPrompt,
  pieceSendPrompt,
  pieceWakePrompt,
} from "../agent/prompt.ts";
import type { ReadPiece } from "../agent/tasks.ts";
import { isMessage, type TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { NAME_SHAPE, overNameShape, sentenceCase, titleFrom } from "./naming.ts";
import { matchBy, PER_TURN_MAX, proposedThisTurn } from "./proposals.ts";
import type { CreateOpts } from "./service.ts";
import type { RowCounts } from "./treeState.ts";

/** the origin as the chat the piece lands in names it: kept whole, since the row outlives the
 * origin, and with the project's name when the piece crossed into another one */
export function handedOrigin(origin: WorktreeInfo, project: string | undefined): HandedOrigin {
  return {
    id: origin.id,
    repoId: origin.repoId,
    branch: origin.branch,
    title: origin.title,
    ...(project ? { project } : {}),
  };
}

export interface HandoffDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor" | "ensureAgent">;
  /** what a sent message carried, as something a new message can carry again */
  attachments: Pick<AttachmentStore, "reattach">;
  /** WorktreeService.create, as a closure: the two services must not import each other */
  create: (repoId: string, prompt: string, opts: CreateOpts) => Promise<WorktreeInfo>;
  /** WorktreeService.markPrompted, as a closure: a piece sent to an open worktree is a hand
   * putting work into it, and the rail sorts on that stamp */
  prompted: (worktreeId: string) => void;
  /** the rail's numbers for a worktree as its tree was last read (WorktreeService.tree.counts);
   * nothing for a tree never read */
  counts: (worktreeId: string) => RowCounts | undefined;
  /** the pieces a plan names, read off its text on the quick model (tasks.ts); null where the
   * agent has no quick model, or the plan is one piece of work */
  reader: (wt: WorktreeInfo, markdown: string) => Promise<ReadPiece[] | null>;
  /** the title of an archived worktree, by its id: how a wait names a worktree that has gone */
  archivedTitle: (worktreeId: string) => string | undefined;
}

type Proposed = Extract<AgentEvent, { type: "handoff-proposed" }>;
type PieceLanded = Extract<AgentEvent, { type: "piece-landed" }>;

/** A landing as another worktree's chat is told of it. `to` is the worktree told: a landing in
 * its own project is a sibling's, one elsewhere is named with its project. `mark` is the landing
 * the op wrote, so the word says what main received; `why` is what the landing is to `to` when it
 * is more than a piece of its work closing. */
function pieceLanded(
  landed: WorktreeInfo,
  repo: RepoInfo,
  to: WorktreeInfo,
  mark: LandMark | undefined,
  why: Pick<PieceLanded, "again" | "awaited" | "sent"> = {},
): PieceLanded {
  return {
    type: "piece-landed",
    worktreeId: landed.id,
    repoName: repo.name,
    title: landed.title,
    ...(landed.pr?.url ? { url: landed.pr.url } : {}),
    ...(mark?.subjects.length ? { subjects: mark.subjects } : {}),
    ...(to.repoId === landed.repoId ? { same: true as const } : {}),
    ...why,
    ts: Date.now(),
  };
}

/** one piece as the tool or the verb hands it in, before anything is checked */
export interface RawPiece {
  title: string;
  plan: string;
  /** the attachments of this chat it needs, by their labels in the prompt ("Image 2") */
  attachments?: string[];
  where: "here" | "worktree" | "send";
  /** `worktree`: the branch it waits for, another piece of the list by its title, or "this" for
   * the origin itself */
  after?: string;
  /** `send`: the open worktree it goes to, by branch or title */
  to?: string;
  /** another open project, by name or path: the worktree is made there, or `to` is one of its */
  project?: string;
}

/** the caps keep a runaway agent from filling the list; six is what a person reads beside a plan */
export const PIECES_MAX = 6;
const PLAN_MAX = 20_000;
const ATTACH_MAX = 10;
const PROJECT_MAX = 200;

const refused = (text: string): McpToolResult => ({ text, isError: true });

/** The tool as the agent reads it, with the worktrees (`branch, "title"`) and projects it can name
 * right now. The one description of the tool's fields: the handoff eval serves this same tool to
 * a real agent, so what it measures is what the daemon says. */
export function handoffTool(worktrees: readonly string[], projects: readonly string[]): McpTool {
  const open = worktrees.length
    ? `Open worktrees of this project you can name in \`after\` or \`to\`: ${worktrees.join("; ")}.`
    : "No other worktree of this project is open right now.";
  const elsewhere = projects.length
    ? ` Other projects open in Toyon you can name in \`project\`: ${projects.join(", ")}.`
    : "";
  return {
    name: HANDOFF_TOOL,
    description: `Hand Toyon the pieces of the work you are planning, or one piece you came across: each goes on this worktree, a new worktree of this project or of another open one, or an open worktree already on that part; the person decides on the list beside your plan. Nothing starts. When the person asks to split off, spin off or break out part of the work, or to put it in its own worktree, this is the tool. ${open}${elsewhere}`,
    inputSchema: {
      type: "object",
      properties: {
        pieces: {
          type: "array",
          minItems: 1,
          maxItems: PIECES_MAX,
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: `A name for the piece, the way a teammate would say it: ${NAME_SHAPE}. It titles the worktree.`,
              },
              plan: {
                type: "string",
                description:
                  "The plan its agent builds from, in markdown that stands on its own: what is needed and why, the paths that depend on it, and what done looks like.",
              },
              attachments: {
                type: "array",
                items: { type: "string" },
                description:
                  'The attachments from this chat the piece needs, by their labels as captioned: "Image 2", "Paste 1".',
              },
              where: {
                type: "string",
                enum: ["here", "worktree", "send"],
                description:
                  "here: you do it in this worktree. worktree: a new worktree, of this project or of the one `project` names. send: an open worktree already working on that part.",
              },
              after: {
                type: "string",
                description:
                  'worktree: what the piece waits for before it starts: a branch, another piece of this list by its title, or "this" for your own branch. here: what your own work on the piece waits for, a branch or another piece of this list; Toyon shows the wait under the box until it lands.',
              },
              to: { type: "string", description: "send only: the open worktree it goes to, by branch or title." },
              project: {
                type: "string",
                description:
                  "Another project open in Toyon, by its name as listed or its path: the worktree is made there, or `to` is one of its worktrees. Leave out for this project.",
              },
            },
            required: ["title", "plan", "where"],
            additionalProperties: false,
          },
        },
      },
      required: ["pieces"],
      additionalProperties: false,
    },
  };
}

/** The call's arguments as pieces, or why they are refused: the shape alone, since the client's
 * own check cannot be relied on. What the pieces name (a sibling, a project, an attachment) is
 * checked against the chat by `propose`. */
export function parsePieces(args: unknown): { pieces: RawPiece[] } | { refused: string } {
  const shape = `handoff takes { pieces: [{ title: string, plan: string, where: "here" | "worktree" | "send", attachments?: string[], after?: string, to?: string, project?: string }] }, 1 to ${PIECES_MAX} pieces.`;
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
  const list = a && Array.isArray(a.pieces) ? (a.pieces as unknown[]) : null;
  if (!list || list.length === 0) return { refused: shape };
  const pieces: RawPiece[] = [];
  for (const raw of list) {
    const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const shaped =
      p &&
      typeof p.title === "string" &&
      typeof p.plan === "string" &&
      (p.where === "here" || p.where === "worktree" || p.where === "send") &&
      (p.attachments === undefined ||
        (Array.isArray(p.attachments) && p.attachments.every((l) => typeof l === "string"))) &&
      (p.after === undefined || typeof p.after === "string") &&
      (p.to === undefined || typeof p.to === "string") &&
      (p.project === undefined || typeof p.project === "string");
    if (!shaped) return { refused: shape };
    pieces.push({
      title: p.title as string,
      plan: p.plan as string,
      where: p.where as RawPiece["where"],
      ...(p.attachments ? { attachments: p.attachments as string[] } : {}),
      ...(p.after !== undefined ? { after: p.after as string } : {}),
      ...(p.to !== undefined ? { to: p.to as string } : {}),
      ...(p.project !== undefined ? { project: p.project as string } : {}),
    });
  }
  return { pieces };
}

/** the tool's reply in plan mode; exported for the eval, which answers a real agent with it */
export const HELD =
  "Handed to the person; the list shows beside your plan and they decide where each piece goes. Ask for plan approval now.";
/** The reply outside plan mode when a piece is the agent's own: the person may move any piece, so
 * the agent waits for the answer, and the go starts the turn that builds it (act). */
const SHOWN = "Handed to the person as a card; they decide. Finish your turn.";
/** The reply when nothing on the list is the agent's: a go on such a list starts no turn here, so
 * an agent told to stop would leave the work it already had until the person wrote again. A piece
 * the person moves here reaches it as a message once its turn ends (act). */
const SHOWN_AWAY =
  "Handed to the person as a card; they decide, and none of it is yours unless Toyon says they kept it here. Do not wait for their answer: go on with the work you already have that does not depend on it, and finish your turn when that is done.";
const SHOWN_HERE =
  "Handed to the person as a card. This worktree holds no work yet, so the card leads with doing it here; they decide. Finish your turn.";

type PlanCard = Extract<AgentEvent, { type: "agent-permission" }>;

/** the plan card open on a chat, if one is: an `agent-permission` with a plan and no end yet */
export function openPlanCard(entries: readonly TranscriptEntry[]): PlanCard | null {
  const open = new Map<string, PlanCard>();
  for (const { event } of entries) {
    if (event.type === "agent-permission" && event.plan) open.set(event.id, event);
    else if (event.type === "agent-ask-end") open.delete(event.id);
  }
  return [...open.values()].at(-1) ?? null;
}

/** The text of a plan's section, as the plan a piece read off the plan starts from: the heading
 * line and everything under it up to the next heading of the same or a higher level. The heading
 * is matched loosely, since the model quotes it from memory: case and punctuation aside, the
 * same, else the heading containing the name, else the name containing a heading long enough to
 * be a name and not a word (a plan titled "Rail" would otherwise be the whole plan of its rail
 * section). An exact match anywhere wins over a loose one earlier. Null when nothing matches. */
export function sectionText(markdown: string, heading: string): string | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const want = norm(heading);
  if (!want) return null;
  const lines = markdown.split("\n");
  const heads: Array<{ i: number; level: number; have: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i] ?? "");
    const have = m ? norm(m[2] ?? "") : "";
    if (m && have) heads.push({ i, level: m[1]!.length, have });
  }
  const rungs: Array<(have: string) => boolean> = [
    (have) => have === want,
    (have) => have.includes(want),
    (have) => have.length >= 12 && want.includes(have),
  ];
  for (const rung of rungs) {
    const hit = heads.find((h) => rung(h.have));
    if (!hit) continue;
    const { i, level } = hit;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = /^(#{1,6})\s/.exec(lines[j] ?? "");
      if (n && n[1]!.length <= level) {
        end = j;
        break;
      }
    }
    const text = lines.slice(i, end).join("\n").trim();
    return text.length > PLAN_MAX ? text.slice(0, PLAN_MAX) : text;
  }
  return null;
}

/** the plan text as a list remembers it, for the stale check: trimmed, so a trailing newline the
 * editor adds is no move */
export function hashText(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex").slice(0, 16);
}

/** the held list still waiting for a plan card: one shown as Toyon's own card keeps `held` on its
 * event but belongs to no card, so it is not this */
export function heldUnshown(entries: readonly TranscriptEntry[]): Proposed | null {
  const shown = new Set<string>();
  for (const { event } of entries) if (event.type === "handoff-shown") shown.add(event.id);
  return openHandoff(entries).find((p) => p.held && !shown.has(p.id)) ?? null;
}

/** the proposals on a transcript nothing has closed, newest last */
export function openHandoff(entries: readonly TranscriptEntry[]): Proposed[] {
  const open = new Map<string, Proposed>();
  for (const { event } of entries) {
    if (event.type === "handoff-proposed") open.set(event.id, event);
    else if (event.type === "handoff-go" || event.type === "handoff" || event.type === "handoff-declined")
      open.delete(event.id);
  }
  return [...open.values()];
}

/** The file a list sits on, as the transcript names it: the page Toyon wrote when the list was
 * proposed as its own card or shown as one after its turn, else the plan of the card a held list
 * rode beside, which is the only place a held list's file is named. A sibling's pointer reads
 * the whole picture there. */
export function listFile(entries: readonly TranscriptEntry[], id: string): string | undefined {
  let file: string | undefined;
  for (const { event } of entries) {
    if ((event.type === "handoff-proposed" || event.type === "handoff-shown") && event.id === id && event.plan) {
      file = event.plan;
    } else if (event.type === "agent-permission" && event.handoff === id && event.plan) file = event.plan;
  }
  return file;
}

/** where the piece stands as go is pressed: the last fate the person set, else the agent's */
export function effectiveFate(entries: readonly TranscriptEntry[], proposal: Proposed, piece: Piece): PieceFate {
  let fate: PieceFate = piece.fate;
  for (const { event } of entries) {
    if (event.type === "handoff-fate" && event.id === proposal.id && event.pieceId === piece.id) fate = event.fate;
  }
  return fate;
}

/** The fates the person pressed on the last list, by piece title, when that list went back with
 * its plan: a held list the no took with it, or one Toyon read again because the plan moved.
 * The next list is that plan's next draft, so a piece with the same title is the same piece and
 * the person's word on it stands; a list they answered as a card (not now) was an answer, and
 * nothing carries from it. */
export function pressedOnSentBack(entries: readonly TranscriptEntry[]): Map<string, PieceFate> {
  const pressed = new Map<string, PieceFate>();
  const last = entries.findLast(({ event }) => event.type === "handoff-proposed")?.event;
  if (last?.type !== "handoff-proposed" || !last.held) return pressed;
  let back = false;
  for (const { event } of entries) {
    if (event.type === "handoff-shown" && event.id === last.id) return pressed;
    if (event.type === "handoff-declined" && event.id === last.id) back = !event.outcome;
  }
  if (!back) return pressed;
  for (const { event } of entries) {
    if (event.type === "handoff-fate" && event.id === last.id) {
      const title = last.pieces.find((p) => p.id === event.pieceId)?.title;
      if (title) pressed.set(title.toLowerCase(), event.fate);
    }
  }
  return pressed;
}

/** why a piece cannot become `fate` as proposed, or null when it can */
export function fateRefused(proposed: Proposed, piece: Piece, fate: PieceFate): string | null {
  if (fate === "send" && !piece.to) return "That piece has no worktree to send to";
  // go acts in list order, so a worktree piece waiting for one later on the list would be made
  // before its wait exists and start at once, while the row still said queued
  const after = piece.after;
  if (fate === "worktree" && after && "piece" in after) {
    const at = proposed.pieces.findIndex((p) => p.id === piece.id);
    if (proposed.pieces.findIndex((p) => p.id === after.piece) > at) {
      return "That piece waits for one later on the list, so it is done here or skipped";
    }
  }
  if (piece.fate === "send" && (fate === "here" || fate === "worktree")) {
    return "A piece for an open worktree is sent there or skipped";
  }
  return null;
}

/** the attachment a label in the prompt names: the kind's word and its number per kind, as
 * the prompt captions them */
const LABEL = /^(image|paste|pasted text|file|element)\s+(\d+)$/i;
const KIND_OF: Record<string, AttachmentRef["kind"]> = {
  image: "image",
  paste: "paste",
  "pasted text": "paste",
  file: "file",
  element: "pick",
};

/** a worktree as a piece names it, on the list and on the record */
type Named = { id: string; branch: string; title: string };
/** one entry of a worktree's `awaits`, with the pieces always on it when written here */
type Awaits = { id: string; pieces: string[] };

/** a landing a wake tells of: the branch and, when it is not this project's, its project.
 * `pieces` are the worktree's own that waited for it; `handed` is a piece it handed off and set
 * nothing to wait for, whose landing its agent is started on all the same; `sent` is the same
 * for a piece it sent into the landed worktree. */
type Woke = {
  title: string;
  branch: string;
  url?: string;
  project?: string;
  pieces: string[];
  handed?: true;
  sent?: true;
};

/** the landed worktree as a wake in `to` names it */
function wokeBy(landed: WorktreeInfo, repo: RepoInfo, to: WorktreeInfo): Omit<Woke, "pieces" | "handed" | "sent"> {
  return {
    title: landed.title,
    branch: landed.branch,
    ...(landed.pr?.url ? { url: landed.pr.url } : {}),
    ...(to.repoId === landed.repoId ? {} : { project: repo.name }),
  };
}

/** what a piece became in one pass of go, for the pieces of the list that wait on it */
type Became = { fate: PieceFate; worktree?: Named; queued?: true };

export class HandoffService implements ToolProvider {
  /** the landings each worktree is to be woken for once its turn ends, by worktree (wake) */
  private wakes = new Map<string, Woke[]>();

  constructor(private d: HandoffDeps) {
    d.hub.on("handoffDecided", (worktreeId, id, approved) =>
      fireAndForget(
        worktreeId,
        approved ? this.act(worktreeId, id, undefined, true) : this.decline(worktreeId, id),
        "handoff",
      ),
    );
    d.hub.on("planUnsplit", (worktreeId, markdown, planPath) =>
      fireAndForget(worktreeId, this.read(worktreeId, markdown, planPath), "pieces read off the plan"),
    );
    d.hub.on("treeChanged", (worktreeId) => fireAndForget(worktreeId, this.stale(worktreeId), "pieces stale"));
    d.hub.on("landed", (worktreeId, mark) =>
      fireAndForget(worktreeId, this.landed(worktreeId, mark), "pieces after landing"),
    );
    d.hub.on("worktreesChanged", () => this.sweep());
    this.sweep();
  }

  /** the other open worktrees of a project a piece may wait for or be sent to */
  private siblings(wt: WorktreeInfo, repoId = wt.repoId): WorktreeInfo[] {
    return this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind === "worktree" && w.id !== wt.id);
  }

  /** Whether a piece can be sent to a row, or its agent started on a landing: its work is not
   * done. A landed row is done until it goes on, and the landed mark cannot say when it has: it
   * reads commits alone, so a row with files in its tree or a turn running still carries it. The
   * files are the rail's last read. */
  private takesSend(w: WorktreeInfo): boolean {
    if (!w.landed) return true;
    return (this.d.counts(w.id)?.dirty ?? 0) > 0 || isBusy(this.d.runtime.agentFor(w.id)?.status);
  }

  /** the projects a piece can cross into: every open one but the worktree's own */
  private otherProjects(wt: WorktreeInfo): RepoInfo[] {
    return this.d.state.repos.filter((r) => r.id !== wt.repoId);
  }

  /** The project a name or a path means. Names are the checkout's directory name, so two open
   * projects can share one; a path settles it, and the refusal for an ambiguous name says so. A
   * unique prefix is enough, as it is in the shell's own picker. Never the worktree's own project,
   * which a piece reaches by naming none. */
  resolveProject(wt: WorktreeInfo, project: string): { repo: RepoInfo } | { refused: string } {
    const q = project.trim();
    const others = this.otherProjects(wt);
    if (others.length === 0) return { refused: "no other project is open in Toyon." };
    const names = others.map((r) => r.name).join(", ");
    if (!q) return { refused: `name the project. Open projects: ${names}.` };
    const found = matchRepos(others, q);
    if (found.length === 1) return { repo: found[0]! };
    if (found.length > 1) {
      return {
        refused: `"${q}" names more than one open project: ${found.map((r) => r.path).join(", ")}. Say which by its path.`,
      };
    }
    const own = this.d.state.repo(wt.repoId);
    if (own && matchRepos([own], q).length === 1) {
      return { refused: `${own.name} is this worktree's own project; leave \`project\` out for a worktree here.` };
    }
    return { refused: `no open project is called "${q}". Open projects: ${names}.` };
  }

  /** the tool as the agent sees it, listed with the worktrees and projects it can name right now */
  tool(worktreeId: string): McpTool {
    const wt = this.d.state.worktree(worktreeId);
    // the rows a send reaches: a landed row at rest is nothing to send to or to wait for
    const open = wt ? this.siblings(wt).filter((w) => this.takesSend(w)) : [];
    const names = open.map((w) => `${w.branch}, "${w.title}"`);
    const projects = wt ? this.otherProjects(wt).map((r) => r.name) : [];
    return handoffTool(names, projects);
  }

  /** a call from the agent, over MCP: the shape is checked here, since the client's own check
   * cannot be relied on, and then it is a proposal like the person's */
  async call(worktreeId: string, args: unknown): Promise<McpToolResult> {
    const pieces = parsePieces(args);
    if ("refused" in pieces) return refused(pieces.refused);
    return this.propose(worktreeId, pieces.pieces, "agent");
  }

  /** A proposal onto the chat. Held beside the next plan card in plan mode, Toyon's own card
   * otherwise, with the pieces written as a page for the section to sit on. One open list per
   * chat: a list the agent hands over again replaces the one still held for a plan card, since
   * the new one is its word now, and a list already shown as a card is the person's to answer
   * first. The turn's allowance caps how many an agent may raise. */
  async propose(
    worktreeId: string,
    raw: RawPiece[],
    by: "agent" | "person" | "toyon" = "agent",
    /** a Toyon-read list: the hash of the plan text it was read from */
    read?: string,
  ): Promise<McpToolResult> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) throw new UserError("that chat is gone");
    if (raw.length > PIECES_MAX)
      return refused(`At most ${PIECES_MAX} pieces in one list; fold the rest into \`here\`.`);
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    const pieces: Piece[] = [];
    /** the titles cut to the shape, for the reply: the agent goes on naming its pieces by title */
    const cut: string[] = [];
    for (const [i, p] of raw.entries()) {
      // the title is a row's name beside the namer's: the same case
      let title = sentenceCase(p.title.trim());
      const plan = p.plan.trim();
      if (!title) return refused(`Piece ${i + 1} has no title.`);
      if (!plan) return refused(`Piece ${i + 1} ("${title}") has no plan; write the plan its agent builds from.`);
      // A title over the shape is cut to it as a prompt's first words are, and marked
      // provisional: the worktree is named from the plan by the namer when it is made, as any
      // row is. Not refused: a refusal costs the agent a whole new call with every plan typed
      // again, twenty seconds and more for three words.
      const over = overNameShape(title);
      const provisional = over !== null;
      if (over) {
        title = titleFrom(title);
        cut.push(
          `piece ${i + 1} shows as "${title}" until its worktree is named (its title ${over.slice(0, over.indexOf(";"))})`,
        );
      }
      if (plan.length > PLAN_MAX) {
        return refused(`Piece ${i + 1}'s plan is over ${PLAN_MAX} characters; cut it to what its agent needs.`);
      }
      if ((p.attachments?.length ?? 0) > ATTACH_MAX) {
        return refused(`Piece ${i + 1} names more than ${ATTACH_MAX} attachments.`);
      }
      if ((p.project?.length ?? 0) > PROJECT_MAX) return refused(`Piece ${i + 1}'s project name is too long.`);
      const attachments: AttachmentRef[] = [];
      for (const label of p.attachments ?? []) {
        const ref = attachmentNamed(entries, label);
        if (!ref)
          return refused(`This chat has no attachment "${label.trim()}"; name them as the messages caption them.`);
        attachments.push(ref);
      }
      const piece: Piece = {
        id: `p${i + 1}`,
        title,
        ...(provisional ? { provisional: true } : {}),
        plan,
        attachments,
        fate: p.where,
      };
      if (p.project !== undefined) {
        if (p.where === "here") return refused(`Piece ${i + 1} ("${title}") is \`here\` and names a project.`);
        const found = this.resolveProject(wt, p.project);
        if ("refused" in found) return refused(`Piece ${i + 1} ("${title}"): ${found.refused}`);
        piece.project = { id: found.repo.id, name: found.repo.name };
      }
      if (p.where === "send" && p.after !== undefined) {
        return refused(`Piece ${i + 1} ("${title}") has \`after\`, which a \`send\` piece does not take.`);
      }
      if (p.where !== "send" && p.to !== undefined) {
        return refused(`Piece ${i + 1} ("${title}") has \`to\`, which only a \`send\` piece takes.`);
      }
      if (p.after !== undefined) {
        const q = p.after.trim();
        if (!q)
          return refused(`Piece ${i + 1} ("${title}") has a blank \`after\`; name what it waits for, or leave it out.`);
        // a worktree piece waits for one made earlier in the same pass; the origin's own work is
        // not made at all, so it may wait for any other piece of the list, wherever it stands
        const after = this.resolveAfter(wt, raw, i, q, p.where === "here");
        if ("refused" in after) return refused(`Piece ${i + 1} ("${title}"): ${after.refused}`);
        if (p.where === "here" && !("piece" in after.after) && after.after.id === wt.id) {
          return refused(`Piece ${i + 1} ("${title}") is \`here\` and waits for its own branch.`);
        }
        if (p.where === "here" && "piece" in after.after) {
          // the origin's own work waits for a worktree: not for another piece of its own, which
          // lands with it, and not for a piece that waits for the origin in turn, which is a cycle
          // nothing would break
          const on = raw[Number(after.after.piece.slice(1)) - 1]!;
          const onTitle = sentenceCase(on.title.trim());
          if (on.where === "here") {
            return refused(
              `Piece ${i + 1} ("${title}") waits for "${onTitle}", which is \`here\` too and lands with it.`,
            );
          }
          const back = on.after?.trim() ?? "";
          const bare = back.startsWith("@") ? back.slice(1) : back;
          const onOrigin =
            bare !== "" &&
            (bare === "this" ||
              bare === wt.branch ||
              raw.some((o) => o.where === "here" && matchBy([o], bare, [(x) => x.title.trim()]).length > 0));
          if (onOrigin) {
            return refused(`Piece ${i + 1} ("${title}") waits for "${onTitle}", which waits for this branch: a cycle.`);
          }
        }
        piece.after = after.after;
      }
      if (p.where === "send") {
        const q = p.to?.trim() ?? "";
        if (!q) return refused(`Piece ${i + 1} ("${title}") is \`send\` and names no worktree in \`to\`.`);
        const all = this.siblings(wt, piece.project?.id);
        const found = this.named(
          all.filter((w) => this.takesSend(w)),
          q,
          piece.project?.name,
          all.filter((w) => !this.takesSend(w)),
        );
        if ("refused" in found) return refused(`Piece ${i + 1} ("${title}"): ${found.refused}`);
        piece.to = found.worktree;
      }
      pieces.push(piece);
    }
    // the agent's own earlier list, still waiting for its plan card, gives way to the new one;
    // any other open list is the person's to answer first
    const waiting = heldUnshown(entries);
    const replaced = openHandoff(entries).filter((o) => by === "agent" && o.id === waiting?.id && o.by !== "toyon");
    if (openHandoff(entries).some((o) => !replaced.includes(o))) {
      return refused("A pieces list is already waiting for the person on this chat; finish your turn.");
    }
    // the person's own proposals are gated by the open card alone: no turn of theirs to finish.
    // Before the held list goes, so a refusal here leaves the agent its last list.
    if (by === "agent" && proposedThisTurn(entries) >= PER_TURN_MAX) {
      return refused(
        `${PER_TURN_MAX} proposals were made this turn already; finish your turn and let the person answer.`,
      );
    }
    for (const o of replaced) {
      agent.note({ type: "handoff-declined", id: o.id, reason: "handed over again", ts: Date.now() });
    }
    // the agent's list in plan mode rides the plan card it is about to ask for, and one Toyon read
    // off the plan rides the card that is up; the person's own (the verb) has no card coming and
    // is a card of its own at once
    const held = by !== "person" && wt.mode === "plan";
    const here = by === "agent" && !held && this.offerHere(wt, pieces);
    if (here) pieces[0]!.fate = "here";
    const plan = held ? null : writePlanDocNow(wt.path, listDoc(pieces));
    // read before the note, so the list sent back is still the last one on the transcript
    const pressed = by === "person" ? new Map<string, PieceFate>() : pressedOnSentBack(entries);
    const proposal: Proposed = {
      type: "handoff-proposed",
      id: randomUUID(),
      pieces,
      mode: wt.mode ?? DEFAULT_PERMISSION_MODE,
      ...(held ? { held: true } : {}),
      ...(plan ? { plan } : {}),
      ...(by === "toyon" ? { by: "toyon" as const } : {}),
      ...(by === "toyon" && read ? { read } : {}),
      ts: Date.now(),
    };
    agent.note(proposal);
    // the person's presses on the list sent back follow the titles onto this one; a press the
    // piece as re-proposed cannot take is left to the agent's word
    for (const piece of pressed.size ? pieces : []) {
      const fate = pressed.get(piece.title.toLowerCase());
      if (fate && fate !== piece.fate && !fateRefused(proposal, piece, fate)) {
        agent.note({ type: "handoff-fate", id: proposal.id, pieceId: piece.id, fate, ts: Date.now() });
      }
    }
    const shown = cut.length ? `${sentenceCase(cut.join("; "))}. ` : "";
    const own = pieces.some((p) => p.fate === "here");
    return { text: shown + (held ? HELD : here ? SHOWN_HERE : own ? SHOWN : SHOWN_AWAY) };
  }

  /** Whether the agent's one offer should open on "do it here". The agent offers what it comes
   * across as `worktree` by rule, since it cannot reliably tell whether its own tree holds
   * anything; Toyon can. A worktree that is clean and level with main would be left empty by a
   * sibling, its chat's context unused, so the card leads with here and the person can still
   * move it. Only a piece that has a here: one for another project, an open worktree or a
   * branch to wait for has none. The numbers are the rail's last read, so a tree never read is
   * not known to be empty. */
  private offerHere(wt: WorktreeInfo, pieces: readonly Piece[]): boolean {
    if (pieces.length !== 1) return false;
    const p = pieces[0]!;
    if (p.fate !== "worktree" || p.project || p.to || p.after) return false;
    const counts = this.d.counts(wt.id);
    return counts?.dirty === 0 && counts.ahead === 0;
  }

  /** What a piece waits for: an earlier piece of the same list by its title, the origin's own
   * branch as "this" or by name, else an open worktree of the project by branch or title. A piece
   * on the list first, since a sibling and a piece can share a name only once the piece has
   * started, by which time the list is answered. Only an earlier one: go acts in list order, so a
   * piece can wait only for what was made or queued before it. */
  private resolveAfter(
    wt: WorktreeInfo,
    raw: readonly RawPiece[],
    at: number,
    q: string,
    /** any other piece of the list may be named, not only one earlier on it */
    anywhere = false,
  ): { after: NonNullable<Piece["after"]> } | { refused: string } {
    const bare = q.startsWith("@") ? q.slice(1) : q;
    const titled = raw.map((p, i) => ({ i, title: p.title.trim() }));
    const onList = matchBy(
      titled.filter((p) => (anywhere ? p.i !== at : p.i < at)),
      bare,
      [(p) => p.title],
    );
    if (onList.length === 1) return { after: { piece: `p${onList[0]!.i + 1}` } };
    if (onList.length > 1)
      return { refused: `"${q}" names more than one piece on the list; give them different titles.` };
    const rest = matchBy(
      titled.filter((p) => (anywhere ? p.i === at : p.i >= at)),
      bare,
      [(p) => p.title],
    );
    if (rest.length > 0) {
      return {
        refused: anywhere
          ? `"${q}" is this piece itself.`
          : `"${q}" is this piece or a later one; a piece waits only for one earlier on the list.`,
      };
    }
    if (bare === "this" || bare === wt.branch) return { after: { id: wt.id, branch: wt.branch, title: wt.title } };
    const found = this.named(this.siblings(wt), bare);
    if ("refused" in found) return found;
    return { after: found.worktree };
  }

  /** the worktree a branch or a title names, on the ladder the project picker uses; `where` is
   * the project as the refusal names it. `done` is the rows left out of `among` for having landed:
   * a name that only they answer to is refused as landed, since "none is called that" reads as a
   * wrong name or an archived row, and the row is neither. */
  private named(
    among: readonly WorktreeInfo[],
    q: string,
    where = "this project",
    done: readonly WorktreeInfo[] = [],
  ): { worktree: Named } | { refused: string } {
    const bare = q.startsWith("@") ? q.slice(1) : q;
    const list = among.map((w) => `${w.branch}, "${w.title}"`).join("; ");
    const keys = [(w: WorktreeInfo) => w.branch, (w: WorktreeInfo) => w.title];
    const found = matchBy(among, bare, keys);
    const landed = found.length === 0 ? matchBy(done, bare, keys) : [];
    if (landed.length > 0) {
      const names = landed.map((w) => `"${w.title}" (${w.branch})`).join(", ");
      return {
        refused: `${names} landed and ${landed.length === 1 ? "holds" : "hold"} no new work, so no piece is sent there; a \`worktree\` piece starts a new one.`,
      };
    }
    if (among.length === 0) return { refused: `no other worktree of ${where} is open.` };
    if (found.length === 1) {
      const w = found[0]!;
      return { worktree: { id: w.id, branch: w.branch, title: w.title } };
    }
    if (found.length > 1) {
      return {
        refused: `"${q}" names more than one worktree: ${found.map((w) => w.branch).join(", ")}. Say which by its branch.`,
      };
    }
    return { refused: `no open worktree of ${where} is called "${q}". Open: ${list}.` };
  }

  /** the person moved a piece: recorded, so every tab sees it, and read when go is pressed */
  fate(worktreeId: string, id: string, pieceId: string, fate: PieceFate): void {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) throw new UserError("that chat is gone");
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const proposed = openHandoff(agent.transcript()).find((p) => p.id === id);
    if (!proposed) throw new UserError("That list is not open in this chat");
    const piece = proposed.pieces.find((p) => p.id === pieceId);
    if (!piece) throw new UserError("That piece is not on the list");
    const refusedWhy = fateRefused(proposed, piece, fate);
    if (refusedWhy) throw new UserError(refusedWhy);
    agent.note({ type: "handoff-fate", id, pieceId, fate, ts: Date.now() });
  }

  /** the answer to Toyon's own card: go acts on the list as the fates stand, not go closes it,
   * and words typed with either go with it */
  async answer(worktreeId: string, id: string, go: boolean, note?: string): Promise<void> {
    if (!this.d.state.worktree(worktreeId)) throw new UserError("that chat is gone");
    if (go) await this.act(worktreeId, id, note?.trim() || undefined);
    else await this.decline(worktreeId, id, undefined, note?.trim() || undefined);
  }

  /** the list closes with nothing done: the plan was sent back, the card was pressed not go, or
   * `reason` says what stopped the go. A held list has no file of its own, and the plan it sat on
   * is the agent's to rewrite now, so its pieces are written as a page the row keeps. `note` is
   * what the person typed with not now: the agent's turn ends without the answer, so the words
   * start one, the way a plan card's no carries what to change. A bare not now tells it
   * nothing, since a turn begun to say nothing happened is noise. */
  async decline(worktreeId: string, id: string, reason?: string, note?: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    const proposed = openHandoff(entries).find((p) => p.id === id);
    if (!proposed) return log.debug(worktreeId, `decline for a pieces list that already closed (${id})`);
    const plan = listFile(entries, id) ? null : writePlanDocNow(wt.path, listDoc(proposed.pieces));
    agent.note({
      type: "handoff-declined",
      id,
      ...(reason ? { outcome: "failed" as const, reason } : {}),
      ...(note ? { note } : {}),
      ...(plan ? { plan } : {}),
      ts: Date.now(),
    });
    if (!note) return;
    // the card goes up as the handoff call answers, so the agent may still be on that turn, and a
    // message steered into it would abort the call in flight: the words wait for the turn to end
    const text = handoffDeclinedPrompt(proposed.pieces, note);
    fireAndForget(
      wt.id,
      this.idle(wt.id, agent).then(() =>
        agent.send(text, {
          asked: { kind: "handoff", why: "the list was sent back with a note, so the agent reads it before going on" },
          keepCards: true,
        }),
      ),
      "pieces declined",
    );
  }

  /** The yes. The go is on the transcript before anything slow starts, so the card closes on
   * every tab at once; then each piece in list order, on its own, so one that fails is one outcome
   * and not the end of the list: `here` and `skip` are nothing to do, `send` is a message into
   * the open worktree, `worktree` is a worktree made now or queued behind what it waits for. A
   * piece that waits for another on the list waits for that one's worktree, made or queued
   * earlier in the same pass, which is why the order matters. `tell`: the list went with a plan's
   * yes, so the agent is about to build and is told what the list started elsewhere, steered into
   * that turn once the card's answer is on the wire. Toyon's own card is answered between turns,
   * so the message starts one, and only when a piece is the agent's own to build now. */
  async act(worktreeId: string, id: string, note?: string, tell = false): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    const proposed = openHandoff(entries).find((p) => p.id === id);
    if (!proposed) return log.debug(worktreeId, `go for a pieces list that already closed (${id})`);
    agent.note({ type: "handoff-go", id, ...(note ? { note } : {}), ts: Date.now() });
    try {
      const repo = this.d.state.repo(wt.repoId);
      if (!repo) throw new UserError(`${wt.title}'s project is no longer open in Toyon`);
      const origin = this.originOf(wt, repo.name, listFile(entries, id));
      const outcomes: PieceOutcome[] = [];
      const became = new Map<string, Became>();
      for (const piece of proposed.pieces) {
        const fate = effectiveFate(entries, proposed, piece);
        let outcome: PieceOutcome;
        try {
          outcome = await this.actOn(wt, origin, proposed, piece, fate, note, became);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          log.warn(worktreeId, `piece "${piece.title}" (${fate}) failed`, e);
          became.set(piece.id, { fate: "skip" });
          outcome = { pieceId: piece.id, fate, error };
        }
        outcomes.push(outcome);
        // the row names each worktree as it comes up, so the person watches the list start
        // rather than reading one sentence once it is all done
        agent.note({ type: "handoff-piece", id, outcome, ts: Date.now() });
      }
      // the origin's own pieces wait for what the rest of the list became, which is known only
      // once the whole list was acted on: a here piece may name any other piece, later ones too
      const awaits: Awaits[] = [];
      for (const o of outcomes) {
        if (o.fate !== "here") continue;
        const piece = proposed.pieces.find((p) => p.id === o.pieceId);
        if (!piece) continue;
        const wait = this.hereWait(proposed, piece, became);
        if (!wait) continue;
        o.after = wait.said;
        if (wait.queued) this.waitOnQueued(wt.id, proposed.id, wait.queued, piece.title);
        if (!wait.worktree) continue;
        const known = awaits.find((a) => a.id === wait.worktree?.id);
        if (known) known.pieces.push(piece.title);
        else awaits.push({ id: wait.worktree.id, pieces: [piece.title] });
      }
      agent.note({ type: "handoff", id, outcomes, ts: Date.now() });
      this.recordAwaits(wt.id, awaits);
      if (tell && outcomes.some((o) => o.fate !== "here")) {
        // the card's answer must be on the wire before anything is steered into the turn it
        // releases: a steer that lands while the plan tool is still being answered aborts the
        // tool, and the approval with it (session.ts, sayPlanEdited). The card closes on the
        // transcript as it is answered, so wait for that, then a beat for the write.
        for (let i = 0; i < 30 && openPlanCard(agent.transcript()); i++) await Bun.sleep(100);
        await Bun.sleep(100);
        agent.send(handoffActedPrompt(proposed.pieces, outcomes), {
          asked: { kind: "handoff", why: "what the handoff started, so the agent builds only its own piece" },
          keepCards: true,
        });
      } else if (!tell && outcomes.some((o) => o.fate === "here" && !o.after)) {
        // Toyon's own card is not a turn's, so a piece kept here starts one: the agent was told
        // to finish its turn when it handed off, and until it builds its piece nothing queued behind
        // this branch can start. A piece here that waits for a sibling waits for its word. The
        // card goes up as the handoff call answers, so the agent may still be on that turn, and a
        // message steered into it would abort the call in flight: the message waits for the
        // turn to end, off this call, which answers the card now.
        const text = handoffActedPrompt(proposed.pieces, outcomes, "card", note);
        fireAndForget(
          wt.id,
          this.idle(wt.id, agent).then(() =>
            agent.send(text, {
              asked: { kind: "handoff", why: "the piece kept here, so the agent starts on it" },
              keepCards: true,
            }),
          ),
          "pieces here",
        );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      agent.note({ type: "handoff-declined", id, outcome: "failed", reason, ts: Date.now() });
      throw e;
    }
  }

  /** A plan card went up with no list for it: read the pieces off the plan on the quick model and
   * hold them beside that card. Only while the card is still up and no list arrived meanwhile; a
   * plan that reads as one piece of work gets nothing. */
  async read(worktreeId: string, markdown: string, planPath: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    if (openHandoff(agent.transcript()).length > 0) return;
    const found = await this.d.reader(wt, markdown);
    if (!found || found.length < 2) return;
    // the card may have been answered while the model read: a list held now would wait for a
    // card that is not coming
    const card = openPlanCard(agent.transcript());
    if (!card || card.plan !== planPath || openHandoff(agent.transcript()).length > 0) return;
    await this.proposeRead(wt, markdown, found);
  }

  /** The pieces read off a plan as a held list on the chat, the plan's text hashed onto the list
   * for the stale check. A piece's text is its section of the plan, verbatim, when the heading it
   * names is its alone; a section two parts share (rows of one table, say) or none at all is the
   * model's own plan for the part, never the whole plan and never one section twice. An `after`
   * the model made up (a sibling piece's name, which is no branch yet) is dropped rather than
   * refusing the list: the piece starts at once, and the person can see as much on the row. */
  private async proposeRead(wt: WorktreeInfo, markdown: string, found: ReadPiece[]): Promise<Proposed | null> {
    const siblings = this.siblings(wt);
    const known = (q: string) =>
      q === "this" || q === wt.branch || !("refused" in this.named(siblings, q.startsWith("@") ? q.slice(1) : q));
    const sections = new Map<string, number>();
    for (const p of found) sections.set(p.section, (sections.get(p.section) ?? 0) + 1);
    const raw = found.map((p): RawPiece => {
      const own = sections.get(p.section) === 1 ? sectionText(markdown, p.section) : null;
      const plan = own ?? p.plan ?? sectionText(markdown, p.section) ?? `${p.title}\n\n${p.section}`;
      const after = p.where === "worktree" && p.after && known(p.after) ? p.after : undefined;
      return { title: p.title, plan, where: p.where, ...(after ? { after } : {}) };
    });
    const r = await this.propose(wt.id, raw, "toyon", hashText(markdown));
    if (r.isError) {
      log.warn(wt.id, `the list read off the plan was refused: ${r.text}`);
      return null;
    }
    const agent = this.d.runtime.agentFor(wt.id);
    return agent ? (openHandoff(agent.transcript()).find((p) => p.by === "toyon") ?? null) : null;
  }

  /** The plan file moved under an open held list: mark the list stale, and a list Toyon read is
   * read again from the file as it stands. The agent's own list is only marked, since the agent
   * hands over again when it re-plans. Run on every tree
   * change of a watched worktree, so the gates come first: a held list exists only in plan mode,
   * and one already shown as Toyon's own card belongs to no plan card. Everything it needs is on
   * the transcript, so a restart changes nothing. */
  async stale(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (wt?.mode !== "plan") return;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) return;
    const entries = agent.transcript();
    const open = heldUnshown(entries);
    if (!open) return;
    if (entries.some(({ event }) => event.type === "handoff-stale" && event.id === open.id)) return;
    const card = openPlanCard(entries);
    if (!card?.plan || !card.detail) return;
    let markdown: string;
    try {
      markdown = readFileSync(join(wt.path, card.plan), "utf8");
    } catch (e) {
      log.warn(worktreeId, `could not read ${card.plan} to see whether the plan moved`, e);
      return;
    }
    // a Toyon-read list is measured against the text it was read from; the agent's against the
    // plan it proposed, which is the card's text
    const moved = open.read ? hashText(markdown) !== open.read : planEdited(wt.path, card.plan, card.detail);
    if (!moved) return;
    agent.note({ type: "handoff-stale", id: open.id, ts: Date.now() });
    if (open.by !== "toyon") return;
    const found = await this.d.reader(wt, markdown);
    if (!found || found.length < 2) return;
    if (openPlanCard(agent.transcript())?.id !== card.id) return;
    // the fates pressed follow the titles onto the list read again, as onto any list after one
    // sent back (propose)
    agent.note({ type: "handoff-declined", id: open.id, reason: "the plan changed; read again", ts: Date.now() });
    await this.proposeRead(wt, markdown, found);
  }

  /** The verb: the person wants part of this work done in a new worktree of project `repoId`,
   * this one or another open one. With the tool in the agent's hands the agent is asked to
   * propose it, so the plan is its own account of the work, with the person's words carried;
   * without the tool the card is raised from those words alone. */
  async ask(worktreeId: string, repoId: string, text?: string): Promise<void> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const repo = this.d.state.repo(repoId);
    if (!repo) throw new UserError("no such project");
    const here = repo.id === wt.repoId;
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    // whether the agent has the tool is only known once its process is up
    if (agent.mcpTools === null) await agent.warm();
    if (agent.mcpTools === true) {
      agent.send(pieceAskPrompt(text, here ? undefined : repo), {
        asked: { kind: "handoff", why: here ? "a new worktree here" : `a new worktree in ${repo.name}` },
      });
      return;
    }
    const own = text?.trim();
    if (!own) throw new UserError(`Write what ${here ? "the new worktree" : repo.name} should do first`);
    const r = await this.propose(
      worktreeId,
      [{ title: titleFrom(own), plan: own, where: "worktree", ...(here ? {} : { project: repo.path }) }],
      "person",
    );
    if (r.isError) throw new UserError(r.text);
  }

  /** the pointer a piece carries: the origin, and the file its list sits on. That file, not the
   * record's plan: outside plan mode the record's plan is whatever an earlier plan card left there,
   * and a sibling sent to read it would read the wrong picture */
  private originOf(wt: WorktreeInfo, project: string, file: string | undefined): PieceOrigin {
    return { path: wt.path, project, branch: wt.branch, ...(file ? { plan: file } : {}) };
  }

  private async actOn(
    wt: WorktreeInfo,
    origin: PieceOrigin,
    proposed: Proposed,
    piece: Piece,
    fate: PieceFate,
    note: string | undefined,
    became: Map<string, Became>,
  ): Promise<PieceOutcome> {
    const crossed = piece.project ? { repoName: piece.project.name } : {};
    if (fate === "here" || fate === "skip") {
      became.set(piece.id, { fate });
      // what a here piece waits for is filled in once the whole list was acted on (act)
      return { pieceId: piece.id, fate };
    }
    if (fate === "send") {
      const target = piece.to ? this.d.state.worktree(piece.to.id) : undefined;
      const repoId = piece.project?.id ?? wt.repoId;
      if (target?.kind !== "worktree" || target.repoId !== repoId) {
        throw new UserError(`"${piece.to?.title ?? "the worktree"}" is no longer open`);
      }
      const attachments = await this.reattachAll(wt.id, piece.attachments);
      this.d.runtime.ensureAgent(target).agent.send(pieceSendPrompt(piece.plan, note, origin), {
        keepCards: true,
        ...(attachments.length ? { attachments } : {}),
        handed: {
          via: "message",
          body: piece.plan,
          origin: handedOrigin(wt, piece.project ? origin.project : undefined),
          ...(note ? { note } : {}),
        },
      });
      // the press put work into the target, so its row moves up the rail like a composer send's
      this.d.prompted(target.id);
      this.recordSender(target, wt.id);
      became.set(piece.id, { fate, worktree: { id: target.id, branch: target.branch, title: target.title } });
      return { pieceId: piece.id, fate, worktreeId: target.id, title: target.title, ...crossed };
    }
    const waits = this.waitsFor(wt, piece, became);
    if (waits) {
      // refs, not inputs: an adopted upload expires long before a land, and the refs read back
      // from the store whenever the sibling is made
      const queued: QueuedPiece = {
        proposalId: proposed.id,
        pieceId: piece.id,
        title: piece.title,
        ...(piece.provisional ? { provisional: true } : {}),
        plan: piece.plan,
        after: waits,
        ...(piece.project ? { project: piece.project } : {}),
        attachments: piece.attachments,
        ...(note ? { note } : {}),
        queuedAt: Date.now(),
      };
      const live = this.d.state.requireWorktree(wt.id);
      live.queued = [...(live.queued ?? []), queued];
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      became.set(piece.id, { fate, queued: true });
      // what the row says it waits for: a branch, or a piece of the list still to be made
      const after =
        "piece" in waits
          ? (proposed.pieces.find((p) => p.id === waits.piece)?.title ?? waits.piece)
          : (this.d.state.worktree(waits.id)?.branch ?? waits.id);
      return { pieceId: piece.id, fate, after, ...crossed };
    }
    const made = await this.make(wt, origin, piece, note);
    became.set(piece.id, { fate, worktree: { id: made.id, branch: made.branch, title: made.title } });
    return { pieceId: piece.id, fate, worktreeId: made.id, title: made.title, ...crossed };
  }

  /** What the origin's own work on a here piece still waits for as go runs, or null to start it
   * now: a branch it named that is open and has not landed; a piece of the list by the worktree
   * it became in this pass, made or sent on; a piece itself queued, by the piece, until it is
   * made. A piece skipped or failed, or a branch landed or gone, is nothing to wait for. `said`
   * is the wait in the row's words, a branch or a piece's title; `worktree` the one to record,
   * `queued` the piece to record it on once it is made (waitOnQueued). */
  private hereWait(
    proposed: Proposed,
    piece: Piece,
    became: Map<string, Became>,
  ): { said: string; worktree?: Named; queued?: string } | null {
    const after = piece.after;
    if (!after) return null;
    if (!("piece" in after)) {
      const w = this.d.state.worktree(after.id);
      return w?.kind === "worktree" && !w.landed ? { said: after.branch, worktree: after } : null;
    }
    const on = became.get(after.piece);
    const said = proposed.pieces.find((p) => p.id === after.piece)?.title ?? after.piece;
    if (on?.worktree) return { said, worktree: on.worktree };
    if (on?.queued) return { said, queued: after.piece };
    return null;
  }

  /** a here piece that waits for a piece still queued is named on that piece's record: there is
   * no worktree to await yet, and the landing that makes one moves the wait onto `awaits` */
  private waitOnQueued(originId: string, proposalId: string, pieceId: string, here: string): void {
    const q = this.d.state
      .worktree(originId)
      ?.queued?.find((q) => q.proposalId === proposalId && q.pieceId === pieceId);
    if (!q) return;
    q.heres = [...new Set([...(q.heres ?? []), here])];
    this.d.state.save();
  }

  /** resolves once the worktree's agent is between turns: at once when it is, else on the first
   * status that says so. A worktree removed meanwhile never says so, and the listener stays; one
   * closure, once per go, which is nothing. */
  private idle(worktreeId: string, agent: Pick<AgentAdapter, "status">): Promise<void> {
    if (!isBusy(agent.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.d.hub.on("agentStatus", (id, status) => {
        if (id !== worktreeId || isBusy(status)) return;
        off();
        resolve();
      });
    });
  }

  /** The sender of a piece sent to an open worktree, onto that worktree's record, once however
   * many pieces it sent: the target's next landing is the one that can carry them, and reads the
   * record to tell the sender (tellSenders). On the target's record, so it survives a restart
   * and leaves with the target, which then has no landing to tell of. */
  private recordSender(target: WorktreeInfo, senderId: string): void {
    if (target.senders?.includes(senderId)) return;
    target.senders = [...(target.senders ?? []), senderId];
    this.d.state.save();
  }

  /** The worktrees the origin's own work waits for, by its here pieces, onto its record (hereWait).
   * The landing reads the record to tell the origin and start it (tellAwaiting). A worktree
   * already waited for keeps the pieces that waited, with the new ones. */
  private recordAwaits(originId: string, awaits: readonly Awaits[]): void {
    if (awaits.length === 0) return;
    const live = this.d.state.requireWorktree(originId);
    const kept = live.awaits ?? [];
    live.awaits = [
      ...kept.filter((a) => !awaits.some((b) => b.id === a.id)),
      ...awaits.map((b) => {
        const had = kept.find((a) => a.id === b.id)?.pieces ?? [];
        return { ...b, pieces: [...new Set([...had, ...b.pieces])] };
      }),
    ];
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** What a `worktree` piece still has to wait for as go runs, or null to make it now. A branch
   * it named that has not landed; a piece of the list made into a worktree in this pass, by that
   * worktree; a piece itself queued, by the piece, until it is made; a piece kept here, by the
   * origin's own branch; a piece sent on, by the worktree it went to; a piece skipped or failed,
   * nothing. */
  private waitsFor(wt: WorktreeInfo, piece: Piece, became: Map<string, Became>): QueuedPiece["after"] | null {
    const after = piece.after;
    if (!after) return null;
    if (!("piece" in after)) {
      const waits = this.d.state.worktree(after.id);
      return waits && waits.kind === "worktree" && !waits.landed ? { id: after.id } : null;
    }
    const on = became.get(after.piece);
    if (!on) return null;
    if (on.queued) return { piece: after.piece };
    if (on.worktree) return { id: on.worktree.id };
    if (on.fate === "here") return { id: wt.id };
    return null;
  }

  /** the worktree for a piece, born with the piece's text as its plan, the origin pointer as its
   * first message, and what the origin's chat attached; on the origin's agent, model and effort
   * (the picks for new worktrees of that agent stand in where the origin named none), in its write
   * mode (a plan it was given is approved by the go, so never in plan mode), cold until someone
   * looks at it. In the origin's project, or in the one the piece named. */
  private async make(
    origin: WorktreeInfo,
    at: PieceOrigin,
    piece: Pick<Piece, "title" | "provisional" | "plan" | "attachments" | "project">,
    note: string | undefined,
    after?: { id: string },
  ): Promise<WorktreeInfo> {
    const repoId = piece.project?.id ?? origin.repoId;
    if (piece.project && !this.d.state.repo(repoId)) {
      throw new UserError(`${piece.project.name} is no longer open in Toyon`);
    }
    // right before the create, since the create's send is what holds the uploads
    const attachments = await this.reattachAll(origin.id, piece.attachments);
    const mode = origin.mode === "plan" ? "auto" : origin.mode;
    const via = piece.project ? "project" : "piece";
    // A provisional title is the agent's cut to the shape, so the row is born as one from a
    // prompt is: the title stands until the namer answers, from the title and the plan, with
    // the title first so the row and the card read the same until then. No createdBy: the row
    // is nobody's to jump to, and the person stays put.
    const task = piece.provisional ? `${piece.title}\n\n${piece.plan}` : piece.title;
    return this.d.create(repoId, task, {
      ...(piece.provisional ? {} : { title: piece.title }),
      // the person chose these for the origin, and a sibling of it is the same work: without them
      // the agent would fall back to its own defaults, a different model than the one planning
      ...(origin.agent ? { agent: origin.agent } : {}),
      ...(origin.model ? { model: origin.model } : {}),
      ...(origin.effort ? { effort: origin.effort } : {}),
      ...(mode ? { mode } : {}),
      ...(attachments.length ? { attachments } : {}),
      from: {
        kind: "worktree",
        ref: origin.branch,
        origin: { id: origin.id, repoId: origin.repoId },
        ...(at.plan ? { plan: at.plan } : {}),
        ...(after ? { after } : {}),
      },
      plan: {
        markdown: pieceDoc(piece),
        // the text rides on the record too: what a search, a recap and the archive's row read
        handed: {
          via: "plan",
          body: piece.plan,
          origin: handedOrigin(origin, piece.project ? at.project : undefined),
          ...(note ? { note } : {}),
        },
        // a tree that would not take the file gets the plan in the message itself
        prompt: (path) =>
          path ? handedPrompt(path, note, at, via) : `${pieceDoc(piece)}\n${handedPrompt(null, note, at, via)}`,
      },
      cold: true,
    });
  }

  private async reattachAll(worktreeId: string, refs: readonly AttachmentRef[]): Promise<AttachmentInput[]> {
    const out: AttachmentInput[] = [];
    for (const ref of refs) {
      const again = await this.d.attachments.reattach(worktreeId, ref);
      if (again) out.push(again);
      else log.warn(worktreeId, `a piece's attachment is gone from the store (${ref.kind} ${ref.n})`);
    }
    return out;
  }

  /** A worktree landed. The worktree it came from, when a piece made it, is told on its chat and
   * in its agent's next prompt, and so is each worktree that sent a piece into it since it last
   * landed (tellSenders). Every piece queued behind it, on any origin, is made now and that
   * origin's chat told, a piece waiting on one of those re-pointed at the worktree made; one that
   * could not be made is dropped with the reason, and what waited on it goes too. Then every
   * worktree that waited for this branch before it started hears that it landed again. Each of
   * them is told what landed, from the landing's `mark`. */
  async landed(landedId: string, mark?: LandMark): Promise<void> {
    const told = new Set<string>();
    const origin = this.tellOrigin(landedId, mark);
    if (origin) told.add(origin);
    const senders = this.tellSenders(landedId, told, mark);
    // the worktrees this landing makes waited for it by design: this is their first word, not again
    const madeNow = new Set<string>();
    for (const origin of this.d.state.worktrees) {
      const due = origin.queued?.filter((q) => !("piece" in q.after) && q.after.id === landedId) ?? [];
      if (due.length === 0) continue;
      const repo = this.d.state.repo(origin.repoId);
      origin.queued = origin.queued?.filter((q) => !due.includes(q));
      if (origin.queued?.length === 0) delete origin.queued;
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      const agent = this.d.runtime.ensureAgent(origin).agent;
      for (const q of due) {
        try {
          if (!repo) throw new UserError("the project is no longer open in Toyon");
          const at = this.originOf(origin, repo.name, listFile(agent.transcript(), q.proposalId));
          const made = await this.make(origin, at, q, q.note, "piece" in q.after ? undefined : q.after);
          agent.note({
            type: "piece-made",
            id: q.proposalId,
            pieceId: q.pieceId,
            worktreeId: made.id,
            title: made.title,
            ts: Date.now(),
          });
          madeNow.add(made.id);
          this.repoint(origin, q, { id: made.id });
          if (q.heres?.length) this.recordAwaits(origin.id, [{ id: made.id, pieces: q.heres }]);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log.warn(origin.id, `queued piece "${q.title}" could not be made`, e);
          agent.note({ type: "piece-dropped", id: q.proposalId, pieceId: q.pieceId, reason, ts: Date.now() });
          this.dropDependents(origin, q);
        }
      }
    }
    for (const id of this.tellWaiters(landedId, madeNow, mark)) told.add(id);
    const awaited = this.tellAwaiting(landedId, told, mark);
    // an origin started as one is not started again as a sender, in the same message
    const woken = origin && !awaited.has(origin) && this.wakeHanded(origin, landedId) ? origin : null;
    for (const id of senders) if (id !== woken && !awaited.has(id)) this.wakeHanded(id, landedId, true);
  }

  /** The origin of a piece is started when the piece first lands, though nothing of its own was
   * set to wait: handing the work off was the ask, and the landing is the answer, which its agent
   * takes up or says it has no use for. Without this the answer sits until the person next writes
   * there. Only the first landing: what that worktree lands later is its own follow-up, which
   * rides the next prompt as a note. `sent`: the same for the sender of a piece sent into the
   * landed worktree, at whichever landing follows the send, since the record names a sender for
   * one landing alone. Not a worktree whose own piece still waits for another branch: that
   * landing starts it, on a prompt that carries this one's note. Never one whose own work is
   * done. Says whether it was started. */
  private wakeHanded(toId: string, landedId: string, sent = false): boolean {
    const to = this.d.state.worktree(toId);
    const landed = this.d.state.worktree(landedId);
    const repo = landed ? this.d.state.repo(landed.repoId) : undefined;
    if (to?.kind !== "worktree" || !landed || !repo) return false;
    if (to.awaits?.length || !this.takesSend(to)) return false;
    if (!sent && (landed.lands?.length ?? 0) > 1) return false;
    this.wake(to, this.d.runtime.ensureAgent(to).agent, {
      ...wokeBy(landed, repo, to),
      pieces: [],
      ...(sent ? { sent: true as const } : { handed: true as const }),
    });
    return true;
  }

  /** every worktree whose own work waited for the landed branch (recordAwaits) hears of it, once:
   * not again when the landing already told it as its origin or as a waiter. The record lets the
   * wait go either way, so the line under its box does too. Then its agent is started on the
   * piece, unless the worktree's own work is done. The worktrees that waited are named. */
  private tellAwaiting(landedId: string, told: ReadonlySet<string>, mark?: LandMark): Set<string> {
    const landed = this.d.state.worktree(landedId);
    const repo = landed ? this.d.state.repo(landed.repoId) : undefined;
    const awaited = new Set<string>();
    let changed = false;
    for (const w of this.d.state.worktrees) {
      if (!w.awaits?.some((a) => a.id === landedId)) continue;
      awaited.add(w.id);
      const pieces = w.awaits.filter((a) => a.id === landedId).flatMap((a) => a.pieces ?? []);
      w.awaits = w.awaits.filter((a) => a.id !== landedId);
      if (w.awaits.length === 0) delete w.awaits;
      changed = true;
      if (!landed || !repo || w.kind !== "worktree") continue;
      const agent = this.d.runtime.ensureAgent(w).agent;
      if (!told.has(w.id)) agent.note(pieceLanded(landed, repo, w, mark, { awaited: true }));
      if (this.takesSend(w)) this.wake(w, agent, { ...wokeBy(landed, repo, w), pieces });
    }
    if (changed) {
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    }
    return awaited;
  }

  /** The agent whose own piece waited for the landed branch, or who handed the landed work off
   * or sent a piece into it, is started on it, between turns: the landing's note rides the next prompt, but an agent with
   * nothing else to do sends none, and what is queued behind this branch waits on that piece.
   * Landings during one turn make one wake naming them all, since the first wake's own message
   * would make a second read as told. Nothing is sent when a message went out meanwhile, the
   * person's or Toyon's, which carried the note already, or when the worktree's work was done or
   * the worktree gone by the time the turn ended. */
  private wake(w: WorktreeInfo, agent: AgentAdapter, woke: Woke): void {
    const pending = this.wakes.get(w.id);
    if (pending) return void pending.push(woke);
    this.wakes.set(w.id, [woke]);
    const mark = agent.transcript().length;
    fireAndForget(
      w.id,
      this.idle(w.id, agent).then(() => {
        const landed = this.wakes.get(w.id) ?? [];
        this.wakes.delete(w.id);
        const live = this.d.state.worktree(w.id);
        if (live?.kind !== "worktree" || !this.takesSend(live)) return;
        if (
          agent
            .transcript()
            .slice(mark)
            .some((e) => isMessage(e.event))
        )
          return;
        const titles = landed.map((l) => `"${l.title}"`).join(", ");
        const pieces = new Set(landed.flatMap((l) => l.pieces));
        const why = landed.every((l) => l.handed || l.sent)
          ? `${titles} landed, so the agent takes up what it handed off`
          : `${titles} landed, so the agent starts the ${pieces.size === 1 ? "piece" : "pieces"} that waited`;
        agent.send(pieceWakePrompt(landed), { asked: { kind: "handoff", why }, keepCards: true });
      }),
      "piece woken",
    );
  }

  /** the queued pieces of the same list that waited for `made`'s piece now wait for its worktree */
  private repoint(origin: WorktreeInfo, made: QueuedPiece, worktree: { id: string }): void {
    const live = this.d.state.worktree(origin.id);
    if (!live?.queued) return;
    let changed = false;
    for (const q of live.queued) {
      if (q.proposalId === made.proposalId && "piece" in q.after && q.after.piece === made.pieceId) {
        q.after = worktree;
        changed = true;
      }
    }
    if (changed) {
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    }
  }

  /** a dropped piece takes the pieces that waited on it with it, with the reason on the chat */
  private dropDependents(origin: WorktreeInfo, dropped: QueuedPiece): void {
    const live = this.d.state.worktree(origin.id);
    if (!live?.queued) return;
    const gone = live.queued.filter(
      (q) => q.proposalId === dropped.proposalId && "piece" in q.after && q.after.piece === dropped.pieceId,
    );
    if (gone.length === 0) return;
    live.queued = live.queued.filter((q) => !gone.includes(q));
    if (live.queued.length === 0) delete live.queued;
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
    const agent = this.d.runtime.ensureAgent(live).agent;
    for (const q of gone) {
      agent.note({
        type: "piece-dropped",
        id: q.proposalId,
        pieceId: q.pieceId,
        reason: `the piece it waited for, "${dropped.title}", was dropped`,
        ts: Date.now(),
      });
      this.dropDependents(live, q);
    }
  }

  /** the worktree a landed one came from hears of the landing, on its chat and in its agent's
   * next prompt, and is named; nothing when the origin is gone or was never a worktree. */
  private tellOrigin(landedId: string, mark?: LandMark): string | null {
    const wt = this.d.state.worktree(landedId);
    if (wt?.from?.kind !== "worktree") return null;
    const origin = this.d.state.worktree(wt.from.origin.id);
    if (origin?.kind !== "worktree") return null;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return null;
    this.d.runtime.ensureAgent(origin).agent.note(pieceLanded(wt, repo, origin, mark));
    return origin.id;
  }

  /** every live worktree that waited for the landed branch before it started hears that the
   * branch landed again: follow-ups on it may touch the piece, and the agent reads them off main.
   * Not the ones this landing just made, whose first word it is. The ones told are named. */
  private tellWaiters(landedId: string, madeNow: ReadonlySet<string>, mark?: LandMark): string[] {
    const landed = this.d.state.worktree(landedId);
    if (!landed) return [];
    const repo = this.d.state.repo(landed.repoId);
    if (!repo) return [];
    const told: string[] = [];
    for (const w of this.d.state.worktrees) {
      if (w.kind !== "worktree" || w.landed || w.id === landedId || madeNow.has(w.id)) continue;
      if (w.from?.kind !== "worktree" || w.from.after?.id !== landedId) continue;
      told.push(w.id);
      this.d.runtime.ensureAgent(w).agent.note(pieceLanded(landed, repo, w, mark, { again: true }));
    }
    return told;
  }

  /** Every worktree that sent a piece into the landed one since it last landed hears of the
   * landing, as a send, and joins `told`. Once: not one `told` already as its origin, and not one
   * whose own work waited for it, which tellAwaiting tells in that word. The record lets them all
   * go, told or gone, since a piece sent after this rides the next landing. The senders still
   * open are named, told here or not, for the landing to start. */
  private tellSenders(landedId: string, told: Set<string>, mark?: LandMark): string[] {
    const wt = this.d.state.worktree(landedId);
    if (!wt?.senders) return [];
    const senders = wt.senders;
    delete wt.senders;
    this.d.state.save();
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return [];
    const open: string[] = [];
    for (const id of senders) {
      const sender = this.d.state.worktree(id);
      if (sender?.kind !== "worktree") continue;
      open.push(id);
      if (told.has(id) || sender.awaits?.some((a) => a.id === landedId)) continue;
      told.add(id);
      this.d.runtime.ensureAgent(sender).agent.note(pieceLanded(wt, repo, sender, mark, { sent: true }));
    }
    return open;
  }

  /** a queued piece whose awaited worktree is gone will never be made: dropped, and the origin's
   * chat told why, and the pieces that waited on it with it. One that waits for another piece of
   * its list is left to that piece. Saves and emits only on a change, so the frame this answers
   * to finds nothing more to do. */
  sweep(): void {
    let changed = false;
    for (const origin of this.d.state.worktrees) {
      if (!origin.queued?.length) continue;
      const live = (id: string) => this.d.state.worktree(id)?.kind === "worktree";
      const gone = origin.queued.filter((q) => !("piece" in q.after) && !live(q.after.id));
      if (gone.length === 0) continue;
      origin.queued = origin.queued.filter((q) => !gone.includes(q));
      if (origin.queued.length === 0) delete origin.queued;
      changed = true;
      const agent = this.d.runtime.ensureAgent(origin).agent;
      for (const q of gone) {
        // named from the archive, which keeps the title a removed worktree ended with; one gone
        // from there too goes unnamed
        const title = "piece" in q.after ? undefined : this.d.archivedTitle(q.after.id);
        agent.note({
          type: "piece-dropped",
          id: q.proposalId,
          pieceId: q.pieceId,
          reason: title ? `the worktree it waited for, "${title}", is gone` : "the worktree it waited for is gone",
          ts: Date.now(),
        });
        this.dropDependents(origin, q);
      }
    }
    if (changed) {
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    }
  }
}

/** the repos `q` names: its path or its name, on the ladder every target climbs */
function matchRepos(repos: readonly RepoInfo[], q: string): RepoInfo[] {
  return matchBy(repos, q, [(r) => r.path, (r) => r.name]);
}

/** the attachment a prompt label names, among everything this chat's messages carried: the
 * kind's word and its number per kind, which is how the prompt captions them */
function attachmentNamed(entries: readonly TranscriptEntry[], label: string): AttachmentRef | null {
  const m = LABEL.exec(label.trim());
  if (!m) return null;
  const kind = KIND_OF[m[1]!.toLowerCase()];
  const n = Number(m[2]);
  for (const { event } of entries) {
    if (event.type !== "user-message" && event.type !== "handed") continue;
    const ref = event.attachments?.find((a) => a.kind === kind && a.n === n);
    if (ref) return ref;
  }
  return null;
}
