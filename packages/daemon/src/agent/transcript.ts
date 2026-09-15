// Per-worktree transcript: the JSONL file under ~/.toyon/transcripts is the source of truth for
// rendering (backfill on subscribe); the agent's own session id is only used for resume.

import { existsSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { log } from "../core/log.ts";

export type TranscriptEntry = { seq: number; event: AgentEvent };

export function transcriptPathFor(transcriptsDir: string, worktreeId: string): string {
  return join(transcriptsDir, `${worktreeId}.jsonl`);
}

/** the entries with each run of adjacent text or thinking deltas folded into one, keeping the run's
 * first seq. A streamed reply is a delta per token, so a whole long session sent raw is a frame of
 * tens of thousands of entries and a fold in the shell that copies the chat once per token; the
 * shell joins adjacent deltas into one row anyway, so what it renders is the same. The first seq is
 * the row's name: the shell stamps it when the run's first delta lands, a chat search names the row
 * by it, and it stays put while the run is still streaming. */
export function coalesce(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    const { event } = entry;
    if ((event.type === "text-delta" || event.type === "thinking-delta") && last?.event.type === event.type) {
      out[out.length - 1] = { seq: last.seq, event: { type: event.type, text: last.event.text + event.text } };
    } else {
      out.push(entry);
    }
  }
  return out;
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
