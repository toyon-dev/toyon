// Who last touched each line of a file, for the ghost the editor draws after the caret's line.
// Read-only; nothing here writes a ref.

import type { BlameCommit, FileBlame } from "@toyon/shared";
import { git, gitRaw } from "./exec.ts";
import { commitPage, githubRepoUrl } from "./forge.ts";

const NONE: FileBlame = { commits: [], lines: [] };

/** the sha git blame gives a line the working tree has and no commit does */
const UNCOMMITTED = "0".repeat(40);

/** The working tree's copy of `file` line by line, or the copy `ref` left. Empty for a file git
 * cannot blame: untracked, gone, or a path that is not a file. Each commit the origin has carries
 * its page on GitHub, when the origin is there. */
export async function blameFile(cwd: string, file: string, ref?: string): Promise<FileBlame> {
  const [r, origin, fetched] = await Promise.all([
    gitRaw(cwd, "blame", "--porcelain", ...(ref ? [ref] : []), "--", file),
    git(cwd, "remote", "get-url", "origin"),
    git(cwd, "for-each-ref", "--count=1", "refs/remotes/origin"),
  ]);
  if (!r.ok) return NONE;
  const blame = parseBlame(r.out);
  const repoUrl = origin.ok ? githubRepoUrl(origin.out) : null;
  // an origin nothing has been fetched from or pushed to has none of the commits, and a walk
  // against its no refs would print the whole history to say so
  if (repoUrl && fetched.ok && fetched.out && blame.commits.length > 0) {
    const local = await unpushed(
      cwd,
      blame.commits.map((c) => c.sha),
    );
    for (const c of blame.commits) if (!local.has(c.sha)) Object.assign(c, commitPage(repoUrl, c));
  }
  return blame;
}

/** Which of `shas` no ref under origin reaches: a page on GitHub for one of those would be a 404,
 * since the commit is only here. One walk for all of them: the output is every commit behind the
 * given ones that origin lacks, and the given ones among it are the answer. */
async function unpushed(cwd: string, shas: string[]): Promise<Set<string>> {
  const r = await git(cwd, "rev-list", ...shas, "--not", "--remotes=origin");
  // a walk that failed says nothing about what is pushed, so nothing is linked
  if (!r.ok) return new Set(shas);
  return new Set(r.out.split("\n").filter(Boolean));
}

/** `--porcelain`: a header `<sha> <line in that commit> <line here> [<lines in this run>]`, then the
 * commit's fields the first time it appears, then the line itself behind a tab. Later runs of the
 * same commit carry the header and the line alone, so the fields are kept by sha as they come. */
export function parseBlame(out: string): FileBlame {
  const commits: BlameCommit[] = [];
  const index = new Map<string, number>();
  const lines: number[] = [];
  const rows = out.split("\n");
  let i = 0;
  while (i < rows.length) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(rows[i] ?? "");
    i++;
    if (!head) continue;
    const sha = head[1] ?? "";
    const line = Number(head[2]);
    let idx = index.get(sha);
    if (idx === undefined && sha !== UNCOMMITTED) {
      idx = commits.length;
      index.set(sha, idx);
      commits.push({ sha, author: "", email: "", at: 0, subject: "" });
    }
    const c = idx === undefined ? null : commits[idx];
    for (; i < rows.length && !rows[i]?.startsWith("\t"); i++) {
      const row = rows[i] ?? "";
      const sp = row.indexOf(" ");
      const key = sp < 0 ? row : row.slice(0, sp);
      const value = sp < 0 ? "" : row.slice(sp + 1);
      if (!c) continue;
      if (key === "author") c.author = value;
      else if (key === "author-mail") c.email = value.replace(/^<(.*)>$/, "$1");
      else if (key === "author-time") c.at = Number(value) * 1000 || 0;
      else if (key === "summary") c.subject = value;
    }
    // the line itself
    i++;
    if (line > 0) lines[line - 1] = idx ?? -1;
  }
  // every line is named by exactly one header; a gap would be a line the parse never reached
  for (let k = 0; k < lines.length; k++) lines[k] ??= -1;
  return { commits, lines };
}
