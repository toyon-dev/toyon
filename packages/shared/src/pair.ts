// Pairing: how a phone that never saw the token gets it. A shell that holds the token asks the
// daemon for a code, shows it as a QR, and the phone's camera opens the machine's own address with
// the code in the fragment. The page trades the code for the token once. The token is never drawn,
// printed or photographed, and a code is worth nothing two minutes later.

import { isLoopbackHost } from "./daemon.ts";

/** how long a code can be redeemed after it is minted */
export const PAIR_TTL_MS = 120_000;

/** the fragment the phone opens; the inline boot script in the shell's index.html reads the same
 * shape, spelled out there because it runs before any module */
export const pairLink = (host: string, code: string): string => `https://${host}/#pair=${code}`;

/** what `POST /pair` answers: the code, the link the QR carries, and how long is left. A duration
 * rather than a time, because the desk showing the countdown may not share the daemon's clock. */
export interface PairMint {
  code: string;
  url: string;
  ms: number;
}

/** what `POST /pair/redeem` answers for a live code */
export interface PairRedeem {
  token: string;
}

/** What a link pasted into "add a machine" names: the machine's origin and a pairing code to trade
 * there (the link a desk's QR carries), or the origin and the token itself (the `#token=` line
 * `toyon` prints at start, which is how two daemons on one machine pair). Null for anything else.
 * Only https, or a loopback name over http: a token over plain http to any other name would cross
 * a network in the clear. */
export function parsePairLink(
  text: string,
): { origin: string; code: string } | { origin: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
  const code = url.hash.match(/pair=([A-Za-z0-9_-]+)/)?.[1];
  if (code) return { origin: url.origin, code };
  const token = url.hash.match(/token=([a-f0-9]+)/)?.[1];
  if (token) return { origin: url.origin, token };
  return null;
}

/** a tailnet name answers only for a device connected to that tailnet, so a phone with Tailscale
 * off gets the browser's "address not found" and never reaches a page of ours that could say why */
export const isTailnetName = (host: string): boolean => host.endsWith(".ts.net");

/** a phone Tailscale lists on this machine's tailnet, and whether it is connected now */
export interface TailnetPhone {
  name: string;
  online: boolean;
}

const listed = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** What to say beside a pairing code for a tailnet name. `ok` is false when no phone could open
 * the link as things stand. null phones: Tailscale here could not be asked. */
export function tailnetLine(phones: TailnetPhone[] | null): { ok: boolean; text: string } {
  if (phones === null) return { ok: true, text: "Your phone needs Tailscale on, signed in to the same tailnet." };
  if (phones.length === 0) {
    return {
      ok: false,
      text: "No phone has joined your tailnet. Install Tailscale on it and sign in to the same account first.",
    };
  }
  const on = phones.filter((p) => p.online).map((p) => p.name);
  if (on.length > 0) return { ok: true, text: `${listed(on)} ${on.length > 1 ? "are" : "is"} on your tailnet.` };
  const off = phones.map((p) => p.name);
  return {
    ok: false,
    text: `${listed(off)} ${off.length > 1 ? "are" : "is"} not answering on your tailnet. Check Tailscale is on there.`,
  };
}
