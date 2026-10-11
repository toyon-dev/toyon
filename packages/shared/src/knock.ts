// Letting a device in: how a browser that never saw the token gets it. A device opens the
// machine's own address, knocks, and shows a two-word name for its knock. Every shell that holds
// the token sees the knock with the same two words, and a person lets it in or not. The device
// polls its knock until it is answered, and a let-in answer carries the token, once. The token is
// never drawn, printed or photographed, and a knock nobody answers is gone in five minutes.
//
// Tailscale says a device is on the tailnet; it cannot say which device holds a shell on this
// machine, because the front reaches the daemon as a loopback peer, which a sandboxed agent is
// too. So the person's own yes stays the gate, whatever the network.

import { isShellOrigin } from "./daemon.ts";

/** how long a knock waits for an answer; a person has walked to the other machine by then */
export const KNOCK_TTL_MS = 5 * 60_000;

/** how many knocks wait at once: a bound on memory, and on how long the card can get */
export const KNOCK_MAX = 32;

/** How many of those one client address may hold on a public name, where anyone on the internet
 * can reach the address. A nuisance from a few addresses leaves room for the person's own device;
 * one that brings addresses by the dozen can still fill the list, as it could fill anything else
 * on a public name, and the person's knock lands once it stops. */
export const KNOCK_PER_CLIENT = 2;

/** the address a device opens to knock: the machine's own, nothing in it */
export const machineLink = (host: string): string => `https://${host}/`;

/** a knock as the shells that may answer it see it */
export interface Knock {
  id: string;
  /** two words the knocking device shows too, so the person answers the knock they meant */
  word: string;
  /** the origin of the page that knocked, or null when it was a page this machine served (a
   * phone opening the address, the usual case). A page from elsewhere is named on the card: the
   * person decides whether they opened it. */
  from: string | null;
}

/** what `POST /knock` answers: the knock's id, and the words to show */
export interface Knocked {
  id: string;
  word: string;
}

/** what `GET /knock/<id>` answers while the knock lives; the token comes once, then the knock
 * is gone */
export type KnockState = { state: "waiting" } | { state: "let-in"; token: string } | { state: "refused" };

/** The machine a typed text names, as an origin: the address itself, or the address with the
 * token link toyon prints at start. Null for anything else. Only https, or a loopback name over
 * http, since the token would travel back to this page over the same scheme. */
export function machineAddress(text: string): string | null {
  let raw = text.trim();
  if (raw === "") return null;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return isShellOrigin(url.origin) ? url.origin : null;
}

/** Two words a person can read across a room and say aloud, picked by `pick(n)` giving an index
 * under n. Common nouns and plain colours, none of them a thing a person would mind saying. */
export function knockWord(pick: (n: number) => number): string {
  return `${KNOCK_FIRST[pick(KNOCK_FIRST.length)]} ${KNOCK_SECOND[pick(KNOCK_SECOND.length)]}`;
}

const KNOCK_FIRST = [
  "amber",
  "blue",
  "coral",
  "green",
  "ivory",
  "jade",
  "lilac",
  "olive",
  "plum",
  "red",
  "rose",
  "rust",
  "sage",
  "silver",
  "slate",
  "teal",
  "violet",
  "white",
  "yellow",
  "gold",
];
const KNOCK_SECOND = [
  "apple",
  "bell",
  "boat",
  "cloud",
  "fox",
  "hill",
  "kite",
  "lamp",
  "leaf",
  "moon",
  "owl",
  "pear",
  "river",
  "stone",
  "sun",
  "tree",
  "wave",
  "wolf",
  "wren",
  "door",
];

/** a tailnet name answers only for a device connected to that tailnet, so a phone with Tailscale
 * off gets the browser's "address not found" and never reaches a page of ours that could say why */
export const isTailnetName = (host: string): boolean => host.endsWith(".ts.net");

/** One device on this machine's tailnet, as reached from here. Both cards draw the same row:
 * a dot for `reached`, the name, and on the add-machine card the Toyon there. */
export interface TailnetDevice {
  name: string;
  /** its MagicDNS name without the trailing dot; empty when the tailnet has none */
  host: string;
  kind: "phone" | "machine";
  /** Answered a ping from this machine just now: the dot on the row. The coordination server's
   * own word on a device is wrong both ways for minutes at a time, so only the ping says. */
  reached: boolean;
  /** For a machine, the Toyon with a name that answered there, now or a few minutes ago; null
   * when none has, and always null for a phone. A link that drops for a minute (two machines on
   * a Wi-Fi that will not pass their packets, while Tailscale keeps trying it before falling back
   * to a relay) misses a probe without the machine going anywhere, so one missed probe reads as
   * "not answering" and not as no Toyon at all. */
  toyon: { machine: string; answering: boolean } | null;
}

/** The tailnet as asked from this machine. A device is reached by pinging it from here, so when
 * this machine's own link is down every ping fails for a reason that is not the device's;
 * `here` says which side to look at. */
export interface TailnetView {
  /** whether this machine is connected to the tailnet itself, as Tailscale here says; nothing
   * is pinged or probed while it is not */
  here: boolean;
  devices: TailnetDevice[];
}
