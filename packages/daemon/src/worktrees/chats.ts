// What the chats palette searches: the transcripts of a project's worktrees, the ones on the rail
// and the ones archived. Only what was said is read, the person's messages and the model's prose. A
// tool's output is a file or a command's print, and the files search is where a file is looked for.
//
// The matching is pure so its rules have tests without a transcript on disk; the class around it
// owns what costs something, reading and parsing the files.

import type { ChatHit } from "@toyon/shared";
import { coalesce, parseTranscript, type TranscriptEntry } from "../agent/transcript.ts";
import type { StateStore } from "../core/state.ts";

/** at most this many hits from one chat: the palette names a place to look, not every line in it */
export const CHAT_HITS_PER_WORKTREE = 20;
/** and this many in all */
export const CHAT_HITS_MAX = 200;
/** a query this short matches nearly every message */
const MIN_QUERY = 2;
/** how much of a message a hit shows, and how much of that sits before the match */
const SNIPPET = 160;
const BEFORE = 50;

/** one thing said in a chat, as the search reads it: whitespace collapsed, and a lower-cased copy
 * to match against, so a query finds a phrase that wrapped onto the next line */
export type SaidRow = { seq: number; role: ChatHit["role"]; text: string; lower: string; ts: number };

export interface ChatFs {
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  text(path: string): Promise<string | null>;
}

const bunFs: ChatFs = {
  async stat(path) {
    try {
      const s = await Bun.file(path).stat();
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      // a worktree nobody has written to yet has no transcript: absent is the answer, not an error
      return null;
    }
  },
  async text(path) {
    try {
      return await Bun.file(path).text();
    } catch {
      // gone between the stat and the read: a restore or a delete moved it
      return null;
    }
  },
};

export interface ChatSearchDeps {
  state: StateStore;
  /** a running session's entries, in memory and current to the token; undefined when none runs,
   * and then the file is the whole chat */
  live: (worktreeId: string) => TranscriptEntry[] | undefined;
  transcriptPath: (worktreeId: string) => string;
  /** where each of the project's archived chats is kept */
  archivedChats: (repoId: string) => Array<{ id: string; transcript: string }>;
  fs?: ChatFs;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** What was said, in order: each message the person sent and each run of the model's prose, named by
 * the seq the run starts at. That is the seq the shell stamps on the row. */
export function saidRows(entries: TranscriptEntry[]): SaidRow[] {
  const out: SaidRow[] = [];
  let turnTs = 0;
  const push = (seq: number, role: SaidRow["role"], said: string, ts: number) => {
    const text = flat(said);
    if (text) out.push({ seq, role, text, lower: text.toLowerCase(), ts });
  };
  for (const { seq, event } of coalesce(entries)) {
    if (event.type === "user-message") {
      turnTs = event.ts;
      push(seq, "user", event.text, event.ts);
    } else if (event.type === "turn-start") {
      turnTs = event.ts;
    } else if (event.type === "text-delta") {
      push(seq, "assistant", event.text, turnTs);
    }
  }
  return out;
}

/** The words a query is matched by: lower-cased, each once. A message matches when it has every one,
 * in any order, so "footer link" finds "the link in the footer". Empty when the query is too short. */
export function needleWords(query: string): string[] {
  const needle = flat(query).toLowerCase();
  if (needle.length < MIN_QUERY) return [];
  return [...new Set(needle.split(" "))];
}

/** the part of `text` around the first of `ranges` (start and length, in `text`), and where each
 * range sits in what is returned; a range the cut left out is dropped, one it crossed is clipped */
export function snippet(text: string, ranges: Array<[number, number]>): Pick<ChatHit, "text" | "match"> {
  const first = Math.min(...ranges.map(([at]) => at));
  const start = Math.max(0, Math.min(first - BEFORE, text.length - SNIPPET));
  const end = Math.min(text.length, start + SNIPPET);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const match: Array<[number, number]> = [];
  for (const [at, length] of ranges) {
    if (at < start || at >= end) continue;
    match.push([at - start + head.length, Math.min(length, end - at)]);
  }
  return { text: `${head}${text.slice(start, end)}${tail}`, match };
}

/** one chat's hits for the query's words, newest first; `more` when the limit left some out */
export function searchRows(
  rows: SaidRow[],
  words: string[],
  chat: Pick<ChatHit, "worktreeId" | "archived">,
  limit = CHAT_HITS_PER_WORKTREE,
): { hits: ChatHit[]; more: boolean } {
  const hits: ChatHit[] = [];
  if (words.length === 0) return { hits, more: false };
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const ranges = wordRanges(row.lower, words);
    if (!ranges) continue;
    if (hits.length === limit) return { hits, more: true };
    hits.push({ ...chat, seq: row.seq, role: row.role, ts: row.ts, ...snippet(row.text, ranges) });
  }
  return { hits, more: false };
}

/** each word where it first appears in `lower`, or null when one is absent */
function wordRanges(lower: string, words: string[]): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at < 0) return null;
    ranges.push([at, word.length]);
  }
  return ranges;
}

export class ChatSearch {
  /** what each chat said, by where it was read from: a file by its size and mtime, a running session
   * by how many entries it holds. A keystroke over twenty idle chats is then twenty stats. */
  private said = new Map<string, { sig: string; rows: SaidRow[] }>();

  constructor(private d: ChatSearchDeps) {}

  async search(repoId: string, query: string): Promise<{ hits: ChatHit[]; truncated: boolean }> {
    this.d.state.requireRepo(repoId);
    const words = needleWords(query);
    if (words.length === 0) return { hits: [], truncated: false };
    // main has no chat of its own and a spare has not started one, so the chats are the worktrees
    const chats = [
      ...this.d.state.worktrees
        .filter((w) => w.repoId === repoId && w.kind === "worktree")
        .map((w) => ({ id: w.id, archived: false, path: this.d.transcriptPath(w.id) })),
      ...this.d.archivedChats(repoId).map((a) => ({ id: a.id, archived: true, path: a.transcript })),
    ];
    const read = new Set<string>();
    const found = await Promise.all(
      chats.map(async (c) => {
        const rows = await this.rowsOf(c.id, c.archived, c.path, read);
        return searchRows(rows, words, { worktreeId: c.id, archived: c.archived });
      }),
    );
    // a chat no longer listed (restored, deleted, its worktree gone) is not read again
    for (const key of this.said.keys()) if (!read.has(key)) this.said.delete(key);
    // the chat where it was said most recently first; the rail's order where nobody knows when
    const all = found
      .filter((f) => f.hits.length > 0)
      .sort((a, b) => b.hits[0]!.ts - a.hits[0]!.ts)
      .flatMap((f) => f.hits);
    return { hits: all.slice(0, CHAT_HITS_MAX), truncated: all.length > CHAT_HITS_MAX || found.some((f) => f.more) };
  }

  private async rowsOf(id: string, archived: boolean, path: string, read: Set<string>): Promise<SaidRow[]> {
    const live = archived ? undefined : this.d.live(id);
    if (live) {
      const key = `live:${id}`;
      read.add(key);
      return this.remember(key, `n:${live.length}`, () => saidRows(live));
    }
    read.add(path);
    const fs = this.d.fs ?? bunFs;
    const at = await fs.stat(path);
    if (!at) return [];
    const sig = `${at.mtimeMs}:${at.size}`;
    const known = this.said.get(path);
    if (known?.sig === sig) return known.rows;
    const text = await fs.text(path);
    return text === null ? [] : this.remember(path, sig, () => saidRows(parseTranscript(text, id)));
  }

  private remember(key: string, sig: string, rows: () => SaidRow[]): SaidRow[] {
    const known = this.said.get(key);
    if (known?.sig === sig) return known.rows;
    const fresh = rows();
    this.said.set(key, { sig, rows: fresh });
    return fresh;
  }
}
