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
import { viteLineOffset } from "./vite-offset.ts";

const SEARCH_MAX = 300;

export class FileService {
  constructor(
    private state: StateStore,
    private runtime: RuntimeRegistry,
  ) {}

  /** With `ref`, the file on either side of that commit (history, read-only in the editor);
   * without it, the working tree against the merge-base with main. */
  async diff(worktreeId: string, path: string, ref?: string): Promise<{ before: string; after: string }> {
    const { wt, repo } = this.state.requireWorktreeWithRepo(worktreeId);
    // the ref side never opens the file, but the path is still the client's: bound it the same
    // way, then hand git the relative form it wants
    const target = resolveInside(wt.path, path);
    if (ref) return fileAtCommit(wt.path, ref, path);
    const before = await fileBefore(wt.path, repo.defaultBranch, path);
    const afterFile = Bun.file(target);
    const after = (await afterFile.exists()) ? await afterFile.text() : "";
    return { before, after };
  }

  async write(worktreeId: string, path: string, content: string): Promise<void> {
    const wt = this.state.requireWorktree(worktreeId);
    await Bun.write(resolveInside(wt.path, path), content);
  }

  /** drop uncommitted changes to one file (delete it if untracked) */
  async discard(worktreeId: string, path: string): Promise<void> {
    const wt = this.state.requireWorktree(worktreeId);
    const target = resolveInside(wt.path, path);
    const entry = (await statusFiles(wt.path)).find((f) => f.path === path);
    if (!entry) throw new UserError("file has no uncommitted changes");
    if (entry.xy === "??") unlinkSync(target);
    else await git(wt.path, "checkout", "HEAD", "--", path);
  }

  /** tracked + untracked (respecting .gitignore) */
  async list(worktreeId: string): Promise<string[]> {
    const wt = this.state.requireWorktree(worktreeId);
    const r = await git(wt.path, "ls-files", "-co", "--exclude-standard");
    return r.out.split("\n").filter(Boolean);
  }

  /** fixed-string, case-insensitive git grep over tracked + untracked (not ignored) files */
  async search(worktreeId: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const wt = this.state.requireWorktree(worktreeId);
    const q = query.trim();
    const hits: SearchHit[] = [];
    let truncated = false;
    if (q.length < 2) return { hits, truncated };
    const r = await run(
      GIT,
      ["grep", "-n", "-I", "-i", "-F", "--untracked", "--no-color", `--max-count=${SEARCH_MAX}`, "-e", q, "--"],
      wt.path,
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
    const { wt, repo } = this.state.requireWorktreeWithRepo(worktreeId);
    resolveInside(wt.path, path);
    const ranges = await changedRanges(wt.path, repo.defaultBranch, path);
    const lineOffset = await viteLineOffset(wt.path, path, this.runtime.previewTarget(wt.id));
    return { ranges, lineOffset };
  }

  /** Finder reveal (macOS only; elsewhere there is no viewer-side filesystem) */
  reveal(worktreeId: string, path?: string): void {
    const wt = this.state.requireWorktree(worktreeId);
    const target = resolveInside(wt.path, path ?? ".", { allowRoot: true });
    if (process.platform !== "darwin") throw new UserError("reveal is only available on macOS");
    const child = spawn("open", ["-R", target], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
}
