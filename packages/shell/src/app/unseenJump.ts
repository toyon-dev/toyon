/** Where ⌥⇧↑/↓ lands: Slack's next-unread, on the rail. Three tiers, in falling order of what the
 * rail owes you: an agent waiting on you, which has stopped until someone answers; a turn nobody has
 * looked at, which is finished and can sit; a row still working, which owes you nothing yet but is
 * the only place left with something happening. The nearest row of the best occupied tier in the
 * direction pressed, wrapping round when the direction runs out. With every tier empty the chord is
 * the walk's end instead, the first row going up and the draft going down, so it always does
 * something. From a draft, "here" is its seat under the first row, where the rail draws it. */
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
  const tiers = [
    () => marked((w) => w.agent === "waiting"),
    () => marked((w) => !!w.unseen),
    () => marked((w) => w.agent === "working"),
  ];
  const targets = tiers.reduce<number[]>((found, tier) => (found.length > 0 ? found : tier()), []);
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
