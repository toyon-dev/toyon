#!/usr/bin/env bun
// One version for every package: `bun scripts/version.ts 0.2.0`. The CLI's package.json is what
// npm publishes and the daemon reports its own on /health, so they have to agree, and doctor
// says so when they do not.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/version.ts <semver>");
  process.exit(2);
}
const root = resolve(import.meta.dir, "..");
for (const pkg of ["bridge", "cli", "daemon", "shared", "shell"]) {
  const file = join(root, "packages", pkg, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg}: ${version}`);
}
