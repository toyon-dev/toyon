import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { run } from "../git/exec.ts";
import { WatchmanWatches } from "./watchman.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** a worktrees root as watchman names it, with its symlinks resolved */
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "toyon-watchman-")));
  dirs.push(dir);
  return dir;
}

type Answer = Partial<Awaited<ReturnType<typeof run>>>;

/** a watchman with these roots watched: every spawn is recorded, a `watch-del` takes its root off
 * the list, and `answer` stands in for the list when the server has something else to say */
function fakeWatchman(roots: string[], answer?: () => Answer) {
  const calls: string[][] = [];
  const watched = new Set(roots);
  const fake: typeof run = async (_cmd, args) => {
    calls.push(args);
    const command = args.filter((a) => !a.startsWith("--"));
    const said: Answer =
      command[0] === "watch-list"
        ? (answer?.() ?? { ok: true, out: JSON.stringify({ version: "2024.01.01.00", roots: [...watched] }) })
        : { ok: watched.delete(command[1] ?? "") };
    return { ok: false, out: "", rawOut: "", err: "", exit: said.ok ? 0 : 1, ...said };
  };
  return { calls, watched, run: fake };
}

const here = () => "/opt/homebrew/bin/watchman";

describe("drop", () => {
  test("the watch on a removed worktree goes, and any on a folder inside it", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "app", "wt-live"), { recursive: true });
    const gone = join(root, "app", "wt-gone");
    const w = fakeWatchman([
      gone,
      join(gone, "packages", "web"),
      join(root, "app", "wt-live"),
      `${gone}-2`,
      "/elsewhere",
    ]);
    await new WatchmanWatches({ root, run: w.run, which: here }).drop(gone);
    expect([...w.watched]).toEqual([join(root, "app", "wt-live"), `${gone}-2`, "/elsewhere"]);
    expect(w.calls).toEqual([
      ["--no-spawn", "--no-local", "watch-list"],
      ["--no-spawn", "--no-local", "watch-del", gone],
      ["--no-spawn", "--no-local", "watch-del", join(gone, "packages", "web")],
    ]);
  });

  test("a directory that still stands keeps its watch", async () => {
    const root = tmpRoot();
    const kept = join(root, "app", "wt-kept");
    mkdirSync(kept, { recursive: true });
    const w = fakeWatchman([kept]);
    await new WatchmanWatches({ root, run: w.run, which: here }).drop(kept);
    expect(w.calls).toEqual([]);
  });

  test("a worktree outside the root is not asked about", async () => {
    const root = tmpRoot();
    const outside = join(tmpRoot(), "wt-gone");
    const w = fakeWatchman([outside]);
    await new WatchmanWatches({ root, run: w.run, which: here }).drop(outside);
    expect(w.calls).toEqual([]);
  });

  test("a root reached through a link is matched by its real path", async () => {
    const root = tmpRoot();
    const link = join(tmpRoot(), "worktrees");
    symlinkSync(root, link);
    const w = fakeWatchman([join(root, "app", "wt-gone")]);
    await new WatchmanWatches({ root: link, run: w.run, which: here }).drop(join(link, "app", "wt-gone"));
    expect([...w.watched]).toEqual([]);
  });
});

describe("no watchman", () => {
  test("a machine with none is asked once and nothing is ever spawned", async () => {
    const root = tmpRoot();
    const w = fakeWatchman([join(root, "wt-a"), join(root, "wt-b")]);
    let looked = 0;
    const watches = new WatchmanWatches({
      root,
      run: w.run,
      which: () => {
        looked++;
        return null;
      },
    });
    await watches.sweep();
    await watches.drop(join(root, "wt-a"));
    await watches.drop(join(root, "wt-b"));
    expect(looked).toBe(1);
    expect(w.calls).toEqual([]);
  });

  test("no server running is one question that starts none, and no watch-del", async () => {
    const root = tmpRoot();
    const w = fakeWatchman([join(root, "wt-gone")], () => ({ ok: false, exit: 1 }));
    const watches = new WatchmanWatches({ root, run: w.run, which: here });
    await watches.drop(join(root, "wt-gone"));
    await watches.sweep();
    expect(w.calls).toEqual([
      ["--no-spawn", "--no-local", "watch-list"],
      ["--no-spawn", "--no-local", "watch-list"],
    ]);
  });

  test("an answer that is not the list drops nothing", async () => {
    const root = tmpRoot();
    for (const out of ["", "not json", '{"roots":"all"}', "null"]) {
      const w = fakeWatchman([join(root, "wt-gone")], () => ({ ok: true, out }));
      await new WatchmanWatches({ root, run: w.run, which: here }).sweep();
      expect(w.calls).toHaveLength(1);
    }
  });
});

describe("sweep", () => {
  test("only watches under the root whose directory is gone", async () => {
    const root = tmpRoot();
    const live = join(root, "app", "wt-live");
    mkdirSync(live, { recursive: true });
    const gone = [join(root, "app", "wt-gone"), join(root, "other", "wt-gone")];
    const w = fakeWatchman([root, live, ...gone, "/elsewhere/gone"]);
    await new WatchmanWatches({ root, run: w.run, which: here }).sweep();
    expect([...w.watched]).toEqual([root, live, "/elsewhere/gone"]);
  });

  test("every spawn is short and never starts a server", async () => {
    const root = tmpRoot();
    const seen: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs?: number }> = [];
    const w = fakeWatchman([join(root, "wt-gone")]);
    const spy: typeof run = (cmd, args, cwd, env, opts) => {
      seen.push({ cmd, args, cwd, timeoutMs: opts?.timeoutMs });
      return w.run(cmd, args, cwd, env, opts);
    };
    await new WatchmanWatches({ root, run: spy, which: here }).sweep();
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.cmd).toBe(here());
      expect(s.args.slice(0, 2)).toEqual(["--no-spawn", "--no-local"]);
      expect(s.cwd).toBe(root);
      expect(s.timeoutMs).toBeLessThanOrEqual(5_000);
    }
  });
});

describe("the binary", () => {
  test("is spawned with the flags ahead of the command, and its list is read", async () => {
    const root = tmpRoot();
    const gone = join(root, "app", "wt-gone");
    const bin = tmpRoot();
    const exe = join(bin, "watchman");
    const asked = join(bin, "asked");
    // pretty-printed, as watchman answers when nothing asks it not to
    const list = JSON.stringify({ version: "2024.01.01.00", roots: [gone] }, null, 4);
    writeFileSync(
      exe,
      `#!/bin/sh\necho "$@" >> '${asked}'\n[ "$3" = watch-list ] && cat <<'JSON'\n${list}\nJSON\nexit 0\n`,
    );
    chmodSync(exe, 0o755);
    await new WatchmanWatches({ root, which: () => exe }).drop(gone);
    expect(readFileSync(asked, "utf8").trim().split("\n")).toEqual([
      "--no-spawn --no-local watch-list",
      `--no-spawn --no-local watch-del ${gone}`,
    ]);
  });
});
