import type { GitFileStatus, GitInfo } from "@toyon/shared";
import type { ReviewAt } from "../../state/store.ts";
import { testsLast } from "./testFiles.ts";

const NONE: readonly GitFileStatus[] = [];

/** The changes list's three sections, each read change first and tests after, in the one flat
 * order the cursor walks: what is uncommitted, what the last turn changed (shut until asked for,
 * and absent when the turn is everything uncommitted), and what is committed on the branch
 * (folded away when shut). `*Source` counts the rows before a section's tests. The list and the
 * review both read this, so a row and its section are always the same file read the same way. */
export interface ChangeSections {
  files: readonly GitFileStatus[];
  fileSource: number;
  turned: readonly GitFileStatus[];
  turnedSource: number;
  /** the tree the last turn started from, which its rows are read against */
  turnBase: string | undefined;
  committed: readonly GitFileStatus[];
  committedSource: number;
}

export function changeSections(
  git: GitInfo | null | undefined,
  open: { turn: boolean; committed: boolean },
): ChangeSections {
  const files = testsLast(git?.files ?? NONE);
  const turn = git?.extras?.turn;
  const turned = testsLast(turn && open.turn ? turn.files : NONE);
  const committed = testsLast(open.committed ? (git?.extras?.committed ?? NONE) : NONE);
  return {
    files: files.files,
    fileSource: files.source,
    turned: turned.files,
    turnedSource: turned.source,
    turnBase: turn?.base,
    committed: committed.files,
    committedSource: committed.source,
  };
}

/** one file of the review's scroll, read the way the row it stands for reads it */
export interface ReviewSection {
  f: GitFileStatus;
  at: ReviewAt;
  /** in the working tree, so a discard has something to undo */
  uncommitted: boolean;
}

/** The review's files, in the list's order. A path can be two rows: uncommitted and committed are
 * then the same diff against the branch's base, so it is one section; the last turn's row is read
 * against the tree the turn started from, another diff, so it is a section of its own. */
export function reviewSections(c: ChangeSections): ReviewSection[] {
  const out: ReviewSection[] = [];
  const seen = new Set<string>();
  const add = (f: GitFileStatus, since: string | undefined, uncommitted: boolean) => {
    const key = `${since ?? ""}\n${f.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ f, at: since ? { path: f.path, since } : { path: f.path }, uncommitted });
  };
  for (const f of c.files) add(f, undefined, true);
  for (const f of c.turned) add(f, c.turnBase, true);
  for (const f of c.committed) add(f, undefined, false);
  return out;
}
