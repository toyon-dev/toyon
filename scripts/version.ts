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
// the notes are part of the release commit: the package serves them to the shell as what's new,
// so a tag without a section for its version would ship a changelog that stops one release short
if (!readFileSync(join(root, "CHANGELOG.md"), "utf8").includes(`\n## ${version} (`)) {
  console.error(
    `CHANGELOG.md has no section for ${version}; write the release notes first (a "## ${version} (YYYY-MM-DD)" heading at the top)`,
  );
  process.exit(2);
}
for (const pkg of ["bridge", "cli", "daemon", "shared", "shell"]) {
  const file = join(root, "packages", pkg, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg}: ${version}`);
}

// bun.lock carries each workspace package's own version, so it is stale the moment the files
// above are written and the next bun command in anyone's tree rewrites it. No dependency moved,
// so this only rewrites those versions. The bun running this script, not whatever is on PATH.
const install = Bun.spawnSync([process.execPath, "install"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (install.exitCode !== 0) {
  console.error("could not update bun.lock; commit the version bump only once `bun install` works");
  process.exit(install.exitCode ?? 1);
}
console.log("bun.lock: updated");
