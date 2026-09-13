// `toyon uninstall`: everything toyon put on the machine, listed first and removed only after a
// yes. The worktrees go through git so each repo's worktree list is left clean; the branches
// toyon made are the person's work and stay, said in so many words. The npm package itself is
// npm's to remove.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_FILES } from "@toyon/shared";
import { alive, health, home, readPid } from "./daemon.ts";
import { stop } from "./stop.ts";

interface Persisted {
  repos?: Array<{ id: string; path: string; name?: string }>;
  worktrees?: Array<{ id: string; repoId: string; path: string; branch?: string; kind?: string }>;
}

function readState(): Persisted {
  const file = join(home, DAEMON_FILES.state);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Persisted;
  } catch {
    // a torn state file still leaves the home directory to remove
    return {};
  }
}

async function git(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk) => resolve(String(chunk).trim().toLowerCase().startsWith("y")));
    process.stdin.once("end", () => resolve(false));
  });
}

export async function uninstall(opts: { yes: boolean }): Promise<number> {
  const state = readState();
  const repos = state.repos ?? [];
  const worktrees = (state.worktrees ?? []).filter((w) => w.kind !== "main");
  const app = join(homedir(), "Applications", "Toyon.app");
  const branches = worktrees.map((w) => w.branch).filter((b): b is string => !!b && b.startsWith("toyon/"));

  console.log("toyon uninstall removes:");
  console.log(
    `  ${home}  (state, transcripts, agent adapters, ${worktrees.length} worktree director${worktrees.length === 1 ? "y" : "ies"})`,
  );
  for (const w of worktrees) {
    const repo = repos.find((r) => r.id === w.repoId);
    console.log(`    ${w.path}  (worktree of ${repo?.path ?? "?"})`);
  }
  if (existsSync(app)) console.log(`  ${app}`);
  console.log("and stops the daemon if it is running.");
  console.log(
    "it keeps: your repos, every branch toyon made" +
      (branches.length ? ` (${branches.length} under toyon/)` : "") +
      ", and toyon's settings in each repo (.toyon/ or toyon.json).",
  );
  if (!opts.yes && !(await confirm("continue?"))) {
    console.log("nothing removed");
    return 1;
  }

  if ((await health()) || (readPid() !== null && alive(readPid()!))) await stop();

  // through git, so the repo forgets the worktree rather than keeping a dangling entry
  for (const w of worktrees) {
    const repo = repos.find((r) => r.id === w.repoId);
    if (repo && existsSync(repo.path)) {
      const ok = await git(repo.path, "worktree", "remove", "--force", w.path);
      if (!ok && existsSync(w.path)) rmSync(w.path, { recursive: true, force: true });
      await git(repo.path, "worktree", "prune");
    } else if (existsSync(w.path)) {
      rmSync(w.path, { recursive: true, force: true });
    }
  }
  rmSync(home, { recursive: true, force: true });
  if (existsSync(app)) rmSync(app, { recursive: true, force: true });
  console.log("removed. `npm uninstall -g toyon` removes the command itself.");
  return 0;
}
