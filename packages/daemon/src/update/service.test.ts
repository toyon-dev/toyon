import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../core/hub.ts";
import { readVersion } from "./installed.ts";
import { UpdateService } from "./service.ts";

function make(start: { installed?: string | null; waiting?: string[] | null } = {}) {
  const hub = new Hub();
  let installed = start.installed ?? null;
  const waiting = start.waiting ?? null;
  let changes = 0;
  hub.on("updateChanged", () => changes++);
  const update = new UpdateService({
    hub,
    running: "0.2.0",
    installed: async () => installed,
    restarter: { waitingOn: () => waiting },
    setInterval: () => {},
  });
  return {
    update,
    install: (v: string | null) => {
      installed = v;
    },
    changes: () => changes,
  };
}

describe("UpdateService", () => {
  test("nothing to say while the installed version is the one running", async () => {
    const { update, changes } = make({ installed: "0.2.0" });
    await update.refresh();
    expect(update.get()).toBeNull();
    expect(changes()).toBe(0);
  });

  test("an install under the running daemon is announced once", async () => {
    const { update, changes } = make({ installed: "0.3.0" });
    await update.refresh();
    await update.refresh();
    expect(update.get()).toEqual({ running: "0.2.0", installed: "0.3.0", restarting: null });
    expect(changes()).toBe(1);
  });

  test("a package.json caught half-written is not the update going away", async () => {
    const { update, install, changes } = make({ installed: "0.3.0" });
    await update.refresh();
    install(null);
    await update.refresh();
    expect(update.get()?.installed).toBe("0.3.0");
    expect(changes()).toBe(1);
  });

  test("installing the running version back takes the notice away", async () => {
    const { update, install } = make({ installed: "0.3.0" });
    await update.refresh();
    install("0.2.0");
    await update.refresh();
    expect(update.get()).toBeNull();
  });

  test("a restart someone asked for is said with nothing installed", () => {
    const { update } = make({ waiting: ["fix login"] });
    expect(update.get()).toEqual({ running: "0.2.0", installed: null, restarting: ["fix login"] });
  });
});

describe("readVersion", () => {
  test("names the version, and null for a file that is missing or not JSON yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-version-"));
    try {
      const file = join(dir, "package.json");
      expect(await readVersion(file)).toBeNull();
      writeFileSync(file, '{"name":"toyon","ver');
      expect(await readVersion(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ name: "toyon", version: "1.2.3" }));
      expect(await readVersion(file)).toBe("1.2.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
