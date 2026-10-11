import { describe, expect, test } from "bun:test";
import { machineAddress, type TailscaleReadiness } from "@toyon/shared";
import { DEVICES, hostOf, knockFailureLine, machineRank, machineState, selfState } from "./devices.ts";

describe("the add-machine lines", () => {
  test("each failure says what to do next, naming the machine where that helps", () => {
    expect(knockFailureLine("refused", "https://work.tail1234.ts.net", "this page")).toBe(
      "work.tail1234.ts.net did not let this page in.",
    );
    expect(knockFailureLine("gone", "https://work.tail1234.ts.net", "this page")).toBe(
      "work.tail1234.ts.net stopped waiting. Ask again, and answer there within five minutes.",
    );
    expect(knockFailureLine("full", "https://work.tail1234.ts.net", "this page")).toBe(
      "work.tail1234.ts.net has too many devices waiting already. Answer or turn those away there first.",
    );
    expect(knockFailureLine("not-toyon", "https://work.tail1234.ts.net", "this page")).toBe(
      "work.tail1234.ts.net is not a Toyon machine, or has no remote name set up.",
    );
    expect(knockFailureLine("unreachable", "https://work.tail1234.ts.net", "this page")).toBe(
      "work.tail1234.ts.net did not answer. Is Tailscale on here, and is Toyon running there?",
    );
  });
  test("the same failure on the machine's own address speaks of this device", () => {
    expect(knockFailureLine("refused", "https://mac.tail1234.ts.net", "this device")).toBe(
      "mac.tail1234.ts.net did not let this device in.",
    );
  });
  test("the waiting line names the words the other screen shows", () => {
    expect(DEVICES.waiting("https://work.tail1234.ts.net", "amber fox")).toBe(
      "Toyon on work.tail1234.ts.net is asking whether to let amber fox in.",
    );
  });
  test("a row offers the request only for a Toyon answering now, and says why not otherwise", () => {
    const work = {
      name: "work",
      host: "work.tail1234.ts.net",
      kind: "machine" as const,
      reached: true,
      toyon: { machine: "work", answering: true },
    };
    const quiet = { ...work, toyon: { machine: "work", answering: false } };
    const bare = { ...work, toyon: null };
    const off = { ...bare, reached: false };
    expect(machineState(work, false)).toBeNull();
    expect(machineState(work, true)).toBe("listed");
    expect(machineState(quiet, false)).toBe("not answering right now");
    expect(machineState(bare, false)).toBe("no Toyon");
    expect(machineState(off, false)).toBe("offline");
    expect([off, bare, quiet, work].map(machineRank)).toEqual([3, 2, 1, 0]);
  });
  test("this machine's row says which way Tailscale here is off, and offers the way back where the CLI can", () => {
    const at = (state: TailscaleReadiness["state"]) =>
      selfState(null, { state, name: null, line: "the daemon's line" }, "mac.tail1234.ts.net");
    expect(at("not-running")).toEqual({
      word: "Tailscale not running",
      note: "Tailscale is not running on this machine, so nothing on your tailnet can reach it.",
      offer: null,
    });
    expect(at("not-installed")).toMatchObject({ word: "no Tailscale", offer: null });
    expect(at("disconnected")).toMatchObject({ word: null, offer: "connect" });
    expect(at("signed-out")).toMatchObject({ word: null, offer: "sign-in" });
    expect(at("signed-out").note).toContain("signed out");
    expect(at("needs-approval")).toEqual({ word: "not approved", note: "the daemon's line", offer: null });
    // a daemon that answered nothing, or readiness not yet read: no blame, just the fact
    expect(at("ready").word).toBe("not asked");
    expect(selfState(null, null, null).word).toBe("not asked");
  });
  test("readiness is read before the view: a switched-off Tailscale still lists the tailnet, and is not 'not connected'", () => {
    const off = { state: "disconnected" as const, name: null, line: "" };
    expect(selfState({ here: false, devices: [] }, off, "mac.tail1234.ts.net")).toMatchObject({ offer: "connect" });
  });
  test("a link that is down is said so; on the tailnet with nothing in the way is no word at all", () => {
    const ready = { state: "ready" as const, name: "mac.tail1234.ts.net", line: "" };
    expect(selfState({ here: false, devices: [] }, ready, "mac.tail1234.ts.net")).toEqual({
      word: "not connected",
      note: DEVICES.hereOff,
      offer: null,
    });
    expect(selfState({ here: true, devices: [] }, ready, "mac.tail1234.ts.net")).toEqual({
      word: null,
      note: null,
      offer: null,
    });
    expect(selfState({ here: true, devices: [] }, ready, null)).toMatchObject({ word: null, note: null });
    // with no name, what keeps the switch from being offered
    const dns = { state: "magicdns-off" as const, name: null, line: "MagicDNS is off for this tailnet" };
    expect(selfState({ here: true, devices: [] }, dns, null)).toMatchObject({ word: "MagicDNS off", note: dns.line });
    expect(selfState({ here: true, devices: [] }, dns, "mac.tail1234.ts.net")).toMatchObject({
      word: null,
      note: null,
    });
  });
  test("hostOf keeps a port and survives something that is not an origin", () => {
    expect(hostOf("http://127.0.0.1:4242")).toBe("127.0.0.1:4242");
    expect(hostOf("nonsense")).toBe("nonsense");
  });
});

describe("machineAddress", () => {
  test("an address, with or without https, a path or a fragment, is the machine's origin", () => {
    expect(machineAddress("https://work.tail1234.ts.net/")).toBe("https://work.tail1234.ts.net");
    expect(machineAddress(" work.tail1234.ts.net ")).toBe("https://work.tail1234.ts.net");
    expect(machineAddress("https://work.tail1234.ts.net/#token=0123abcd")).toBe("https://work.tail1234.ts.net");
    expect(machineAddress("http://127.0.0.1:4242/#token=0123abcd")).toBe("http://127.0.0.1:4242");
  });
  test("plain http to a name off this machine, or nothing at all, is nothing", () => {
    expect(machineAddress("http://work.tail1234.ts.net/")).toBeNull();
    expect(machineAddress("")).toBeNull();
    expect(machineAddress("not a name at all")).toBeNull();
  });
});
