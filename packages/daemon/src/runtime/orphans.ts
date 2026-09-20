// Which of the process groups the last daemon recorded are still running with nobody to own
// them, from its ledger and the process table. Pure: the registry reads the machine and kills.

import type { GroupEntry } from "../core/state.ts";
import type { PsRow } from "./memory.ts";

/** an entry older than this is dropped unread: pids wrap (macOS counts to 99999), and a group
 * recorded a day ago says nothing about who holds its number now */
const GROUP_TTL_MS = 24 * 60 * 60_000;
/** a leader whose start is further than this from the record's is another process on a reused
 * pid; `ps` gives the start to the second, and the record is stamped a beat after the spawn */
const LEADER_SLACK_MS = 10_000;

export interface Orphan {
  worktreeId: string;
  pgid: number;
  name: string;
}

/** The entries whose group is still up under nobody. A leader present must have started when
 * the record says, else its pid was reused. A group with members and no leader is ours for
 * certain: a group id cannot come back without a leader of that pid, and nothing can join a
 * group whose leader is gone. That is the shape a dead daemon leaves: the `sh` that led each
 * proc is gone, and the dev server it started sits under launchd with the old pgid. */
export function orphansIn(
  ledger: Array<GroupEntry & { worktreeId: string }>,
  rows: PsRow[],
  bootId: string | null,
  ledgerBootId: string | undefined,
  now: number,
): Orphan[] {
  // no reading, or a ledger from another boot: every pid in it is from another life
  if (bootId === null || ledgerBootId === undefined || bootId !== ledgerBootId) return [];
  const out: Orphan[] = [];
  for (const entry of ledger) {
    if (now - entry.startedAt > GROUP_TTL_MS) continue;
    const members = rows.filter((r) => r.pgid === entry.pgid);
    if (members.length === 0) continue;
    const leader = members.find((r) => r.pid === entry.pgid);
    if (leader && Math.abs(leader.startedAt - entry.startedAt) > LEADER_SLACK_MS) continue;
    out.push({ worktreeId: entry.worktreeId, pgid: entry.pgid, name: entry.name });
  }
  return out;
}

/** Adapter processes reparented to init: a group leader under pid 1 running from the agents
 * directory. Whatever spawned it was toyon (a probe or a sign-out runs with no worktree and is
 * never in the ledger, and a daemon from before the ledger wrote none), and its daemon is gone. */
export function strayAdapters(rows: PsRow[], agentsDir: string): PsRow[] {
  return rows.filter((r) => r.pid === r.pgid && r.ppid === 1 && r.command.includes(agentsDir));
}
