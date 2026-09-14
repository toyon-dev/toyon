import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoInfo } from "@toyon/shared";
import { git } from "../git/exec.ts";
import { classify, SelfWatch } from "./self.ts";

// Which half of toyon a landed change leaves behind. The rules are the whole of it: everything
// else here is plumbing around a git diff.
describe("classify", () => {
  test("the shell and the bridge are served off disk, so a rebuild is enough", () => {
    expect(classify(["packages/shell/src/main.tsx"])).toEqual({ rebuild: true, restart: false });
    expect(classify(["packages/bridge/src/bridge.ts"])).toEqual({ rebuild: true, restart: false });
  });

  test("the daemon's own code is in memory from boot, so only a restart picks it up", () => {
    expect(classify(["packages/daemon/src/server/ws.ts"])).toEqual({ rebuild: false, restart: true });
    expect(classify(["bun.lock"])).toEqual({ rebuild: false, restart: true });
  });

  test("shared is compiled into both halves, so it is both", () => {
    expect(classify(["packages/shared/src/model.ts"])).toEqual({ rebuild: true, restart: true });
  });

  test("what a running daemon does not read asks for neither", () => {
    expect(classify(["README.md", "docs/remote.md", "packages/cli/src/doctor.ts"])).toEqual({
      rebuild: false,
      restart: false,
    });
  });

  test("one file of each is both, whichever order they arrive in", () => {
    const paths = ["docs/remote.md", "packages/shell/src/app.tsx", "packages/daemon/src/index.ts"];
    expect(classify(paths)).toEqual({ rebuild: true, restart: true });
  });
});

/** a checkout with one commit on `main`, standing in for the tree a daemon runs from */
async function checkout(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "toyon-self-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "first");
  return dir;
}

const repoAt = (path: string): RepoInfo =>
  ({
    id: "r1",
    path,
    name: "toyon",
    defaultBranch: "main",
    config: { run: {} },
    configFile: ".toyon/settings.json",
  }) as RepoInfo;

describe("SelfWatch", () => {
  test("says nothing while the branch is where the daemon started", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      expect(await self.check(repoAt(dir))).toBe(false);
      expect(self.get()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a commit on the branch names which half is behind", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      await Bun.write(join(dir, "packages/shell/src/app.tsx"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "shell");
      expect(await self.check(repoAt(dir))).toBe(true);
      expect(self.get()).toEqual({ repoId: "r1", rebuild: true, restart: false, building: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("measures against the commit it booted from, not the last check", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      await Bun.write(join(dir, "packages/daemon/src/x.ts"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "daemon");
      await self.check(repoAt(dir));
      // a second land that touches nothing the daemon reads must not clear the first one's verdict
      await Bun.write(join(dir, "docs/x.md"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "docs");
      await self.check(repoAt(dir));
      expect(self.get()?.restart).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("another project moving is not this daemon's business", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      await Bun.write(join(dir, "packages/daemon/src/x.ts"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "daemon");
      expect(await self.check({ ...repoAt(dir), path: "/somewhere/else" })).toBe(false);
      expect(self.get()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a packaged daemon has no tree, so nothing to be behind", async () => {
    const self = new SelfWatch(null);
    await self.start();
    expect(await self.check(repoAt("/anywhere"))).toBe(false);
    expect(self.get()).toBeNull();
  });

  test("a clean afterLand clears the rebuild and leaves the restart standing", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      await Bun.write(join(dir, "packages/shared/src/model.ts"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "shared");
      await self.check(repoAt(dir));
      expect(self.get()).toMatchObject({ rebuild: true, restart: true });
      self.building(true);
      expect(self.get()?.building).toBe(true);
      self.building(false);
      // no build replaces a running process, so the restart half is untouched
      expect(self.get()).toMatchObject({ rebuild: false, restart: true, building: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed afterLand keeps the rebuild standing and says why", async () => {
    const dir = await checkout();
    try {
      const self = new SelfWatch(dir);
      await self.start();
      await Bun.write(join(dir, "packages/shell/src/app.tsx"), "x");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "shell");
      await self.check(repoAt(dir));
      self.building(true);
      self.building(false, "error: TS2322");
      expect(self.get()).toMatchObject({ rebuild: true, building: false, buildFailed: "error: TS2322" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
