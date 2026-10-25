// Pieces: a plan's work across worktrees. The agent hands Toyon a list of pieces through its own
// tool (`split`), beside its plan or during a reply, and each piece goes on this worktree, a
// sibling worktree of the project, or an open worktree already working on that part. Nothing
// starts until the person says so: in plan mode the list rides beside the next plan card and the
// plan's yes is its yes; otherwise it is a card of Toyon's own. The list's whole state lives on
// the origin's transcript, as a handoff's does: a proposal is open from its `pieces-proposed`
// until a `pieces-go`, `pieces` or `pieces-declined` with the same id, and the fates the person
// pressed are `pieces-fate` events, the last one per piece standing. A piece that waits for a
// sibling to land is held on the origin's record, so it survives a restart and leaves with it.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  AttachmentInput,
  AttachmentRef,
  Brief,
  Piece,
  PieceFate,
  PieceOutcome,
  QueuedPiece,
  WorktreeInfo,
} from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, SPLIT_TOOL } from "@toyon/shared";
import type { AttachmentStore } from "../agent/attachments.ts";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { briefsDoc, planEdited, writePlanDocNow } from "../agent/planDoc.ts";
import { type PieceOrigin, piecePrompt, pieceSendPrompt, piecesActedPrompt } from "../agent/prompt.ts";
import type { ReadPiece } from "../agent/tasks.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { matchBy, PER_TURN_MAX, proposedThisTurn } from "./proposals.ts";
import type { CreateOpts } from "./service.ts";

/** what the chat the brief lands in shows of it: the origin agent's words and the person's note,
 * and the origin as it is now, since the row keeps it after the origin is gone */
function briefOf(origin: WorktreeInfo, text: string, note: string | undefined, plan: string | undefined): Brief {
  return {
    via: "piece",
    text,
    ...(note ? { note } : {}),
    origin: { id: origin.id, repoId: origin.repoId, branch: origin.branch, title: origin.title },
    ...(plan ? { plan } : {}),
  };
}

export interface PiecesDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor" | "ensureAgent">;
  /** what a sent message carried, as something a new message can carry again */
  attachments: Pick<AttachmentStore, "reattach">;
  /** WorktreeService.create, as a closure: the two services must not import each other */
  create: (repoId: string, prompt: string, opts: CreateOpts) => Promise<WorktreeInfo>;
  /** the pieces a plan names, read off its text on the quick model (tasks.ts); null where the
   * agent has no quick model, or the plan is one piece of work */
  reader: (wt: WorktreeInfo, markdown: string) => Promise<ReadPiece[] | null>;
}

type Proposed = Extract<AgentEvent, { type: "pieces-proposed" }>;

/** one piece as the tool or the verb hands it in, before anything is checked */
export interface RawPiece {
  title: string;
  brief: string;
  /** the attachments of this chat it needs, by their labels in the prompt ("Image 2") */
  attachments?: string[];
  where: "here" | "worktree" | "send";
  /** `worktree`: the branch it waits for, or "this" for the origin itself */
  after?: string;
  /** `send`: the open worktree it goes to, by branch or title */
  to?: string;
}

/** the caps keep a runaway agent from filling the list; six is what a person reads beside a plan */
export const PIECES_MAX = 6;
const TITLE_MAX = 200;
const BRIEF_MAX = 6_000;
const ATTACH_MAX = 10;

const refused = (text: string): McpToolResult => ({ text, isError: true });

const HELD =
  "Handed to the person; the list shows beside your plan and they decide where each piece goes. Ask for plan approval now.";
const SHOWN = "Handed to the person as a card; they decide. Finish your turn.";

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

/** The text of a plan's section, as the brief a piece read off the plan starts from: the heading
 * line and everything under it up to the next heading of the same or a higher level. The heading
 * is matched loosely, since the model quotes it from memory: case and punctuation aside, the
 * same, else the heading containing the name, else the name containing a heading long enough to
 * be a name and not a word (a plan titled "Rail" would otherwise be the whole brief of its rail
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
    return text.length > BRIEF_MAX ? text.slice(0, BRIEF_MAX) : text;
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
function heldUnshown(entries: readonly TranscriptEntry[]): Proposed | null {
  const shown = new Set<string>();
  for (const { event } of entries) if (event.type === "pieces-shown") shown.add(event.id);
  return openPieces(entries).find((p) => p.held && !shown.has(p.id)) ?? null;
}

/** the proposals on a transcript nothing has closed, newest last */
export function openPieces(entries: readonly TranscriptEntry[]): Proposed[] {
  const open = new Map<string, Proposed>();
  for (const { event } of entries) {
    if (event.type === "pieces-proposed") open.set(event.id, event);
    else if (event.type === "pieces-go" || event.type === "pieces" || event.type === "pieces-declined")
      open.delete(event.id);
  }
  return [...open.values()];
}

/** the file a list sits on, as the transcript last named it: the agent's plan on a held list, the
 * briefs Toyon wrote when it was proposed as its own card or shown as one after its turn */
export function listFile(entries: readonly TranscriptEntry[], id: string): string | undefined {
  let file: string | undefined;
  for (const { event } of entries) {
    if ((event.type === "pieces-proposed" || event.type === "pieces-shown") && event.id === id && event.plan) {
      file = event.plan;
    }
  }
  return file;
}

/** where the piece stands as go is pressed: the last fate the person set, else the agent's */
export function effectiveFate(entries: readonly TranscriptEntry[], proposal: Proposed, piece: Piece): PieceFate {
  let fate: PieceFate = piece.fate;
  for (const { event } of entries) {
    if (event.type === "pieces-fate" && event.id === proposal.id && event.pieceId === piece.id) fate = event.fate;
  }
  return fate;
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

export class PiecesService implements ToolProvider {
  constructor(private d: PiecesDeps) {
    d.hub.on("piecesDecided", (worktreeId, id, approved) =>
      fireAndForget(
        worktreeId,
        approved ? this.act(worktreeId, id, undefined, true) : this.decline(worktreeId, id),
        "pieces",
      ),
    );
    d.hub.on("planUnsplit", (worktreeId, markdown, planPath) =>
      fireAndForget(worktreeId, this.read(worktreeId, markdown, planPath), "pieces read off the plan"),
    );
    d.hub.on("treeChanged", (worktreeId) => fireAndForget(worktreeId, this.stale(worktreeId), "pieces stale"));
    d.hub.on("landed", (worktreeId) => fireAndForget(worktreeId, this.landed(worktreeId), "pieces after landing"));
    d.hub.on("worktreesChanged", () => this.sweep());
    this.sweep();
  }

  /** the other worktrees of the origin's project a piece may wait for or be sent to */
  private siblings(wt: WorktreeInfo): WorktreeInfo[] {
    return this.d.state.worktrees.filter((w) => w.repoId === wt.repoId && w.kind === "worktree" && w.id !== wt.id);
  }

  /** the tool as the agent sees it, listed with the sibling worktrees it can name right now */
  tool(worktreeId: string): McpTool {
    const wt = this.d.state.worktree(worktreeId);
    const names = wt ? this.siblings(wt).map((w) => `${w.branch}, "${w.title}"`) : [];
    const open = names.length
      ? `Open worktrees of this project you can name in \`after\` or \`to\`: ${names.join("; ")}.`
      : "No other worktree of this project is open right now.";
    return {
      name: SPLIT_TOOL,
      description: `Hand Toyon the pieces of the work you are planning, or one piece you came across: each goes on this worktree, a new one, or an open one; the person decides on the list beside your plan. Nothing starts. ${open}`,
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
                title: { type: "string", description: "A short name for the piece, a few words." },
                brief: {
                  type: "string",
                  description:
                    "Markdown that stands on its own as a first message: what is needed and why, and the paths that depend on it.",
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
                    "here: you do it in this worktree. worktree: a new sibling worktree of this project. send: an open worktree of this project already working on that part.",
                },
                after: {
                  type: "string",
                  description:
                    'worktree only: the branch the piece must wait for before it starts, or "this" for your own.',
                },
                to: { type: "string", description: "send only: the open worktree it goes to, by branch or title." },
              },
              required: ["title", "brief", "where"],
              additionalProperties: false,
            },
          },
        },
        required: ["pieces"],
        additionalProperties: false,
      },
    };
  }

  /** a call from the agent, over MCP: the shape is checked here, since the client's own check
   * cannot be relied on, and then it is a proposal like the person's */
  async call(worktreeId: string, args: unknown): Promise<McpToolResult> {
    const shape = `split takes { pieces: [{ title: string, brief: string, where: "here" | "worktree" | "send", attachments?: string[], after?: string, to?: string }] }, 1 to ${PIECES_MAX} pieces.`;
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
    const list = a && Array.isArray(a.pieces) ? (a.pieces as unknown[]) : null;
    if (!list || list.length === 0) return refused(shape);
    const pieces: RawPiece[] = [];
    for (const raw of list) {
      const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const shaped =
        p &&
        typeof p.title === "string" &&
        typeof p.brief === "string" &&
        (p.where === "here" || p.where === "worktree" || p.where === "send") &&
        (p.attachments === undefined ||
          (Array.isArray(p.attachments) && p.attachments.every((l) => typeof l === "string"))) &&
        (p.after === undefined || typeof p.after === "string") &&
        (p.to === undefined || typeof p.to === "string");
      if (!shaped) return refused(shape);
      pieces.push({
        title: p.title as string,
        brief: p.brief as string,
        where: p.where as RawPiece["where"],
        ...(p.attachments ? { attachments: p.attachments as string[] } : {}),
        ...(p.after !== undefined ? { after: p.after as string } : {}),
        ...(p.to !== undefined ? { to: p.to as string } : {}),
      });
    }
    return this.propose(worktreeId, pieces, "agent");
  }

  /** A proposal onto the chat. Held beside the next plan card in plan mode, Toyon's own card
   * otherwise, with the briefs written as a file for the section to sit on. One open list per
   * chat, and the turn's allowance is shared with handoff. */
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
    const siblings = this.siblings(wt);
    const pieces: Piece[] = [];
    for (const [i, p] of raw.entries()) {
      const title = p.title.trim();
      const brief = p.brief.trim();
      if (!title) return refused(`Piece ${i + 1} has no title.`);
      if (title.length > TITLE_MAX)
        return refused(`Piece ${i + 1}'s title is over ${TITLE_MAX} characters; a few words.`);
      if (!brief) return refused(`Piece ${i + 1} ("${title}") has no brief; write what its agent starts from.`);
      if (brief.length > BRIEF_MAX) {
        return refused(`Piece ${i + 1}'s brief is over ${BRIEF_MAX} characters; cut it to what its agent needs.`);
      }
      if ((p.attachments?.length ?? 0) > ATTACH_MAX) {
        return refused(`Piece ${i + 1} names more than ${ATTACH_MAX} attachments.`);
      }
      const attachments: AttachmentRef[] = [];
      for (const label of p.attachments ?? []) {
        const ref = attachmentNamed(entries, label);
        if (!ref)
          return refused(`This chat has no attachment "${label.trim()}"; name them as the messages caption them.`);
        attachments.push(ref);
      }
      const piece: Piece = { id: `p${i + 1}`, title, brief, attachments, fate: p.where };
      if (p.where !== "worktree" && p.after !== undefined) {
        return refused(`Piece ${i + 1} ("${title}") has \`after\`, which only a \`worktree\` piece takes.`);
      }
      if (p.where !== "send" && p.to !== undefined) {
        return refused(`Piece ${i + 1} ("${title}") has \`to\`, which only a \`send\` piece takes.`);
      }
      if (p.where === "worktree" && p.after !== undefined) {
        const q = p.after.trim();
        if (!q) return refused(`Piece ${i + 1} ("${title}") has a blank \`after\`; name the branch, or leave it out.`);
        if (q === "this" || q === wt.branch) piece.after = { id: wt.id, branch: wt.branch, title: wt.title };
        else {
          const found = this.named(siblings, q);
          if ("refused" in found) return refused(`Piece ${i + 1} ("${title}"): ${found.refused}`);
          piece.after = found.worktree;
        }
      }
      if (p.where === "send") {
        const q = p.to?.trim() ?? "";
        if (!q) return refused(`Piece ${i + 1} ("${title}") is \`send\` and names no worktree in \`to\`.`);
        const found = this.named(
          siblings.filter((w) => !w.landed),
          q,
        );
        if ("refused" in found) return refused(`Piece ${i + 1} ("${title}"): ${found.refused}`);
        piece.to = found.worktree;
      }
      pieces.push(piece);
    }
    if (openPieces(entries).length > 0) {
      return refused("A pieces list is already waiting for the person on this chat; finish your turn.");
    }
    // the person's own proposals are gated by the open card alone: no turn of theirs to finish
    if (by === "agent" && proposedThisTurn(entries) >= PER_TURN_MAX) {
      return refused(
        `${PER_TURN_MAX} proposals were made this turn already; finish your turn and let the person answer.`,
      );
    }
    // the agent's list in plan mode rides the plan card it is about to ask for, and one Toyon read
    // off the plan rides the card that is up; the person's own (the verb aimed at this project)
    // has no card coming and is a card of its own at once
    const held = by !== "person" && wt.mode === "plan";
    const plan = held ? null : writePlanDocNow(wt.path, briefsDoc(pieces));
    agent.note({
      type: "pieces-proposed",
      id: randomUUID(),
      pieces,
      mode: wt.mode ?? DEFAULT_PERMISSION_MODE,
      ...(held ? { held: true } : {}),
      ...(plan ? { plan } : {}),
      ...(by === "toyon" ? { by: "toyon" as const } : {}),
      ...(by === "toyon" && read ? { read } : {}),
      ts: Date.now(),
    });
    return { text: held ? HELD : SHOWN };
  }

  /** the worktree a branch or a title names, on the ladder the handoff's project picker uses */
  private named(
    among: readonly WorktreeInfo[],
    q: string,
  ): { worktree: { id: string; branch: string; title: string } } | { refused: string } {
    const bare = q.startsWith("@") ? q.slice(1) : q;
    const list = among.map((w) => `${w.branch}, "${w.title}"`).join("; ");
    if (among.length === 0) return { refused: "no other worktree of this project is open." };
    const found = matchBy(among, bare, [(w) => w.branch, (w) => w.title]);
    if (found.length === 1) {
      const w = found[0]!;
      return { worktree: { id: w.id, branch: w.branch, title: w.title } };
    }
    if (found.length > 1) {
      return {
        refused: `"${q}" names more than one worktree: ${found.map((w) => w.branch).join(", ")}. Say which by its branch.`,
      };
    }
    return { refused: `no open worktree of this project is called "${q}". Open: ${list}.` };
  }

  /** the person moved a piece: recorded, so every tab sees it, and read when go is pressed */
  fate(worktreeId: string, id: string, pieceId: string, fate: PieceFate): void {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) throw new UserError("that chat is gone");
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const proposed = openPieces(agent.transcript()).find((p) => p.id === id);
    if (!proposed) throw new UserError("That list is not open in this chat");
    const piece = proposed.pieces.find((p) => p.id === pieceId);
    if (!piece) throw new UserError("That piece is not on the list");
    if (fate === "send" && !piece.to) throw new UserError("That piece has no worktree to send to");
    if (piece.fate === "send" && (fate === "here" || fate === "worktree")) {
      throw new UserError("A piece for an open worktree is sent there or skipped");
    }
    agent.note({ type: "pieces-fate", id, pieceId, fate, ts: Date.now() });
  }

  /** the answer to Toyon's own card: go acts on the list as the fates stand, not go closes it */
  async answer(worktreeId: string, id: string, go: boolean, note?: string): Promise<void> {
    if (!this.d.state.worktree(worktreeId)) throw new UserError("that chat is gone");
    if (go) await this.act(worktreeId, id, note?.trim() || undefined);
    else await this.decline(worktreeId, id);
  }

  /** the list closes with nothing done: the plan was sent back, the card was pressed not go, or
   * `reason` says what stopped the go */
  async decline(worktreeId: string, id: string, reason?: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    if (!openPieces(agent.transcript()).some((p) => p.id === id)) {
      return log.debug(worktreeId, `decline for a pieces list that already closed (${id})`);
    }
    agent.note({
      type: "pieces-declined",
      id,
      ...(reason ? { outcome: "failed" as const, reason } : {}),
      ts: Date.now(),
    });
  }

  /** The yes. The go is on the transcript before anything slow starts, so the card closes on
   * every tab at once; then each piece in turn, on its own, so one that fails is one outcome and
   * not the end of the list: `here` and `skip` are nothing to do, `send` is a message into the
   * open worktree, `worktree` is a sibling made now or queued behind the branch it waits for.
   * `tell`: the list went with a plan's yes, so the agent is about to build and is told what the
   * list started elsewhere, steered into that turn once the card's answer is on the wire; Toyon's
   * own card is answered between turns, and a message there would start one. */
  async act(worktreeId: string, id: string, note?: string, tell = false): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return;
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    const proposed = openPieces(entries).find((p) => p.id === id);
    if (!proposed) return log.debug(worktreeId, `go for a pieces list that already closed (${id})`);
    agent.note({ type: "pieces-go", id, ts: Date.now() });
    try {
      const repo = this.d.state.repo(wt.repoId);
      if (!repo) throw new UserError(`${wt.title}'s project is no longer open in Toyon`);
      const origin = this.originOf(wt, repo.name, listFile(entries, id));
      const outcomes: PieceOutcome[] = [];
      for (const piece of proposed.pieces) {
        const fate = effectiveFate(entries, proposed, piece);
        try {
          outcomes.push(await this.actOn(wt, origin, proposed.id, piece, fate, note));
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          log.warn(worktreeId, `piece "${piece.title}" (${fate}) failed`, e);
          outcomes.push({ pieceId: piece.id, fate, error });
        }
      }
      agent.note({ type: "pieces", id, outcomes, ts: Date.now() });
      if (tell && outcomes.some((o) => o.fate !== "here")) {
        // the card's answer must be on the wire before anything is steered into the turn it
        // releases: a steer that lands while the plan tool is still being answered aborts the
        // tool, and the approval with it (session.ts, sayPlanEdited). The card closes on the
        // transcript as it is answered, so wait for that, then a beat for the write.
        for (let i = 0; i < 30 && openPlanCard(agent.transcript()); i++) await Bun.sleep(100);
        await Bun.sleep(100);
        agent.send(piecesActedPrompt(proposed.pieces, outcomes), {
          asked: { kind: "pieces", why: "what the split started, so the agent builds only its own piece" },
          keepCards: true,
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      agent.note({ type: "pieces-declined", id, outcome: "failed", reason, ts: Date.now() });
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
    if (openPieces(agent.transcript()).length > 0) return;
    const found = await this.d.reader(wt, markdown);
    if (!found || found.length < 2) return;
    // the card may have been answered while the model read: a list held now would wait for a
    // card that is not coming and show as Toyon's own at the turn's end, which nobody asked for
    const card = openPlanCard(agent.transcript());
    if (!card || card.plan !== planPath || openPieces(agent.transcript()).length > 0) return;
    await this.proposeRead(wt, markdown, found);
  }

  /** The pieces read off a plan as a held list on the chat, briefs cut from the plan's sections,
   * the plan's text hashed onto the list for the stale check. An `after` the model made up (a
   * sibling piece's name, which is no branch yet) is dropped rather than refusing the list: the
   * piece starts at once, and the person can see as much on the row. */
  private async proposeRead(wt: WorktreeInfo, markdown: string, found: ReadPiece[]): Promise<Proposed | null> {
    const siblings = this.siblings(wt);
    const known = (q: string) =>
      q === "this" || q === wt.branch || !("refused" in this.named(siblings, q.startsWith("@") ? q.slice(1) : q));
    const raw = found.map((p): RawPiece => {
      const brief = sectionText(markdown, p.section) ?? `${p.title}\n\n${p.section}`;
      const after = p.where === "worktree" && p.after && known(p.after) ? p.after : undefined;
      return { title: p.title, brief, where: p.where, ...(after ? { after } : {}) };
    });
    const r = await this.propose(wt.id, raw, "toyon", hashText(markdown));
    if (r.isError) {
      log.warn(wt.id, `the list read off the plan was refused: ${r.text}`);
      return null;
    }
    const agent = this.d.runtime.agentFor(wt.id);
    return agent ? (openPieces(agent.transcript()).find((p) => p.by === "toyon") ?? null) : null;
  }

  /** The plan file moved under an open held list: mark the list stale, and a list Toyon read is
   * read again from the file as it stands, the fates pressed carried over by title. The agent's
   * own list is only marked, since the agent hands over again when it re-plans. Run on every tree
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
    if (entries.some(({ event }) => event.type === "pieces-stale" && event.id === open.id)) return;
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
    agent.note({ type: "pieces-stale", id: open.id, ts: Date.now() });
    if (open.by !== "toyon") return;
    const found = await this.d.reader(wt, markdown);
    if (!found || found.length < 2) return;
    if (openPlanCard(agent.transcript())?.id !== card.id) return;
    const pressed = new Map<string, PieceFate>();
    for (const { event } of agent.transcript()) {
      if (event.type === "pieces-fate" && event.id === open.id) {
        const title = open.pieces.find((p) => p.id === event.pieceId)?.title;
        if (title) pressed.set(title.toLowerCase(), event.fate);
      }
    }
    agent.note({ type: "pieces-declined", id: open.id, reason: "the plan changed; read again", ts: Date.now() });
    const fresh = await this.proposeRead(wt, markdown, found);
    if (!fresh) return;
    for (const piece of fresh.pieces) {
      const fate = pressed.get(piece.title.toLowerCase());
      if (fate && fate !== piece.fate && !(fate === "send" && !piece.to)) {
        agent.note({ type: "pieces-fate", id: fresh.id, pieceId: piece.id, fate, ts: Date.now() });
      }
    }
  }

  /** the pointer a piece carries: the origin, and the file its list sits on. That file, not the
   * record's plan: outside plan mode the record's plan is whatever an earlier plan card left there,
   * and a sibling sent to read it would read the wrong picture */
  private originOf(wt: WorktreeInfo, project: string, plan: string | undefined): PieceOrigin {
    return { path: wt.path, project, branch: wt.branch, ...(plan ? { plan } : {}) };
  }

  private async actOn(
    wt: WorktreeInfo,
    origin: PieceOrigin,
    proposalId: string,
    piece: Piece,
    fate: PieceFate,
    note: string | undefined,
  ): Promise<PieceOutcome> {
    if (fate === "here" || fate === "skip") return { pieceId: piece.id, fate };
    if (fate === "send") {
      const target = piece.to ? this.d.state.worktree(piece.to.id) : undefined;
      if (target?.kind !== "worktree" || target.repoId !== wt.repoId) {
        throw new UserError(`"${piece.to?.title ?? "the worktree"}" is no longer open`);
      }
      const attachments = await this.reattachAll(wt.id, piece.attachments);
      this.d.runtime.ensureAgent(target).agent.send(pieceSendPrompt(piece.brief, note, origin), {
        keepCards: true,
        ...(attachments.length ? { attachments } : {}),
        brief: briefOf(wt, piece.brief, note, origin.plan),
      });
      return { pieceId: piece.id, fate, worktreeId: target.id, title: target.title };
    }
    const waits = piece.after ? this.d.state.worktree(piece.after.id) : undefined;
    if (piece.after && waits && waits.kind === "worktree" && !waits.landed) {
      // refs, not inputs: an adopted upload expires long before a land, and the refs read back
      // from the store whenever the sibling is made
      const queued: QueuedPiece = {
        proposalId,
        pieceId: piece.id,
        title: piece.title,
        brief: piece.brief,
        after: piece.after,
        attachments: piece.attachments,
        ...(note ? { note } : {}),
        queuedAt: Date.now(),
      };
      const live = this.d.state.requireWorktree(wt.id);
      live.queued = [...(live.queued ?? []), queued];
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      return { pieceId: piece.id, fate, after: piece.after.branch };
    }
    const made = await this.make(wt, origin, piece, note);
    return { pieceId: piece.id, fate, worktreeId: made.id, title: made.title };
  }

  /** the sibling for a piece: seeded with the brief, the origin pointer, the file its list sits on
   * and what the origin's chat attached, in the origin's mode, cold until someone looks at it */
  private async make(
    origin: WorktreeInfo,
    at: PieceOrigin,
    piece: Pick<Piece, "title" | "brief" | "attachments">,
    note: string | undefined,
  ): Promise<WorktreeInfo> {
    // right before the create, since the create's send is what holds the uploads
    const attachments = await this.reattachAll(origin.id, piece.attachments);
    // no createdBy, as a handoff: the row is nobody's to jump to, and the person stays put
    return this.d.create(origin.repoId, piecePrompt(piece.brief, note, at), {
      title: piece.title,
      ...(origin.mode ? { mode: origin.mode } : {}),
      ...(attachments.length ? { attachments } : {}),
      from: {
        kind: "worktree",
        ref: origin.branch,
        origin: { id: origin.id, repoId: origin.repoId },
        ...(at.plan ? { plan: at.plan } : {}),
      },
      brief: briefOf(origin, piece.brief, note, at.plan),
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

  /** a worktree landed: every piece queued behind it, on any origin, is made now and the origin's
   * chat told; one that could not be made is dropped with the reason */
  async landed(landedId: string): Promise<void> {
    for (const origin of this.d.state.worktrees) {
      const due = origin.queued?.filter((q) => q.after.id === landedId) ?? [];
      if (due.length === 0) continue;
      const repo = this.d.state.repo(origin.repoId);
      origin.queued = origin.queued?.filter((q) => q.after.id !== landedId);
      if (origin.queued?.length === 0) delete origin.queued;
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
      const agent = this.d.runtime.ensureAgent(origin).agent;
      for (const q of due) {
        try {
          if (!repo) throw new UserError("the project is no longer open in Toyon");
          const at = this.originOf(origin, repo.name, listFile(agent.transcript(), q.proposalId));
          const made = await this.make(origin, at, q, q.note);
          agent.note({
            type: "piece-made",
            id: q.proposalId,
            pieceId: q.pieceId,
            worktreeId: made.id,
            title: made.title,
            ts: Date.now(),
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log.warn(origin.id, `queued piece "${q.title}" could not be made`, e);
          agent.note({ type: "piece-dropped", id: q.proposalId, pieceId: q.pieceId, reason, ts: Date.now() });
        }
      }
    }
  }

  /** a queued piece whose awaited sibling is gone will never be made: dropped, and the origin's
   * chat told why. Saves and emits only on a change, so the frame this answers to finds nothing
   * more to do. */
  sweep(): void {
    let changed = false;
    for (const origin of this.d.state.worktrees) {
      if (!origin.queued?.length) continue;
      const live = (id: string) => this.d.state.worktree(id)?.kind === "worktree";
      const gone = origin.queued.filter((q) => !live(q.after.id));
      if (gone.length === 0) continue;
      origin.queued = origin.queued.filter((q) => live(q.after.id));
      if (origin.queued.length === 0) delete origin.queued;
      changed = true;
      const agent = this.d.runtime.ensureAgent(origin).agent;
      for (const q of gone) {
        agent.note({
          type: "piece-dropped",
          id: q.proposalId,
          pieceId: q.pieceId,
          reason: `the worktree it waited for, "${q.after.title}", is gone`,
          ts: Date.now(),
        });
      }
    }
    if (changed) {
      this.d.state.save();
      this.d.hub.emit("worktreesChanged");
    }
  }
}

/** the attachment a prompt label names, among everything this chat's messages carried: the
 * kind's word and its number per kind, which is how the prompt captions them */
function attachmentNamed(entries: readonly TranscriptEntry[], label: string): AttachmentRef | null {
  const m = LABEL.exec(label.trim());
  if (!m) return null;
  const kind = KIND_OF[m[1]!.toLowerCase()];
  const n = Number(m[2]);
  for (const { event } of entries) {
    if (event.type !== "user-message") continue;
    const ref = event.attachments?.find((a) => a.kind === kind && a.n === n);
    if (ref) return ref;
  }
  return null;
}
