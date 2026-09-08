import { describe, expect, test } from "bun:test";
import type { ProcState } from "@toyon/shared";
import { procTrouble, splitPath } from "./util.ts";

const proc = (name: string, status: ProcState["status"], port = 3000): ProcState => ({
  name,
  command: `run ${name}`,
  port,
  status,
});

describe("splitPath", () => {
  test("a file at the root is all name", () => {
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
  test("the name leads and the rest is the directory", () => {
    expect(splitPath("packages/shell/vite.config.ts")).toEqual({ name: "vite.config.ts", dir: "packages/shell" });
  });
  test("a dotted directory keeps its dot on the front", () => {
    expect(splitPath(".claude/settings.json")).toEqual({ name: "settings.json", dir: ".claude" });
  });
});

describe("procTrouble", () => {
  test("nothing to say while the procs are alive or on their way", () => {
    expect(procTrouble([])).toBeNull();
    expect(procTrouble([proc("web", "running"), proc("api", "starting", 4000)])).toBeNull();
  });

  test("a stopped proc is not trouble: you or a clean exit did that", () => {
    expect(procTrouble([proc("web", "stopped")])).toBeNull();
  });

  test("a crash names the proc and its port, and points at its tab", () => {
    const t = procTrouble([proc("web", "running"), proc("api", "crashed", 4000)]);
    expect(t?.stream).toBe("api");
    expect(t?.tip).toBe("api crashed on :4000 · click to open its tab");
  });

  test("several crashes all get named; the first one owns the click", () => {
    const t = procTrouble([proc("web", "crashed", 3000), proc("api", "crashed", 4000)]);
    expect(t?.dead.map((p) => p.name)).toEqual(["web", "api"]);
    expect(t?.stream).toBe("web");
    expect(t?.tip).toStartWith("web crashed on :3000, api crashed on :4000");
  });
});
