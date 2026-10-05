// Who else is on this machine's tailnet, as the tailscale CLI tells it. Read only: the pairing card
// uses it to say a phone has Tailscale off before the phone's browser fails to find the name.

import type { TailnetPhone } from "@toyon/shared";

interface Status {
  Peer?: Record<string, { HostName?: string; DNSName?: string; OS?: string; Online?: boolean } | null> | null;
}

const PHONE_OS = new Set(["android", "ios"]);

/** the phones in `tailscale status --json`, or null for output that is not a status */
export function tailnetPhones(json: string): TailnetPhone[] | null {
  let st: Status;
  try {
    st = JSON.parse(json) as Status;
  } catch {
    // the CLI prints prose when tailscaled is not up
    return null;
  }
  if (st === null || typeof st !== "object") return null;
  const phones: TailnetPhone[] = [];
  for (const p of Object.values(st.Peer ?? {})) {
    if (!p || !PHONE_OS.has((p.OS ?? "").toLowerCase())) continue;
    const name = p.HostName || (p.DNSName ?? "").split(".")[0] || "a phone";
    phones.push({ name, online: p.Online === true });
  }
  return phones;
}

/** ask the tailscale CLI; null when it is missing, slow or not running */
export async function readTailnetPhones(bin: string | null = Bun.which("tailscale")): Promise<TailnetPhone[] | null> {
  if (bin === null) return null;
  try {
    const p = Bun.spawn([bin, "status", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 3000,
    });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? tailnetPhones(out) : null;
  } catch {
    // a binary that would not start reads the same as no Tailscale: the card falls back to its plain line
    return null;
  }
}
