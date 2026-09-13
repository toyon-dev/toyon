import { describe, expect, test } from "bun:test";
import { checkPreviews, isRemoteHost, matchPreview, parseRemote, previewOrigin } from "./daemon.ts";

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
  test("reads the host a valid file names, with previews routed by name unless it says otherwise", () => {
    expect(parseRemote('{ "host": "toyon.example.com" }')).toEqual({
      host: "toyon.example.com",
      previews: "https://w{id}.toyon.example.com",
    });
    expect(parseRemote('{ "host": "box.tail1234.ts.net", "previews": "https://box.tail1234.ts.net:{port}" }')).toEqual({
      host: "box.tail1234.ts.net",
      previews: "https://box.tail1234.ts.net:{port}",
    });
  });
  test("a file that is not JSON, names nothing, or names an invalid host or previews reads as off", () => {
    for (const text of [
      "",
      "toyon.example.com",
      "{}",
      '{ "host": 3 }',
      '{ "host": "box" }',
      "null",
      '{ "host": "toyon.example.com", "previews": "port" }',
      '{ "host": "toyon.example.com", "previews": 3 }',
    ]) {
      expect(parseRemote(text)).toBeNull();
    }
  });
});

// A preview pattern says where each worktree's preview lives under the public name. The daemon
// matches requests against it and the shell fills it in, so one pattern serves every front.
describe("previews", () => {
  test("a name route, a port route, and the port on the name's own subdomain all serve the name", () => {
    expect(checkPreviews("https://w{id}.toyon.example.com", "toyon.example.com")).toBeNull();
    expect(checkPreviews("https://app.fly.dev:{port}", "app.fly.dev")).toBeNull();
    expect(checkPreviews("https://p{port}.toyon.example.com", "toyon.example.com")).toBeNull();
  });
  test("hosts on another site are refused: the preview cookie cannot reach them", () => {
    expect(checkPreviews("https://cs-{port}.app.github.dev", "cs-4141.app.github.dev")).toContain("cookie");
    expect(checkPreviews("https://w{id}.elsewhere.example", "toyon.example.com")).toContain("cookie");
  });
  test("a pattern with no placeholder, two, a path, plain http, or {id} as the port is refused", () => {
    for (const bad of [
      "https://toyon.example.com",
      "https://w{id}.toyon.example.com:{port}",
      "https://w{id}.toyon.example.com/app",
      "http://w{id}.toyon.example.com",
      "https://toyon.example.com:{id}",
    ]) {
      expect(checkPreviews(bad, "toyon.example.com")).not.toBeNull();
    }
  });
  test("the shell fills a pattern in; the daemon reads the same one back", () => {
    expect(previewOrigin("https://w{id}.toyon.example.com", "ab12", 10001)).toBe("https://wab12.toyon.example.com");
    expect(previewOrigin("https://app.fly.dev:{port}", "ab12", 10001)).toBe("https://app.fly.dev:10001");
    expect(matchPreview("https://w{id}.toyon.example.com", "wab12.toyon.example.com")).toEqual({ id: "ab12" });
    expect(matchPreview("https://app.fly.dev:{port}", "app.fly.dev:10001")).toEqual({ port: 10001 });
  });
  test("a name that only resembles the pattern matches nothing", () => {
    for (const authority of [
      "toyon.example.com",
      "w-1.toyon.example.com",
      "wa1.wb2.toyon.example.com",
      "wab12toyon.example.com",
      "wab12.toyon.example.com.evil.example",
    ]) {
      expect(matchPreview("https://w{id}.toyon.example.com", authority)).toBeNull();
    }
    expect(matchPreview("https://app.fly.dev:{port}", "app.fly.dev")).toBeNull();
    expect(matchPreview("https://app.fly.dev:{port}", "appxfly.dev:10001")).toBeNull();
  });
});
