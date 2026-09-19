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

/** what a restart held behind replies says, wherever it is read: the bar's chip and the card a page
 * from a newer build shows. The names are the progress: each one leaves as its chat settles. */
export const restartWaitLine = (names: string[]): string =>
  `Toyon restarts once ${names.join(", ")} ${names.length === 1 ? "finishes" : "finish"}`;

/** One chat on the card a held restart shows. The dot is the rail's own, so a chat reads here the
 * way it did on the rail a moment ago: breathing while it replies, accent when it asks. */
export interface RestartRow {
  name: string;
  dot: "working" | "idle" | "waiting";
  /** what the dot means, for a row that is not simply replying */
  note: string | null;
}

/** every chat the card has watched hold the restart, in the order it met them: a finished one
 * keeps its place, so the list is a count going down and not rows jumping about */
export const restartSeen = (seen: string[], held: string[]): string[] => [
  ...seen,
  ...held.filter((name) => !seen.includes(name)),
];

/** The card's list: the chats met holding the restart, replying or finished, then the ones stopped
 * on a question, which hold nothing. Two chats can share a title, so a name held once marks one
 * row and not both. */
export function restartRows(seen: string[], held: string[], asking: string[]): RestartRow[] {
  const left = [...held];
  const met = seen.map((name): RestartRow => {
    const i = left.indexOf(name);
    if (i === -1) return { name, dot: "idle", note: "finished" };
    left.splice(i, 1);
    return { name, dot: "working", note: null };
  });
  return [...met, ...asking.map((name): RestartRow => ({ name, dot: "waiting", note: "asking you" }))];
}

/** the card's sentence over that list: how many of the chats met are still replying */
export function restartHeldLine(held: number, seen: number): string {
  const lead =
    held >= seen
      ? `Toyon restarts once ${held === 1 ? "this chat finishes its reply" : `these ${held} chats finish their replies`}`
      : `${seen - held} of ${seen} chats have finished; Toyon restarts after the ${held === 1 ? "last one" : `other ${held}`}`;
  return `${lead}, and this page reloads when it is back. Restarting now stops ${held === 1 ? "it" : "them"} mid-reply.`;
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
      text: restartWaitLine(u.restarting),
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
