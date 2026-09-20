import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallMethod } from "@toyon/shared";
import { Hub } from "../core/hub.ts";
import { readVersion } from "./installed.ts";
import { UpdateService } from "./service.ts";

const MIN = 60_000;
const REGISTRY = "https://artifacts.example/api/npm/npm-packages/";

function make(
  start: {
    installed?: string | null;
    latest?: string | null;
    method?: InstallMethod;
    managed?: boolean;
    installFails?: boolean;
  } = {},
) {
  const hub = new Hub();
  const method = start.method ?? "npm";
  let installed = start.installed ?? null;
  let latest = start.latest ?? null;
  let clock = 0;
  let busy = false;
  let asked = false;
  let requests = 0;
  let registryAsks = 0;
  const working: string[] = [];
  const installs: string[][] = [];
  const state = {
    updateFailed: undefined as { version: string; at: number } | undefined,
    setUpdateFailed(f: { version: string; at: number } | undefined) {
      state.updateFailed = f;
    },
  };
  const update = new UpdateService({
    hub,
    state,
    running: "0.2.0",
    method,
    managed: start.managed ?? false,
    installed: async () => installed,
    latest: async () => {
      registryAsks++;
      return { version: latest, registry: REGISTRY };
    },
    command: (v) => (method === "npm" ? ["npm", "install", "-g", `toyon@${v}`] : null),
    install: async (command) => {
      installs.push(command);
      if (start.installFails) return { ok: false, line: "npm error code EACCES" };
      installed = command.at(-1)?.split("@")[1] ?? null;
      return { ok: true, line: "added 4 packages" };
    },
    restarter: {
      working: () => working,
      waitingOn: () => (asked ? working : null),
      request: () => {
        asked = true;
        requests++;
        return null;
      },
    },
    busy: () => busy,
    now: () => clock,
    setInterval: () => {},
    setTimeout: () => {},
  });
  return {
    hub,
    update,
    state,
    working,
    installs,
    install: (v: string | null) => {
      installed = v;
    },
    publish: (v: string | null) => {
      latest = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setBusy: (b: boolean) => {
      busy = b;
    },
    ask: () => {
      asked = true;
    },
    requests: () => requests,
    registryAsks: () => registryAsks,
  };
}

describe("UpdateService: what is installed", () => {
  test("nothing to say while the installed version is the one running", async () => {
    const { update, hub } = make({ installed: "0.2.0" });
    let changes = 0;
    hub.on("updateChanged", () => changes++);
    await update.tick();
    expect(update.get()).toBeNull();
    expect(changes).toBe(0);
  });

  test("an install under the running daemon is announced once", async () => {
    const { update, hub } = make({ installed: "0.3.0" });
    let changes = 0;
    hub.on("updateChanged", () => changes++);
    await update.refresh();
    await update.refresh();
    expect(update.get()).toMatchObject({ running: "0.2.0", installed: "0.3.0", latest: null, restarting: null });
    expect(changes).toBe(1);
  });

  test("a package.json caught half-written is not the update going away", async () => {
    const { update, install } = make({ installed: "0.3.0" });
    await update.refresh();
    install(null);
    await update.refresh();
    expect(update.get()?.installed).toBe("0.3.0");
  });

  test("a restart someone asked for is said with nothing installed", () => {
    const { update, working, ask } = make();
    working.push("fix login");
    ask();
    expect(update.get()).toMatchObject({ installed: null, restarting: ["fix login"] });
  });

  test("a hand install restarts onto itself once the machine settles, with nothing to install", async () => {
    const { update, advance, installs, requests } = make({ installed: "0.3.0" });
    advance(3 * MIN);
    await update.tick();
    expect(installs).toEqual([]);
    expect(requests()).toBe(1);
  });
});

describe("UpdateService: what is out", () => {
  test("a newer version in the registry is known, and an equal one is not", async () => {
    const { update, publish } = make({ latest: "0.3.0" });
    await update.check();
    expect(update.get()).toMatchObject({ latest: "0.3.0", method: "npm" });
    publish("0.2.0");
    await update.check();
    expect(update.get()).toBeNull();
  });

  test("where this install cannot update, the registry is not asked", async () => {
    const { update, registryAsks } = make({ latest: "0.3.0", method: "none" });
    await update.check();
    expect(registryAsks()).toBe(0);
  });

  test("a registry without toyon is named for doctor, and an answer later clears it", async () => {
    const { update, publish } = make();
    await update.check();
    expect(update.get()).toBeNull();
    expect(update.status()).toEqual({ managed: false, unreachable: REGISTRY, latest: null });
    publish("0.3.0");
    await update.check();
    expect(update.status()).toEqual({ managed: false, unreachable: null, latest: "0.3.0" });
  });
});

describe("UpdateService: on its own", () => {
  test("installs and restarts once nothing has been busy for a couple of minutes", async () => {
    const { update, advance, installs, requests } = make({ latest: "0.3.0" });
    // boot counts as busy: a check in a daemon's first minutes waits
    await update.check();
    expect(installs).toEqual([]);
    advance(3 * MIN);
    await update.tick();
    expect(installs).toEqual([["npm", "install", "-g", "toyon@0.3.0"]]);
    expect(requests()).toBe(1);
  });

  test("waits while anything is busy, and a little after", async () => {
    const { update, advance, setBusy, installs } = make({ latest: "0.3.0" });
    await update.check();
    advance(3 * MIN);
    setBusy(true);
    await update.tick();
    expect(installs).toEqual([]);
    setBusy(false);
    advance(1 * MIN);
    await update.tick();
    expect(installs).toEqual([]);
    advance(2 * MIN);
    await update.tick();
    expect(installs).toHaveLength(1);
  });

  test("a reply settling is activity: the gap before the next message is not idle", async () => {
    const { update, hub, advance, installs } = make({ latest: "0.3.0" });
    await update.check();
    advance(3 * MIN);
    hub.emit("agentStatus", "w1", "idle");
    await update.tick();
    expect(installs).toEqual([]);
    advance(3 * MIN);
    await update.tick();
    expect(installs).toHaveLength(1);
  });

  test("a failed install says why and what to run by hand, and that version is left alone for a day", async () => {
    const { update, advance, state, installs, requests } = make({ latest: "0.3.0", installFails: true });
    await update.check();
    advance(3 * MIN);
    await update.tick();
    expect(update.get()?.failed).toEqual({
      version: "0.3.0",
      line: "npm error code EACCES",
      command: "npm install -g toyon@0.3.0",
    });
    expect(state.updateFailed?.version).toBe("0.3.0");
    expect(requests()).toBe(0);
    advance(60 * MIN);
    await update.tick();
    expect(installs).toHaveLength(1);
    advance(24 * 60 * MIN);
    await update.tick();
    expect(installs).toHaveLength(2);
  });

  test("an npx copy never installs", async () => {
    const { update, advance, installs } = make({ latest: "0.3.0", method: "npx" });
    await update.check();
    advance(30 * MIN);
    await update.tick();
    expect(installs).toEqual([]);
  });
});

describe("UpdateService: a press on the failed chip", () => {
  test("tries again at once, without waiting for the machine to settle", async () => {
    const { update, installs, requests } = make({ latest: "0.3.0" });
    await update.check();
    await update.updateNow();
    expect(installs).toHaveLength(1);
    expect(requests()).toBe(1);
  });

  test("waits out a chat mid-reply before installing, and goes when it settles", async () => {
    const { update, hub, working, installs, requests } = make({ latest: "0.3.0" });
    await update.check();
    working.push("fix login");
    await update.updateNow();
    expect(installs).toEqual([]);
    expect(update.get()?.restarting).toEqual(["fix login"]);
    working.length = 0;
    hub.emit("agentStatus", "w1", "idle");
    await Bun.sleep(5);
    expect(installs).toHaveLength(1);
    expect(requests()).toBe(1);
  });

  test("with nothing to go to, says Toyon is up to date", async () => {
    const { update } = make();
    await expect(update.updateNow()).rejects.toThrow("Toyon is up to date");
  });

  test("an npx copy is told the command", async () => {
    const { update } = make({ latest: "0.3.0", method: "npx" });
    await update.check();
    await expect(update.updateNow()).rejects.toThrow("npx toyon@0.3.0");
  });
});

describe("UpdateService: a press on the version chip", () => {
  test("asks the registry now, and what it finds is announced the usual way", async () => {
    const { update, registryAsks } = make({ latest: "0.3.0" });
    await update.checkNow();
    expect(registryAsks()).toBe(1);
    expect(update.get()).toMatchObject({ latest: "0.3.0" });
  });

  test("a check that finds nothing says so in words, since nothing else would move", async () => {
    const { update } = make({ latest: "0.2.0" });
    await expect(update.checkNow()).rejects.toThrow("Toyon 0.2.0 is the newest version");
    const { update: off } = make();
    await expect(off.checkNow()).rejects.toThrow(`Could not reach ${REGISTRY}`);
  });

  test("a checkout is told it does not update itself, without asking the registry", async () => {
    const { update, registryAsks } = make({ latest: "0.3.0", method: "none" });
    await expect(update.checkNow()).rejects.toThrow("runs from a checkout");
    expect(registryAsks()).toBe(0);
    expect(update.install()).toBe("none");
  });
});

describe("UpdateService: TOYON_UPDATES=off", () => {
  test("the registry is never asked, nothing installs, a press is refused, and doctor can say so", async () => {
    const { update, advance, installs, registryAsks } = make({ latest: "0.3.0", managed: true });
    await update.check();
    advance(30 * MIN);
    await update.tick();
    expect(registryAsks()).toBe(0);
    expect(installs).toEqual([]);
    expect(update.status().managed).toBe(true);
    await expect(update.updateNow()).rejects.toThrow("turned off for this machine");
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
