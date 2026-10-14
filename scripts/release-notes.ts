#!/usr/bin/env bun
// The GitHub release body for one version: `bun scripts/release-notes.ts 0.15.0`. CHANGELOG.md is
// the one place the notes are written, so the body is its section for that version, with the
// upgrade line the file leaves out because the app shows the same text to people who already have
// the version. Prints to stdout, for `gh release create vX.Y.Z --notes-file <(...)`.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/release-notes.ts <semver>");
  process.exit(2);
}
const text = readFileSync(join(resolve(import.meta.dir, ".."), "CHANGELOG.md"), "utf8");
const lines = text.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} (`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(2);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## "));
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
process.stdout.write(`${body}\n\nUpgrade with \`npx toyon@latest\`.\n`);
