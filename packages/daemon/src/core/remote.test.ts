import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Remote } from "@toyon/shared";
import { door, grantCookie, loadRemote, type PreviewGate, passPreview, setsGrant, takeGrant } from "./remote.ts";

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

/** a gate over one live code, `ok`; `spent` lists what was redeemed */
function gate(ok = "ok", spent: string[] = []): PreviewGate {
  return {
    grant: "g",
    host: "toyon.example.com",
    redeem: (code) => {
      spent.push(code);
      return code === ok && spent.filter((c) => c === ok).length === 1;
    },
  };
}

describe("a grant by address, for a page another machine served", () => {
  const at = (url: string, headers: Record<string, string> = {}) => passPreview(new Request(url, { headers }), gate());
  const refused = (r: ReturnType<typeof passPreview>) => (r.ok ? -1 : r.response.status);

  test("the code becomes a cookie and the address loses it, path and search kept", () => {
    const r = at("https://w3.toyon.example.com/app/x?toyon_grant=ok&q=1");
    expect(refused(r)).toBe(302);
    if (r.ok) return;
    expect(r.response.headers.get("location")).toBe("/app/x?q=1");
    expect(r.response.headers.get("cache-control")).toBe("no-store");
    expect(r.response.headers.get("set-cookie")).toContain("toyon_preview=g");
    expect(r.response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(r.response.headers.get("set-cookie")).not.toContain("Partitioned");
  });
  test("the cookie is partitioned only when the frame is cross-site", () => {
    const r = at("https://w3.toyon.example.com/?toyon_grant=ok", { "sec-fetch-site": "cross-site" });
    if (r.ok) throw new Error("expected a redirect");
    expect(r.response.headers.get("set-cookie")).toContain("SameSite=None; Partitioned");
    const same = at("https://w3.toyon.example.com/?toyon_grant=ok", { "sec-fetch-site": "same-site" });
    if (same.ok) throw new Error("expected a redirect");
    expect(same.response.headers.get("set-cookie")).toContain("SameSite=Strict");
  });
  test("a code is spent once; a wrong or spent one is the usual refusal", () => {
    const spent: string[] = [];
    const g = gate("ok", spent);
    expect(refused(passPreview(new Request("https://w3.toyon.example.com/?toyon_grant=ok"), g))).toBe(302);
    expect(refused(passPreview(new Request("https://w3.toyon.example.com/?toyon_grant=ok"), g))).toBe(403);
    expect(refused(passPreview(new Request("https://w3.toyon.example.com/?toyon_grant=no"), g))).toBe(403);
  });
  test("a browser that already holds the cookie is sent on without spending the code", () => {
    const spent: string[] = [];
    const r = passPreview(
      new Request("https://w3.toyon.example.com/?toyon_grant=ok", { headers: { cookie: "toyon_preview=g" } }),
      gate("ok", spent),
    );
    expect(refused(r)).toBe(302);
    if (r.ok) return;
    expect(r.response.headers.get("location")).toBe("/");
    expect(r.response.headers.get("set-cookie")).toBeNull();
    expect(spent).toEqual([]);
  });
  test("without the parameter nothing changes: the cookie passes and strips, its absence refuses", () => {
    const ok = at("https://w3.toyon.example.com/a", { cookie: "sid=1; toyon_preview=g" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.req.headers.get("cookie")).toBe("sid=1");
    expect(refused(at("https://w3.toyon.example.com/a"))).toBe(403);
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
    const pass = passPreview(new Request("http://x.example/"), gate());
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
  test("the managed policy: off ignores the file, tailscale admits a tailnet name and no other", () => {
    writeFileSync(file, '{ "host": "box.tail1234.ts.net", "previews": "https://box.tail1234.ts.net:{port}" }');
    expect(loadRemote(file, {}, { remote: "off" })).toBeNull();
    expect(loadRemote(file, {}, { remote: "tailscale" })?.host).toBe("box.tail1234.ts.net");
    writeFileSync(file, '{ "host": "toyon.example.com" }');
    expect(loadRemote(file, {}, { remote: "tailscale" })).toBeNull();
    expect(loadRemote(file, {}, { remote: "any" })?.host).toBe("toyon.example.com");
    // the edge is the deployed machine, not the laptop the policy manages
    expect(loadRemote(file, { TOYON_CLOUD: "1", TOYON_PUBLIC_HOST: "app.fly.dev" }, { remote: "off" })?.front).toBe(
      "edge",
    );
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
    const refused = (d: ReturnType<typeof door>) => (d.kind === "refused" ? d.response.status : d.kind);
    expect(refused(door(at("127.0.0.1:10001"), "100.64.0.7", byHost, "preview"))).toBe(403);
    expect(refused(door(at("toyon.example.com"), "100.64.0.7", byHost, "preview"))).toBe(403);
    expect(refused(door(at("other.example"), "100.64.0.7", byHost, "daemon"))).toBe(403);
    expect(refused(door(at("wab12.toyon.example.com"), "100.64.0.7", byHost, "daemon"))).toBe(403);
    expect(refused(door(at("toyon.example.com:8080"), "100.64.0.7", byHost, "daemon"))).toBe(403);
    expect(refused(door(at("toyon.example.com"), "100.64.0.7", null, "daemon"))).toBe(403);
  });
  test("the public name typed without https from off the box is sent to https, fragment and all", () => {
    const sent = (req: Request, headers = {}) => {
      const d = door(
        new Request(req, { headers: { host: new URL(req.url).host, ...headers } }),
        "100.64.0.7",
        byHost,
        "daemon",
      );
      if (d.kind !== "refused") throw new Error(`admitted as ${d.kind}`);
      return [d.response.status, d.response.headers.get("location"), d.response.headers.get("cache-control")];
    };
    expect(sent(at("toyon.example.com"))).toEqual([302, "https://toyon.example.com/", "no-store"]);
    expect(sent(at("toyon.example.com:80"))).toEqual([302, "https://toyon.example.com/", "no-store"]);
    expect(sent(new Request("http://toyon.example.com/some/page?x=1"))).toEqual([
      302,
      "https://toyon.example.com/some/page?x=1",
      "no-store",
    ]);
    // a peer off the box reached the plain-http listener whatever its headers claim
    expect(sent(at("toyon.example.com"), https)[0]).toBe(302);
    // a browser follows; anything else gets the plain refusal
    const post = door(
      new Request("http://toyon.example.com/", { method: "POST", headers: { host: "toyon.example.com" } }),
      "100.64.0.7",
      byHost,
      "daemon",
    );
    expect(post.kind === "refused" && post.response.status).toBe(403);
  });
});
