import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "@toyon/shared/tailscale";
import { UserError } from "./errors.ts";
import { Hub } from "./hub.ts";
import { RemoteSetting } from "./remote.ts";
import { RemoteSwitch } from "./remoteSwitch.ts";

const NAME = "mac.tail1234.ts.net";
const status = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: `${NAME}.` },
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: [NAME],
});

/** a tailscale CLI that is signed in with HTTPS on, recording every serve change */
function fake(opts: { status?: string } = {}) {
  const calls: string[][] = [];
  const ts = async (args: string[]): Promise<Ran> => {
    calls.push(args);
    if (args[0] === "status") return { ok: true, out: opts.status ?? status, err: "" };
    if (args.join(" ") === "serve status --json") return { ok: true, out: "{}", err: "" };
    return { ok: true, out: "", err: "" };
  };
  return { ts, changes: () => calls.filter((c) => c[0] === "serve" && c[1] !== "status") };
}

function make(opts: { status?: string; policy?: "any" | "off" | "tailscale"; edge?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "toyon-remote-"));
  const file = join(dir, "remote.json");
  const hub = new Hub();
  const setting = new RemoteSetting(
    opts.edge ? { host: "app.fly.dev", previews: "https://app.fly.dev:{port}", front: "edge" } : null,
    hub,
  );
  /** the host after each change the hub announced */
  const seen: (string | null)[] = [];
  hub.on("remoteChanged", () => seen.push(setting.get()?.host ?? null));
  const f = fake(opts);
  const sw = new RemoteSwitch({ setting, ts: f.ts, port: 4141, file, policy: { remote: opts.policy ?? "any" } });
  return { sw, setting, seen, file, changes: f.changes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("RemoteSwitch", () => {
  test("on: serve is set up, the file written, the setting live and announced; off undoes it", async () => {
    const m = make();
    try {
      const r = await m.sw.turnOn();
      expect(r).toEqual({ host: NAME, previews: `https://${NAME}:{port}`, front: "local" });
      expect(m.setting.get()).toEqual(r);
      expect(JSON.parse(readFileSync(m.file, "utf8"))).toEqual({ host: NAME, previews: `https://${NAME}:{port}` });
      expect(m.changes().length).toBe(9);
      expect(m.seen).toEqual([NAME]);

      await m.sw.turnOff();
      expect(m.setting.get()).toBeNull();
      expect(existsSync(m.file)).toBe(false);
      expect(m.seen).toEqual([NAME, null]);
    } finally {
      m.cleanup();
    }
  });

  test("a name of the person's own is checked as the file would be, then written and live", async () => {
    const m = make();
    try {
      const r = m.sw.use({ host: "Toyon.Example.com", previews: "https://w{id}.toyon.example.com" });
      expect(r).toEqual({ host: "toyon.example.com", previews: "https://w{id}.toyon.example.com", front: "local" });
      expect(m.seen).toEqual(["toyon.example.com"]);
      expect(m.changes()).toEqual([]);
      expect(() => m.sw.use({ host: "localhost", previews: "https://localhost:{port}" })).toThrow(UserError);
      expect(() => m.sw.use({ host: "toyon.example.com", previews: "https://elsewhere.com:{port}" })).toThrow(
        UserError,
      );
    } finally {
      m.cleanup();
    }
  });

  test("what Tailscale is missing is the refusal, and nothing is written", async () => {
    const m = make({ status: JSON.stringify({ BackendState: "NeedsLogin" }) });
    try {
      await expect(m.sw.turnOn()).rejects.toThrow("signed out");
      expect(existsSync(m.file)).toBe(false);
      expect(m.seen).toEqual([]);
    } finally {
      m.cleanup();
    }
  });

  test("the policy and an edge refuse before Tailscale is asked", async () => {
    const off = make({ policy: "off" });
    const edge = make({ edge: true });
    try {
      await expect(off.sw.turnOn()).rejects.toBeInstanceOf(UserError);
      await expect(edge.sw.turnOn()).rejects.toThrow("edge");
      await expect(edge.sw.turnOff()).rejects.toThrow("edge");
      expect(off.changes()).toEqual([]);
    } finally {
      off.cleanup();
      edge.cleanup();
    }
  });
});
