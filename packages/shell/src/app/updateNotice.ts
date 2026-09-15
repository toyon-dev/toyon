import type { UpdateState } from "@toyon/shared";

/** what the top bar's update chip says and does; null when there is nothing to say */
export interface UpdateNotice {
  /** the chip's word */
  word: string;
  /** its tip: what the state means */
  text: string;
  /** what a press does: restart onto what is installed, install the newest and restart, or copy the
   * command an npx copy has to be run with */
  action: "restart" | "update" | "copy" | null;
  /** the text a copy puts on the clipboard */
  copy?: string;
  /** an update or restart is under way, so the chip shows it and takes no press */
  busy: boolean;
}

/**
 * The chip for Toyon's own version. A press is the consent to restart, and the daemon holds it until
 * no chat is mid-reply, so the chip says it is waiting rather than refusing the press. The word stays
 * short for the bar; the tip carries the versions and the chats.
 */
export function updateNotice(u: UpdateState | null): UpdateNotice | null {
  if (!u) return null;
  if (u.installing) {
    const next = u.latest ?? u.installed;
    return { word: "updating", text: next ? `Installing Toyon ${next}` : "Installing Toyon", action: null, busy: true };
  }
  if (u.restarting) {
    const n = u.restarting.length;
    if (n === 0) return { word: "restarting", text: "Toyon is restarting", action: null, busy: true };
    return {
      word: n === 1 ? "restarts after a reply" : `restarts after ${n} replies`,
      text: `Toyon restarts once ${u.restarting.join(", ")} ${n === 1 ? "finishes" : "finish"}`,
      action: null,
      busy: true,
    };
  }
  if (u.failed) {
    const why = u.failed.line.replace(/\.$/, "");
    return {
      word: "update failed",
      text: `Installing Toyon ${u.failed.version} stopped: ${why}. To update by hand, run ${u.failed.command}`,
      action: "update",
      busy: false,
    };
  }
  // the daemon only names a newest that is past what is running, so one that differs from the
  // install is past the install too
  const next = u.latest !== null && u.latest !== u.installed ? u.latest : null;
  if (next) {
    if (u.method === "npx") {
      return {
        word: `${next} is out`,
        text: `Toyon ${next} is out. Press to copy the command that runs it`,
        action: "copy",
        copy: `npx toyon@${next}`,
        busy: false,
      };
    }
    return {
      word: `update to ${next}`,
      text: `Toyon ${next} is out; ${u.running} is running`,
      action: "update",
      busy: false,
    };
  }
  if (u.installed) {
    return {
      word: "restart to update",
      text: `Toyon ${u.installed} is installed; ${u.running} is running`,
      action: "restart",
      busy: false,
    };
  }
  return null;
}
