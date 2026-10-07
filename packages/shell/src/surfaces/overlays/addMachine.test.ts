import { describe, expect, test } from "bun:test";
import { parsePairLink } from "@toyon/shared";
import { failureLine, hostOf } from "./addMachine.ts";

describe("the add-machine lines", () => {
  test("each failure says what to do next, naming the machine where that helps", () => {
    expect(failureLine("expired", "https://work.tail1234.ts.net")).toBe(
      "This code has expired; show a new one on the other machine.",
    );
    expect(failureLine("not-toyon", "https://work.tail1234.ts.net")).toBe(
      "work.tail1234.ts.net is not a Toyon machine, or has no remote name set up.",
    );
    expect(failureLine("unreachable", "https://work.tail1234.ts.net")).toBe(
      "work.tail1234.ts.net did not answer. Is Tailscale on here, and is Toyon running there?",
    );
  });
  test("hostOf keeps a port and survives something that is not an origin", () => {
    expect(hostOf("http://127.0.0.1:4242")).toBe("127.0.0.1:4242");
    expect(hostOf("nonsense")).toBe("nonsense");
  });
});

describe("parsePairLink", () => {
  test("a pair link names the machine and the code; a token link the machine and the token", () => {
    expect(parsePairLink("https://work.tail1234.ts.net/#pair=abc_-9")).toEqual({
      origin: "https://work.tail1234.ts.net",
      code: "abc_-9",
    });
    expect(parsePairLink(" http://127.0.0.1:4242/#token=0123abcd ")).toEqual({
      origin: "http://127.0.0.1:4242",
      token: "0123abcd",
    });
  });
  test("plain http to a name off this machine, no fragment, or no url at all is nothing", () => {
    expect(parsePairLink("http://work.tail1234.ts.net/#token=0123abcd")).toBeNull();
    expect(parsePairLink("https://work.tail1234.ts.net/")).toBeNull();
    expect(parsePairLink("work")).toBeNull();
  });
});
