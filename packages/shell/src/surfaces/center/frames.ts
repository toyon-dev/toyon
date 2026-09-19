/**
 * Which preview frame the centre paints.
 *
 * Not always the selected worktree's. A frame mounts blank: the iframe is created when the
 * worktree's server answers, and the page inside it arrives some time after that. Painting it
 * straight away is how a send that starts a worktree used to blank the centre, with the boot pane
 * and then a white frame standing in for an app that was on screen a moment earlier.
 *
 * So a switch keeps the frame it is leaving until the one arriving has drawn a page. The rules are
 * here rather than in the component because each of them is a judgement: what may stand in for
 * what, and what it means for a frame to have something on it.
 */

/** the frame a switch keeps on screen while the one coming in is still blank: the one leaving, if
 * there is a frame coming in at all and both belong to the same project. Another project's app is
 * not a stand-in for this one, however briefly. */
export function carriedFrame(
  leaving: string | null,
  arriving: string | null,
  repoOf: (id: string) => string | null,
): string | null {
  if (!leaving || !arriving || leaving === arriving) return null;
  return repoOf(leaving) === repoOf(arriving) ? leaving : null;
}

/** what is painted: the selected worktree's frame once it has drawn a page, else the frame being
 * carried while it is still mounted (it comes down on its own timer), else nothing */
export function shownFrame(o: {
  previewId: string | null;
  painted: boolean;
  /** the selected worktree's own server answers, so its frame is up or on its way */
  ready: boolean;
  carry: string | null;
  mounted: readonly string[];
}): string | null {
  // nothing selected is nothing to show: the centre has its own view there (a chat, an archived
  // page), and a carried app under it would be another worktree's
  if (o.previewId === null) return null;
  if (o.painted) return o.previewId;
  // No frame is coming yet, so the boot pane has the honest answer: it says what this worktree's
  // procs are doing, where a stale app left up for seconds is something to click on by mistake.
  // The carry is for the gap between a frame existing and its app drawing, and no longer.
  if (!o.ready) return null;
  if (o.carry && o.mounted.includes(o.carry)) return o.carry;
  // Nothing to carry (the first preview of a session, another project's, or a carry that has run
  // out): the frame itself, blank or on the proxy's waiting page, which is what stood here before
  // any of this. An empty centre would be the one thing worse than either.
  return o.previewId;
}
