// Who else is on this machine's tailnet, as the tailscale CLI tells it. Read only: the pairing card
// uses it to say a phone has Tailscale off before the phone's browser fails to find the name.

import type { TailnetPhone } from "@toyon/shared";

interface Status {
  Peer?: Record<
    string,
    { HostName?: string; DNSName?: string; OS?: string; Online?: boolean; TailscaleIPs?: string[] | null } | null
  > | null;
}

const PHONE_OS = new Set(["android", "ios"]);

/** a phone as the status lists it: `online` is the coordination server's word, which a phone that
 * has gone idle loses while it still carries traffic, so it is trusted only when true */
export interface ListedPhone extends TailnetPhone {
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
    phones.push({ name, online: p.Online === true, ip: p.TailscaleIPs?.[0] ?? null });
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

/** The phones on the tailnet and whether each answers now; null when Tailscale is missing or not
 * running. A phone the status calls offline is pinged before it is reported so. */
export async function readTailnetPhones(
  run: TailscaleRun | null = ((bin) => (bin ? cli(bin) : null))(Bun.which("tailscale")),
): Promise<TailnetPhone[] | null> {
  if (run === null) return null;
  const st = await run(["status", "--json"]);
  const listed = st.ok ? tailnetPhones(st.out) : null;
  if (listed === null) return null;
  return Promise.all(
    listed.map(async ({ name, online, ip }) => ({
      name,
      online: online || (ip !== null && (await run(["ping", "--c", "1", "--timeout", PING_TIMEOUT, ip])).ok),
    })),
  );
}
