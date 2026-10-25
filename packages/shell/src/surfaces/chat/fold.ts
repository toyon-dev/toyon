/** How far past the ride's extent the reader has to be before the box counts as folded, and how
 * far back inside it before it does not: a reader resting on the extent itself would otherwise
 * flip the strip and the ghost with every pixel of rounding. The box's own place is the
 * stylesheet's and moves with neither. */
export const FOLD_SETTLE = 4;

/** Whether the phone's box stands folded for a reader `gap` px up from the end of the log. The
 * box rides down with the end of the transcript (its sticky offset, chat.css) as far as `extent`,
 * its full height less the rows it keeps, and past that those rows stand at the foot while the
 * transcript goes on scrolling under them. `folded` is the box as it stands, for the band. */
export function foldedAt(gap: number, extent: number, folded: boolean): boolean {
  const reach = Math.max(extent, 0);
  return folded ? gap >= reach + 1 : gap >= reach + FOLD_SETTLE;
}
