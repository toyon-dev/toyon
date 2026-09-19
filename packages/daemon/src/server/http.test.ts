import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import { PairCodes } from "../core/pair.ts";
import { previewGrant } from "../core/remote.ts";
import type { RepoRegistry } from "../repos/registry.ts";
import type { PreviewHandler } from "../runtime/proxy.ts";
import { createFetch, type HttpOpts, type WsData } from "./http.ts";

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
/** what the daemon answers a restart with: a refusal, or null having taken it */
let restartRefusal: string | null = null;
let restartsAsked = 0;
/** whether the last restart asked was one that does not wait */
let restartNow = false;
let restartWaiting: string[] | null = null;
const opts: HttpOpts = {
  token: "secret",
  shellDist: "/nonexistent",
  version: "0",
  repos,
  attachments: new AttachmentStore(attachmentsDir),
  archivedAttachment: () => null,
  worktreeFile: async (id, path) =>
    id === "wt1" && path === "public/a b.png" ? join(attachmentsDir, "wt1", "1.png") : null,
  branded: () => false,
  metrics: () => ({ lag: 0 }),
  noteShellOrigin: (o) => learnedOrigins.push(o),
  remote: null,
  preview: () => null,
  bootstrap: async () => ({ t: "hello", repos: [{ id: "r1" }] }),
  restart: (now) => {
    restartsAsked++;
    restartNow = now;
    return restartRefusal;
  },
  restartWait: () => ({ waiting: restartWaiting, asking: ["pick a colour"] }),
  pair: new PairCodes(),
  onPaired: () => {},
};
const fetch = createFetch(opts);
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://${init.host ?? "localhost"}${path}`, {
    ...init,
    headers: { host: init.host ?? "localhost", ...(init.headers as Record<string, string>) },
  });

describe("bootstrap", () => {
  test("the hello frame, for the token, never cached", async () => {
    const r = await fetch(req("/bootstrap?token=secret"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toContain("no-store");
    expect(await r?.json()).toEqual({ t: "hello", repos: [{ id: "r1" }] });
  });
  test("refused without the token", async () => {
    expect((await fetch(req("/bootstrap"), srv()))?.status).toBe(401);
    expect((await fetch(req("/bootstrap?token=wrong"), srv()))?.status).toBe(401);
  });
});

describe("pair", () => {
  const name = "toyon.example.com";
  let paired = 0;
  const remote = createFetch({
    ...opts,
    remote: { host: name, previews: `https://w{id}.${name}`, front: "local" },
    pair: new PairCodes(),
    onPaired: () => paired++,
  });
  const https = { "x-forwarded-proto": "https" };
  const mint = (auth = "Bearer secret") =>
    remote(req("/pair", { method: "POST", headers: { authorization: auth } }), srv());
  const redeem = (code: string, headers: Record<string, string> = https, host = name) =>
    remote(req("/pair/redeem", { method: "POST", host, headers, body: JSON.stringify({ code }) }), srv());

  test("a code needs the token, and a public name for its link", async () => {
    expect((await mint("Bearer wrong"))?.status).toBe(401);
    const local = await fetch(req("/pair", { method: "POST", headers: { authorization: "Bearer secret" } }), srv());
    expect(local?.status).toBe(400);
    expect(await local?.text()).toContain("toyon remote");
  });

  test("the phone trades the code for the token and the preview grant, once", async () => {
    const r = await mint();
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toContain("no-store");
    const { code, url, ms } = (await r!.json()) as { code: string; url: string; ms: number };
    expect(url).toBe(`https://${name}/#pair=${code}`);
    expect(ms).toBeGreaterThan(0);

    const before = paired;
    const ok = await redeem(code);
    expect(ok?.status).toBe(200);
    expect(await ok?.json()).toEqual({ token: "secret" });
    expect(ok?.headers.get("set-cookie")).toContain(`toyon_preview=${previewGrant("secret")}`);
    expect(paired).toBe(before + 1);

    const again = await redeem(code);
    expect(again?.status).toBe(401);
    expect(await again?.text()).toBe("code expired");
    expect(paired).toBe(before + 1);
  });

  test("a redeem off the https front is refused before the code is spent", async () => {
    const { code } = (await (await mint())!.json()) as { code: string };
    expect((await redeem(code, {}))?.status).toBe(403);
    expect((await redeem(code, https, "localhost"))?.status).toBe(404);
    expect((await redeem(code))?.status).toBe(200);
  });

  test("a body without a code is expired, not an error", async () => {
    const r = await remote(req("/pair/redeem", { method: "POST", host: name, headers: https, body: "nope" }), srv());
    expect(r?.status).toBe(401);
  });
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

describe("guards, remote mode", () => {
  const app: PreviewHandler = {
    fetch: async (r) => new Response(`app ${new URL(r.url).pathname} cookie=${r.headers.get("cookie")}`),
    open: () => {},
    message: () => {},
    close: () => {},
  };
  const remote = createFetch({
    ...opts,
    remote: { host: "toyon.example.com", previews: "https://w{id}.toyon.example.com", front: "local" },
    preview: (id) => (id === "a1b2c3" ? app : null),
  });
  const https = { "x-forwarded-proto": "https" };
  const granted = { ...https, cookie: `theme=dark; toyon_preview=${previewGrant("secret")}; sid=1` };

  test("the remote name passes when the front on this machine says the hop was https", async () => {
    const r = await remote(req("/health", { host: "toyon.example.com", headers: https }), srv());
    expect(r?.status).toBe(200);
    expect(await r?.json()).toMatchObject({
      remote: { host: "toyon.example.com", previews: "https://w{id}.toyon.example.com" },
    });
  });
  test("the remote name over plain http is refused, saying why", async () => {
    const r = await remote(req("/health", { host: "toyon.example.com" }), srv());
    expect(r?.status).toBe(403);
    expect(await r?.text()).toContain("https");
  });
  test("a peer off this machine is still refused: the front is local", async () => {
    const r = await remote(req("/health", { host: "toyon.example.com", headers: https }), srv("100.64.0.7"));
    expect(r?.status).toBe(403);
  });
  test("any other name is refused, including labels under the remote name that are not a preview", async () => {
    for (const host of [
      "evil.example",
      "toyon.example.com.evil.example",
      "x1.toyon.example.com",
      "w-1.toyon.example.com",
      "wa1.wb2.toyon.example.com",
      "w1toyon.example.com",
    ]) {
      expect((await remote(req("/health", { host, headers: https }), srv()))?.status).toBe(403);
    }
  });
  test("w<id>.<name> is that worktree's app, whole, and the app never sees the grant", async () => {
    const r = await remote(req("/health", { host: "wa1b2c3.toyon.example.com", headers: granted }), srv());
    expect(r?.status).toBe(200);
    expect(await r?.text()).toBe("app /health cookie=theme=dark; sid=1");
  });
  test("a request carrying only the grant reaches the app with no cookie header at all", async () => {
    const only = { ...https, cookie: `toyon_preview=${previewGrant("secret")}` };
    const r = await remote(req("/", { host: "wa1b2c3.toyon.example.com", headers: only }), srv());
    expect(await r?.text()).toBe("app / cookie=null");
  });
  test("a preview name for a worktree with no proxy up is 404, once granted", async () => {
    const r = await remote(req("/", { host: "wffff.toyon.example.com", headers: granted }), srv());
    expect(r?.status).toBe(404);
  });
  test("without the grant, or with a wrong one, a preview is refused before saying whether it exists", async () => {
    for (const host of ["wa1b2c3.toyon.example.com", "wffff.toyon.example.com"]) {
      expect((await remote(req("/", { host, headers: https }), srv()))?.status).toBe(403);
      const wrong = { ...https, cookie: `toyon_preview=${previewGrant("other")}` };
      expect((await remote(req("/", { host, headers: wrong }), srv()))?.status).toBe(403);
    }
  });
  test("/bootstrap on the remote name hands out the grant for every preview under it", async () => {
    const r = await remote(req("/bootstrap?token=secret", { host: "toyon.example.com", headers: https }), srv());
    const cookie = r?.headers.get("set-cookie") ?? "";
    expect(cookie).toStartWith(`toyon_preview=${previewGrant("secret")};`);
    for (const attr of ["Domain=toyon.example.com", "HttpOnly", "Secure", "SameSite=Strict"])
      expect(cookie).toContain(attr);
  });
  test("the grant is not handed out for a wrong token, nor to a local shell", async () => {
    const bad = await remote(req("/bootstrap?token=wrong", { host: "toyon.example.com", headers: https }), srv());
    expect(bad?.headers.get("set-cookie")).toBeNull();
    const local = await remote(req("/bootstrap?token=secret", { host: "toyon.localhost" }), srv());
    expect(local?.headers.get("set-cookie")).toBeNull();
  });
  test("the grant is not the token", () => {
    expect(previewGrant("secret")).not.toContain("secret");
    expect(previewGrant("secret")).toMatch(/^[0-9a-f]{64}$/);
  });
  test("a preview name over plain http, or from off this machine, is refused", async () => {
    expect((await remote(req("/", { host: "wa1b2c3.toyon.example.com" }), srv()))?.status).toBe(403);
    const far = await remote(req("/", { host: "wa1b2c3.toyon.example.com", headers: https }), srv("10.0.0.5"));
    expect(far?.status).toBe(403);
  });
  test("with remote off, the name is refused like any other", async () => {
    const r = await fetch(req("/health", { host: "toyon.example.com", headers: https }), srv());
    expect(r?.status).toBe(403);
  });
  test("a refused preview is a page that reloads itself, so a frame that raced the cookie recovers", async () => {
    const r = await remote(req("/", { host: "wa1b2c3.toyon.example.com", headers: https }), srv());
    expect(r?.headers.get("cache-control")).toBe("no-store");
    expect(await r?.text()).toContain('http-equiv="refresh"');
  });
});

describe("guards, a local front with previews on ports", () => {
  const ports = createFetch({
    ...opts,
    remote: { host: "box.tail1234.ts.net", previews: "https://box.tail1234.ts.net:{port}", front: "local" },
  });
  const https = { "x-forwarded-proto": "https" };

  test("the name is the shell, and hands out the grant", async () => {
    const r = await ports(req("/bootstrap?token=secret", { host: "box.tail1234.ts.net", headers: https }), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("set-cookie")).toContain("Domain=box.tail1234.ts.net");
  });
  test("no preview is routed by name: previews answer on their own ports", async () => {
    const r = await ports(req("/", { host: "wa1b2c3.box.tail1234.ts.net", headers: https }), srv());
    expect(r?.status).toBe(403);
  });
});

describe("guards, an edge front", () => {
  const edge = createFetch({
    ...opts,
    remote: { host: "app.fly.dev", previews: "https://app.fly.dev:{port}", front: "edge" },
  });
  const https = { "x-forwarded-proto": "https" };
  const flyPeer = "172.19.0.2";

  test("the public name over https passes from a peer that is not loopback, since the edge never is", async () => {
    const r = await edge(req("/bootstrap?token=secret", { host: "app.fly.dev", headers: https }), srv(flyPeer));
    expect(r?.status).toBe(200);
    expect(r?.headers.get("set-cookie")).toContain("Domain=app.fly.dev");
  });
  test("a foreign name, a loopback name, or the name over plain http is refused", async () => {
    const tries: [string, Record<string, string>][] = [
      ["evil.example", https],
      ["localhost", https],
      ["toyon.localhost", https],
      ["app.fly.dev", {}],
    ];
    for (const [host, headers] of tries) {
      expect((await edge(req("/bootstrap?token=secret", { host, headers }), srv(flyPeer)))?.status).toBe(403);
    }
  });
  test("/health answers the platform's own check, which names the machine and not the public name", async () => {
    const r = await edge(req("/health", { host: "172.19.0.3:4141" }), srv(flyPeer));
    expect(r?.status).toBe(200);
  });
  test("the token still guards the socket behind the edge", async () => {
    let data: WsData | undefined;
    const s = srv(flyPeer, ((_r: Request, o: { data: WsData }) => {
      data = o.data;
      return true;
    }) as never);
    await edge(req("/ws?token=nope", { host: "app.fly.dev", headers: https }), s);
    expect(data?.authed).toBe(false);
  });
});

describe("/ws", () => {
  test("wrong token upgrades unauthenticated, for open() to close with a code the shell can read", async () => {
    let data: WsData | undefined;
    const s = srv("127.0.0.1", ((_r: Request, o: { data: WsData }) => {
      data = o.data;
      return true;
    }) as never);
    expect(await fetch(req("/ws?token=nope"), s)).toBeUndefined();
    expect(data?.authed).toBe(false);
  });
  test("wrong token on a request that is not a websocket is 401", async () => {
    expect(
      (
        await fetch(
          req("/ws?token=nope"),
          srv("127.0.0.1", () => false),
        )
      )?.status,
    ).toBe(401);
  });
  test("the framing origin is learned from an authenticated handshake, never a refused one", async () => {
    learnedOrigins.length = 0;
    const s = srv("127.0.0.1", (() => true) as never);
    await fetch(req("/ws?token=nope", { headers: { origin: "http://evil.example" } }), s);
    expect(learnedOrigins).toEqual([]);
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
  const img = {
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png" as const,
    data: png,
    width: 2,
    height: 2,
  };
  test("serves a stored image with the token, immutable", async () => {
    await new AttachmentStore(attachmentsDir).put("wt1", 1, img);
    const r = await fetch(req("/attachments/wt1/1.png?token=secret"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await r!.arrayBuffer()).toString("base64")).toBe(png);
  });
  test("an image the archive holds is served once the store no longer has it", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "toyon-archive-"));
    mkdirSync(join(archiveDir, "wt2"));
    writeFileSync(join(archiveDir, "wt2", "1.png"), Buffer.from(png, "base64"));
    const serve = createFetch({ ...opts, archivedAttachment: (id, file) => join(archiveDir, id, file) });
    const r = await serve(req("/attachments/wt2/1.png?token=secret"), srv());
    expect(r?.status).toBe(200);
    expect(Buffer.from(await r!.arrayBuffer()).toString("base64")).toBe(png);
    rmSync(archiveDir, { recursive: true, force: true });
  });
  test("no token is 401; a missing or malformed path is 404", async () => {
    expect((await fetch(req("/attachments/wt1/1.png"), srv()))?.status).toBe(401);
    expect((await fetch(req("/attachments/wt1/9.png?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/attachments/..%2F..%2Fetc/passwd?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/attachments/wt1/1.png/x?token=secret"), srv()))?.status).toBe(404);
  });
});

describe("/files", () => {
  test("serves a worktree's file by its decoded path, never cached", async () => {
    await new AttachmentStore(attachmentsDir).put("wt1", 1, {
      kind: "image",
      name: "a.png",
      mimeType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      width: 2,
      height: 2,
    });
    const r = await fetch(req("/files/wt1/public/a%20b.png?token=secret"), srv());
    expect(r?.status).toBe(200);
    expect(r?.headers.get("cache-control")).toBe("no-store");
    expect(r?.headers.get("x-content-type-options")).toBe("nosniff");
  });
  test("no token is 401; anything the service does not name is 404", async () => {
    expect((await fetch(req("/files/wt1/public/a%20b.png"), srv()))?.status).toBe(401);
    expect((await fetch(req("/files/wt1/other.png?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/files/wt1/%E0%A4%A.png?token=secret"), srv()))?.status).toBe(404);
    expect((await fetch(req("/files/wt1?token=secret"), srv()))?.status).toBe(404);
  });
});

describe("/restart", () => {
  // the page asking is one whose socket stopped at a protocol mismatch, so this is plain HTTP
  const post = (path: string) => fetch(req(path, { method: "POST" }), srv());

  test("no token is 401, and nothing is asked of the daemon", async () => {
    const before = restartsAsked;
    expect((await post("/restart"))?.status).toBe(401);
    expect((await post("/restart?token=wrong"))?.status).toBe(401);
    expect(restartsAsked).toBe(before);
  });

  test("a taken request is 202, and a refusal is 409 with the reason to read", async () => {
    restartRefusal = null;
    expect((await post("/restart?token=secret"))?.status).toBe(202);
    restartRefusal = "restart it from its terminal tab";
    const refused = await post("/restart?token=secret");
    expect(refused?.status).toBe(409);
    expect(await refused?.text()).toBe("restart it from its terminal tab");
    restartRefusal = null;
  });

  test("a GET is not a restart: it answers what one is waiting on", async () => {
    const before = restartsAsked;
    restartWaiting = ["fix login", "docs"];
    const r = await fetch(req("/restart?token=secret"), srv());
    expect(restartsAsked).toBe(before);
    expect(await r?.json()).toEqual({ waiting: ["fix login", "docs"], asking: ["pick a colour"] });
    expect(r?.headers.get("cache-control")).toBe("no-store");
    restartWaiting = null;
    expect(await (await fetch(req("/restart?token=secret"), srv()))?.json()).toEqual({
      waiting: null,
      asking: ["pick a colour"],
    });
  });

  test("chat titles are not for a caller without the token", async () => {
    restartWaiting = ["fix login"];
    expect((await fetch(req("/restart"), srv()))?.status).toBe(401);
    expect(await (await fetch(req("/health"), srv()))?.text()).not.toContain("fix login");
    restartWaiting = null;
  });

  test("`now` is passed on, and only when the page said it", async () => {
    await post("/restart?token=secret");
    expect(restartNow).toBe(false);
    await post("/restart?token=secret&now");
    expect(restartNow).toBe(true);
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
    archivedAttachment: () => null,
    worktreeFile: async () => null,
    branded: () => false,
    noteShellOrigin: () => {},
    remote: null,
    preview: () => null,
    metrics: () => ({ lag: 0 }),
    bootstrap: async () => ({}),
    restart: () => null,
    restartWait: () => ({ waiting: null, asking: [] }),
    pair: new PairCodes(),
    onPaired: () => {},
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
