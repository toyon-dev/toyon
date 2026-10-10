import { describe, expect, test } from "bun:test";
import { machineAddress } from "@toyon/shared";
import { ADD_MACHINE, hostOf, knockFailureLine, machineRank, machineState } from "./addMachine.ts";

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
    expect(ADD_MACHINE.waiting("https://work.tail1234.ts.net", "amber fox")).toBe(
      "Toyon on work.tail1234.ts.net is asking whether to let amber fox in.",
    );
  });
  test("a row offers the request only for a Toyon answering now, and says why not otherwise", () => {
    const work = {
      name: "work",
      host: "work.tail1234.ts.net",
      online: true,
      toyon: { machine: "work", answering: true },
    };
    const quiet = { ...work, toyon: { machine: "work", answering: false } };
    const bare = { ...work, toyon: null };
    const off = { ...bare, online: false };
    expect(machineState(work, false)).toBeNull();
    expect(machineState(work, true)).toBe("listed");
    expect(machineState(quiet, false)).toBe("not answering right now");
    expect(machineState(bare, false)).toBe("no Toyon");
    expect(machineState(off, false)).toBe("offline");
    expect([off, bare, quiet, work].map(machineRank)).toEqual([3, 2, 1, 0]);
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
