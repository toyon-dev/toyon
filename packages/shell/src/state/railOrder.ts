import { isMain, type OwnedWorktree, type WorktreeInfo } from "@toyon/shared";

/** when someone last put work into a row: what they sent, else its agent's last turn for a row from
 * before sends were stamped, else when it was made */
const sentAt = (w: WorktreeInfo) => w.promptedAt ?? w.lastTurnAt ?? w.createdAt;

/** The rail's order: main, then the rows most recently sent to, then landed ones. Only a send moves
 * a row, never an agent finishing or asking, so a row does not slide out from under the pointer
 * while agents run; what needs you is the dot's and the jump chord's to say. A variant group moves
 * as one, at its newest sibling's time and in index order, so a follow-up to one attempt does not
 * pull it away from the attempts it is being compared with. Rows that tie keep the daemon's order. */
export function railOrder(rows: readonly OwnedWorktree[]): OwnedWorktree[] {
  const units: { tier: number; at: number; rows: OwnedWorktree[] }[] = [];
  const groups = new Map<string, (typeof units)[number]>();
  for (const row of rows) {
    const w = row.worktree;
    const tier = isMain(w) ? 0 : w.landed ? 2 : 1;
    const key = w.variant ? `${tier}:${w.variant.group}` : null;
    const unit = key ? groups.get(key) : undefined;
    if (unit) {
      unit.rows.push(row);
      unit.at = Math.max(unit.at, sentAt(w));
      continue;
    }
    const fresh = { tier, at: sentAt(w), rows: [row] };
    units.push(fresh);
    if (key) groups.set(key, fresh);
  }
  // stable, so a tie is the daemon's order
  units.sort((a, b) => a.tier - b.tier || b.at - a.at);
  return units.flatMap((u) =>
    u.rows.length > 1
      ? u.rows.sort((a, b) => (a.worktree.variant?.index ?? 0) - (b.worktree.variant?.index ?? 0))
      : u.rows,
  );
}
