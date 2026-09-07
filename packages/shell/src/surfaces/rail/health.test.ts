import { describe, expect, test } from "bun:test";
import type { ProcState } from "@toyon/shared";
import { health } from "./health.ts";

const proc = (name: string, status: ProcState["status"], port = 3000): ProcState => ({
  name,
  command: `run ${name}`,
  port,
  status,
});

describe("health", () => {
  test("offline outranks everything and offers no restart", () => {
    const h = health(false, [proc("web", "crashed")]);
    expect(h.level).toBe("offline");
    expect(h.restart).toEqual([]);
  });

  test("all running is ok and names the ports", () => {
    const h = health(true, [proc("web", "running", 3000), proc("api", "running", 4000)]);
    expect(h.level).toBe("ok");
    expect(h.tip).toBe("Connected · web :3000, api :4000");
  });

  test("worst proc wins; starting is not restartable", () => {
    const h = health(true, [proc("web", "starting"), proc("api", "crashed", 4000), proc("db", "stopped", 5432)]);
    expect(h.level).toBe("crashed");
    expect(h.restart).toEqual(["api", "db"]);
    expect(h.label).toBe("3 procs crashed");
    expect(h.tip).toEndWith("· click to open its tab");
  });

  test("a lone starting proc has no click action", () => {
    const h = health(true, [proc("web", "starting")]);
    expect(h.level).toBe("starting");
    expect(h.label).toBe("web starting");
    expect(h.tip).toBe("web starting on :3000");
  });
});
