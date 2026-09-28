// How much of the unchanged code a diff shows around its hunks.
//
// Monaco folds every unchanged stretch down to a fixed few lines of context. That is the right
// policy for a long file with hunks all through it and the wrong one for a one-line change in a
// short file, where the pane has room for the whole thing and shows eight rows of it over a blank.
// The pane's height decides instead: a diff that fits is shown whole, and one that does not takes
// as much context around each hunk as fills the pane, so nothing is folded that there was room
// to read. The fold bands stay for what is left over.

/** one hunk: the first line of its modified range, and the line count on each side (0 for a
 * pure insert or a pure delete) */
export interface Hunk {
  modifiedStart: number;
  original: number;
  modified: number;
}

export interface Fold {
  /** fold the unchanged stretches at all */
  enabled: boolean;
  /** lines kept on each side of a hunk when they are */
  contextLineCount: number;
  /** the diff runs past the pane even so, and the pane scrolls */
  scrolls: boolean;
}

export interface Pane {
  height: number;
  lineHeight: number;
}

/** Monaco's default, and the floor: under it a hunk is read with nothing around it */
export const CONTEXT_FLOOR = 3;

/** a short gap between hunks shows as code: a fold band saves a couple of lines and costs a click
 * and a jump, so only a real stretch is worth folding */
export const FOLD_MIN = 10;

/** the fold band is a fixed zone, not a row */
const BAND_PX = 24;

/** the height of the diff of `hunks` over a file `modifiedLines` long, folded with `context` lines
 * around each hunk, or unfolded for a context of Infinity. Monaco's own rule: a stretch at either
 * end of the file folds once it holds a context and the minimum; one between hunks needs a context
 * on each side. Inline, a deleted line is a row of its own under the file's lines. */
function heightOf(pane: Pane, modifiedLines: number, hunks: Hunk[], context: number): number {
  let rows = 0;
  let bands = 0;
  let at = 1;
  const gap = (length: number, edge: boolean) => {
    const keep = edge ? context : 2 * context;
    if (length >= keep + FOLD_MIN) {
      rows += keep;
      bands += 1;
    } else rows += length;
  };
  hunks.forEach((h, i) => {
    gap(h.modifiedStart - at, i === 0);
    rows += Math.max(h.original, h.modified);
    at = h.modifiedStart + h.modified;
  });
  gap(modifiedLines + 1 - at, true);
  return rows * pane.lineHeight + bands * BAND_PX;
}

/** the fold for a diff of `hunks` over a file `modifiedLines` long, read in `pane` */
export function diffFit(pane: Pane, modifiedLines: number, hunks: Hunk[]): Fold {
  const whole = { enabled: false, contextLineCount: CONTEXT_FLOOR, scrolls: false };
  if (hunks.length === 0) return whole;
  if (heightOf(pane, modifiedLines, hunks, Number.POSITIVE_INFINITY) <= pane.height) return whole;
  // the largest context that still fits; past what unfolds everything there is nothing to gain
  let context = CONTEXT_FLOOR;
  for (let c = CONTEXT_FLOOR + 1; c <= modifiedLines; c++) {
    if (heightOf(pane, modifiedLines, hunks, c) > pane.height) break;
    context = c;
  }
  const scrolls = heightOf(pane, modifiedLines, hunks, context) > pane.height;
  return { enabled: true, contextLineCount: context, scrolls };
}
