import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import { expandEnv, resolveRun } from "./profile.ts";

const base: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: { run: { api: "a", web: "w", worker: "k" } },
  configFile: ".toyon/settings.json",
  needsSetup: false,
};
const withProfiles: RepoInfo = {
  ...base,
  config: {
    ...base.config,
    profiles: {
      full: { run: ["api", "web"], env: { VITE_BACKEND_URL: "$API_URL" } },
      staging: { run: ["web"], env: { VITE_ENVIRONMENT: "staging" } },
      jobs: { run: ["worker", "api"], preview: "api" },
    },
    defaultProfile: "staging",
  },
};

describe("resolveRun", () => {
  test("no profiles: every proc, no env, web previews", () => {
    const r = resolveRun(base, { id: "w", kind: "worktree" });
    expect(Object.keys(r.procs)).toEqual(["api", "web", "worker"]);
    expect(r.env).toEqual({});
    expect(r.preview).toBe("web");
    expect(r.profile).toBeUndefined();
  });

  test("no profiles: config.preview wins when it names a proc, else first proc", () => {
    expect(
      resolveRun({ ...base, config: { ...base.config, preview: "api" } }, { id: "w", kind: "worktree" }).preview,
    ).toBe("api");
    expect(resolveRun({ ...base, config: { run: { job: "j" } } }, { id: "w", kind: "worktree" }).preview).toBe("job");
  });

  test("a worktree without a profile runs the default; an explicit one narrows and orders the procs", () => {
    const d = resolveRun(withProfiles, { id: "w", kind: "worktree" });
    expect(Object.keys(d.procs)).toEqual(["web"]);
    expect(d.profile).toBe("staging");
    expect(d.env).toEqual({ VITE_ENVIRONMENT: "staging" });
    const f = resolveRun(withProfiles, { id: "w", kind: "worktree", profile: "full" });
    expect(Object.keys(f.procs)).toEqual(["api", "web"]);
    expect(f.preview).toBe("web");
    const j = resolveRun(withProfiles, { id: "w", kind: "worktree", profile: "jobs" });
    expect(Object.keys(j.procs)).toEqual(["worker", "api"]);
    expect(j.preview).toBe("api");
  });

  test("an unknown profile (file edited since) falls back to the default", () => {
    const r = resolveRun(withProfiles, { id: "w", kind: "worktree", profile: "gone" });
    expect(r.profile).toBe("staging");
  });
});

describe("resolveRun and the shared tier", () => {
  const tiered: RepoInfo = {
    ...base,
    config: {
      run: {
        web: "w",
        api: { cmd: "a", from: "trunk", paths: ["server/**"] },
        db: { cmd: "d", from: "trunk", paths: [] },
      },
    },
  };

  test("the long form is a command like any other, and marks the shared tier with its paths", () => {
    const r = resolveRun(tiered, { id: "w", kind: "worktree" });
    expect(r.procs).toEqual({ web: "w", api: "a", db: "d" });
    expect(r.shared).toEqual(["api", "db"]);
    expect(r.paths).toEqual({ api: ["server/**"], db: [] });
    expect(r.preview).toBe("web");
  });

  test("a worktree borrows what it does not own; main borrows nothing", () => {
    expect(resolveRun(tiered, { id: "w", kind: "worktree" }).borrowed).toEqual(["api", "db"]);
    expect(resolveRun(tiered, { id: "w", kind: "worktree", owns: ["api"] }).borrowed).toEqual(["db"]);
    expect(resolveRun(tiered, { id: "w", kind: "spare" }).borrowed).toEqual(["api", "db"]);
    expect(resolveRun(tiered, { id: "m", kind: "main" }).borrowed).toEqual([]);
    expect(resolveRun(tiered, { id: "m", kind: "main" }).shared).toEqual(["api", "db"]);
  });

  test("a profile narrows the shared tier with the rest", () => {
    const r = resolveRun(
      { ...tiered, config: { ...tiered.config, profiles: { fe: { run: ["web", "api"] } }, defaultProfile: "fe" } },
      { id: "w", kind: "worktree" },
    );
    expect(Object.keys(r.procs)).toEqual(["web", "api"]);
    expect(r.borrowed).toEqual(["api"]);
  });
});

describe("expandEnv", () => {
  test("replaces $VAR and ${VAR} from vars and leaves unknown refs alone", () => {
    const vars = { API_URL: "http://127.0.0.1:1" };
    expect(expandEnv({ A: "$API_URL", B: "x-${API_URL}-y", C: "$HOME/$NOPE", D: "plain" }, vars)).toEqual({
      A: "http://127.0.0.1:1",
      B: "x-http://127.0.0.1:1-y",
      C: "$HOME/$NOPE",
      D: "plain",
    });
  });
});
