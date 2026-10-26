// The rows a `worktrees` frame leaves the page with. The daemon publishes one set to every page
// (its hello carries it) and each frame after names every id in order and carries only the rows
// that changed, so the list is rebuilt from the frame's rows and the ones held, and a row that did
// not move keeps its identity.

import type { WorktreeStatus } from "@toyon/shared";

/** The full list the frame makes. `complete` is false when an id names a row this page holds no
 * version of, a frame it should never have been sent: the id is dropped, and the caller blanks the
 * rows stamp so the next hello sends the set whole. */
export function rowsFrom(
  held: readonly WorktreeStatus[],
  frame: { ids: readonly string[]; rows: readonly WorktreeStatus[] },
): { rows: WorktreeStatus[]; complete: boolean } {
  const changed = new Map(frame.rows.map((r) => [r.id, r]));
  const kept = new Map(held.map((r) => [r.id, r]));
  const rows: WorktreeStatus[] = [];
  let complete = true;
  for (const id of frame.ids) {
    const row = changed.get(id) ?? kept.get(id);
    if (row) rows.push(row);
    else complete = false;
  }
  return { rows, complete };
}
