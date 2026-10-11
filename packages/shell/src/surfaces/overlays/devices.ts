// The words on the devices card, apart from the card: what each way adding a machine can fail
// reads as, so the lines are tested and the component only picks one.

import type { TailnetDevice, TailnetView, TailscaleReadiness } from "@toyon/shared";
import type { KnockFailure } from "../../ws.ts";

export const DEVICES = {
  title: "Your devices",
  /** under the address: what the code is for */
  scan: "Scan with your phone's camera to open this machine there, then let the phone in here.",
  /** with no name yet: what turning one on means */
  turnOn:
    "Turn on, and your phone opens this machine at its tailnet name. Anyone on your tailnet you let in gets a shell here.",
  /** this machine is listed but its own link is down, as Tailscale here says */
  hereOff: "Tailscale on this machine is not connected, so nothing on your tailnet can reach it.",
  noneOnTailnet: "No other device is on your tailnet yet.",
  /** an address is up and no phone is listed: the thing to do is on the phone */
  noPhone: "No phone has joined your tailnet. Install Tailscale on it and sign in to the same account.",
  /** the devices asking to be let in, above their rows */
  knocking: "Let in the one whose words match the other screen.",
  /** under the list, when a connected peer answers as no Toyon: the fix is on that machine */
  missing: "A machine with no Toyon needs the phone button pressed on it, or `toyon remote --tailscale`.",
  listed: "listed",
  request: "request access",
  /** a Toyon answered there lately and misses the probe now: the link, not the machine */
  notAnswering: "not answering right now",
  offline: "offline",
  noToyon: "no Toyon",
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

/** What a machine's row says on its right, when it is not the request itself. Whether it
 * answers comes first, since that is what the dot asks: a machine that does not answer from
 * here is offline whether or not it is listed. Then a Toyon that answered lately but not now,
 * then listed here already, then a machine that answers and runs no Toyon with a name. Null is
 * the request. */
export function machineState(m: TailnetDevice, listed: boolean): string | null {
  if (!m.reached) return DEVICES.offline;
  if (m.toyon && !m.toyon.answering) return DEVICES.notAnswering;
  if (listed) return DEVICES.listed;
  if (m.toyon) return null;
  return DEVICES.noToyon;
}

/** the list's order: the Toyons that answer, then those that answered lately, then the machines
 * reached from here, then the rest; ties keep Tailscale's order */
export function machineRank(m: TailnetDevice): number {
  if (m.toyon?.answering) return 0;
  if (m.toyon) return 1;
  return m.reached ? 2 : 3;
}

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

/** This machine's row: the word on its right, the note under the list, and the offer that
 * brings Tailscale back where the CLI can, from what the daemon could say. Readiness first:
 * signed in and switched off is `tailscale up` ("connect"), signed out is a sign-in link
 * ("sign in"), not running or not installed is a sentence, since only the Tailscale app or the
 * system service fixes those. Then `view` null is Tailscale unanswered, and a view with `here`
 * false is a link that is down while the app runs and is signed in. The daemon's own readiness
 * lines are for a terminal (they name commands), so the card has lines of its own where they
 * differ; the admin-console ones read fine as they are. The lines say what is so, not what to
 * do: the offer is the doing, and where there is one the line is its tooltip and the row
 * carries no word, since the button already says it. All null when this machine is on the
 * tailnet with nothing in the way. */
export function selfState(
  view: TailnetView | null | undefined,
  r: TailscaleReadiness | null,
  host: string | null,
): { word: string | null; note: string | null; offer: "connect" | "sign-in" | null } {
  const plain = (word: string | null, note: string | null) => ({ word, note, offer: null });
  switch (r?.state) {
    case "not-installed":
      return plain(
        "no Tailscale",
        "Tailscale is not installed on this machine, so nothing on your tailnet can reach it.",
      );
    case "not-running":
      return plain(
        "Tailscale not running",
        "Tailscale is not running on this machine, so nothing on your tailnet can reach it.",
      );
    // with an offer the button says what to do and the note is its tooltip, so no word beside it
    case "disconnected":
      return {
        word: null,
        note: "Tailscale on this machine is switched off, so nothing on your tailnet can reach it.",
        offer: "connect",
      };
    case "signed-out":
      return {
        word: null,
        note: "Tailscale on this machine is signed out, so nothing on your tailnet can reach it.",
        offer: "sign-in",
      };
    case "needs-approval":
      return plain("not approved", r.line);
    default:
      break;
  }
  if (view === null) return plain("not asked", "Toyon could not ask Tailscale here just now.");
  if (view !== undefined && !view.here) return plain("not connected", DEVICES.hereOff);
  // on the tailnet with no name: what stops the switch from being offered, if anything
  if (host === null && r !== null && r.state !== "ready") {
    switch (r.state) {
      case "magicdns-off":
        return plain("MagicDNS off", r.line);
      case "https-off":
        return plain("HTTPS off", r.line);
      default:
        return plain(null, r.line);
    }
  }
  return plain(null, null);
}
