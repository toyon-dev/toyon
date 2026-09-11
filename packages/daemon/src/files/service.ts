// Files inside a worktree, as the shell sees them: diff vs main, autosave, discard, quick-open
// listing, content search, changed-line ranges. Every client path goes through resolveInside.

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import type { SearchHit } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { StateStore } from "../core/state.ts";
import { GIT, git, run } from "../git/exec.ts";
import { fileAtCommit } from "../git/log.ts";
import { changedRanges, fileBefore, statusFiles } from "../git/status.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { resolveInside } from "../worktrees/paths.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { viteLineOffset } from "./vite-offset.ts";

const SEARCH_MAX = 300;

export class FileService {
  constructor(
    private state: StateStore,
    private runtime: RuntimeRegistry,
    /** id -> directory + default branch. Injected rather than reached for, because it also answers
     * for worktrees toyon only knows about, which have no record in the state store. */
    private readable: (id: string) => ReadableWorktree | null,
  ) {}

  /** the reads all want the same two things; a spare or an unknown id is a toast, not a crash */
  private require(worktreeId: string): ReadableWorktree {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("unknown worktree");
    return r;
  }

  /** With `ref`, the file on either side of that commit (history, read-only in the editor);
   * without it, the working tree against the merge-base with main. */
  async diff(worktreeId: string, path: string, ref?: string): Promise<{ before: string; after: string }> {
    const r = this.require(worktreeId);
    // the ref side never opens the file, but the path is still the client's: bound it the same
    // way, then hand git the relative form it wants
    const target = resolveInside(r.path, path);
    if (ref) return fileAtCommit(r.path, ref, path);
    const before = await fileBefore(r.path, r.defaultBranch, path);
    const afterFile = Bun.file(target);
    const after = (await afterFile.exists()) ? await afterFile.text() : "";
    return { before, after };
  }

  /** the writes, unlike the reads, want a worktree toyon actually runs. Autosave and discard fire
   * on a keystroke and on a click, and a directory toyon did not create is not somewhere it should
   * be editing behind you: open a shell there, or take it over first. */
  private requireOwned(worktreeId: string) {
    if (!this.state.worktree(worktreeId) && this.readable(worktreeId)) {
      throw new UserError("toyon does not run this worktree: take it over to edit files here");
    }
    return this.state.requireWorktree(worktreeId);
  }

  async write(worktreeId: string, path: string, content: string): Promise<void> {
    const wt = this.requireOwned(worktreeId);
    await Bun.write(resolveInside(wt.path, path), content);
  }

  /** drop uncommitted changes to one file: back to HEAD, or deleted if untracked */
  async discard(worktreeId: string, path: string): Promise<"restored" | "removed"> {
    const wt = this.requireOwned(worktreeId);
    const target = resolveInside(wt.path, path);
    const entry = (await statusFiles(wt.path)).find((f) => f.path === path);
    if (!entry) throw new UserError("file has no uncommitted changes");
    if (entry.xy === "??") {
      unlinkSync(target);
      return "removed";
    }
    await git(wt.path, "checkout", "HEAD", "--", path);
    return "restored";
  }

  /** tracked + untracked (respecting .gitignore) */
  async list(worktreeId: string): Promise<string[]> {
    const r = await git(this.require(worktreeId).path, "ls-files", "-co", "--exclude-standard");
    return r.out.split("\n").filter(Boolean);
  }

  /** fixed-string, case-insensitive git grep over tracked + untracked (not ignored) files */
  async search(worktreeId: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const { path: cwd } = this.require(worktreeId);
    const q = query.trim();
    const hits: SearchHit[] = [];
    let truncated = false;
    if (q.length < 2) return { hits, truncated };
    const r = await run(
      GIT,
      ["grep", "-n", "-I", "-i", "-F", "--untracked", "--no-color", `--max-count=${SEARCH_MAX}`, "-e", q, "--"],
      cwd,
    );
    for (const row of r.rawOut.split("\n")) {
      if (!row) continue;
      const m = /^(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      if (hits.length >= SEARCH_MAX) {
        truncated = true;
        break;
      }
      hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) });
    }
    return { hits, truncated };
  }

  async changedRanges(
    worktreeId: string,
    path: string,
  ): Promise<{ ranges: Array<[number, number]>; lineOffset: number }> {
    const r = this.require(worktreeId);
    resolveInside(r.path, path);
    const ranges = await changedRanges(r.path, r.defaultBranch, path);
    // a discovered worktree serves nothing, so there is no preview to ask about a preamble shift
    const lineOffset = await viteLineOffset(r.path, path, this.runtime.previewTarget(r.id));
    return { ranges, lineOffset };
  }

  /** Finder reveal (macOS only; elsewhere there is no viewer-side filesystem) */
  reveal(worktreeId: string, path?: string): void {
    this.revealPath(resolveInside(this.require(worktreeId).path, path ?? ".", { allowRoot: true }));
  }

  /** Reveal an absolute path the caller has already established the person may see. Used for
   * discovered worktrees, which have no record to resolve against: the worktree service checks
   * the path is still one git reports before this is reached. */
  revealPath(target: string): void {
    if (process.platform !== "darwin") throw new UserError("reveal is only available on macOS");
    const child = spawn("open", ["-R", target], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
}
