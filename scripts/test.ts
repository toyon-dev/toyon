#!/usr/bin/env bun
// The whole suite as several `bun test` processes side by side, each a shard run serially:
// `bun scripts/test.ts [bun test args]`. Not `bun test --parallel`: on Bun 1.4.2 a parallel
// worker now and then spins for ever inside a synchronous spawn whose child has already exited
// (the git fixtures make thousands of them), and no test timeout can fire on a thread that never
// yields. A plain `bun test` process does not, so the parallelism is across processes instead.

import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { holdMachineSlot } from "./slot.ts";

// One shard for every two cores, eight at most. The git fixtures are all spawns, and more test
// processes than the machine can serve make every fixed wait in the suite miss: a three-core CI
// runner gets one shard, which is the serial run. TOYON_TEST_SHARDS names a count outright.
const SHARDS =
  Number(process.env.TOYON_TEST_SHARDS) || Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
// bunfig's [test] timeout does not reach Bun 1.4.2, which then stops a test at five seconds; the
// git fixtures need the room it asks for whenever the machine is busy with a second run
if (!args.some((arg) => arg.startsWith("--timeout"))) args.unshift("--timeout", "20000");

// queued behind the machine's other runs; inside `check` the slot is already held
await holdMachineSlot("test");

const runs = Array.from({ length: SHARDS }, async (_, i) => {
  const proc = Bun.spawn([process.execPath, "test", `--shard=${i + 1}/${SHARDS}`, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // a shard's output whole, when it ends, so two shards never interleave
  await drain(process.stdout, out);
  await drain(process.stderr, err);
  return code;
});

const failed = (await Promise.all(runs)).filter((code) => code !== 0).length;
if (failed) console.error(`${failed} of ${SHARDS} test shards failed`);
// an exit code, not process.exit: a write to a pipe is still draining when a shard's output is
// large, and exit would cut it off right where a failure is printed
process.exitCode = failed ? 1 : 0;

function drain(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => {
    if (text.length === 0) return done();
    stream.write(text, () => done());
  });
}
