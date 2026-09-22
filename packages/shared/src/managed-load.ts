// Reading the managed policy off the disk: the node half of managed.ts, kept out of index.ts so
// the shell's bundle never sees it. The CLI and the daemon both inline it.

import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import {
  type ManagedResolved,
  type ManagedSourceRead,
  type ManagedSourceSpec,
  managedSources,
  resolveManaged,
} from "./managed.ts";

export interface LoadManagedOpts {
  platform?: string;
  /** the account name, for the user-scope plist; the process's own when absent */
  user?: string;
  /** the places to read, instead of the platform's; for tests */
  sources?: ManagedSourceSpec[];
  /** reads a plist as JSON text; plutil when absent */
  plist?: (path: string) => Promise<string>;
}

/** `plutil -convert json -o - <path>`: macOS's own reader, which is on every Mac */
async function plutilJson(path: string): Promise<string> {
  const p = Bun.spawn(["plutil", "-convert", "json", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(err.trim().split("\n")[0] || `plutil exited ${p.exitCode}`);
  return out;
}

/** A JSON policy is trusted only when root wrote it and nobody else can: a file the person could
 * edit is no policy. The plist is trusted as MDM's own place. */
function ownedByRoot(st: { uid: number; mode: number }): boolean {
  return st.uid === 0 && (st.mode & 0o022) === 0;
}

export async function loadManaged(opts: LoadManagedOpts = {}): Promise<ManagedResolved> {
  const platform = opts.platform ?? process.platform;
  const user = opts.user ?? safeUser();
  const sources = opts.sources ?? managedSources(platform, user);
  const reads: ManagedSourceRead[] = [];
  for (const s of sources) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(s.path);
    } catch {
      reads.push(s); // absent is the common case, and not a problem
      continue;
    }
    if (s.kind === "json" && !ownedByRoot(st)) {
      reads.push({ ...s, owned: false });
      continue;
    }
    try {
      const text = s.kind === "plist" ? await (opts.plist ?? plutilJson)(s.path) : readFileSync(s.path, "utf8");
      reads.push({ ...s, text });
    } catch (e) {
      reads.push({ ...s, problem: e instanceof Error ? e.message : String(e) });
    }
  }
  return resolveManaged(reads);
}

function safeUser(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined; // no account name for this uid: only the computer-scope plist then
  }
}
