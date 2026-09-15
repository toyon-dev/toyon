import type { UpdateState } from "@toyon/shared";

/** what the top bar's update chip says and does; null when there is nothing to say */
export interface UpdateNotice {
  /** the chip's word */
  word: string;
  /** its tip: what the state means */
  text: string;
  /** a press tries the update again */
  retry: boolean;
  /** a restart is waiting, so the chip shows it and takes no press */
  busy: boolean;
}

/**
 * Toyon updates itself the way a site does, so while that works the chip says nothing: a newer
 * version installs and the tab reloads onto it. It shows only what someone has to know: an
 * install that failed, with why and what to run by hand, and a restart someone pressed for that
 * is waiting on a chat to finish.
 */
export function updateNotice(u: UpdateState | null): UpdateNotice | null {
  if (!u) return null;
  if (u.restarting && u.restarting.length > 0) {
    const n = u.restarting.length;
    return {
      word: n === 1 ? "restarts after a reply" : `restarts after ${n} replies`,
      text: `Toyon restarts once ${u.restarting.join(", ")} ${n === 1 ? "finishes" : "finish"}`,
      retry: false,
      busy: true,
    };
  }
  if (u.failed) {
    const why = u.failed.line.replace(/\.$/, "");
    return {
      word: "update failed",
      text: `Installing Toyon ${u.failed.version} stopped: ${why}. To update by hand, run ${u.failed.command}`,
      retry: true,
      busy: false,
    };
  }
  return null;
}
