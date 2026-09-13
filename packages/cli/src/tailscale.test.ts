import { describe, expect, test } from "bun:test";
import {
  entries,
  holder,
  parseServeConfig,
  type Ran,
  serveTailnet,
  TailscaleError,
  tailnetName,
  tailscaleCli,
  unserveTailnet,
} from "./tailscale.ts";

const NAME = "box.tail1234.ts.net";

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: `${NAME}.` },
    CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: "tail1234.ts.net" },
    CertDomains: [NAME],
    ...over,
  });

/** a serve config as tailscale serve status --json prints it, one proxy per https port */
function config(proxies: Record<number, string>, name = NAME) {
  const TCP: Record<string, unknown> = {};
  const Web: Record<string, unknown> = {};
  for (const [port, proxy] of Object.entries(proxies)) {
    TCP[port] = { HTTPS: true };
    Web[`${name}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
  }
  return JSON.stringify({ TCP, Web });
}

const allToyon = () => Object.fromEntries(entries(4141).map((e) => [e.port, e.target])) as Record<number, string>;

/** a fake tailscale CLI: answers status and serve status, records every call */
function fake(opts: { status?: Ran; serve?: string; fail?: string } = {}) {
  const calls: string[][] = [];
  const ts = async (args: string[]): Promise<Ran> => {
    calls.push(args);
    if (args[0] === "status") return opts.status ?? { ok: true, out: status(), err: "" };
    if (args.join(" ") === "serve status --json") return { ok: true, out: opts.serve ?? "{}", err: "" };
    if (opts.fail && args.includes(opts.fail)) return { ok: false, out: "", err: "Access denied: serve config denied" };
    return { ok: true, out: "", err: "" };
  };
  return { ts, calls, changes: () => calls.filter((c) => c[0] === "serve" && c[1] !== "status") };
}

describe("tailnetName", () => {
  test("reads the machine's name without the trailing dot", () => {
    expect(tailnetName(status())).toBe(NAME);
    expect(tailnetName(status({ Self: { DNSName: "Box.Tail1234.ts.net." }, CertDomains: [NAME] }))).toBe(NAME);
  });
  test("refuses a signed out, stopped or unapproved machine, naming the fix", () => {
    expect(() => tailnetName(status({ BackendState: "NeedsLogin" }))).toThrow("signed out; run `tailscale up`");
    expect(() => tailnetName(status({ BackendState: "Stopped" }))).toThrow("run `tailscale up`");
    expect(() => tailnetName(status({ BackendState: "NeedsMachineAuth" }))).toThrow("approved");
    expect(() => tailnetName(status({ BackendState: "Starting" }))).toThrow("not connected yet");
  });
  test("refuses a tailnet without MagicDNS or HTTPS certificates", () => {
    expect(() => tailnetName(status({ CurrentTailnet: { MagicDNSEnabled: false } }))).toThrow("MagicDNS is off");
    expect(() => tailnetName(status({ Self: { DNSName: "" } }))).toThrow("MagicDNS is off");
    expect(() => tailnetName(status({ CertDomains: null }))).toThrow("HTTPS certificates are off");
    expect(() => tailnetName(status({ CertDomains: ["other.tail1234.ts.net"] }))).toThrow("HTTPS certificates");
  });
  test("refuses when tailscaled is not running", () => {
    expect(() => tailnetName("failed to connect to local Tailscale service; is Tailscale running?")).toThrow(
      "Tailscale is not running",
    );
  });
});

describe("entries", () => {
  test("the daemon on 443 and every preview port to itself on loopback", () => {
    expect(entries(4141)).toEqual([
      { port: 443, target: "http://127.0.0.1:4141" },
      ...[10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008].map((p) => ({
        port: p,
        target: `http://127.0.0.1:${p}`,
      })),
    ]);
  });
});

describe("holder", () => {
  const daemon = entries(4141)[0]!;
  test("free, toyon's own (a trailing slash aside), or someone else's", () => {
    expect(holder(parseServeConfig("{}"), NAME, daemon)).toEqual({ kind: "free" });
    expect(holder(parseServeConfig(""), NAME, daemon)).toEqual({ kind: "free" });
    expect(holder(parseServeConfig(config({ 443: "http://127.0.0.1:4141/" })), NAME, daemon)).toEqual({
      kind: "toyon",
    });
    expect(holder(parseServeConfig(config({ 443: "http://127.0.0.1:3000" })), NAME, daemon)).toEqual({
      kind: "other",
      what: "a proxy to http://127.0.0.1:3000",
    });
    const tcp = JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } });
    expect(holder(parseServeConfig(tcp), NAME, daemon).kind).toBe("other");
  });
  test("a second mount on the port makes it not toyon's alone", () => {
    const two = JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4141" }, "/docs": { Path: "/srv" } } } },
    });
    expect(holder(parseServeConfig(two), NAME, daemon).kind).toBe("other");
  });
  test("with no name, any name's entry on the port counts", () => {
    const other = parseServeConfig(config({ 443: "http://127.0.0.1:4141" }, "old.tail1234.ts.net"));
    expect(holder(other, null, daemon)).toEqual({ kind: "toyon" });
  });
});

describe("serveTailnet", () => {
  test("sets the exact serve lines for 443 and ports 10001-10008", async () => {
    const f = fake();
    expect(await serveTailnet(f.ts, 4141)).toBe(NAME);
    expect(f.changes()).toEqual([
      ["serve", "--bg", "--https=443", "http://127.0.0.1:4141"],
      ...[10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008].map((p) => [
        "serve",
        "--bg",
        `--https=${p}`,
        `http://127.0.0.1:${p}`,
      ]),
    ]);
  });
  test("follows TOYON_PORT for the daemon's entry", async () => {
    const f = fake();
    await serveTailnet(f.ts, 5151);
    expect(f.changes()[0]).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:5151"]);
  });
  test("run again, skips the entries already in place", async () => {
    const f = fake({ serve: config({ 443: "http://127.0.0.1:4141", 10001: "http://127.0.0.1:10001" }) });
    await serveTailnet(f.ts, 4141);
    expect(f.changes().map((c) => c[2])).toEqual(
      [10002, 10003, 10004, 10005, 10006, 10007, 10008].map((p) => `--https=${p}`),
    );
  });
  test("changes nothing when a port already serves something else", async () => {
    const f = fake({ serve: config({ 10003: "http://127.0.0.1:8080" }) });
    const err = await serveTailnet(f.ts, 4141).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect((err as Error).message).toContain("https 10003 (a proxy to http://127.0.0.1:8080)");
    expect(f.changes()).toEqual([]);
  });
  test("refuses before touching serve when Tailscale is signed out or has HTTPS off", async () => {
    for (const out of [status({ BackendState: "NeedsLogin" }), status({ CertDomains: [] })]) {
      const f = fake({ status: { ok: true, out, err: "" } });
      await expect(serveTailnet(f.ts, 4141)).rejects.toBeInstanceOf(TailscaleError);
      expect(f.calls).toEqual([["status", "--json"]]);
    }
  });
  test("refuses when tailscaled is not running, on whichever stream it says so", async () => {
    const msg = "failed to connect to local Tailscale service; is Tailscale running?";
    for (const st of [
      { ok: false, out: "", err: msg },
      { ok: true, out: msg, err: "" },
    ]) {
      await expect(serveTailnet(fake({ status: st }).ts, 4141)).rejects.toThrow("Tailscale is not running");
    }
  });
  test("a failed serve line names its port and tailscale's own reason", async () => {
    const f = fake({ fail: "--https=10002" });
    await expect(serveTailnet(f.ts, 4141)).rejects.toThrow(
      "tailscale serve --https=10002: Access denied: serve config denied",
    );
  });
  test("refuses clearly when Tailscale is not installed", async () => {
    await expect(serveTailnet(tailscaleCli(null), 4141)).rejects.toThrow("Tailscale is not installed");
  });
});

describe("unserveTailnet", () => {
  test("removes toyon's entries and leaves the person's own", async () => {
    const serve = config({ ...allToyon(), 8443: "http://127.0.0.1:3000", 10005: "http://127.0.0.1:9999" });
    const f = fake({ serve });
    expect(await unserveTailnet(f.ts, 4141)).toBe(8);
    expect(f.changes()).toEqual(
      [443, 10001, 10002, 10003, 10004, 10006, 10007, 10008].map((p) => ["serve", `--https=${p}`, "off"]),
    );
    // never asks for status: the name is not needed, and a signed-out machine still cleans up
    expect(f.calls.some((c) => c[0] === "status")).toBe(false);
  });
  test("nothing to remove is not an error", async () => {
    const f = fake();
    expect(await unserveTailnet(f.ts, 4141)).toBe(0);
    expect(f.changes()).toEqual([]);
  });
});
