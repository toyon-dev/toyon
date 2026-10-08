// The words on the add-machine card, apart from the card: what each way adding can fail reads
// as, so the lines are tested and the component only picks one.

import type { KnockFailure } from "../../ws.ts";

export const ADD_MACHINE = {
  title: "Add a machine",
  lead: "Pick a machine on your tailnet, or type an address.",
  /** with no Tailscale here, or none of the machines on it answering as a Toyon */
  leadTyped: "Type the address from the screen of the other machine.",
  noneOnTailnet: "No other machine on your tailnet answers as a Toyon yet.",
  /** under the list, when a peer answered nothing: the fix is on that machine */
  missing: "A machine missing here needs the phone button pressed on it, or `toyon remote --tailscale`.",
  listed: "listed",
  request: "request access",
  placeholder: "https://",
  notAnAddress: "That is not a Toyon address. It is https:// and the machine's name, as its screen shows it.",
  asking: (origin: string) => `Asking ${hostOf(origin)}.`,
  /** while the other machine's person decides: the words to match on its card */
  waiting: (origin: string, word: string) => `Toyon on ${hostOf(origin)} is asking whether to let ${word} in.`,
  added: (name: string) => `Added ${name}.`,
  /** let in there, but the daemon that serves this page would not keep it */
  notKept: (why: string) => `Let in, but not listed: ${why}`,
  add: "add",
} as const;

/** `work.tail1234.ts.net` out of an origin, for a line that names the machine */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Why a knock at `origin` ended with no token, in a sentence that says what to do next.
 * `subject` is what was asking: this page, from another Toyon, or this device, at the machine's
 * own address. */
export function knockFailureLine(failure: KnockFailure, origin: string, subject: "this page" | "this device"): string {
  const host = hostOf(origin);
  switch (failure) {
    case "refused":
      return `${host} did not let ${subject} in.`;
    case "gone":
      return `${host} stopped waiting. Ask again, and answer there within five minutes.`;
    case "full":
      return `${host} has too many devices waiting already. Answer or turn those away there first.`;
    case "not-toyon":
      return `${host} is not a Toyon machine, or has no remote name set up.`;
    case "unreachable":
      return `${host} did not answer. Is Tailscale on here, and is Toyon running there?`;
  }
}
