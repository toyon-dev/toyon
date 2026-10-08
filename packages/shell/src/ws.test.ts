import { describe, expect, test } from "bun:test";
import { daemonUrls } from "./ws.ts";

// Every address the shell fetches from one daemon is built here, absolute, so the same shapes
// reach the machine that served the page and one that let it in.

describe("daemonUrls", () => {
  test("a tailnet machine: https, wss, the token where each route reads it", () => {
    const u = daemonUrls("https://work.tail1234.ts.net", "abc");
    expect(u.origin).toBe("https://work.tail1234.ts.net");
    expect(u.host).toBe("work.tail1234.ts.net");
    expect(u.ws).toBe("wss://work.tail1234.ts.net/ws?token=abc");
    expect(u.attachment("w1", "1.png")).toBe("https://work.tail1234.ts.net/attachments/w1/1.png?token=abc");
    expect(u.upload("u1")).toBe("https://work.tail1234.ts.net/uploads/u1?token=abc");
    expect(u.worktreeFile("w1", "public/a b.png", "v2")).toBe(
      "https://work.tail1234.ts.net/files/w1/public/a%20b.png?token=abc&v=v2",
    );
    expect(u.loose("g1", null)).toBe("https://work.tail1234.ts.net/loose/g1?token=abc&v=");
    expect(u.health).toBe("https://work.tail1234.ts.net/health");
    expect(u.restart(false)).toBe("https://work.tail1234.ts.net/restart?token=abc");
    expect(u.restart(true)).toContain("&now");
    expect(u.uploads("file")).toBe("https://work.tail1234.ts.net/uploads?kind=file");
    expect(u.phones).toBe("https://work.tail1234.ts.net/phones");
    expect(u.knockAnswer("k1")).toBe("https://work.tail1234.ts.net/knock/k1/answer");
    expect(u.previewGrant).toBe("https://work.tail1234.ts.net/preview-grant");
  });
  test("a loopback daemon on a port: plain ws, the port kept", () => {
    const u = daemonUrls("http://127.0.0.1:4242/", "t");
    expect(u.origin).toBe("http://127.0.0.1:4242");
    expect(u.host).toBe("127.0.0.1");
    expect(u.ws).toBe("ws://127.0.0.1:4242/ws?token=t");
  });
});
