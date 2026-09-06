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

export class Transcript {
  /** read from disk once; from then on the in-memory copy serves backfills (a long session used
   * to be re-parsed on every subscribe) */
  readonly entries: TranscriptEntry[];
  private seq: number;
  /** appends are chained so lines land in order without a sync write per streamed token */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private path: string,
    private tag: string,
  ) {
    this.entries = this.read();
    this.seq = this.entries.length;
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
    return entry;
  }

  /** resolves once every append so far is on disk (tests; shutdown) */
  flush(): Promise<void> {
    return this.writes;
  }
}
