import { expect, test } from "bun:test";
import type { Ran } from "@toyon/shared/tailscale";
import { Tailnet, tailnetListed } from "./tailnet.ts";

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
  expect(tailnetListed(json)).toEqual({
    here: true,
    peers: [
      { name: "work", host: "work.tail1234.ts.net", ip: "100.1.1.3", os: "macos", online: false },
      { name: "kyles-iphone", host: "kyles-iphone.tail.ts.net", ip: null, os: "ios", online: false },
      { name: "nameless", host: "", ip: null, os: "windows", online: false },
    ],
  });
  expect(tailnetListed("{}")).toEqual({ here: true, peers: [] });
  expect(tailnetListed(status([], { Self: { Online: false } }))).toMatchObject({ here: false });
  expect(tailnetListed("failed to connect to local tailscaled")).toBeNull();
});

test("every peer is a device: reached when it answers a ping, whatever the status calls it, and a machine with a name carries the Toyon that answers there", async () => {
  const json = status([
    { HostName: "idle", OS: "android", Online: false, TailscaleIPs: ["100.1.1.1"] },
    { HostName: "gone", OS: "android", Online: true, TailscaleIPs: ["100.1.1.2"] },
    { HostName: "work", DNSName: "Work.Tail1234.ts.net.", OS: "macOS", Online: true, TailscaleIPs: ["100.1.1.3"] },
    { HostName: "box", DNSName: "box.tail1234.ts.net.", OS: "linux", Online: false, TailscaleIPs: ["100.1.1.4"] },
    { HostName: "nameless", OS: "windows" },
  ]);
  const asked: string[] = [];
  const tailnet = new Tailnet({
    ts: fake(json, ["100.1.1.1", "100.1.1.3"]).ts,
    hub: hub(),
    health: async (origin, named) => {
      asked.push(`${origin}${named ? " named" : ""}`);
      return origin.includes("work") ? { machine: "work" } : null;
    },
  });
  expect(await tailnet.view()).toEqual({
    here: true,
    devices: [
      { name: "idle", host: "", kind: "phone", reached: true, toyon: null },
      { name: "gone", host: "", kind: "phone", reached: false, toyon: null },
      {
        name: "work",
        host: "work.tail1234.ts.net",
        kind: "machine",
        reached: true,
        toyon: { machine: "work", answering: true },
      },
      { name: "box", host: "box.tail1234.ts.net", kind: "machine", reached: false, toyon: null },
      { name: "nameless", host: "", kind: "machine", reached: false, toyon: null },
    ],
  });
  // phones and nameless machines are never probed: nothing of ours answers at no address
  expect(asked).toEqual(["https://work.tail1234.ts.net named", "https://box.tail1234.ts.net named"]);
  expect(await tailnet.isToyon("https://work.tail1234.ts.net")).toBe(true);
  expect(await tailnet.isToyon("https://evil.example")).toBe(false);
  expect(asked.at(-1)).toBe("https://evil.example");
  expect(await new Tailnet({ ts: null, hub: hub() }).view()).toBeNull();
});

test("with this machine's own link down nothing is pinged or probed, and the answer says so", async () => {
  const json = status(
    [
      { HostName: "Pixel", OS: "android", Online: true, TailscaleIPs: ["100.1.1.1"] },
      { HostName: "work", DNSName: "work.tail1234.ts.net.", OS: "macOS", Online: true, TailscaleIPs: ["100.1.1.3"] },
    ],
    { Self: { DNSName: "mac.tail1234.ts.net.", Online: false } },
  );
  const pinged: string[] = [];
  const probed: string[] = [];
  const ts = async (args: string[]): Promise<Ran> => {
    if (args[0] === "ping") pinged.push(args.at(-1) ?? "");
    return { ok: true, out: args[0] === "status" ? json : "", err: "" };
  };
  const tailnet = new Tailnet({
    ts,
    hub: hub(),
    health: async (origin) => {
      probed.push(origin);
      return { machine: "work" };
    },
  });
  expect(await tailnet.view()).toEqual({
    here: false,
    devices: [
      { name: "Pixel", host: "", kind: "phone", reached: false, toyon: null },
      { name: "work", host: "work.tail1234.ts.net", kind: "machine", reached: false, toyon: null },
    ],
  });
  expect(pinged).toEqual([]);
  expect(probed).toEqual([]);
});

test("a Toyon that answered lately stays on the list as not answering, and drops off after three minutes", async () => {
  const json = status([{ HostName: "work", DNSName: "work.tail1234.ts.net.", OS: "macOS", Online: true }]);
  let t = 1000;
  let up = true;
  const tailnet = new Tailnet({
    ts: fake(json).ts,
    hub: hub(),
    now: () => t,
    health: async () => (up ? { machine: "work" } : null),
  });
  const row = async () => (await tailnet.view())?.devices[0]?.toyon;
  expect(await row()).toEqual({ machine: "work", answering: true });
  up = false;
  t += 60_000;
  expect(await row()).toEqual({ machine: "work", answering: false });
  t += 3 * 60_000;
  expect(await row()).toBeNull();
  up = true;
  expect(await row()).toEqual({ machine: "work", answering: true });
});

test("one status fork feeds the view and readiness inside the window; readiness is announced when it changes", async () => {
  const f = fake(status([]));
  let t = 1000;
  const h = hub();
  const tailnet = new Tailnet({ ts: f.ts, hub: h, now: () => t });
  expect(tailnet.readiness()).toBeNull();
  expect((await tailnet.refresh()).state).toBe("ready");
  expect(h.events).toEqual(["tailscaleChanged"]);
  await tailnet.view();
  await tailnet.view();
  expect(f.statusForks).toBe(1);
  t += 6000;
  await tailnet.view();
  expect(f.statusForks).toBe(2);
  // the same answer again says nothing; a refresh always forks
  await tailnet.refresh();
  expect(h.events).toEqual(["tailscaleChanged"]);
  expect(f.statusForks).toBe(3);
  expect((await new Tailnet({ ts: null, hub: hub() }).refresh()).state).toBe("not-installed");
});

test("up runs the CLI and reads readiness again; a refusal is its last line", async () => {
  const json = status([]);
  let okUp = true;
  const calls: string[][] = [];
  const ts = async (args: string[]): Promise<Ran> => {
    calls.push(args);
    if (args[0] === "status") return { ok: true, out: json, err: "" };
    return okUp
      ? { ok: true, out: "", err: "" }
      : {
          ok: false,
          out: "",
          err: "Error: changing settings via 'tailscale up' requires mentioning all\nnon-default flags",
        };
  };
  const h = hub();
  const tailnet = new Tailnet({ ts, hub: h });
  expect(await tailnet.up()).toBeNull();
  expect(calls.map((c) => c[0])).toEqual(["up", "status"]);
  okUp = false;
  expect(await tailnet.up()).toBe("non-default flags");
  expect(await new Tailnet({ ts: null, hub: hub() }).up()).toBe("Tailscale is not installed here");
});

test("login starts the CLI without waiting on it and answers with the link the status posts", async () => {
  let authUrl: string | undefined;
  const json = () => JSON.stringify({ BackendState: "NeedsLogin", Self: {}, AuthURL: authUrl, Peer: {} });
  let t = 1000;
  let loginStarted = false;
  const ts = (args: string[]): Promise<Ran> => {
    if (args[0] === "login") {
      loginStarted = true;
      // the CLI waits for the browser; nothing here should wait on it
      return new Promise(() => {});
    }
    return Promise.resolve({ ok: true, out: json(), err: "" });
  };
  const tailnet = new Tailnet({
    ts,
    hub: hub(),
    now: () => t,
    sleep: async () => {
      t += 300;
      if (t >= 1600) authUrl = "https://login.tailscale.com/a/abc";
    },
  });
  expect(await tailnet.login()).toEqual({ url: "https://login.tailscale.com/a/abc" });
  expect(loginStarted).toBe(true);
  authUrl = undefined;
  t = 1000;
  const tick = async () => {
    t += 300;
  };
  const late = new Tailnet({ ts, hub: hub(), now: () => t, sleep: tick });
  expect(await late.login()).toMatchObject({ why: expect.stringContaining("tailscale login") });
});
