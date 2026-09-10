// `toyon logs`: the daemon writes to stderr and the CLI points that at a file; this is the file.

import { existsSync, readFileSync, statSync } from "node:fs";
import { logFile } from "./daemon.ts";

export async function logs(opts: { follow: boolean; lines: number }): Promise<number> {
  if (!existsSync(logFile)) {
    console.log(`no log yet at ${logFile}; it appears once \`toyon\` has started the daemon`);
    return opts.follow ? 0 : 1;
  }
  const text = readFileSync(logFile, "utf8");
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  const tail = opts.lines === 0 ? [] : all.slice(-opts.lines);
  if (tail.length > 0) process.stdout.write(`${tail.join("\n")}\n`);
  if (!opts.follow) return 0;

  // poll rather than fs.watch: the daemon appends with its own fd, and watch on macOS coalesces
  // or drops events for a file another process holds open
  let offset = statSync(logFile).size;
  for (;;) {
    await Bun.sleep(300);
    if (!existsSync(logFile)) continue;
    const size = statSync(logFile).size;
    if (size < offset) offset = 0; // rotated or truncated: start over
    if (size === offset) continue;
    const chunk = readFileSync(logFile, { encoding: "utf8", flag: "r" }).slice(offset);
    offset = size;
    process.stdout.write(chunk);
  }
}
