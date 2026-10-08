// `toyon pair`: pair a device with this machine from the terminal. Turns the name on through
// Tailscale when it is off, prints the address, and answers each device that asks to be let in. A
// box with no Toyon window open on it (a server reached over ssh) pairs its first device from
// here; after that the window anywhere does it.

import { isTailnetName, type Knock, machineLink, type TailnetPhone, tailnetLine } from "@toyon/shared";
import { daemonFetch, health } from "./daemon.ts";
import { confirm } from "./prompt.ts";
import { HOW_TO_OPEN, switchRemote } from "./remote.ts";

/** how often the terminal asks what waits: the device itself asks every two seconds */
const POLL_MS = 2000;

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
    const r = await daemonFetch("/phones");
    const phones = r?.ok ? ((await r.json()) as TailnetPhone[] | null) : null;
    console.log(tailnetLine(phones).text);
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
