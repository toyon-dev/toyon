import type { UpdateState } from "@toyon/shared";

/** what the top bar's update chip says; null when there is nothing to say */
export interface UpdateNotice {
  /** the chip's word */
  word: string;
  /** its tip: what the state means */
  text: string;
  /** a restart is already asked for, so the chip shows it under way and takes no press */
  busy: boolean;
}

/**
 * The chip for Toyon falling behind what is installed on the machine. A restart, once asked for, is
 * held by the daemon until no chat is mid-reply, so the chip says it is waiting rather than
 * refusing the press. The word stays short for the bar; the tip names the chats.
 */
export function updateNotice(u: UpdateState | null): UpdateNotice | null {
  if (!u) return null;
  if (u.restarting) {
    const n = u.restarting.length;
    if (n === 0) return { word: "restarting", text: "Toyon is restarting", busy: true };
    return {
      word: n === 1 ? "restarts after a reply" : `restarts after ${n} replies`,
      text: `Toyon restarts once ${u.restarting.join(", ")} ${n === 1 ? "finishes" : "finish"}`,
      busy: true,
    };
  }
  if (u.installed) {
    return {
      word: "restart to update",
      text: `Toyon ${u.installed} is installed; ${u.running} is running`,
      busy: false,
    };
  }
  return null;
}
