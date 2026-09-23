/**
 * Which preview frame the centre paints.
 *
 * Not always the selected worktree's. A frame mounts blank: the iframe is created when the
 * worktree's server answers, and the page inside it arrives some time after that, so painting it
 * straight away puts a white frame where an app was on screen a moment earlier. A switch keeps
 * the frame it is leaving until the one arriving has drawn a page. The rules are here rather than
 * in the component because each is a judgement: what may stand in for what.
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
  // no frame is coming yet, so the boot pane has the honest answer: a stale app left up for seconds
  // is something to click on by mistake. The carry covers only the gap between a frame existing
  // and its app drawing.
  if (!o.ready) return null;
  if (o.carry && o.mounted.includes(o.carry)) return o.carry;
  // nothing to carry: the frame itself, blank or on the proxy's waiting page, which beats an empty centre
  return o.previewId;
}
