import { describe, expect, test } from "bun:test";
import { isRemoteHost, parseRemote } from "./daemon.ts";

// The name in remote.json is one the CLI writes and the daemon trusts as a Host: both read it
// through here, so a name one accepts the other cannot refuse.

describe("isRemoteHost", () => {
  test("a dotted lowercase DNS name, tailnet names included", () => {
    for (const ok of ["toyon.example.com", "box.tail1234.ts.net", "a-b.example"]) expect(isRemoteHost(ok)).toBe(true);
  });
  test("not a scheme, port, bare label, IP, localhost name or uppercase", () => {
    for (const bad of [
      "https://toyon.example.com",
      "toyon.example.com:443",
      "box",
      "10.0.0.5",
      "localhost",
      "toyon.localhost",
      "Toyon.Example.com",
      "-bad.example",
      "",
    ]) {
      expect(isRemoteHost(bad)).toBe(false);
    }
  });
});

describe("parseRemote", () => {
  test("reads the host a valid file names", () => {
    expect(parseRemote('{ "host": "toyon.example.com" }')).toEqual({ host: "toyon.example.com" });
  });
  test("a file that is not JSON, names nothing, or names an invalid host reads as off", () => {
    for (const text of ["", "toyon.example.com", "{}", '{ "host": 3 }', '{ "host": "box" }', "null"]) {
      expect(parseRemote(text)).toBeNull();
    }
  });
});
