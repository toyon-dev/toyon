#!/usr/bin/env node
// The npm entry. Everything toyon does runs under bun; this finds one and hands over. The `bun`
// package in our dependencies carries the platform binary, so `npx toyon` works on a machine with
// only Node. Three places are tried in turn: where bun's postinstall puts the binary, where the
// platform package keeps it when that postinstall never ran, and finally a bun already on PATH.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The bun this package was built against: the daemon and bun-pty are tested on it, and an older one
// on PATH fails somewhere opaque rather than here.
const FLOOR = require("../package.json").dependencies.bun;

function parse(v) {
  const bare = v.trim().replace(/^[\^~]/, "");
  return bare.split(".").map(Number);
}
function atLeast(version, floor) {
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

// Whether a candidate is a bun we can use is asked of the candidate itself. When npm or pnpm skips
// bun's postinstall the package still leaves a bin/bun.exe behind: a shell script that prints an
// error and exits 1. And `npx` puts node_modules/.bin first on PATH, where that same stub sits
// under the name `bun`. Existence proves nothing and so does the file's shape (an asdf or mise
// shim is a script and a real bun); a run does, for the price of one spawn per candidate.
function usable(file) {
  const r = spawnSync(file, ["--version"], { encoding: "utf8" });
  return r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()) && atLeast(r.stdout, FLOOR);
}

function bundledBun() {
  try {
    // the package's postinstall leaves the real binary at bin/bun.exe on every platform
    return join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");
  } catch {
    return null;
  }
}

// Where the platform packages keep the binary before bun's postinstall moves it into place. A
// skipped postinstall is the only reason bundledBun misses, so the binary is still right here.
// On Alpine both the glibc and the musl package install; the probe tells them apart.
function platformBuns() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  const names = [`@oven/bun-${process.platform}-${arch}`];
  if (process.platform === "linux") names.push(`@oven/bun-linux-${arch}-musl`);
  const out = [];
  for (const name of names) {
    try {
      out.push(join(dirname(require.resolve(`${name}/package.json`)), "bin", "bun"));
    } catch {
      // not installed for this platform; try the next candidate
    }
  }
  return out;
}

// every bun on PATH, not the first: under npx the first is the stub in node_modules/.bin
function pathBuns() {
  const r = spawnSync("which", ["-a", "bun"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter((line) => line.trim()) : [];
}

const bun = [bundledBun(), ...platformBuns(), ...pathBuns()].filter(Boolean).find(usable);
if (!bun) {
  console.error(
    `toyon: could not find a usable bun (${FLOOR} or newer).\n` +
      "the bundled copy is missing or incomplete, and there is none on PATH.\n" +
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
