// Which branches git knows about, local and remote, and where each is checked out. Read-only, the
// way worktrees.ts is: the parser is pure and the functions around it shell out through git/exec.
// `%(worktreepath)` needs git 2.23 or later, which is also the floor for `worktree list`'s lock
// reasons, so nothing here asks for more than discovery already did.

import { git } from "./exec.ts";

export interface GitRef {
  /** the branch name with `refs/heads/` or `refs/remotes/<remote>/` stripped */
  name: string;
  /** set for a remote-tracking ref: the remote it belongs to */
  remote?: string;
  sha: string;
  /** the worktree that has this branch checked out, when one does */
  worktreePath?: string;
  /** a local branch's upstream, as `origin/x` */
  upstream?: string;
  /** committer date of the tip, ms since the epoch */
  at: number;
  subject: string;
}

/** NUL between fields and a record separator between refs, as log.ts does: no field here can hold
 * either, so the parse needs no escaping rules */
const FORMAT =
  "--format=%(refname)%00%(objectname:short)%00%(worktreepath)%00%(upstream:short)%00%(committerdate:unix)%00%(contents:subject)%1e";

/** `git for-each-ref` over heads and remotes → one entry per branch. A remote's `HEAD` symref is
 * skipped: it names the default branch, and the default branch is already a ref of its own. */
export function parseForEachRef(out: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const rec of out.split("\x1e")) {
    const [refname, sha, worktreePath, upstream, at, subject] = rec.replace(/^\n/, "").split("\0");
    if (!refname || !sha) continue;
    let name: string;
    let remote: string | undefined;
    if (refname.startsWith("refs/heads/")) {
      name = refname.slice("refs/heads/".length);
    } else if (refname.startsWith("refs/remotes/")) {
      const rest = refname.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      remote = rest.slice(0, slash);
      name = rest.slice(slash + 1);
      if (name === "HEAD") continue;
    } else {
      continue;
    }
    refs.push({
      name,
      ...(remote ? { remote } : {}),
      sha,
      ...(worktreePath ? { worktreePath } : {}),
      ...(upstream ? { upstream } : {}),
      at: Number(at) * 1000 || 0,
      subject: subject ?? "",
    });
  }
  return refs;
}

/** every local and remote-tracking branch of the repo */
export async function listRefs(repoPath: string): Promise<GitRef[]> {
  const r = await git(repoPath, "for-each-ref", FORMAT, "refs/heads", "refs/remotes");
  if (!r.ok || !r.out) return [];
  return parseForEachRef(r.out);
}

/** the local branches whose every commit is already on the default branch: landed, or never
 * started. What the ref palette hides until asked for by name. */
export async function mergedBranches(repoPath: string, defaultBr: string): Promise<Set<string>> {
  const r = await git(repoPath, "for-each-ref", `--merged=${defaultBr}`, "--format=%(refname:short)", "refs/heads");
  if (!r.ok || !r.out) return new Set();
  return new Set(r.out.split("\n").filter(Boolean));
}
