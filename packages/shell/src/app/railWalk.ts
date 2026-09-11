/** Where ⌥↑/↓ and ⌃Tab land: the rail's order, top to bottom, with the new-worktree row as the
 * last stop on the owned walk, and the walk wraps round the way a terminal's tabs do. Down from
 * the last owned row opens the draft and down from the draft is the first row; up runs the same
 * loop backwards. The found list is a walk of its own: it is off the loop (down never wanders into
 * it), but a found row on screen is the one place the keys have to work, so from there they step
 * through the found rows, and up from the first one is the way back to the owned rows. */
export type RailWalk = { activate: string } | { draft: true } | null;

export function railWalk(
  owned: readonly { id: string }[],
  found: readonly { id: string }[],
  activeId: string | null,
  drafting: boolean,
  dir: 1 | -1,
): RailWalk {
  const last = owned[owned.length - 1];
  if (drafting) {
    const wt = dir > 0 ? owned[0] : last;
    return wt ? { activate: wt.id } : null;
  }
  const at = owned.findIndex((w) => w.id === activeId);
  if (at >= 0) {
    const wt = owned[at + dir];
    return wt ? { activate: wt.id } : { draft: true };
  }
  const fat = found.findIndex((w) => w.id === activeId);
  if (fat < 0) return null;
  const wt = found[fat + dir];
  if (wt) return { activate: wt.id };
  return dir < 0 && last ? { activate: last.id } : null;
}
