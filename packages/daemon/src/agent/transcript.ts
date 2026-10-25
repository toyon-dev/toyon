// Per-worktree transcript: the JSONL file under ~/.toyon/transcripts is the source of truth for
// rendering (backfill on subscribe); the agent's own session id is only used for resume.

import { existsSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, TranscriptEntry } from "@toyon/shared";
import { log } from "../core/log.ts";

export type { TranscriptEntry };

export function transcriptPathFor(transcriptsDir: string, worktreeId: string): string {
  return join(transcriptsDir, `${worktreeId}.jsonl`);
}

/** events that are not the agent's own doing, read past when asking what a turn said last: the
 * figures it left, and a message queued behind it that no turn has picked up yet */
const NOT_THE_TURNS = new Set<AgentEvent["type"]>(["usage", "session-info", "user-message", "fix-asked", "handed"]);

/** The turn-end a transcript is owed when its last turn has none: the daemon died under it. The
 * reason reads off the last thing the agent did: the auth card, the error row, or anything else,
 * which means the daemon went away mid-work (`lost`, its own word, since `interrupted` is a
 * person's press and draws a stop under the turn). Anything the agent did after an error row
 * means the row was not how the turn ended. The stamp is the turn's newest: it ended no later
 * than its last event. Null when the last turn is closed, or there is none. */
export function sealOpenTurn(entries: readonly TranscriptEntry[]): Extract<AgentEvent, { type: "turn-end" }> | null {
  let reason: string | null = null;
  let ts = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if ("ts" in e && typeof e.ts === "number") ts = Math.max(ts, e.ts);
    if (e.type === "turn-end") return null;
    if (e.type === "turn-start") return { type: "turn-end", stopReason: reason ?? "lost", ts };
    if (NOT_THE_TURNS.has(e.type)) continue;
    reason ??= e.type === "agent-auth-required" ? "auth" : e.type === "agent-error" ? "failed" : "lost";
  }
  return null;
}

/** a transcript file's text as entries. A crash mid-append leaves a partial last line, and one bad
 * line must not make the whole worktree unbootable, so a line that does not parse is counted and
 * skipped. */
export function parseTranscript(text: string, tag: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let torn = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      torn++;
    }
  }
  if (torn) log.warn(tag, `transcript: skipped ${torn} unparsable line(s)`);
  return out;
}

/** the highest seq on the transcript; -1 for none */
export const lastSeq = (entries: readonly TranscriptEntry[]): number => entries.at(-1)?.seq ?? -1;

/** The entries past `since`: what a page that holds the transcript up to that seq is missing. A
 * binary search, since a long session is tens of thousands of entries and every subscribe asks.
 * Seqs ascend but may skip (a torn line dropped at parse), so the search finds the first entry
 * past `since` rather than the one at it. */
export function after(entries: readonly TranscriptEntry[], since: number): TranscriptEntry[] {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid]!.seq <= since) lo = mid + 1;
    else hi = mid;
  }
  return entries.slice(lo);
}

export class Transcript {
  /** the whole session, read from disk once; from then on the in-memory copy serves backfills.
   * Never trimmed: the first prompt has to stay reachable by scrolling up, however long the
   * session runs. The session holds this array. */
  readonly entries: TranscriptEntry[];
  private seq: number;
  /** appends are chained so lines land in order without a sync write per streamed token */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private path: string,
    private tag: string,
  ) {
    this.entries = this.read();
    this.seq = (this.entries.at(-1)?.seq ?? -1) + 1;
  }

  private read(): TranscriptEntry[] {
    return existsSync(this.path) ? parseTranscript(readFileSync(this.path, "utf8"), this.tag) : [];
  }

  /** record the event and hand back its entry (the seq is what the hub broadcasts) */
  append(event: AgentEvent): TranscriptEntry {
    const entry = { seq: this.seq++, event };
    this.entries.push(entry);
    const line = `${JSON.stringify(entry)}\n`;
    this.writes = this.writes
      .then(() => appendFile(this.path, line))
      .catch((e) => log.warn(this.tag, "transcript append failed", e));
    return entry;
  }

  /** resolves once every append so far is on disk (tests; shutdown) */
  flush(): Promise<void> {
    return this.writes;
  }
}
