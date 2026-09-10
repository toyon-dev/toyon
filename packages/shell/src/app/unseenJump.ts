/** Where ⌥⇧↑/↓ lands: Slack's next-unread, on the rail. The nearest row in that direction with a
 * turn nobody has looked at, wrapping round when the direction runs out; with no such row anywhere
 * the chord is the walk's end instead, the first row going up and the draft going down, so it
 * always does something. From a draft, "here" is past the last row. */
export type UnseenJump = { activate: string } | { draft: true } | null;

export function unseenJump(
  rows: readonly { id: string; unseen?: boolean }[],
  activeId: string | null,
  drafting: boolean,
  dir: 1 | -1,
): UnseenJump {
  const n = rows.length;
  // the row on screen is looked at by definition, so it is never the answer
  const unseen = rows.map((w, i) => (w.unseen && w.id !== activeId ? i : -1)).filter((i) => i >= 0);
  if (unseen.length === 0) {
    if (dir < 0) return rows[0] ? { activate: rows[0].id } : null;
    return drafting ? null : { draft: true };
  }
  const at = drafting ? n : rows.findIndex((w) => w.id === activeId);
  const i =
    dir > 0 ? (unseen.find((k) => k > at) ?? unseen[0]) : (unseen.findLast((k) => k < at) ?? unseen[unseen.length - 1]);
  const wt = i === undefined ? undefined : rows[i];
  return wt ? { activate: wt.id } : null;
}
