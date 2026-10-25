#!/usr/bin/env bun
// Each builtin adapter's pin beside what npm has published: `bun scripts/adapter-pins.ts`, and
// the version bump prints the same table. `toyon doctor` compares a pin with what is on disk,
// which says nothing about what shipped since; this is where a pin that fell releases behind
// shows itself before a release carries it further. Exits 1 when a pin is behind or npm could
// not be asked, so a release step can read the answer without parsing the lines.

import { hostTraits, nativePackage } from "../packages/daemon/src/agent/native.ts";
import { BUILTIN_AGENTS } from "../packages/daemon/src/agent/registry.ts";

interface Pin {
  id: string;
  pkg: string;
  pinned: string;
}

// a native adapter is one npm package per platform; this machine's is the one asked about, since
// every build of a version is published together
const host = hostTraits();
const pins: Pin[] = BUILTIN_AGENTS.flatMap((a) => {
  if (a.run.kind === "command") return [];
  const pkg = a.run.kind === "npm-native" ? nativePackage(a.run.pkg, host) : a.run.pkg;
  return pkg ? [{ id: a.id, pkg, pinned: a.run.version }] : [];
});

const STABLE = /^\d+\.\d+\.\d+$/;

/** the stable versions npm lists for the package, oldest first; the error line when npm could not
 * be asked (offline, a registry that refuses, a package that moved) */
async function published(pkg: string): Promise<string[] | { error: string }> {
  const proc = Bun.spawn(["npm", "view", pkg, "versions", "--json"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    // npm's `code` line names the cause (E404, ENOTFOUND); the lines after it point at a log
    const lines = err.split("\n").map((l) => l.replace(/^npm error\s*/, "").trim());
    const cause = lines.find((l) => l.startsWith("code ")) ?? lines.find(Boolean);
    return { error: cause || `npm exited ${code}` };
  }
  const parsed: unknown = JSON.parse(out);
  const all = Array.isArray(parsed) ? (parsed as string[]) : [String(parsed)];
  return all.filter((v) => STABLE.test(v)).sort(Bun.semver.order);
}

const width = Math.max(...pins.map((p) => p.pkg.length));
let behind = false;
for (const pin of pins) {
  const versions = await published(pin.pkg);
  const head = `${pin.id.padEnd(8)} ${pin.pkg.padEnd(width)}  ${pin.pinned} pinned`;
  if (!Array.isArray(versions)) {
    behind = true;
    console.log(`${head}, npm could not be asked: ${versions.error}`);
    continue;
  }
  const newer = versions.filter((v) => Bun.semver.order(v, pin.pinned) > 0);
  if (newer.length === 0) {
    console.log(`${head}, the newest on npm`);
    continue;
  }
  behind = true;
  const releases = newer.length === 1 ? "1 release" : `${newer.length} releases`;
  console.log(`${head}, ${newer.at(-1)} on npm, ${releases} behind`);
}
process.exit(behind ? 1 : 0);
