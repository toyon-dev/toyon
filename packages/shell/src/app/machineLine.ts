import type { ConnectFailure } from "@toyon/shared";
import { needsYou } from "./unseenJump.ts";

/** what a row about another machine reads from that machine's store */
export interface MachineGlance {
  /** that machine's owned rows: id, whether a turn there is unread, what its agent is doing */
  rows: readonly { id: string; unseen?: boolean; agent?: string }[];
  connected: boolean;
  connectFailure: ConnectFailure | null;
  /** its daemon speaks another protocol than this page */
  incompatible: boolean;
  /** an edge machine not being looked at holds no connection on purpose */
  suspended?: boolean;
}

/** The line under another machine's name on the home screen: what it needs of you, or why it
 * cannot say. The tiers are the rail's (unseenJump.ts), read as a person would say them. */
export function machineLine(name: string, g: MachineGlance): string {
  if (g.incompatible) return `update Toyon on ${name}`;
  if (g.suspended) return "sleeping";
  if (!g.connected) return g.connectFailure ? "not answering" : "connecting";
  const owed = needsYou(g.rows, null);
  if (!owed) return "all quiet";
  return `${owed.n} ${owed.tier === "waiting" ? "waiting" : "unread"}`;
}
