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

/** The nearest row of the best occupied tier in the direction pressed, wrapping round, or null with
 * every tier empty. `activeId` is where the looking starts and is never the answer. */
export function owedJump(rows: readonly JumpRow[], activeId: string | null, dir: 1 | -1): UnseenJump {
  // the row on screen is looked at by definition, so it is never the answer
  const marked = (hit: (w: JumpRow) => boolean) =>
    rows.map((w, i) => (hit(w) && w.id !== activeId ? i : -1)).filter((i) => i >= 0);
  const tiers = [
    () => marked((w) => w.agent === "waiting"),
    () => marked((w) => !!w.unseen),
    () => marked((w) => w.agent === "working"),
  ];
  const targets = tiers.reduce<number[]>((found, tier) => (found.length > 0 ? found : tier()), []);
  const at = rows.findIndex((w) => w.id === activeId);
  const i =
    dir > 0
      ? (targets.find((k) => k > at) ?? targets[0])
      : (targets.findLast((k) => k < at) ?? targets[targets.length - 1]);
  const wt = i === undefined ? undefined : rows[i];
  return wt ? { activate: wt.id } : null;
}

export function unseenJump(rows: readonly JumpRow[], activeId: string | null, dir: 1 | -1): UnseenJump {
  const owed = owedJump(rows, activeId, dir);
  if (owed) return owed;
  const first = rows[0];
  return first && first.id !== activeId ? { activate: first.id } : null;
}

/** another machine this page lists, and the rows its daemon holds */
export type Elsewhere = { origin: string; rows: readonly JumpRow[] };

/** `needsYou` over every machine the page lists: what this rail owes plus what each other machine
 * owes, since a phone is opened to find out what needs you and cannot see the other machines'
 * lists. The tier is the best present anywhere. */
export function needsYouAcross(
  rows: readonly JumpRow[],
  activeId: string | null,
  elsewhere: readonly Elsewhere[],
): NeedsYou {
  const found = [needsYou(rows, activeId), ...elsewhere.map((m) => needsYou(m.rows, null))].filter(
    (o): o is NonNullable<NeedsYou> => o !== null,
  );
  if (found.length === 0) return null;
  return {
    n: found.reduce((n, o) => n + o.n, 0),
    tier: found.some((o) => o.tier === "waiting") ? "waiting" : "unseen",
  };
}

/** where the control that says `needsYouAcross` lands: the best tier present anywhere, this
 * machine's rows first at that tier (the nearest after the row on screen, as the chord picks),
 * then the other machines in the order they are listed, each at its first row of the tier. With
 * nothing owed anywhere it falls back to this machine's `unseenJump`, so the control always does
 * something. `origin` is null for a row on this machine. */
export function owedJumpAcross(
  rows: readonly JumpRow[],
  activeId: string | null,
  elsewhere: readonly Elsewhere[],
): { origin: string | null; activate: string } | null {
  const tiers: ((w: JumpRow) => boolean)[] = [(w) => w.agent === "waiting", (w) => !!w.unseen];
  for (const hit of tiers) {
    if (rows.some((w) => hit(w) && w.id !== activeId)) {
      // owedJump's own first tier is this one, since nothing above it is present here
      const here = owedJump(rows, activeId, 1);
      return here && { origin: null, activate: here.activate };
    }
    for (const m of elsewhere) {
      const w = m.rows.find(hit);
      if (w) return { origin: m.origin, activate: w.id };
    }
  }
  const here = unseenJump(rows, activeId, 1);
  return here && { origin: null, activate: here.activate };
}
