// The `worktrees` tool: what an agent asks when a question names a topic, a ticket or a feature
// and not a branch. Toyon alone knows a worktree's title, where its chat is and what became of it
// once archived; `git worktree list` has paths and branches, and the mention context only speaks
// of a sibling the message names with `@<branch>`. Each row reads as the mention would say it, so
// the agent learns one shape, plus what the chat was about: the first thing the person asked, and
// when they last wrote. The query is matched against the title, the branch and every message the
// person wrote in that chat, which is where "COS-634" or "Databricks" lives when the branch says
// "double-log".

import { readFile } from "node:fs/promises";
import type { ArchivedWorktree, WorktreeInfo } from "@toyon/shared";
import { WORKTREES_TOOL } from "@toyon/shared";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { dayOf, type SiblingWorktree, siblingParagraph } from "../agent/prompt.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import type { StateStore } from "../core/state.ts";

/** archived rows listed without a query: the archive grows for as long as the project is open,
 * and a list past this is a search the agent should have asked with a query */
export const ARCHIVED_MAX = 20;

/** how much of the first message a row repeats: enough to say what the work was */
const ASKED_MAX = 200;

export interface LookupDeps {
  state: StateStore;
  transcriptsDir: string;
  /** a project's archived worktrees, newest first */
  archived: (repoId: string) => ArchivedWorktree[];
}

/** what the person wrote in a chat, oldest first, with when */
interface Said {
  text: string;
  ts: number;
}

/** a row with its chat read: the sibling as the mention names it, and what was said in it */
interface Candidate {
  sibling: SiblingWorktree;
  said: Said[];
  /** the first message, from the archive record when the chat file is gone */
  prompt?: string;
  /** when the person last wrote; the record's dates when nothing was */
  active: number;
}

export class WorktreeLookup implements ToolProvider {
  constructor(private d: LookupDeps) {}

  tool(worktreeId: string): McpTool {
    const wt = this.d.state.worktree(worktreeId);
    const open = wt ? this.siblings(wt).length : 0;
    const gone = wt ? this.d.archived(wt.repoId).length : 0;
    return {
      name: WORKTREES_TOOL,
      description: `List the other worktrees of this project, open and archived, by title and branch, with where each chat is on disk and what it was about. Call it to find which worktree worked on a topic, a ticket or a feature, or to see what else is open. Right now ${open} other ${open === 1 ? "worktree is" : "worktrees are"} open and ${gone} ${gone === 1 ? "is" : "are"} archived. Without a query the open ones are listed and the newest ${ARCHIVED_MAX} archived; with one, only the worktrees whose title, branch or chat mention every word of it.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words to look for, such as a ticket key, a product name or a feature: a worktree is listed when its title, branch or what the person wrote in its chat contains every word, in any case. Leave it out to list everything.",
          },
        },
      },
    };
  }

  async call(worktreeId: string, args: unknown): Promise<McpToolResult> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return { text: "unknown worktree", isError: true };
    const raw = args && typeof args === "object" ? (args as { query?: unknown }).query : undefined;
    const query = typeof raw === "string" ? raw.trim() : "";
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const open = await Promise.all(this.siblings(wt).map((w) => this.read(w)));
    const archived = await Promise.all(this.d.archived(wt.repoId).map((a) => this.readArchived(a)));
    // the open rows by who wrote last; the archive keeps its own order, newest archived first
    open.sort((a, b) => b.active - a.active);
    if (words.length === 0) {
      const shown = [...open, ...archived.slice(0, ARCHIVED_MAX)];
      const more = archived.length - ARCHIVED_MAX;
      const head = `${open.length} other ${open.length === 1 ? "worktree" : "worktrees"} of this project ${open.length === 1 ? "is" : "are"} open and ${archived.length} ${archived.length === 1 ? "is" : "are"} archived.`;
      const tail =
        more > 0
          ? `\n\n${more} older archived ${more === 1 ? "worktree is" : "worktrees are"} not listed; pass a query to search them.`
          : "";
      return { text: shown.length ? `${head}\n\n${shown.map((c) => row(c, [])).join("\n\n")}${tail}` : head };
    }
    const hits = [...open, ...archived].filter((c) => matches(c, words));
    if (hits.length === 0) {
      return {
        text: `No worktree of this project matches "${query}". Searched ${open.length} open and ${archived.length} archived by title, branch and what the person wrote in each chat.`,
      };
    }
    return {
      text: `${hits.length} ${hits.length === 1 ? "worktree" : "worktrees"} of this project ${hits.length === 1 ? "matches" : "match"} "${query}".\n\n${hits.map((c) => row(c, words)).join("\n\n")}`,
    };
  }

  /** the project's other open worktrees: the rows a mention could name, in the same set */
  private siblings(wt: WorktreeInfo): WorktreeInfo[] {
    return this.d.state.worktrees.filter((w) => w.repoId === wt.repoId && w.id !== wt.id && w.kind === "worktree");
  }

  private async read(w: WorktreeInfo): Promise<Candidate> {
    const transcript = transcriptPathFor(this.d.transcriptsDir, w.id);
    const said = await userMessages(transcript);
    return {
      sibling: { branch: w.branch, title: w.title, path: w.path, transcript },
      said,
      active: said.at(-1)?.ts ?? w.createdAt,
    };
  }

  private async readArchived(a: ArchivedWorktree): Promise<Candidate> {
    const said = await userMessages(a.transcript);
    return {
      sibling: {
        branch: a.branch,
        title: a.title,
        path: a.path,
        transcript: a.transcript,
        archived: { at: a.archivedAt, landed: a.landed, restorable: a.restorable },
      },
      said,
      prompt: a.prompt,
      active: said.at(-1)?.ts ?? a.archivedAt,
    };
  }
}

/** What the person wrote in a chat, read off its file. A chat that is not there yet (a row whose
 * first turn has not started) or a torn line says nothing rather than failing the whole list; a
 * line is parsed only when it can be the person's, since a long chat is tens of thousands of
 * tool lines. */
async function userMessages(transcript: string): Promise<Said[]> {
  let text: string;
  try {
    text = await readFile(transcript, "utf8");
  } catch {
    // no chat yet, or the archive has moved on without it: nothing was said there
    return [];
  }
  const out: Said[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"user-message"')) continue;
    try {
      const e = JSON.parse(line)?.event;
      if (e?.type === "user-message" && typeof e.text === "string") out.push({ text: e.text, ts: Number(e.ts) || 0 });
    } catch {
      // a torn line, counted and skipped where the transcript is loaded for real
    }
  }
  return out;
}

/** every word of the query, somewhere in the title, the branch or what was said */
function matches(c: Candidate, words: readonly string[]): boolean {
  const corpus = [c.sibling.title, c.sibling.branch, c.prompt ?? "", ...c.said.map((s) => s.text)]
    .join("\n")
    .toLowerCase();
  return words.every((w) => corpus.includes(w));
}

/** one worktree as the tool says it: the mention's paragraph, then what the chat was about */
function row(c: Candidate, words: readonly string[]): string {
  const parts = [siblingParagraph(c.sibling)];
  const first = c.said[0]?.text ?? c.prompt;
  if (first) parts.push(`The person first asked: "${clip(first)}"${first.length > ASKED_MAX ? " (cut there)." : ""}`);
  if (c.said.length > 0) parts.push(`They last wrote there on ${dayOf(c.active)}.`);
  if (words.length > 0 && c.said.length > 0) {
    const mentioning = c.said.filter((s) => {
      const t = s.text.toLowerCase();
      return words.some((w) => t.includes(w));
    }).length;
    if (mentioning > 0) parts.push(`${mentioning} of their ${c.said.length} messages mention the query.`);
  }
  return parts.join(" ");
}

/** the first message on one line, cut where a row stops being a summary */
function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > ASKED_MAX ? one.slice(0, ASKED_MAX).trimEnd() : one;
}
