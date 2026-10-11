// `toyon pair`: pair a device with this machine from the terminal. Turns the name on through
// Tailscale when it is off, prints the address, and answers each device that asks to be let in. A
// box with no Toyon window open on it (a server reached over ssh) pairs its first device from
// here; after that the window anywhere does it.

import { isTailnetName, type Knock, machineLink, type TailnetView } from "@toyon/shared";
import { daemonFetch, health } from "./daemon.ts";
import { confirm } from "./prompt.ts";
import { HOW_TO_OPEN, switchRemote } from "./remote.ts";

/** how often the terminal asks what waits: the device itself asks every two seconds */
const POLL_MS = 2000;

/** the tailnet as the pair card lists it, a line per row: this machine first, then each device
 * and whether it answers from here, so a phone that cannot open the address is named before
 * the wait begins */
export function tailnetLines(view: TailnetView | null): string[] {
  if (view === null) return ["Your phone needs Tailscale on, signed in to the same tailnet."];
  const lines = [`  this machine: ${view.here ? "connected" : "not connected"}`];
  for (const d of view.devices) {
    lines.push(`  ${d.toyon?.machine ?? d.name}: ${d.reached ? "on your tailnet" : "not answering"}`);
  }
  if (!view.devices.some((d) => d.kind === "phone")) {
    lines.push("No phone has joined your tailnet. Install Tailscale on it and sign in to the same account.");
  }
  return lines;
}

async function waiting(): Promise<Knock[]> {
  const r = await daemonFetch("/knocks");
  // the daemon between restarts; the next ask will tell
  return r?.ok ? ((await r.json()) as Knock[]) : [];
}

export async function pair(): Promise<number> {
  const h = await health();
  if (!h) {
    console.error("toyon: Toyon is not running. Start it with `toyon`, then run `toyon pair`.");
    return 1;
  }
  let remote = h.remote ?? null;
  if (!remote) {
    const r = await switchRemote({ tailscale: true });
    if (typeof r === "string") {
      console.error(`toyon: ${r}`);
      return 1;
    }
    remote = r.remote;
  }
  if (!remote) {
    console.error("toyon: remote access did not come on; `toyon remote` says what Tailscale is missing");
    return 1;
  }
  console.log(machineLink(remote.host));
  console.log(HOW_TO_OPEN);
  if (isTailnetName(remote.host)) {
    // a daemon that cannot say still leaves the plain line: the phone needs Tailscale on either way
    const r = await daemonFetch("/tailnet");
    const view = r?.ok ? ((await r.json()) as TailnetView | null) : null;
    for (const line of tailnetLines(view)) console.log(line);
  }
  console.log("waiting for a device; ctrl-c to stop");
  /** knocks already put to the person, so a slow answer is not asked for twice */
  const asked = new Set<string>();
  for (;;) {
    for (const k of await waiting()) {
      if (asked.has(k.id)) continue;
      asked.add(k.id);
      const from = k.from === null ? "a device that opened the address" : `a Toyon page at ${new URL(k.from).host}`;
      const yes = await confirm(`${k.word} wants in (${from}). Let it in?`);
      const r = await daemonFetch(`/knock/${k.id}/answer`, { body: { letIn: yes } });
      if (!r?.ok) console.log(`${k.word} stopped waiting`);
      else console.log(yes ? `${k.word} is in` : `${k.word} turned away`);
    }
    await Bun.sleep(POLL_MS);
  }
}
