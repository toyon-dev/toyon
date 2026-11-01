import type { GitFileStatus, GitInfo } from "@toyon/shared";
import { testsLast } from "./testFiles.ts";

const NONE: readonly GitFileStatus[] = [];

/** The changes list's three sections, each read change first and tests after, in the one flat
 * order the cursor walks: what is uncommitted, what the last turn changed (shut until asked for,
 * and absent when the turn is everything uncommitted), and what is committed on the branch
 * (folded away when shut). `*Source` counts the rows before a section's tests. One place, so
 * anything that reads the changes as the list draws them gets the same order. */
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
