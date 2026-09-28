// How much of the unchanged code a diff shows around its hunks.
//
// Monaco folds every unchanged stretch down to a fixed few lines of context. That is the right
// policy for a long file with hunks all through it and the wrong one for a one-line change in a
// short file, where the pane has room for the whole thing and shows eight rows of it over a blank.
// The pane's height decides instead: a diff that fits is shown whole, and one that does not takes
// as much context around each hunk as fills the rows, so nothing is folded that there was room
// to read. The fold bands stay for what is left over.

/** one hunk, as the line count on each side (0 for a pure insert or a pure delete) */
export interface Hunk {
  original: number;
  modified: number;
}

export interface Fold {
  /** fold the unchanged stretches at all */
  enabled: boolean;
  /** lines kept on each side of a hunk when they are */
  contextLineCount: number;
}

/** Monaco's default, and the floor: under it a hunk is read with nothing around it */
export const CONTEXT_FLOOR = 3;

const WHOLE: Fold = { enabled: false, contextLineCount: CONTEXT_FLOOR };

/** the fold for a diff of `hunks` over a file `modifiedLines` long, in a pane `rows` lines tall */
export function diffFit(rows: number, modifiedLines: number, hunks: Hunk[]): Fold {
  if (hunks.length === 0) return WHOLE;
  // inline, a deleted line is a row of its own under the file's lines, so the whole diff runs
  // longer than the file by what was removed
  const deleted = hunks.reduce((n, h) => n + Math.max(0, h.original - h.modified), 0);
  if (modifiedLines + deleted <= rows) return WHOLE;
  const changed = hunks.reduce((n, h) => n + Math.max(h.original, h.modified), 0);
  // a fold band takes room too, a row and a half of it: one between hunks and one at each end,
  // at most, each counted as two rows so the diff never runs a few pixels past the pane
  const bands = 2 * (hunks.length + 1);
  const context = Math.floor((rows - changed - bands) / (2 * hunks.length));
  return { enabled: true, contextLineCount: Math.max(CONTEXT_FLOOR, context) };
}
