/** How far past the ride's extent the reader has to be before the box folds: a reader resting on
 * the extent itself would otherwise swap the box with every pixel of rounding. The swap moves
 * nothing either way, since a box ridden to its extent shows the same line the fold does, so the
 * band is only against the blink. Unfolding waits a pixel inside the extent for the same reason. */
export const FOLD_SETTLE = 4;

/** Where the phone's box stands for a reader `gap` px up from the end of the log. The box rides
 * down with the end of the transcript, pixel for pixel, as far as `extent`: its full height less
 * the line it folds to, so that what is left on screen at the extent is that line. Past it the box
 * is `folded` to the line itself and the transcript goes on scrolling under it; back within the
 * extent it unfolds and rides up with the end. `folded` is the box as it stands, for the band. */
export function foldAt(gap: number, extent: number, folded: boolean): { ride: number; folded: boolean } {
  const reach = Math.max(extent, 0);
  const ride = Math.min(Math.max(gap, 0), reach);
  return { ride, folded: folded ? gap >= reach + 1 : gap >= reach + FOLD_SETTLE };
}
