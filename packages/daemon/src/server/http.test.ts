import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
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
const fetch = createFetch({
  token: "secret",
  shellDist: "/nonexistent",
  version: "0",
  repos,
  branded: () => false,
  metrics: () => ({ lag: 0 }),
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
