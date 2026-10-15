/** Where the arrow keys take the full view: one stop along the list it was opened from. Unmodified
 * only, as in the tool rows: with shift or a modifier they are the browser's, extending a selection
 * in a paste. */
export function navStep(e: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): -1 | 1 | null {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return null;
  if (e.key === "ArrowLeft") return -1;
  if (e.key === "ArrowRight") return 1;
  return null;
}

/** The stop a step lands on, or null at the list's end: the view stops there rather than wrapping,
 * so a key held down reads the list once and does not come round to the start. */
export function stepIndex(at: number, of: number, dir: -1 | 1): number | null {
  const next = at + dir;
  return next < 0 || next >= of ? null : next;
}
