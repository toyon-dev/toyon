import { describe, expect, test } from "bun:test";
import {
  describeManaged,
  MANAGED_DEFAULTS,
  MANAGED_STRICTEST,
  type ManagedSourceRead,
  managedSources,
  resolveManaged,
} from "./managed.ts";

// The policy is what a company's reviewer signs off on, so what a file means has to be exact:
// absent means allowed, stricter wins between sources, and anything unreadable fails closed.

const json = (text: string, path = "/etc/toyon/policy.json"): ManagedSourceRead => ({ path, kind: "json", text });

describe("resolveManaged", () => {
  test("no source at all is every key allowed, with nowhere named", () => {
    const r = resolveManaged([{ path: "/etc/toyon/policy.json", kind: "json" }]);
    expect(r.policy).toEqual(MANAGED_DEFAULTS);
    expect(r).toMatchObject({ source: null, problem: null, hash: null });
    expect(r.sources).toEqual([{ path: "/etc/toyon/policy.json", kind: "json", state: "absent" }]);
  });

  test("a file sets only the keys it names", () => {
    const r = resolveManaged([json('{ "updates": false, "remote": "tailscale" }')]);
    expect(r.policy).toEqual({ ...MANAGED_DEFAULTS, updates: false, remote: "tailscale" });
    expect(r.source).toBe("/etc/toyon/policy.json");
    expect(r.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("two sources: the stricter value of each key wins, whichever file it came from", () => {
    const r = resolveManaged([
      json('{ "updates": false, "remote": "any", "agents": ["claude", "codex"], "planSignIn": true }', "/a.json"),
      json(
        '{ "updates": true, "remote": "tailscale", "agents": ["codex", "opencode"], "planSignIn": false }',
        "/b.json",
      ),
    ]);
    expect(r.policy).toEqual({
      ...MANAGED_DEFAULTS,
      updates: false,
      remote: "tailscale",
      agents: ["codex"],
      planSignIn: false,
    });
    // the first applied path is the one named
    expect(r.source).toBe("/a.json");
  });

  test("the remote ladder: off under tailscale under any", () => {
    const at = (a: string, b: string) =>
      resolveManaged([json(`{ "remote": "${a}" }`, "/a"), json(`{ "remote": "${b}" }`, "/b")]).policy.remote;
    expect(at("any", "tailscale")).toBe("tailscale");
    expect(at("tailscale", "off")).toBe("off");
    expect(at("off", "any")).toBe("off");
  });

  test("an agents list on one side alone is the list; an empty list leaves nothing", () => {
    expect(resolveManaged([json('{ "agents": ["claude"] }', "/a"), json("{}", "/b")]).policy.agents).toEqual([
      "claude",
    ]);
    expect(resolveManaged([json('{ "agents": [] }')]).policy.agents).toEqual([]);
  });

  test("an unknown key is ignored, so a file for a newer Toyon still reads", () => {
    const r = resolveManaged([json('{ "updates": false, "telemetry": false }')]);
    expect(r.problem).toBeNull();
    expect(r.policy.updates).toBe(false);
  });

  test("a key of the wrong type fails closed and says which", () => {
    const r = resolveManaged([json('{ "updates": "no" }')]);
    expect(r.policy).toEqual(MANAGED_STRICTEST);
    expect(r.problem).toContain('"updates"');
    expect(r.source).toBe("/etc/toyon/policy.json");
    expect(r.sources[0]).toMatchObject({ state: "invalid" });
  });

  test("a file that is not JSON fails closed", () => {
    const r = resolveManaged([json('{ "updates": false, }')]);
    expect(r.policy).toEqual(MANAGED_STRICTEST);
    expect(r.problem).toBe("/etc/toyon/policy.json: not valid JSON");
  });

  test("a file not owned by root fails closed, whatever it says", () => {
    const r = resolveManaged([{ ...json('{ "updates": true }'), owned: false }]);
    expect(r.policy).toEqual(MANAGED_STRICTEST);
    expect(r.problem).toContain("not owned by root");
  });

  test("one invalid source beside a good one still fails everything closed", () => {
    const r = resolveManaged([json('{ "updates": false }', "/a"), json("nope", "/b")]);
    expect(r.policy).toEqual(MANAGED_STRICTEST);
    expect(r.source).toBe("/b");
    expect(r.sources.map((s) => s.state)).toEqual(["applied", "invalid"]);
  });

  test("the hash follows the content, not the path", () => {
    const a = resolveManaged([json('{ "updates": false }')]).hash;
    const b = resolveManaged([json('{ "updates": true }')]).hash;
    const c = resolveManaged([json('{ "updates": false }', "/elsewhere.json")]).hash;
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});

describe("managedSources", () => {
  test("macOS reads MDM's plists, the computer's and the user's, then the JSON file", () => {
    expect(managedSources("darwin", "kyle").map((s) => s.path)).toEqual([
      "/Library/Managed Preferences/dev.toyon.plist",
      "/Library/Managed Preferences/kyle/dev.toyon.plist",
      "/Library/Application Support/toyon/policy.json",
    ]);
  });
  test("linux reads one file; anywhere else reads none", () => {
    expect(managedSources("linux")).toEqual([{ path: "/etc/toyon/policy.json", kind: "json" }]);
    expect(managedSources("win32")).toEqual([]);
  });
});

describe("describeManaged", () => {
  test("names what is off and nothing else", () => {
    expect(describeManaged(MANAGED_DEFAULTS)).toEqual([]);
    expect(describeManaged({ ...MANAGED_DEFAULTS, updates: false, remote: "tailscale", agents: ["claude"] })).toEqual([
      "updates off",
      "remote tailscale",
      "agents claude",
    ]);
    expect(describeManaged(MANAGED_STRICTEST)).toEqual([
      "updates off",
      "deploy off",
      "remote off",
      "custom agents off",
      "toyon.localhost listener off",
      "plan sign-in off",
    ]);
  });
});
