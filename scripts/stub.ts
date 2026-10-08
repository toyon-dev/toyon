#!/usr/bin/env bun
// The helper bundle's executable (packages/daemon/src/core/launcher.m), built once here rather than
// on every Mac the daemon runs on: a universal Mach-O into packages/daemon/dist, which `bun run
// build` and the pack both run. The daemon copies it into the bundle it writes (core/helper.ts).
// Off a Mac there is nothing to build; a Mac without clang builds nothing and the daemon says so.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const src = join(root, "packages", "daemon", "src", "core", "launcher.m");
const out = join(root, "packages", "daemon", "dist", "helper-stub");

if (process.platform !== "darwin") {
  console.log("helper stub: not a Mac, nothing to build");
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
let exitCode: number;
try {
  const p = Bun.spawnSync(
    ["clang", "-arch", "arm64", "-arch", "x86_64", "-O2", "-fobjc-arc", "-framework", "Cocoa", "-o", out, src],
    { stdout: "inherit", stderr: "inherit" },
  );
  exitCode = p.exitCode;
} catch {
  console.warn("helper stub: no clang on this Mac, so none is built; `xcode-select --install` provides it");
  process.exit(0);
}
if (exitCode !== 0) {
  console.error("helper stub: clang failed");
  process.exit(1);
}
console.log(`helper stub: ${out}`);
