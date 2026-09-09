import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import { createFetch, type WsData } from "./http.ts";

// The daemon's front door in local mode: loopback peers and loopback Host headers only (DNS
// rebinding), the token on /ws and /register, and /register mapping user mistakes to 400.

function srv(ip = "127.0.0.1", upgrade = () => true) {
  return { requestIP: () => ({ address: ip }), upgrade } as unknown as Server<WsData>;
}
const repos = {
  register: async (path: string) => {
    if (path === "/bad") throw new UserError("not a git repo");
    if (path === "/boom") throw new Error("disk on fire");
    return { id: "r1" };
  },
} as unknown as RepoRegistry;
const attachmentsDir = mkdtempSync(join(tmpdir(), "toyon-http-"));
afterAll(() => rmSync(attachmentsDir, { recursive: true, force: true }));
const learnedOrigins: (string | null)[] = [];
const fetch = createFetch({
  token: "secret",
  shellDist: "/nonexistent",
  version: "0",
  repos,
  attachments: new AttachmentStore(attachmentsDir),
  branded: () => false,
  metrics: () => ({ lag: 0 }),
  noteShellOrigin: (o) => learnedOrigins.push(o),
});
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://${init.host ?? "localhost"}${path}`, {
    ...init,
    headers: { host: init.host ?? "localhost", ...(init.headers as Record<string, string>) },
  });

describe("guards", () => {
  test("a remote peer is refused even with the token", async () => {
    const r = await fetch(req("/ws?token=secret"), srv("10.0.0.5"));
    expect(r?.status).toBe(403);
  });
  test("a non-loopback Host header is refused (DNS rebinding)", async () => {
    const r = await fetch(req("/health", { host: "evil.example" }), srv());
    expect(r?.status).toBe(403);
  });
  test("*.localhost and 127.0.0.1 hosts pass", async () => {
    expect((await fetch(req("/health", { host: "toyon.localhost" }), srv()))?.status).toBe(200);
    expect((await fetch(req("/health", { host: "127.0.0.1:4141" }), srv("::1")))?.status).toBe(200);
  });
});

describe("/ws", () => {
  test("wrong token is 401", async () => {
    expect((await fetch(req("/ws?token=nope"), srv()))?.status).toBe(401);
  });
  test("the framing origin is learned from an authenticated handshake, never a refused one", async () => {
    learnedOrigins.length = 0;
    await fetch(req("/ws?token=nope", { headers: { origin: "http://evil.example" } }), srv());
    expect(learnedOrigins).toEqual([]);
    const s = srv("127.0.0.1", (() => true) as never);
    await fetch(req("/ws?token=secret", { headers: { origin: "http://w1.toyon.localhost:5173" } }), s);
    expect(learnedOrigins).toEqual(["http://w1.toyon.localhost:5173"]);
  });
  test("right token upgrades (no response) with a fresh subscription set", async () => {
    let data: WsData | undefined;
    const s = srv("127.0.0.1", ((_r: Request, o: { data: WsData }) => {
      data = o.data;
      return true;
    }) as never);
    expect(await fetch(req("/ws?token=secret"), s)).toBeUndefined();
    expect(data?.subs.size).toBe(0);
    expect(data?.authed).toBe(true);
  });
});

describe("/register", () => {
  const post = (body: unknown, auth = "Bearer secret") =>
    req("/register", { method: "POST", body: JSON.stringify(body), headers: { authorization: auth } });
  test("needs the bearer token", async () => {
    expect((await fetch(post({ path: "/x" }, "Bearer nope"), srv()))?.status).toBe(401);
  });
  test("missing or malformed body is 400", async () => {
    expect((await fetch(post({}), srv()))?.status).toBe(400);
    const r = await fetch(
      req("/register", { method: "POST", body: "{", headers: { authorization: "Bearer secret" } }),
      srv(),
    );
    expect(r?.status).toBe(400);
  });
  test("a user mistake is 400 with the message; an internal failure is a generic 500", async () => {
    const bad = await fetch(post({ path: "/bad" }), srv());
    expect(bad?.status).toBe(400);
    expect(await bad?.text()).toBe("not a git repo");
    const boom = await fetch(post({ path: "/boom" }), srv());
    expect(boom?.status).toBe(500);
    expect(await boom?.text()).not.toContain("disk");
  });
  test("success returns the repo id", async () => {
    const r = await fetch(post({ path: "/ok" }), srv());
    expect(await r?.json()).toEqual({ repoId: "r1" });
  });
});

describe("/attachments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const img = { name: "shot.png", mimeType: "image/png" as const, data: png, width: 2, height: 2 };
  test("serves a stored image with the token, immutable", async () => {
    await new AttachmentStore(attachmentsDir).putImage("wt1", 1, img);
    const r = await fetch(req("/attachments/wt1/1.png?token=secret"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await r!.arrayBuffer()).toString("base64")).toBe(png);
  });
  test("no token is 401; a missing or malformed path is 404", async () => {
    expect((await fetch(req("/attachments/wt1/1.png"), srv()))?.status).toBe(401);
    expect((await fetch(req("/attachments/wt1/9.png?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/attachments/..%2F..%2Fetc/passwd?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/attachments/wt1/1.png/x?token=secret"), srv()))?.status).toBe(404);
  });
});

describe("static shell", () => {
  const dist = mkdtempSync(join(tmpdir(), "toyon-dist-"));
  afterAll(() => rmSync(dist, { recursive: true, force: true }));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>toyon</title>");
  writeFileSync(join(dist, "sw.js"), "// worker");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "index-abc123.js"), "export default 1;");
  const serve = createFetch({
    token: "secret",
    shellDist: dist,
    version: "0",
    repos,
    attachments: new AttachmentStore(attachmentsDir),
    branded: () => false,
    noteShellOrigin: () => {},
    metrics: () => ({ lag: 0 }),
  });

  test("a route falls back to index.html so the SPA can handle it", async () => {
    const r = await serve(req("/some/deep/route"), srv());
    expect(r?.status).toBe(200);
    expect(await r?.text()).toContain("<!doctype html>");
  });
  test("a hashed asset that is gone is 404, never index.html", async () => {
    // a rebuilt shell rotates every hashed name; HTML here would fail the open tab's module
    // import on MIME instead of status, and it could not tell a reload is the fix
    const r = await serve(req("/assets/MonacoDiff-old.js"), srv());
    expect(r?.status).toBe(404);
    expect(await r?.text()).not.toContain("doctype");
  });

  test("a hashed asset is immutable: the name cannot mean different bytes later", async () => {
    const r = await serve(req("/assets/index-abc123.js"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toContain("immutable");
  });

  // index.html is what maps hashes to the current build. Cached, a rebuilt daemon leaves the tab
  // booting an asset graph that is gone, and the stale-build screen's reload reads it again.
  test("index.html is never stored", async () => {
    const r = await serve(req("/"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toBe("no-store");
  });
  test("the SPA fallback is never stored either", async () => {
    const r = await serve(req("/some/deep/route"), srv());
    expect(r?.headers.get("cache-control")).toBe("no-store");
  });
  test("an unhashed file beside the shell is never stored", async () => {
    const r = await serve(req("/sw.js"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toBe("no-store");
  });
});
