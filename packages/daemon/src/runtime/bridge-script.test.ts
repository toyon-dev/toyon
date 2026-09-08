import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeScript } from "./bridge-script.ts";

const dir = mkdtempSync(join(tmpdir(), "toyon-bridge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bundle = join(dir, "bridge.js");
writeFileSync(bundle, "/* bridge */");

/** the origins line the script carries to a preview */
function origins(b: BridgeScript): string[] {
  const line = b.get().split("\n")[0] ?? "";
  return JSON.parse(line.replace("window.__toyonShellOrigins=", "").replace(/;$/, ""));
}

describe("bridge script origins", () => {
  test("an origin a shell authenticated from is added to the ones the daemon serves", () => {
    const b = new BridgeScript(bundle);
    b.setShellOrigins(["http://127.0.0.1:4141"]);
    b.learnShellOrigin("http://w1.toyon.localhost:53313");
    expect(origins(b)).toEqual(["http://127.0.0.1:4141", "http://w1.toyon.localhost:53313"]);
  });

  test("a duplicate of a known origin is not added twice", () => {
    const b = new BridgeScript(bundle);
    b.setShellOrigins(["http://127.0.0.1:4141"]);
    b.learnShellOrigin("http://127.0.0.1:4141");
    b.learnShellOrigin("http://localhost:5173");
    b.learnShellOrigin("http://localhost:5173");
    expect(origins(b)).toEqual(["http://127.0.0.1:4141", "http://localhost:5173"]);
  });

  test("a non-loopback or unparseable origin is refused: the daemon answers loopback only", () => {
    const b = new BridgeScript(bundle);
    b.setShellOrigins([]);
    for (const o of ["http://evil.example", "https://toyon.localhost.evil.com", "null", "", "not a url"]) {
      b.learnShellOrigin(o);
    }
    expect(origins(b)).toEqual([]);
  });

  test("the learned set is bounded, oldest first", () => {
    const b = new BridgeScript(bundle);
    b.setShellOrigins([]);
    for (let i = 0; i < 10; i++) b.learnShellOrigin(`http://127.0.0.1:${5000 + i}`);
    const got = origins(b);
    expect(got.length).toBe(8);
    expect(got[0]).toBe("http://127.0.0.1:5002");
    expect(got.at(-1)).toBe("http://127.0.0.1:5009");
  });
});
