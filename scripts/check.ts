#!/usr/bin/env bun
// The whole gate, its steps side by side: `bun scripts/check.ts`. The steps share no output and
// none reads what another writes (no test opens the built bridge), so the wait is the slowest
// step, the tests, and not the sum.

import { resolve } from "node:path";

const STEPS: Record<string, string[]> = {
  typecheck: ["run", "typecheck"],
  lint: ["run", "lint"],
  test: ["run", "test"],
  bridge: ["run", "--cwd", "packages/bridge", "build"],
};
const root = resolve(import.meta.dir, "..");

const runs = Object.entries(STEPS).map(async ([name, args]) => {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // a step's output whole, when it ends, so two steps never interleave
  process.stdout.write(out);
  process.stderr.write(err);
  return code === 0 ? null : name;
});

const failed = (await Promise.all(runs)).filter((name) => name !== null);
if (failed.length) console.error(`check failed: ${failed.join(", ")}`);
process.exit(failed.length ? 1 : 0);
