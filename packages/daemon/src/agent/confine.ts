// toyon's own OS sandbox, for an agent whose adapter brings none. The adapter and everything it
// starts run inside it: writes only within the bounds, toyon's secrets unreadable, and every other
// read and the network left open (sandbox.ts says why). Seatbelt on macOS, bubblewrap on Linux. With
// neither the agent does not start, since running it unconfined would show it as sandboxed when it
// is not.

import { statSync } from "node:fs";
import { UserError } from "../core/errors.ts";
import type { Launch } from "./registry.ts";
import type { Bounds } from "./sandbox.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const uniq = (xs: string[]) => [...new Set(xs)];

/** a path as a Seatbelt string literal */
const literal = (p: string) => `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const subpaths = (ps: string[]) =>
  uniq(ps)
    .map((p) => `(subpath ${literal(p)})`)
    .join(" ");

/** The profile for sandbox-exec. Seatbelt matches the path the kernel resolves, which is why bounds
 * carry canonical forms beside the raw ones. Later rules win, so the denials hold inside the
 * writable paths. */
export function seatbeltProfile(b: Bounds, extraWrite: string[] = []): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${subpaths([...b.allowWrite, ...extraWrite])} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    ...(b.denyWrite.length ? [`(deny file-write* ${subpaths(b.denyWrite)})`] : []),
    ...(b.denyRead.length ? [`(deny file-read* ${subpaths(b.denyRead)})`] : []),
  ].join("\n");
}

type Kind = "file" | "dir" | null;

function kindOf(p: string): Kind {
  try {
    return statSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return null; // not there: nothing to bind, and bubblewrap refuses a bind whose source is missing
  }
}

/** The bubblewrap arguments before `--`: the whole filesystem read-only, the bounds bound back
 * writable, and the denials laid over them. A denied path that does not exist yet is not covered
 * here, since a bind needs something to bind; the policy still refuses it to the file tools, and
 * Seatbelt covers it on macOS. */
export function bwrapArgs(b: Bounds, extraWrite: string[] = [], kind: (p: string) => Kind = kindOf): string[] {
  const args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const p of uniq([...b.allowWrite, ...extraWrite])) if (kind(p)) args.push("--bind", p, p);
  for (const p of uniq(b.denyWrite)) if (kind(p)) args.push("--ro-bind", p, p);
  for (const p of uniq(b.denyRead)) {
    const k = kind(p);
    if (k === "file") args.push("--ro-bind", "/dev/null", p);
    else if (k === "dir") args.push("--tmpfs", p);
  }
  return args;
}

/** The launch, wrapped in this platform's sandbox. `extraWrite` is the agent's own state, which
 * lives outside any worktree. */
export function confine(
  launch: Launch,
  b: Bounds,
  extraWrite: string[] = [],
  platform: NodeJS.Platform = process.platform,
  which: (cmd: string) => string | null = Bun.which,
): Launch {
  if (platform === "darwin") {
    return {
      ...launch,
      command: SANDBOX_EXEC,
      args: ["-p", seatbeltProfile(b, extraWrite), launch.command, ...launch.args],
    };
  }
  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (!bwrap) throw new UserError("This agent runs in Toyon's sandbox, which needs bubblewrap (bwrap) on Linux.");
    return { ...launch, command: bwrap, args: [...bwrapArgs(b, extraWrite), "--", launch.command, ...launch.args] };
  }
  throw new UserError(`This agent runs in Toyon's sandbox, which is not available on ${platform}.`);
}
