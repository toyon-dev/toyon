#!/usr/bin/env bun
// Assemble the npm package in packages/cli: the shell and bridge built, the daemon and the CLI
// each bundled to one file with bun as the target, and everything laid out under dist/ the way
// core/assets.ts and cli/src/layout.ts expect to find it. `npm publish` in packages/cli runs
// this through prepublishOnly, so a publish can never ship a stale build.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const pkgs = join(root, "packages");
const out = join(pkgs, "cli", "dist");

$.cwd(root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The shell's own dist keeps every build's chunks, because the daemon serves it off disk while tabs
// are open. The package wants one build, so it is written straight into the package and emptied
// first; the dev dist is left alone.
await $`bun --bun vite build --outDir ${join(out, "shell")} --emptyOutDir`.cwd(join(pkgs, "shell"));
await $`bun run --cwd packages/bridge build`;

async function bundle(entry: string, name: string, external: string[] = []) {
  const r = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    target: "bun",
    naming: name,
    external,
    minify: false,
  });
  if (!r.success) {
    for (const m of r.logs) console.error(m);
    throw new Error(`bundle failed: ${name}`);
  }
}

// bun-pty finds its native library beside its own source, so it stays a real dependency
await bundle(join(pkgs, "daemon", "src", "index.ts"), "daemon.js", ["bun-pty"]);
await bundle(join(pkgs, "cli", "src", "cli.ts"), "cli.js");
cpSync(join(pkgs, "bridge", "dist", "bridge.js"), join(out, "bridge.js"));
// npm reads the package page from a README beside package.json, and a LICENSE there too; the
// real ones live at the repo root, so the pack carries copies in (gitignored, refreshed every run)
for (const f of ["README.md", "LICENSE"]) cpSync(join(root, f), join(pkgs, "cli", f));

for (const f of ["daemon.js", "cli.js", "bridge.js", "shell/index.html"]) {
  const p = join(out, f);
  if (!existsSync(p)) throw new Error(`missing after pack: ${f}`);
  console.log(`${f.padEnd(18)} ${(statSync(p).size / 1024).toFixed(0).padStart(6)} KB`);
}
