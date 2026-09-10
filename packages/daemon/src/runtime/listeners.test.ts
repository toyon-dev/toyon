import { describe, expect, test } from "bun:test";
import { listeningPorts, parseAddress, portFromLogs, reachableHost } from "./listeners.ts";

describe("parseAddress", () => {
  test("ipv4, ipv6 and wildcard forms from lsof -F n", () => {
    expect(parseAddress("127.0.0.1:5173")).toEqual({ host: "127.0.0.1", port: 5173 });
    expect(parseAddress("[::1]:5173")).toEqual({ host: "::1", port: 5173 });
    expect(parseAddress("*:3000")).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(parseAddress("garbage")).toBeNull();
    expect(parseAddress("127.0.0.1:99999")).toBeNull();
  });
});

describe("portFromLogs", () => {
  test("takes the last URL a server printed, in any of the local spellings", () => {
    const lines = ["  VITE v5 ready", "  ➜  Local:   http://localhost:5173/", "  ➜  Network: use --host"];
    expect(portFromLogs(lines)).toBe(5173);
    expect(portFromLogs(["Listening on http://[::1]:8080"])).toBe(8080);
    expect(portFromLogs(["http://0.0.0.0:4000", "then http://127.0.0.1:4001"])).toBe(4001);
    expect(portFromLogs(["compiling…"])).toBeNull();
  });
});

describe("the OS view", () => {
  test("a bun server in our own group shows up, and reachableHost confirms it", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const ports = await listeningPorts(process.pid);
      // lsof may be missing on a runner; then the list is empty by contract, not wrong
      if (ports.length > 0) expect(ports.some((l) => l.port === Number(server.port))).toBe(true);
      expect(await reachableHost(Number(server.port))).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
    expect(await reachableHost(1)).toBeNull();
  });
});
