/** Where ⌥⇧↑/↓ lands: Slack's next-unread, on the rail. An agent waiting on you outranks a turn
 * nobody has looked at, because the waiting one has stopped until someone answers while the finished
 * one can sit: the nearest waiting row in that direction, else the nearest unseen one, wrapping round
 * when the direction runs out. With neither anywhere the chord is the walk's end instead, the first
 * row going up and the draft going down, so it always does something. From a draft, "here" is its
 * seat under the first row, where the rail draws it. */
export type UnseenJump = { activate: string } | { draft: true } | null;

type JumpRow = { id: string; unseen?: boolean; agent?: string };

export function unseenJump(
  rows: readonly JumpRow[],
  activeId: string | null,
  drafting: boolean,
  dir: 1 | -1,
): UnseenJump {
  // the row on screen is looked at by definition, so it is never the answer
  const marked = (hit: (w: JumpRow) => boolean) =>
    rows.map((w, i) => (hit(w) && w.id !== activeId ? i : -1)).filter((i) => i >= 0);
  const waiting = marked((w) => w.agent === "waiting");
  const targets = waiting.length > 0 ? waiting : marked((w) => !!w.unseen);
  if (targets.length === 0) {
    if (dir < 0) return rows[0] ? { activate: rows[0].id } : null;
    return drafting ? null : { draft: true };
  }
  // between the first row and the second, so up from a draft still finds main
  const at = drafting ? 0.5 : rows.findIndex((w) => w.id === activeId);
  const i =
    dir > 0
      ? (targets.find((k) => k > at) ?? targets[0])
      : (targets.findLast((k) => k < at) ?? targets[targets.length - 1]);
  const wt = i === undefined ? undefined : rows[i];
  return wt ? { activate: wt.id } : null;
}
