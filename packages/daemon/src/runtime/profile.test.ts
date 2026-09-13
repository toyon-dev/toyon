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
    const r = resolveRun(base, { id: "w" });
    expect(Object.keys(r.procs)).toEqual(["api", "web", "worker"]);
    expect(r.env).toEqual({});
    expect(r.preview).toBe("web");
    expect(r.profile).toBeUndefined();
  });

  test("no profiles: config.preview wins when it names a proc, else first proc", () => {
    expect(resolveRun({ ...base, config: { ...base.config, preview: "api" } }, { id: "w" }).preview).toBe("api");
    expect(resolveRun({ ...base, config: { run: { job: "j" } } }, { id: "w" }).preview).toBe("job");
  });

  test("a worktree without a profile runs the default; an explicit one narrows and orders the procs", () => {
    const d = resolveRun(withProfiles, { id: "w" });
    expect(Object.keys(d.procs)).toEqual(["web"]);
    expect(d.profile).toBe("staging");
    expect(d.env).toEqual({ VITE_ENVIRONMENT: "staging" });
    const f = resolveRun(withProfiles, { id: "w", profile: "full" });
    expect(Object.keys(f.procs)).toEqual(["api", "web"]);
    expect(f.preview).toBe("web");
    const j = resolveRun(withProfiles, { id: "w", profile: "jobs" });
    expect(Object.keys(j.procs)).toEqual(["worker", "api"]);
    expect(j.preview).toBe("api");
  });

  test("an unknown profile (file edited since) falls back to the default", () => {
    const r = resolveRun(withProfiles, { id: "w", profile: "gone" });
    expect(r.profile).toBe("staging");
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
