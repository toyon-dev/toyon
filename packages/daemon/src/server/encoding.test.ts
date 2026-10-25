import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedEncodings, encoded, GZIP_MIN_BYTES, pickSibling } from "./encoding.ts";

describe("acceptedEncodings", () => {
  test("nothing offered takes nothing", () => {
    expect(acceptedEncodings(null).size).toBe(0);
    expect(acceptedEncodings("").size).toBe(0);
    expect(acceptedEncodings("identity").size).toBe(0);
  });
  test("a browser's list takes both, whatever the case and spacing", () => {
    expect([...acceptedEncodings("gzip, deflate, br, zstd")].sort()).toEqual(["br", "gzip"]);
    expect([...acceptedEncodings("GZIP ,BR")].sort()).toEqual(["br", "gzip"]);
  });
  test("q=0 refuses one and a weight keeps it", () => {
    expect([...acceptedEncodings("br;q=0, gzip")]).toEqual(["gzip"]);
    expect([...acceptedEncodings("br;q=0.000, gzip;q=0.5")]).toEqual(["gzip"]);
    expect([...acceptedEncodings("br;q=0.8")]).toEqual(["br"]);
  });
});

describe("pickSibling", () => {
  const dir = mkdtempSync(join(tmpdir(), "toyon-enc-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const both = join(dir, "both.js");
  writeFileSync(both, "export default 1;");
  writeFileSync(`${both}.br`, "br-bytes");
  writeFileSync(`${both}.gz`, "gz-bytes");
  const gzOnly = join(dir, "gz.js");
  writeFileSync(gzOnly, "export default 2;");
  writeFileSync(`${gzOnly}.gz`, "gz-bytes");
  const emptyBr = join(dir, "empty.js");
  writeFileSync(emptyBr, "export default 3;");
  writeFileSync(`${emptyBr}.br`, "");
  writeFileSync(`${emptyBr}.gz`, "gz-bytes");
  const plain = join(dir, "plain.js");
  writeFileSync(plain, "export default 4;");
  const all = new Set<"br" | "gzip">(["br", "gzip"]);

  test("brotli first when both are there and taken", () => {
    expect(pickSibling(both, all)).toEqual({ path: `${both}.br`, encoding: "br" });
  });
  test("gzip when brotli is not taken, or was not built", () => {
    expect(pickSibling(both, new Set(["gzip"]))).toEqual({ path: `${both}.gz`, encoding: "gzip" });
    expect(pickSibling(gzOnly, all)).toEqual({ path: `${gzOnly}.gz`, encoding: "gzip" });
  });
  test("an empty sibling is passed over", () => {
    expect(pickSibling(emptyBr, all)).toEqual({ path: `${emptyBr}.gz`, encoding: "gzip" });
  });
  test("the file itself when nothing is taken or nothing was built", () => {
    expect(pickSibling(both, new Set())).toEqual({ path: both, encoding: null });
    expect(pickSibling(plain, all)).toEqual({ path: plain, encoding: null });
  });
});

describe("encoded", () => {
  const big = JSON.stringify({
    rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, title: "a worktree" })),
  });
  const req = (accept?: string) =>
    new Request("http://localhost/bootstrap", { headers: accept ? { "accept-encoding": accept } : {} });
  const headers = { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" };

  test("a body past a KB goes out gzipped when gzip is taken, and says so", async () => {
    const r = await encoded(req("gzip, deflate, br"), big, headers);
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("vary")).toBe("accept-encoding");
    expect(r.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body.byteLength).toBeLessThan(big.length / 4);
    expect(Buffer.from(Bun.gunzipSync(body)).toString()).toBe(big);
  });
  test("as it is when gzip is not taken", async () => {
    const r = await encoded(req(), big, headers);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("vary")).toBeNull();
    expect(await r.text()).toBe(big);
    expect((await (await encoded(req("br"), big, headers)).text()).length).toBe(big.length);
  });
  test("a small body is never worth it", async () => {
    const small = "x".repeat(GZIP_MIN_BYTES - 1);
    const r = await encoded(req("gzip"), small, headers);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(await r.text()).toBe(small);
  });
});
