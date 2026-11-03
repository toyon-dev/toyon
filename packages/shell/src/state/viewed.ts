/** The worktrees viewed, in the order a hand chose them, for ⌘←/→ to walk back and forward
 * through the way a browser walks pages: `at` is where you stand, a step moves it, and choosing a
 * row from where you stand drops what was ahead. Kept for the page, not stored: a reload starts
 * the walk over, as Slack's does. */
export interface Viewed {
  ids: string[];
  at: number;
}

export const EMPTY_VIEWED: Viewed = { ids: [], at: -1 };

/** how far back the walk reaches; past this the oldest entry goes */
export const VIEWED_CAP = 50;

/** a row chosen by hand, from the one that was on screen. The first choice seeds the list with
 * where it was made from, so one step back has somewhere to land. */
export function pushViewed(v: Viewed, from: string | null, to: string): Viewed {
  if (v.ids[v.at] === to) return v;
  const kept = v.ids.length ? v.ids.slice(0, v.at + 1) : from ? [from] : [];
  const ids = [...kept, to].slice(-VIEWED_CAP);
  return { ids, at: ids.length - 1 };
}

export type ViewedStep = { at: number; activate: string } | null;

/** the nearest entry in `dir` that is still a row and is not the one on screen */
export function viewedStep(v: Viewed, live: ReadonlySet<string>, activeId: string | null, dir: 1 | -1): ViewedStep {
  for (let at = v.at + dir; at >= 0 && at < v.ids.length; at += dir) {
    const id = v.ids[at];
    if (id !== undefined && id !== activeId && live.has(id)) return { at, activate: id };
  }
  return null;
}

/** drop the rows that are gone, and the repeats their going leaves side by side; the same object
 * back when nothing changed, so a frame that moves nothing re-renders nothing */
export function pruneViewed(v: Viewed, live: ReadonlySet<string>): Viewed {
  if (v.ids.every((id) => live.has(id))) return v;
  const ids: string[] = [];
  let at = -1;
  v.ids.forEach((id, i) => {
    if (!live.has(id)) return;
    if (ids[ids.length - 1] !== id) ids.push(id);
    // where you stood, or the nearest kept entry before it
    if (i <= v.at) at = ids.length - 1;
  });
  return { ids, at: ids.length ? Math.max(at, 0) : -1 };
}
