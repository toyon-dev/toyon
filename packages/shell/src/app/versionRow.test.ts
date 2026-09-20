import { describe, expect, test } from "bun:test";
import type { RepoInfo, SelfState, UpdateState } from "@toyon/shared";
import { versionRow } from "./versionRow.ts";

const update = (over: Partial<UpdateState> = {}): UpdateState => ({
  running: "0.2.0",
  latest: null,
  installed: null,
  method: "npm",
  installing: false,
  failed: null,
  restarting: null,
  ...over,
});

const self = (over: Partial<SelfState> = {}): SelfState => ({
  repoId: "r1",
  rebuild: false,
  restart: false,
  building: false,
  ...over,
});

const repos = [{ id: "r1", name: "toyon", defaultBranch: "main" } as RepoInfo];

describe("versionRow", () => {
  test("level: the version, how it was installed, and a press asks the registry", () => {
    const row = versionRow("0.2.0", "npm", null, null, repos);
    expect(row.value).toBe("0.2.0");
    expect(row.text).toContain("installed with npm");
    expect(row).toMatchObject({ act: "check", busy: false });
  });

  test("a checkout has nothing to press for: it updates by landing on its own branch", () => {
    const row = versionRow("0.2.0", "none", null, null, repos);
    expect(row.value).toBe("0.2.0");
    expect(row.text).toContain("run from a checkout");
    expect(row.act).toBeNull();
  });

  test("something out says so and a press installs it, unless this copy runs with npx", () => {
    expect(versionRow("0.2.0", "npm", update({ latest: "0.3.0" }), null, repos)).toMatchObject({
      value: "0.2.0, 0.3.0 out",
      act: "update",
      busy: false,
    });
    const npx = versionRow("0.2.0", "npx", update({ latest: "0.3.0", method: "npx" }), null, repos);
    expect(npx.text).toContain("npx toyon@0.3.0");
  });

  test("an install waiting on a restart names it ready, and a press restarts", () => {
    expect(versionRow("0.2.0", "npm", update({ installed: "0.3.0" }), null, repos)).toMatchObject({
      value: "0.3.0 ready",
      act: "restart",
      busy: false,
    });
  });

  test("an install or a held restart is busy, and takes no press", () => {
    expect(versionRow("0.2.0", "npm", update({ latest: "0.3.0", installing: true }), null, repos)).toMatchObject({
      value: "0.3.0, installing",
      busy: true,
    });
    const held = versionRow("0.2.0", "npm", update({ installed: "0.3.0", restarting: ["fix login"] }), null, repos);
    expect(held).toMatchObject({ value: "0.3.0, restarting", busy: true });
    expect(held.text).toContain("fix login");
    const going = versionRow("0.2.0", "npm", update({ installed: "0.3.0", restarting: [] }), null, repos);
    expect(going.text).toContain("reloads");
  });

  test("a failed install says why, what to run, and a press tries again", () => {
    const row = versionRow(
      "0.2.0",
      "npm",
      update({
        latest: "0.3.0",
        failed: { version: "0.3.0", line: "npm error code EACCES.", command: "npm install -g toyon@0.3.0" },
      }),
      null,
      repos,
    );
    expect(row.value).toBe("0.2.0, update failed");
    expect(row.text).toContain("EACCES. Press");
    expect(row.text).toContain("npm install -g toyon@0.3.0");
    expect(row.act).toBe("update");
  });

  test("a checkout that moved on reads behind, and the press is whichever catch-up is next", () => {
    expect(versionRow("0.2.0", "none", null, self({ rebuild: true }), repos)).toMatchObject({
      value: "0.2.0, behind",
      act: "rebuild",
    });
    expect(versionRow("0.2.0", "none", null, self({ restart: true }), repos)).toMatchObject({
      value: "0.2.0, behind",
      act: "restart",
    });
    expect(versionRow("0.2.0", "none", null, self({ building: true }), repos)).toMatchObject({
      value: "0.2.0, rebuilding",
      busy: true,
    });
    const stopped = versionRow("0.2.0", "none", null, self({ buildFailed: "tsc: 3 errors" }), repos);
    expect(stopped).toMatchObject({ value: "0.2.0, rebuild stopped", act: "rebuild", detail: "tsc: 3 errors" });
  });

  test("an update on its way outranks the checkout notice: one thing is next, not two", () => {
    const row = versionRow("0.2.0", "npm", update({ installed: "0.3.0" }), self({ restart: true }), repos);
    expect(row.value).toBe("0.3.0 ready");
  });
});
