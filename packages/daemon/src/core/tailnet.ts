// Who else is on this machine's tailnet, as the tailscale CLI tells it. Read only: the pairing card
// uses it to say a phone has Tailscale off before the phone's browser fails to find the name.

import type { TailnetPhone } from "@toyon/shared";

interface Status {
  Peer?: Record<
    string,
    { HostName?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[] | null } | null
  > | null;
}

const PHONE_OS = new Set(["android", "ios"]);

/** A phone as the status lists it. Its `Online` is the coordination server's word and wrong both
 * ways for minutes at a time: an idle phone loses it while it still carries traffic, and one just
 * switched off keeps it. Only a ping says whether the phone answers. */
export interface ListedPhone {
  name: string;
  ip: string | null;
}

/** the phones in `tailscale status --json`, or null for output that is not a status */
export function tailnetPhones(json: string): ListedPhone[] | null {
  let st: Status;
  try {
    st = JSON.parse(json) as Status;
  } catch {
    // the CLI prints prose when tailscaled is not up
    return null;
  }
  if (st === null || typeof st !== "object") return null;
  const phones: ListedPhone[] = [];
  for (const p of Object.values(st.Peer ?? {})) {
    if (!p || !PHONE_OS.has((p.OS ?? "").toLowerCase())) continue;
    const name = p.HostName || (p.DNSName ?? "").split(".")[0] || "a phone";
    phones.push({ name, ip: p.TailscaleIPs?.[0] ?? null });
  }
  return phones;
}

/** the tailscale CLI with these arguments: whether it exited clean, and what it printed */
export type TailscaleRun = (args: string[]) => Promise<{ ok: boolean; out: string }>;

/** the time a phone gets to answer one ping; one that is connected answers in well under a second */
const PING_TIMEOUT = "2s";

function cli(bin: string): TailscaleRun {
  return async (args) => {
    try {
      const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
      const out = await new Response(p.stdout).text();
      return { ok: (await p.exited) === 0, out };
    } catch {
      // a binary that would not start reads the same as no Tailscale: the card falls back to its plain line
      return { ok: false, out: "" };
    }
  };
}

/** One ping, done at the first answer: without `--until-direct=false` a pong that came through a
 * relay exits as a failure. */
const ping = (ip: string) => ["ping", "--until-direct=false", "--c", "1", "--timeout", PING_TIMEOUT, ip];

/** The phones on the tailnet and whether each answers a ping now; null when Tailscale is missing
 * or not running. */
export async function readTailnetPhones(
  run: TailscaleRun | null = ((bin) => (bin ? cli(bin) : null))(Bun.which("tailscale")),
): Promise<TailnetPhone[] | null> {
  if (run === null) return null;
  const st = await run(["status", "--json"]);
  const listed = st.ok ? tailnetPhones(st.out) : null;
  if (listed === null) return null;
  return Promise.all(listed.map(async ({ name, ip }) => ({ name, online: ip !== null && (await run(ping(ip))).ok })));
}
