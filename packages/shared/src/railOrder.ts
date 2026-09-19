import type { WorktreeInfo } from "./model.ts";
import { isLead } from "./worktree-caps.ts";

/** when someone last put work into a row: what they sent, else its agent's last turn for a row from
 * before sends were stamped, else when it was made */
export const sentAt = (w: WorktreeInfo) => w.promptedAt ?? w.lastTurn?.at ?? w.createdAt;

/** where a row sits in the rail's order: the lead (the spare, or main without one), open work,
 * landed work */
const tierOf = (w: WorktreeInfo) => (isLead(w) ? 0 : w.landed ? 2 : 1);

/** what a row moves with on the rail: itself, or its variant group on its tier, since a landed
 * attempt goes with landed work and the ones it beat stay where they were */
export const railUnitOf = (w: WorktreeInfo): string => (w.variant ? `${tierOf(w)}:${w.variant.group}` : `row:${w.id}`);

/** The rail's order: the lead, then the rows most recently sent to, then landed ones. Only a send moves
 * a row, never an agent finishing or asking, so a row does not slide out from under the pointer
 * while agents run; what needs you is the dot's and the jump chord's to say. A variant group moves
 * as one, at its newest sibling's time and in index order, so a follow-up to one attempt does not
 * pull it away from the attempts it is being compared with. Rows that tie keep the daemon's order. */
export function railOrder<T extends { worktree: WorktreeInfo }>(rows: readonly T[]): T[] {
  const units: { tier: number; at: number; rows: T[] }[] = [];
  const groups = new Map<string, (typeof units)[number]>();
  for (const row of rows) {
    const w = row.worktree;
    const key = railUnitOf(w);
    const unit = groups.get(key);
    if (unit) {
      unit.rows.push(row);
      unit.at = Math.max(unit.at, sentAt(w));
      continue;
    }
    const fresh = { tier: tierOf(w), at: sentAt(w), rows: [row] };
    units.push(fresh);
    groups.set(key, fresh);
  }
  // stable, so a tie is the daemon's order
  units.sort((a, b) => a.tier - b.tier || b.at - a.at);
  return units.flatMap((u) =>
    u.rows.length > 1
      ? u.rows.sort((a, b) => (a.worktree.variant?.index ?? 0) - (b.worktree.variant?.index ?? 0))
      : u.rows,
  );
}
