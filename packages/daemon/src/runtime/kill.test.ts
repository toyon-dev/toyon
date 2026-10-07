import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { groupAlive, killGroup } from "./kill.ts";

/** a group of its own, the way a pty child is: `sh` leads it and what it starts stays in it */
function group(script: string) {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((r) => {
    child.once("exit", () => r());
    // a spawn failure settles the wait too, so the test fails on its assertions and never hangs
    child.once("error", () => r());
  });
  return { pid: child.pid!, exited };
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
}

describe("killGroup", () => {
  test("a group that goes on SIGTERM ends with it, well inside the grace", async () => {
    const g = group("sleep 30 & exec sleep 30");
    await Bun.sleep(50);
    const started = Date.now();
    expect(await killGroup(g.pid, g.exited, 2000)).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(groupAlive(g.pid)).toBe(false);
  });

  test("a member that outlives the leader is SIGKILLed with the rest of the group", async () => {
    // the leader dies of SIGTERM at once; the member ignores it, the way a server stuck mid-close
    // would, and before this it sat under launchd with the dead leader's group id for good
    const g = group(`sh -c 'trap "" TERM; sleep 30' & exec sleep 30`);
    // the member must be in the group with its trap set before the signal lands
    await Bun.sleep(100);
    expect(await killGroup(g.pid, g.exited, 300)).toBe("SIGKILL");
    expect(await until(() => !groupAlive(g.pid), 1000)).toBe(true);
  });

  test("a group already gone is nothing to wait for", async () => {
    const g = group("exit 0");
    await g.exited;
    expect(await killGroup(g.pid, g.exited)).toBeUndefined();
  });
});
