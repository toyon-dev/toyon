// Who last touched each line of a file, for the ghost the editor draws after the caret's line.
// Read-only; nothing here writes a ref.

import type { BlameCommit, FileBlame } from "@toyon/shared";
import { gitRaw } from "./exec.ts";

const NONE: FileBlame = { commits: [], lines: [] };

/** the sha git blame gives a line the working tree has and no commit does */
const UNCOMMITTED = "0".repeat(40);

/** The working tree's copy of `file` line by line, or the copy `ref` left. Empty for a file git
 * cannot blame: untracked, gone, or a path that is not a file. */
export async function blameFile(cwd: string, file: string, ref?: string): Promise<FileBlame> {
  const r = await gitRaw(cwd, "blame", "--porcelain", ...(ref ? [ref] : []), "--", file);
  return r.ok ? parseBlame(r.out) : NONE;
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
