#!/usr/bin/env bun
// The whole suite as several `bun test` processes side by side, each a shard run serially:
// `bun scripts/test.ts [bun test args]`. Not `bun test --parallel`: on Bun 1.4.2 a parallel
// worker now and then spins for ever inside a synchronous spawn whose child has already exited
// (the git fixtures make thousands of them), and no test timeout can fire on a thread that never
// yields. A plain `bun test` process does not, so the parallelism is across processes instead.

import { resolve } from "node:path";

const SHARDS = 8;
const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);

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
  process.stdout.write(out);
  process.stderr.write(err);
  return code;
});

const failed = (await Promise.all(runs)).filter((code) => code !== 0).length;
if (failed) console.error(`${failed} of ${SHARDS} test shards failed`);
process.exit(failed ? 1 : 0);
