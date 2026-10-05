#!/usr/bin/env bun
// The whole gate, its steps side by side: `bun scripts/check.ts`. The steps share no output and
// none reads what another writes (no test opens the built bridge), so the wait is the slowest
// step, the tests, and not the sum.

import { resolve } from "node:path";
import { holdMachineSlot } from "./slot.ts";

const STEPS: Record<string, string[]> = {
  typecheck: ["run", "typecheck"],
  lint: ["run", "lint"],
  test: ["run", "test"],
  bridge: ["run", "--cwd", "packages/bridge", "build"],
};
const root = resolve(import.meta.dir, "..");

// queued behind the machine's other runs before any step starts
await holdMachineSlot("check");

const runs = Object.entries(STEPS).map(async ([name, args]) => {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // a step's output whole, when it ends, so two steps never interleave
  await drain(process.stdout, out);
  await drain(process.stderr, err);
  return code === 0 ? null : name;
});

const failed = (await Promise.all(runs)).filter((name) => name !== null);
if (failed.length) console.error(`check failed: ${failed.join(", ")}`);
// an exit code, not process.exit: a write to a pipe is still draining when the step's output is
// large, and exit would cut it off right where a failure is printed
process.exitCode = failed.length ? 1 : 0;

function drain(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => {
    if (text.length === 0) return done();
    stream.write(text, () => done());
  });
}
