import { expect, test } from "bun:test";
import { tailnetLine } from "@toyon/shared";
import type { Ran } from "@toyon/shared/tailscale";
import { Tailnet, tailnetPeers } from "./tailnet.ts";

const status = (peers: object[], self: object = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "mac.tail1234.ts.net." },
    CurrentTailnet: { MagicDNSEnabled: true },
    CertDomains: ["mac.tail1234.ts.net"],
    ...self,
    Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, p])),
  });

/** a tailscale CLI answering `status` with `json` and pings for the ips given, counting status forks */
function fake(json: string, answering: string[] = []) {
  const f = {
    statusForks: 0,
    ts: async (args: string[]): Promise<Ran> => {
      if (args[0] === "status") {
        f.statusForks++;
        return { ok: true, out: json, err: "" };
      }
      return { ok: answering.includes(args.at(-1) ?? ""), out: "", err: "" };
    },
  };
  return f;
}
const hub = () => {
  const h = { events: [] as string[], emit: (e: unknown, ..._args: unknown[]) => void h.events.push(String(e)) };
  return h;
};

test("peers come with their MagicDNS names, lowercased and without the dot", () => {
  const json = status([
    { HostName: "work", DNSName: "Work.Tail1234.ts.net.", OS: "macOS", TailscaleIPs: ["100.1.1.3"] },
    { HostName: "", DNSName: "kyles-iphone.tail.ts.net.", OS: "iOS" },
    { HostName: "nameless", OS: "windows" },
  ]);
  expect(tailnetPeers(json)).toEqual([
    { name: "work", host: "work.tail1234.ts.net", ip: "100.1.1.3", os: "macos" },
    { name: "kyles-iphone", host: "kyles-iphone.tail.ts.net", ip: null, os: "ios" },
    { name: "nameless", host: "", ip: null, os: "windows" },
  ]);
  expect(tailnetPeers("{}")).toEqual([]);
  expect(tailnetPeers("failed to connect to local tailscaled")).toBeNull();
});

test("a phone is on when it answers a ping, whatever the status calls it", async () => {
  const json = status([
    { HostName: "idle", OS: "android", Online: false, TailscaleIPs: ["100.1.1.1"] },
    { HostName: "gone", OS: "android", Online: true, TailscaleIPs: ["100.1.1.2"] },
    { HostName: "box", OS: "linux", Online: true },
  ]);
  const f = fake(json, ["100.1.1.1"]);
  const tailnet = new Tailnet({ ts: f.ts, hub: hub() });
  expect(await tailnet.phones()).toEqual([
    { name: "idle", online: true },
    { name: "gone", online: false },
  ]);
  expect(await new Tailnet({ ts: null, hub: hub() }).phones()).toBeNull();
});

test("the machines are every peer that is not a phone, with the Toyon that answers at its name", async () => {
  const json = status([
    { HostName: "work", DNSName: "Work.Tail1234.ts.net.", OS: "macOS" },
    { HostName: "box", DNSName: "box.tail1234.ts.net.", OS: "linux" },
    { HostName: "Pixel", DNSName: "pixel.tail1234.ts.net.", OS: "android" },
    { HostName: "nameless", OS: "windows" },
  ]);
  const asked: string[] = [];
  const tailnet = new Tailnet({
    ts: fake(json).ts,
    hub: hub(),
    health: async (origin, named) => {
      asked.push(`${origin}${named ? " named" : ""}`);
      return origin.includes("work") ? { machine: "work" } : null;
    },
  });
  expect(await tailnet.machines()).toEqual([
    { name: "work", host: "work.tail1234.ts.net", toyon: { machine: "work" } },
    { name: "box", host: "box.tail1234.ts.net", toyon: null },
  ]);
  expect(asked).toEqual(["https://work.tail1234.ts.net named", "https://box.tail1234.ts.net named"]);
  expect(await tailnet.isToyon("https://work.tail1234.ts.net")).toBe(true);
  expect(await tailnet.isToyon("https://evil.example")).toBe(false);
  expect(asked.at(-1)).toBe("https://evil.example");
  expect(await new Tailnet({ ts: null, hub: hub() }).machines()).toBeNull();
});

test("one status fork feeds phones, machines and readiness inside the window; readiness is announced when it changes", async () => {
  const f = fake(status([]));
  let t = 1000;
  const h = hub();
  const tailnet = new Tailnet({ ts: f.ts, hub: h, now: () => t });
  expect(tailnet.readiness()).toBeNull();
  expect((await tailnet.refresh()).state).toBe("ready");
  expect(h.events).toEqual(["tailscaleChanged"]);
  await tailnet.phones();
  await tailnet.machines();
  expect(f.statusForks).toBe(1);
  t += 6000;
  await tailnet.machines();
  expect(f.statusForks).toBe(2);
  // the same answer again says nothing; a refresh always forks
  await tailnet.refresh();
  expect(h.events).toEqual(["tailscaleChanged"]);
  expect(f.statusForks).toBe(3);
  expect((await new Tailnet({ ts: null, hub: hub() }).refresh()).state).toBe("not-installed");
});

test("the line names the phone and says what to do when none is connected", () => {
  expect(tailnetLine([{ name: "Pixel", online: true }])).toEqual({ ok: true, text: "Pixel is on your tailnet." });
  expect(tailnetLine([{ name: "Pixel", online: false }])).toEqual({
    ok: false,
    text: "Pixel is not answering on your tailnet. Check Tailscale is on there.",
  });
  expect(tailnetLine([])).toMatchObject({ ok: false });
  expect(tailnetLine(null)).toMatchObject({ ok: true });
});
