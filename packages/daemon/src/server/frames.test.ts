import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameTickets } from "../core/frames.ts";
import { FrameListener, frameHandler, frameOriginFor, pagePolicy } from "./frames.ts";

// Every answer from the frame origin carries the sandbox, the page carries the whole policy, and a
// browser that says it is loading something other than a frame or a file gets nothing.

let base: string;
let root: string;
let tickets: FrameTickets;
let code: string;
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "toyon-frame-srv-"));
  root = join(base, "wt");
  mkdirSync(join(root, "img"), { recursive: true });
  writeFileSync(join(root, "img/a.png"), "png");
  writeFileSync(join(root, "f.woff2"), "font");
  writeFileSync(join(root, "s.css"), "body{}");
  writeFileSync(join(root, "page.html"), '<link href="s.css"><img src="img/a.png"><p>hi</p>');
  writeFileSync(join(root, "unnamed.png"), "png");
  tickets = new FrameTickets({ worktreeRoot: () => root, grantPath: () => null, refused: [] });
  code = (await tickets.mint({ kind: "worktree", worktreeId: "wt1", path: "page.html" })).code;
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ORIGIN = "http://127.0.0.1:5555";
const handler = () =>
  frameHandler({
    tickets,
    shells: () => ({ own: ["http://localhost:4141", "https://toyon.example.com"], learned: [] }),
  });
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  handler().fetch(new Request(`${ORIGIN}${path}`, { method, headers }), ORIGIN);

/** the headers every answer carries */
function hardened(r: Response, policy = "sandbox") {
  expect(r.headers.get("content-security-policy")?.startsWith(policy)).toBe(true);
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("permissions-policy")).toContain("camera=()");
  expect(r.headers.get("set-cookie")).toBeNull();
}

describe("the page", () => {
  test("answers a frame with the whole policy: sandboxed, scripts on, nothing readable back, framed by the shells alone", async () => {
    const r = await get(`/${code}/page.html`, { "sec-fetch-dest": "iframe" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    hardened(r, "sandbox allow-scripts");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors http://localhost:4141 https://toyon.example.com");
    expect(csp).toContain(`img-src data: blob: https: ${ORIGIN}`);
    expect(csp).toContain("frame-src 'none'");
    expect(await r.text()).toContain("<p>hi</p>");
  });
  test("a tab, a fetch, or a script asking for it gets nothing; a browser that says nothing is let through", async () => {
    expect((await get(`/${code}/page.html`, { "sec-fetch-dest": "document" })).status).toBe(404);
    expect((await get(`/${code}/page.html`, { "sec-fetch-dest": "empty" })).status).toBe(404);
    expect((await get(`/${code}/page.html`)).status).toBe(200);
  });
  test("a page held as text is answered the same", async () => {
    const t = await tickets.mint({ kind: "text", text: "<b>text</b>" });
    const r = await get(`/${t.code}/page.html`, { "sec-fetch-dest": "iframe" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<b>text</b>");
    hardened(r, "sandbox allow-scripts");
  });
});

describe("a file", () => {
  test("a picture and a stylesheet the page names, typed by name, the picture closed to other origins", async () => {
    const img = await get(`/${code}/img/a.png`, { "sec-fetch-dest": "image" });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/png");
    expect(img.headers.get("access-control-allow-origin")).toBeNull();
    hardened(img);
    const css = await get(`/${code}/s.css`, { "sec-fetch-dest": "style" });
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });
  test("a font the stylesheet names is open to any origin, since the opaque page fetches it with CORS", async () => {
    writeFileSync(join(root, "font.css"), '@font-face{src:url("f.woff2")}');
    writeFileSync(join(root, "font.html"), '<link href="font.css">');
    const c = (await tickets.mint({ kind: "worktree", worktreeId: "wt1", path: "font.html" })).code;
    const r = await get(`/${c}/f.woff2`, { "sec-fetch-dest": "font" });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    hardened(r);
  });
  test("a file the page never named, a file asked for as a document, and a bad escape are 404, still sandboxed", async () => {
    for (const r of [
      await get(`/${code}/unnamed.png`, { "sec-fetch-dest": "image" }),
      await get(`/${code}/img/a.png`, { "sec-fetch-dest": "document" }),
      await get(`/${code}/img/%zz.png`, { "sec-fetch-dest": "image" }),
      await get(`/${code}/`, { "sec-fetch-dest": "image" }),
    ]) {
      expect(r.status).toBe(404);
      hardened(r);
    }
  });
});

describe("the origin as a whole", () => {
  test("an unknown ticket, a code of the wrong shape, a bare path, and a POST", async () => {
    expect((await get(`/${"x".repeat(22)}/page.html`)).status).toBe(404);
    expect((await get(`/short/page.html`)).status).toBe(404);
    expect((await get("/")).status).toBe(404);
    expect((await get("/favicon.ico")).status).toBe(404);
    const post = await get(`/${code}/page.html`, {}, "POST");
    expect(post.status).toBe(405);
    hardened(post);
  });
  test("a cookie that arrives is neither read nor echoed", async () => {
    const r = await get(`/${code}/page.html`, { "sec-fetch-dest": "iframe", cookie: "toyon_preview=abc123" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.text()).not.toContain("abc123");
  });
  test("the policy names the shells, or none; an IPv6 literal is left out if listed, and leaves the directive off if a shell came from one", () => {
    const own = ["http://localhost:4141", "http://[::1]:4142"];
    expect(pagePolicy(ORIGIN, { own: [], learned: [] })).toContain("frame-ancestors 'none'");
    expect(pagePolicy(ORIGIN, { own: ["a"], learned: ["b"] })).toContain("frame-ancestors a b");
    expect(pagePolicy(ORIGIN, { own, learned: [] })).toMatch(/frame-ancestors http:\/\/localhost:4141$/);
    expect(pagePolicy(ORIGIN, { own, learned: ["http://[::1]:64502"] })).not.toContain("frame-ancestors");
  });
});

describe("the listener", () => {
  test("binds loopback on a port of its own, keeps the door, and sandboxes even a refusal", async () => {
    const l = new FrameListener({ handler: handler(), remote: () => null });
    await l.follow();
    const origin = l.origin();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    try {
      const page = await fetch(`${origin}/${code}/page.html`, { headers: { "sec-fetch-dest": "iframe" } });
      expect(page.status).toBe(200);
      hardened(page, "sandbox allow-scripts");
      // a name of someone's own pointed at this machine
      const rebound = await fetch(`${origin}/${code}/page.html`, { headers: { host: "evil.example" } });
      expect(rebound.status).toBe(403);
      hardened(rebound);
      const nothing = await fetch(`${origin}/nope`);
      expect(nothing.status).toBe(404);
      hardened(nothing);
      // asked to follow the same setting, it stays where it is
      await l.follow();
      expect(l.origin()).toBe(origin);
    } finally {
      l.stop();
    }
    expect(l.origin()).toBeNull();
  });
  test("where a shell frames at: the loopback listener locally, the frame authority through the front", () => {
    expect(frameOriginFor("local", null, "http://127.0.0.1:5555")).toBe("http://127.0.0.1:5555");
    expect(frameOriginFor("local", null, null)).toBeNull();
    expect(frameOriginFor("shell", null, "http://127.0.0.1:5555")).toBeNull();
    const byHost = { host: "toyon.example.com", previews: "https://w{id}.toyon.example.com", front: "local" as const };
    const byPort = { host: "app.fly.dev", previews: "https://app.fly.dev:{port}", front: "edge" as const };
    expect(frameOriginFor("shell", byHost, null)).toBe("https://frames.toyon.example.com");
    expect(frameOriginFor("shell", byPort, null)).toBe("https://app.fly.dev:10000");
  });
});
