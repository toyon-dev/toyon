/** Where ⌥⇧↑/↓ lands: Slack's next-unread, on the rail. Three tiers, in falling order of what the
 * rail owes you: an agent waiting on you, which has stopped until someone answers; a turn nobody has
 * looked at, which is finished and can sit; a row still working, which owes you nothing yet but is
 * the only place left with something happening. The nearest row of the best occupied tier in the
 * direction pressed, wrapping round when the direction runs out. With every tier empty the chord
 * goes to the first row, main, which is where new work starts, so it always does something until
 * you are there. */
export type UnseenJump = { activate: string } | null;

type JumpRow = { id: string; unseen?: boolean; agent?: string };

/** What the rail owes you right now, for a control with no chord behind it: the rows in the first
 * two tiers above, the row on screen excepted, and the best tier present, so the control can say
 * which it is. A row still working is not owed: nothing there is waiting on anyone. */
export type NeedsYou = { n: number; tier: "waiting" | "unseen" } | null;

export function needsYou(rows: readonly JumpRow[], activeId: string | null): NeedsYou {
  const others = rows.filter((w) => w.id !== activeId);
  const n = others.filter((w) => w.agent === "waiting" || w.unseen).length;
  if (n === 0) return null;
  return { n, tier: others.some((w) => w.agent === "waiting") ? "waiting" : "unseen" };
}

export function unseenJump(rows: readonly JumpRow[], activeId: string | null, dir: 1 | -1): UnseenJump {
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
    const first = rows[0];
    return first && first.id !== activeId ? { activate: first.id } : null;
  }
  const at = rows.findIndex((w) => w.id === activeId);
  const i =
    dir > 0
      ? (targets.find((k) => k > at) ?? targets[0])
      : (targets.findLast((k) => k < at) ?? targets[targets.length - 1]);
  const wt = i === undefined ? undefined : rows[i];
  return wt ? { activate: wt.id } : null;
}
