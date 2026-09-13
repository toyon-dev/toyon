import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePackageJson, writeMachineContext } from "./context.ts";

const base = mkdtempSync(join(tmpdir(), "toyon-context-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("machine context", () => {
  test("holds the bundle, the Dockerfile and entrypoint, and a package.json that installs only bun-pty", () => {
    const dist = join(base, "src", "dist");
    const cloud = join(base, "src", "cloud");
    mkdirSync(join(dist, "shell"), { recursive: true });
    mkdirSync(cloud);
    writeFileSync(join(dist, "daemon.js"), "");
    writeFileSync(join(dist, "shell", "index.html"), "");
    writeFileSync(join(cloud, "Dockerfile"), "FROM x");
    writeFileSync(join(cloud, "entrypoint.sh"), "#!/bin/sh");
    const out = join(base, "out");
    writeMachineContext({ dist, cloud }, out);
    for (const f of ["dist/daemon.js", "dist/shell/index.html", "Dockerfile", "entrypoint.sh", "package.json"]) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    expect(Object.keys(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).dependencies)).toEqual(["bun-pty"]);
  });

  test("the manifest pins bun-pty to the version the CLI package depends on", () => {
    const cli = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    expect(JSON.parse(machinePackageJson()).dependencies["bun-pty"]).toBe(cli.dependencies["bun-pty"]);
  });
});
