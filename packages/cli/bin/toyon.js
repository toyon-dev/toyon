#!/usr/bin/env node
// The npm entry. Everything toyon does runs under bun; this finds one and hands over. The `bun`
// package in our dependencies carries the platform binary, so `npx toyon` works on a machine with
// only Node. Three places are tried in turn: where bun's postinstall puts the binary, where the
// platform package keeps it when that postinstall never ran, and finally a bun already on PATH.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// A real bun is a native executable. When npm or pnpm skips bun's postinstall the package still
// leaves a bin/bun.exe behind: a shell script that prints an error and exits 1. Existence alone
// therefore proves nothing, and trusting it would hand the stub to spawnSync and swallow the
// fallbacks below. The magic bytes tell the two apart for the price of one read.
// ELF, then Mach-O in both widths and both byte orders, then a Mach-O universal binary.
const NATIVE_MAGIC = new Set([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isNativeExecutable(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return NATIVE_MAGIC.has(head.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function bundledBun() {
  try {
    // the package's postinstall leaves the real binary at bin/bun.exe on every platform
    const exe = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
    return isNativeExecutable(exe) ? exe : null;
  } catch {
    return null;
  }
}

// Where the platform package keeps the binary before bun's postinstall moves it into place. A
// skipped postinstall is the only reason bundledBun misses, so the binary is still right here.
function platformBun() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  const names = [`@oven/bun-${process.platform}-${arch}`];
  if (process.platform === "linux") names.push(`@oven/bun-linux-${arch}-musl`);
  for (const name of names) {
    try {
      const exe = join(dirname(require.resolve(`${name}/package.json`)), "bin", "bun");
      if (isNativeExecutable(exe)) return exe;
    } catch {
      // not installed for this platform; try the next candidate
    }
  }
  return null;
}

function pathBun() {
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["bun"], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.split("\n")[0].trim() : "";
  return found || null;
}

const bun = bundledBun() ?? platformBun() ?? pathBun();
if (!bun) {
  console.error(
    "toyon: could not find a usable bun.\n" +
      "the bundled copy is missing or incomplete, and there is no bun on PATH.\n" +
      "install bun from https://bun.sh, or reinstall toyon with install scripts enabled.",
  );
  process.exit(1);
}

const r = spawnSync(bun, [join(here, "..", "dist", "cli.js"), ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) {
  console.error(`toyon: could not start bun at ${bun}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
