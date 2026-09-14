/** Where ⌥↑/↓ and ⌃Tab land: the rail's order, top to bottom, and the walk wraps round the way a
 * terminal's tabs do, so down from the last row is main and up from main is the last row. The found
 * list is a walk of its own: it is off the loop (down never wanders into it), but a found row on
 * screen is the one place the keys have to work, so from there they step through the found rows,
 * and up from the first one is the way back to the owned rows. */
export type RailWalk = { activate: string } | null;

export function railWalk(
  owned: readonly { id: string }[],
  found: readonly { id: string }[],
  activeId: string | null,
  dir: 1 | -1,
): RailWalk {
  if (!activeId) return null;
  const at = owned.findIndex((w) => w.id === activeId);
  if (at >= 0) {
    const next = owned[(at + dir + owned.length) % owned.length];
    return next && next.id !== activeId ? { activate: next.id } : null;
  }
  const fat = found.findIndex((w) => w.id === activeId);
  if (fat < 0) return null;
  const wt = found[fat + dir];
  if (wt) return { activate: wt.id };
  const last = owned[owned.length - 1];
  return dir < 0 && last ? { activate: last.id } : null;
}
