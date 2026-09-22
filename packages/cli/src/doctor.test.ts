import { describe, expect, test } from "bun:test";
import { MANAGED_DEFAULTS, MANAGED_STRICTEST, type ManagedResolved } from "@toyon/shared";
import { policyLines } from "./doctor.ts";

// The policy line is what a reviewer reads to check the file took, so each state has to read as
// itself: nothing, applied, broken, and a daemon that has not caught up.

const none: ManagedResolved = { policy: MANAGED_DEFAULTS, sources: [], hash: null, source: null, problem: null };
const applied: ManagedResolved = {
  policy: { ...MANAGED_DEFAULTS, updates: false, remote: "tailscale" },
  sources: [{ path: "/etc/toyon/policy.json", kind: "json", state: "applied" }],
  hash: "0badf00d",
  source: "/etc/toyon/policy.json",
  problem: null,
};

describe("policyLines", () => {
  test("no file is one ok line saying so", () => {
    expect(policyLines(none, undefined)).toEqual([{ ok: true, label: "policy", detail: "none" }]);
  });
  test("an applied file names itself and what it turns off", () => {
    expect(policyLines(applied, { source: applied.source, hash: applied.hash })).toEqual([
      { ok: true, label: "policy", detail: "/etc/toyon/policy.json: updates off, remote tailscale" },
    ]);
  });
  test("a file that turns nothing off still counts as applied", () => {
    const empty = { ...applied, policy: MANAGED_DEFAULTS };
    expect(policyLines(empty, undefined)[0]?.detail).toBe("/etc/toyon/policy.json: nothing turned off");
  });
  test("a broken file fails, and the line says everything it governs is off", () => {
    const broken: ManagedResolved = {
      policy: MANAGED_STRICTEST,
      sources: [{ path: "/etc/toyon/policy.json", kind: "json", state: "invalid", problem: "not valid JSON" }],
      hash: null,
      source: "/etc/toyon/policy.json",
      problem: "/etc/toyon/policy.json: not valid JSON",
    };
    expect(policyLines(broken, undefined)).toEqual([
      { ok: false, label: "policy", detail: "/etc/toyon/policy.json: not valid JSON (everything it governs is off)" },
    ]);
  });
  test("a daemon that booted under another version of the file gets a failing second line", () => {
    const lines = policyLines(applied, { source: applied.source, hash: "older" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ ok: false, label: "daemon" });
    expect(lines[1]?.detail).toContain("toyon restart");
    // a daemon that predates the field cannot be compared, and is not blamed
    expect(policyLines(applied, undefined)).toHaveLength(1);
  });
});
