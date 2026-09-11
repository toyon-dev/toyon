// Removed worktrees, kept. One directory per worktree under ~/.toyon/archive holds its record, its
// transcript and its attachments, so restoring is moving two things back and deleting is one rm.
// Not rows in state.json: that file is rewritten whole on every save, and this only grows.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ArchivedWorktree, WorktreeInfo } from "@toyon/shared";
import { log } from "../core/log.ts";
import type { KeptState } from "../git/archive.ts";

export interface ArchiveRecord {
  /** the record as it was, id included: a restore puts the same worktree back */
  worktree: WorktreeInfo;
  /** the repo's checkout. A project forgotten and opened again comes back under a new id, and its
   * archive should come back with it. */
  repoPath: string;
  archivedAt: number;
  /** the agent's own session, resumed when the worktree returns to the same directory */
  sessionId?: string;
  /** the first message, so a row can say what the work was */
  prompt?: string;
  /** absent when git had nothing to keep or the ref could not be written */
  kept?: KeptState;
}

/** where a worktree's chat lives on disk */
export interface ChatFiles {
  transcript: string;
  attachments: string;
}

export class WorktreeArchive {
  private records = new Map<string, ArchiveRecord>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const id of readdirSync(dir)) {
      const file = this.filesOf(id).record;
      if (!existsSync(file)) continue;
      try {
        this.records.set(id, JSON.parse(readFileSync(file, "utf8")));
      } catch (e) {
        log.warn("archive", `skipped an unreadable record: ${file}`, e);
      }
    }
  }

  get(id: string): ArchiveRecord | undefined {
    return this.records.get(id);
  }

  /** The files move in first and the record is written last: a crash in between leaves loose files
   * nothing lists, rather than a listed worktree with nothing behind it. */
  put(rec: ArchiveRecord, from: ChatFiles): void {
    const at = this.filesOf(rec.worktree.id);
    mkdirSync(at.dir, { recursive: true });
    move(from.transcript, at.transcript);
    move(from.attachments, at.attachments);
    writeFileSync(at.record, JSON.stringify(rec, null, 2));
    this.records.set(rec.worktree.id, rec);
  }

  /** move the chat back out to where a live worktree keeps it, and forget the record */
  take(id: string, to: ChatFiles): void {
    if (!this.records.has(id)) return;
    const at = this.filesOf(id);
    move(at.transcript, to.transcript);
    move(at.attachments, to.attachments);
    this.delete(id);
  }

  /** Only an id this archive holds reaches the filesystem: the id arrives from a client, and a record
   * is the proof it names one of these directories. */
  delete(id: string): void {
    if (!this.records.has(id)) return;
    rmSync(this.filesOf(id).dir, { recursive: true, force: true });
    this.records.delete(id);
  }

  /** a project's archived worktrees, newest first */
  list(repo: { id: string; path: string }): ArchivedWorktree[] {
    return [...this.records.values()]
      .filter((r) => r.worktree.repoId === repo.id || r.repoPath === repo.path)
      .sort((a, b) => b.archivedAt - a.archivedAt)
      .map((r) => summarize(r, repo.id));
  }

  private filesOf(id: string) {
    const dir = join(this.dir, id);
    return {
      dir,
      record: join(dir, "record.json"),
      transcript: join(dir, "transcript.jsonl"),
      attachments: join(dir, "attachments"),
    };
  }
}

/** what the shell is told about a record; `repoId` is the project's id now, which may not be the
 * one it was archived under */
export function summarize(r: ArchiveRecord, repoId: string): ArchivedWorktree {
  return {
    id: r.worktree.id,
    repoId,
    title: r.worktree.title,
    branch: r.worktree.branch,
    createdAt: r.worktree.createdAt,
    archivedAt: r.archivedAt,
    ...(r.prompt ? { prompt: r.prompt } : {}),
    restorable: !!r.kept,
    ...(r.kept?.snapshot ? { uncommitted: true } : {}),
    ...(r.worktree.landed ? { landed: true } : {}),
  };
}

/** the first message in a transcript file, cut to what a row can show */
export function firstPrompt(transcript: string): string | undefined {
  if (!existsSync(transcript)) return undefined;
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.includes('"user-message"')) continue;
    try {
      const event = (JSON.parse(line) as { event?: AgentEvent }).event;
      if (event?.type === "user-message") return event.text.slice(0, 500);
    } catch {
      // a torn line is the transcript loader's to report; the next message will do
    }
  }
  return undefined;
}

function move(from: string, to: string) {
  if (!existsSync(from)) return;
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}
