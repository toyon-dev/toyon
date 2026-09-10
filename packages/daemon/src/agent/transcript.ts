// Per-worktree transcript: the JSONL file under ~/.toyon/transcripts is the source of truth for
// rendering (backfill on subscribe); the agent's own session id is only used for resume.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { log } from "../core/log.ts";

export type TranscriptEntry = { seq: number; event: AgentEvent };

/** past this many entries the transcript is cut back to the newest KEEP_ENTRIES. A busy worktree
 * streams a token per entry, so a long session is tens of thousands of lines; the shell backfills
 * the last thousand anyway, and what the cap costs is scrollback nobody reaches by scrolling. */
export const MAX_ENTRIES = 4000;
export const KEEP_ENTRIES = 2000;

export function transcriptPathFor(transcriptsDir: string, worktreeId: string): string {
  return join(transcriptsDir, `${worktreeId}.jsonl`);
}

/** where to cut so the kept tail starts on a turn boundary: a tool row without its start, or a
 * reply without its question, would render as a torn first item. Exported for a graft, which
 * copies one transcript into another and wants the same tail. */
export function cutPoint(entries: TranscriptEntry[]): number {
  const from = Math.max(0, entries.length - KEEP_ENTRIES);
  for (let i = from; i < entries.length; i++) {
    const t = entries[i]!.event.type;
    if (t === "user-message" || t === "turn-start") return i;
  }
  return from;
}

function serialize(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

export class Transcript {
  /** read from disk once; from then on the in-memory copy serves backfills (a long session used
   * to be re-parsed on every subscribe). Mutated in place on compaction: the session holds this
   * array. */
  readonly entries: TranscriptEntry[];
  private seq: number;
  /** appends are chained so lines land in order without a sync write per streamed token */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private path: string,
    private tag: string,
  ) {
    this.entries = this.read();
    // from the last seq on disk, not the count: a compacted transcript keeps numbering upward
    this.seq = (this.entries.at(-1)?.seq ?? -1) + 1;
  }

  private read(): TranscriptEntry[] {
    if (!existsSync(this.path)) return [];
    const out: TranscriptEntry[] = [];
    let torn = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a crash mid-append leaves a partial last line; one bad line must not make the whole
        // worktree unbootable
        torn++;
      }
    }
    if (torn) log.warn(this.tag, `transcript: skipped ${torn} unparsable line(s)`);
    if (out.length > MAX_ENTRIES) {
      const kept = out.slice(cutPoint(out));
      // synchronous, once, at boot: the file is rewritten before anything can append to it
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, serialize(kept));
      renameSync(tmp, this.path);
      log.info(this.tag, `transcript: compacted ${out.length} entries to ${kept.length}`);
      return kept;
    }
    return out;
  }

  /** record the event and hand back its entry (the seq is what the hub broadcasts) */
  append(event: AgentEvent): TranscriptEntry {
    const entry = { seq: this.seq++, event };
    this.entries.push(entry);
    const line = `${JSON.stringify(entry)}\n`;
    this.writes = this.writes
      .then(() => appendFile(this.path, line))
      .catch((e) => log.warn(this.tag, "transcript append failed", e));
    if (this.entries.length > MAX_ENTRIES) this.compact();
    return entry;
  }

  /** drop the oldest entries in memory now and on disk in turn with the appends. The snapshot is
   * taken here, not when the write runs: what is in memory at this moment is exactly what the
   * appends queued ahead of it will have put on disk, and an entry appended after this call has
   * its own append queued behind the rewrite, so serializing later would write it twice. */
  private compact() {
    this.entries.splice(0, cutPoint(this.entries));
    const snapshot = serialize(this.entries);
    const tmp = `${this.path}.tmp`;
    this.writes = this.writes
      .then(async () => {
        await writeFile(tmp, snapshot);
        await rename(tmp, this.path);
      })
      .catch((e) => log.warn(this.tag, "transcript compaction failed", e));
  }

  /** resolves once every append so far is on disk (tests; shutdown) */
  flush(): Promise<void> {
    return this.writes;
  }
}
