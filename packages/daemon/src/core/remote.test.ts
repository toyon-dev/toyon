import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Remote } from "@toyon/shared";
import { door, grantCookie, loadRemote, passPreview, setsGrant, takeGrant } from "./remote.ts";

// The grant rides in the browser's Cookie header next to the app's own cookies. It is checked, then
// taken off, so the dev server behind a preview sees exactly what the app set and nothing of toyon's.

describe("takeGrant", () => {
  const grant = "ab".repeat(32);

  test("finds the grant among the app's cookies and leaves theirs in order", () => {
    expect(takeGrant(`a=1; toyon_preview=${grant}; b=2`, grant)).toEqual({ ok: true, rest: "a=1; b=2" });
  });
  test("a header holding only the grant leaves nothing to forward", () => {
    expect(takeGrant(`toyon_preview=${grant}`, grant)).toEqual({ ok: true, rest: null });
  });
  test("a wrong or truncated grant fails and is still taken off", () => {
    expect(takeGrant(`toyon_preview=nope; a=1`, grant)).toEqual({ ok: false, rest: "a=1" });
    expect(takeGrant(`toyon_preview=${grant.slice(1)}`, grant)).toEqual({ ok: false, rest: null });
  });
  test("an app cookie whose name only starts the same is the app's", () => {
    expect(takeGrant(`toyon_preview_x=${grant}`, grant)).toEqual({ ok: false, rest: `toyon_preview_x=${grant}` });
  });
  test("no header, or an empty one", () => {
    expect(takeGrant(null, grant)).toEqual({ ok: false, rest: null });
    expect(takeGrant(" ; ", grant)).toEqual({ ok: false, rest: null });
  });
  test("a duplicate set by the app beside the real one does not lock the browser out", () => {
    expect(takeGrant(`toyon_preview=x; toyon_preview=${grant}`, grant)).toEqual({ ok: true, rest: null });
  });
});

describe("the grant on the wire", () => {
  test("the cookie reaches every name and port under the public name, and never rides a cross-site link", () => {
    const cookie = grantCookie("g", "toyon.example.com");
    for (const attr of ["Domain=toyon.example.com", "HttpOnly", "Secure", "SameSite=Strict"])
      expect(cookie).toContain(attr);
  });
  test("an app setting a cookie by the grant's name is caught; one that only starts the same is not", () => {
    expect(setsGrant("toyon_preview=x; Path=/")).toBe(true);
    expect(setsGrant(" toyon_preview =x")).toBe(true);
    expect(setsGrant("toyon_preview_x=1")).toBe(false);
    expect(setsGrant("sid=toyon_preview")).toBe(false);
  });
  test("a refusal is a page that reloads itself and is never kept", async () => {
    const pass = passPreview(new Request("http://x.example/"), "g");
    expect(pass.ok).toBe(false);
    if (pass.ok) return;
    expect(pass.response.status).toBe(403);
    expect(pass.response.headers.get("cache-control")).toBe("no-store");
    expect(await pass.response.text()).toContain('http-equiv="refresh"');
  });
});

describe("loadRemote", () => {
  const dir = mkdtempSync(join(tmpdir(), "toyon-remote-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "remote.json");

  test("an edge comes from the environment, with previews on ports unless it says host", () => {
    expect(loadRemote(file, { TOYON_CLOUD: "1", TOYON_PUBLIC_HOST: "App.fly.dev" })).toEqual({
      host: "app.fly.dev",
      previews: "https://app.fly.dev:{port}",
      front: "edge",
    });
    const named = loadRemote(file, {
      TOYON_CLOUD: "1",
      TOYON_PUBLIC_HOST: "toyon.example.com",
      TOYON_PREVIEWS: "https://w{id}.toyon.example.com",
    });
    expect(named?.previews).toBe("https://w{id}.toyon.example.com");
  });
  test("an edge with no usable name refuses to start rather than answer every Host", () => {
    expect(() => loadRemote(file, { TOYON_CLOUD: "1" })).toThrow("TOYON_PUBLIC_HOST");
    expect(() =>
      loadRemote(file, { TOYON_CLOUD: "1", TOYON_PUBLIC_HOST: "app.fly.dev", TOYON_PREVIEWS: "path" }),
    ).toThrow("TOYON_PREVIEWS");
  });
  test("a local front comes from remote.json, and no file is no public name", () => {
    expect(loadRemote(file, {})).toBeNull();
    writeFileSync(file, '{ "host": "box.tail1234.ts.net", "previews": "https://box.tail1234.ts.net:{port}" }');
    expect(loadRemote(file, {})).toEqual({
      host: "box.tail1234.ts.net",
      previews: "https://box.tail1234.ts.net:{port}",
      front: "local",
    });
  });
});

describe("door", () => {
  const at = (host: string, headers: Record<string, string> = {}) =>
    new Request(`http://${host}/`, { headers: { host, ...headers } });
  const https = { "x-forwarded-proto": "https" };
  const byHost: Remote = { host: "toyon.example.com", previews: "https://w{id}.toyon.example.com", front: "local" };
  const edge: Remote = { host: "app.fly.dev", previews: "https://app.fly.dev:{port}", front: "edge" };

  test("a preview port with no public name answers as it always has", () => {
    expect(door(at("anything.example"), "10.0.0.5", null, "preview").kind).toBe("local");
  });
  test("a worktree's name is routed on the daemon's listener, never on a preview port", () => {
    expect(door(at("wab12.toyon.example.com", https), "127.0.0.1", byHost, "daemon")).toEqual({
      kind: "preview",
      worktreeId: "ab12",
    });
    expect(door(at("wab12.toyon.example.com", https), "127.0.0.1", byHost, "preview").kind).toBe("refused");
  });
  test("the public name on a preview port is that preview, over https only", () => {
    expect(door(at("app.fly.dev:10001", https), "172.19.0.2", edge, "preview")).toEqual({
      kind: "preview",
      worktreeId: null,
    });
    expect(door(at("app.fly.dev:10001"), "172.19.0.2", edge, "preview").kind).toBe("refused");
  });
  test("a front that moves the port out of Host into x-forwarded-port (Fly) is read as the name at that port", () => {
    const fly = (port: string) => ({ ...https, "x-forwarded-port": port });
    expect(door(at("app.fly.dev", fly("10001")), "172.19.0.2", edge, "preview")).toEqual({
      kind: "preview",
      worktreeId: null,
    });
    expect(door(at("app.fly.dev", fly("443")), "172.19.0.2", edge, "daemon").kind).toBe("shell");
    expect(door(at("app.fly.dev", fly("10001")), "172.19.0.2", edge, "daemon").kind).toBe("refused");
    expect(door(at("app.fly.dev", fly("not-a-port")), "172.19.0.2", edge, "preview").kind).toBe("refused");
  });
  test("a port route never reaches the daemon's listener, and the bare name never a preview port", () => {
    expect(door(at("app.fly.dev:10001", https), "172.19.0.2", edge, "daemon").kind).toBe("refused");
    expect(door(at("app.fly.dev", https), "172.19.0.2", edge, "preview").kind).toBe("refused");
    expect(door(at("app.fly.dev", https), "172.19.0.2", edge, "daemon").kind).toBe("shell");
  });
  test("behind an edge a loopback name is refused, since nothing reaching it there is loopback", () => {
    expect(door(at("localhost:10001", https), "172.19.0.2", edge, "preview").kind).toBe("refused");
    expect(door(at("127.0.0.1:4141"), "127.0.0.1", edge, "daemon").kind).toBe("refused");
  });
  test("a local front keeps the peer check on every listener", () => {
    expect(door(at("toyon.example.com", https), "100.64.0.7", byHost, "daemon").kind).toBe("refused");
    expect(door(at("127.0.0.1:10001"), "100.64.0.7", byHost, "preview").kind).toBe("refused");
  });
});
