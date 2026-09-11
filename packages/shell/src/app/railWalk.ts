/** Where ⌥↑/↓ and ⌃Tab land: the rail's order, top to bottom, which seats the new-worktree row
 * under main, and the walk wraps round the way a terminal's tabs do. Down from main opens the draft
 * and down from the draft is the first task; up runs the same loop backwards, so up from main is
 * the last row. The found list is a walk of its own: it is off the loop (down never wanders into
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
  // the loop as drawn: main, the draft's seat (null), then the tasks
  const [first, ...tasks] = owned;
  const loop: (string | null)[] = first ? [first.id, null, ...tasks.map((w) => w.id)] : [];
  const at = drafting ? (first ? 1 : -1) : activeId ? loop.indexOf(activeId) : -1;
  if (at >= 0) {
    const next = loop[(at + dir + loop.length) % loop.length];
    return next ? { activate: next } : { draft: true };
  }
  if (drafting || !activeId) return null;
  const fat = found.findIndex((w) => w.id === activeId);
  if (fat < 0) return null;
  const wt = found[fat + dir];
  if (wt) return { activate: wt.id };
  const last = owned[owned.length - 1];
  return dir < 0 && last ? { activate: last.id } : null;
}
