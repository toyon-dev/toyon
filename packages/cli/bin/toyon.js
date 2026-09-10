#!/usr/bin/env node
// The npm entry. Everything toyon does runs under bun; this finds one and hands over. The `bun`
// package in our dependencies carries the platform binary, so `npx toyon` works on a machine
// with only Node; a bun already on PATH is the fallback when that optional download failed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function bundledBun() {
  try {
    // the package's postinstall leaves the real binary at bin/bun.exe on every platform
    const exe = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

function pathBun() {
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["bun"], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.split("\n")[0].trim() : "";
  return found || null;
}

const bun = bundledBun() ?? pathBun();
if (!bun) {
  console.error(
    "toyon: bun is not installed and npm could not fetch it for this platform.\n" +
      "install it from https://bun.sh and run toyon again.",
  );
  process.exit(1);
}

const r = spawnSync(bun, [join(here, "..", "dist", "cli.js"), ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) {
  console.error(`toyon: could not start bun at ${bun}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
