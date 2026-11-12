/** How far each heading sits under the ones above it: the count of open headings of a lower level,
 * not the level itself. An h1 is the document's title, not a section: it stands at the margin and
 * opens no level, so the sections under it stand at the margin too. An h3 under an h2 is one step
 * in; an h3 with no h2 above it stands at the margin, and an h4 straight under an h2 is one step
 * in, not two. */
export function outlineDepths(levels: number[]): number[] {
  const open: number[] = [];
  return levels.map((level) => {
    while (open.length && open[open.length - 1]! >= level) open.pop();
    if (level === 1) return 0;
    const depth = open.length;
    open.push(level);
    return depth;
  });
}

/** how far inside the list's edge the hand that opened it is kept: half a row, so it is on a title */
const HAND_INSET = 12;

/** Where the middle of the titles goes, down the window. On the strip's own middle, where a list
 * taller than the strip covers all of it. A list the cap left shorter than the strip cannot, so it
 * moves along the strip, and only as far as it takes to open under the hand that pointed: the hand
 * is inside the box from the start, and leaving the box is what closes it. */
export function outlineCentre(strip: { top: number; bottom: number }, hand: number, height: number): number {
  const reach = Math.max(0, height / 2 - HAND_INSET);
  return Math.max(hand - reach, Math.min((strip.top + strip.bottom) / 2, hand + reach));
}
