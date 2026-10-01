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
  test("level: the version, how it was installed, where updates come from, and a press asks there", () => {
    const row = versionRow("0.2.0", "npm", null, null, repos, false, "https://artifacts.example/api/npm/npm-packages/");
    expect(row.value).toBe("0.2.0");
    expect(row.text).toContain("installed with npm");
    expect(row.text).toContain("from artifacts.example");
    expect(row).toMatchObject({ act: "check", busy: false });
    // before the daemon has asked npm, the registry is the one npm is set up for, unnamed
    expect(versionRow("0.2.0", "npm", null, null, repos).text).toContain("from the npm registry");
  });

  test("a checkout does not update itself, and a press still asks what is out", () => {
    const row = versionRow("0.2.0", "none", null, null, repos);
    expect(row.value).toBe("0.2.0");
    expect(row.text).toContain("run from a checkout");
    expect(row.act).toBe("check");
  });

  test("a check is read on the chip: on its way, then what the registry said", () => {
    const checked = (install: "npm" | "none", check: Parameters<typeof versionRow>[7]) =>
      versionRow("0.2.0", install, null, null, repos, false, null, check);
    expect(checked("npm", "asking")).toMatchObject({ value: "0.2.0 checking", busy: true });
    const registry = "https://artifacts.example/api/npm/npm-packages/";
    const newest = checked("npm", { registry, latest: "0.2.0" });
    expect(newest).toMatchObject({ value: "0.2.0 newest", act: "check", busy: false });
    expect(newest.text).toContain("newest version artifacts.example lists");
    const silent = checked("npm", { registry, latest: null });
    expect(silent.value).toBe("0.2.0 no answer");
    expect(silent.text).toContain("Could not reach artifacts.example");
    const out = checked("none", { registry, latest: "0.3.0" });
    expect(out.value).toBe("0.3.0 out");
    expect(out.text).toContain("pull to get it");
  });

  test("an answer gives way to whatever happens next", () => {
    const check = { registry: "https://registry.npmjs.org/", latest: "0.2.0" };
    const row = versionRow("0.2.0", "none", null, self({ restart: true }), repos, false, null, check);
    expect(row.value).toBe("0.2.0 behind");
  });

  test("something out says so and a press installs it, unless this copy runs with npx", () => {
    expect(versionRow("0.2.0", "npm", update({ latest: "0.3.0" }), null, repos)).toMatchObject({
      value: "0.3.0 out",
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
      value: "0.3.0 installing",
      busy: true,
    });
    const held = versionRow("0.2.0", "npm", update({ installed: "0.3.0", restarting: ["fix login"] }), null, repos);
    expect(held).toMatchObject({ value: "0.3.0 restarting", busy: true });
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
    expect(row.value).toBe("0.2.0 update failed");
    expect(row.text).toContain("EACCES. Press");
    expect(row.text).toContain("npm install -g toyon@0.3.0");
    expect(row.act).toBe("update");
  });

  test("a checkout that moved on reads behind, and the press is whichever catch-up is next", () => {
    expect(versionRow("0.2.0", "none", null, self({ rebuild: true }), repos)).toMatchObject({
      value: "0.2.0 behind",
      act: "rebuild",
    });
    expect(versionRow("0.2.0", "none", null, self({ restart: true }), repos)).toMatchObject({
      value: "0.2.0 behind",
      act: "restart",
    });
    expect(versionRow("0.2.0", "none", null, self({ building: true }), repos)).toMatchObject({
      value: "0.2.0 rebuilding",
      busy: true,
    });
    const stopped = versionRow("0.2.0", "none", null, self({ buildFailed: "tsc: 3 errors" }), repos);
    expect(stopped).toMatchObject({ value: "0.2.0 rebuild stopped", act: "rebuild", detail: "tsc: 3 errors" });
  });

  test("a build this page watched finish reads rebuilt, and the press reloads the page", () => {
    expect(versionRow("0.2.0", "none", null, null, repos, true)).toMatchObject({
      value: "0.2.0 rebuilt",
      act: "reload",
      busy: false,
    });
  });

  test("an update on its way outranks the checkout notice: one thing is next, not two", () => {
    const row = versionRow("0.2.0", "npm", update({ installed: "0.3.0" }), self({ restart: true }), repos);
    expect(row.value).toBe("0.3.0 ready");
  });
});
