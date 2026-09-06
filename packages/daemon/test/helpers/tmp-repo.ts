import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs, makePaths, type Paths } from "../../src/core/paths.ts";
import { GIT } from "../../src/git/exec.ts";

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: status=${r.status} signal=${r.signal} error=${r.error?.message ?? ""} stderr=${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

/** a real git repo on `main` with one commit, plus a throwaway TOYON home */
export function tmpRepo(): { repo: string; paths: Paths; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "toyon-t-"));
  const repo = join(root, "repo");
  sh(root, GIT, "init", "-q", "-b", "main", repo);
  sh(repo, GIT, "config", "user.email", "t@t");
  sh(repo, GIT, "config", "user.name", "t");
  sh(repo, GIT, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(repo, GIT, "add", "-A");
  sh(repo, GIT, "commit", "-q", "-m", "init");
  const paths = makePaths(join(root, "home"));
  ensureDirs(paths);
  return { repo, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
