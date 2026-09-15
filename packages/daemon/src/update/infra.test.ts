import { describe, expect, test } from "bun:test";
import { installCommand, installMethod, runInstall } from "./infra.ts";

describe("installMethod", () => {
  test("reads the install from where the package sits", () => {
    expect(installMethod("/usr/local/lib/node_modules/toyon/package.json")).toBe("npm");
    expect(installMethod("/Users/a/.nvm/versions/node/v22.0.0/lib/node_modules/toyon/package.json")).toBe("npm");
    expect(installMethod("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\toyon\\package.json")).toBe("npm");
    expect(installMethod("/Users/a/.bun/install/global/node_modules/toyon/package.json")).toBe("bun");
    expect(installMethod("/Users/a/.npm/_npx/c8a4b33913bd17b0/node_modules/toyon/package.json")).toBe("npx");
  });

  test("no package, or one that is not an install, is nothing to update", () => {
    expect(installMethod(null)).toBe("none");
    expect(installMethod("/app/package.json")).toBe("none");
  });
});

describe("installCommand", () => {
  test("a global npm or bun install has one; an npx copy and the rest do not", () => {
    expect(installCommand("npm", "0.3.0")).toEqual(["npm", "install", "-g", "toyon@0.3.0"]);
    expect(installCommand("bun", "0.3.0")).toEqual(["bun", "add", "-g", "toyon@0.3.0"]);
    expect(installCommand("npx", "0.3.0")).toBeNull();
    expect(installCommand("none", "0.3.0")).toBeNull();
  });
});

describe("runInstall", () => {
  test("a failure keeps the line that says why, not npm's pointer to its log", async () => {
    const r = await runInstall([
      "sh",
      "-c",
      "echo 'npm error code EACCES' >&2; echo 'npm error A complete log of this run can be found in: /x.log' >&2; exit 1",
    ]);
    expect(r).toEqual({ ok: false, line: "npm error code EACCES" });
  });

  test("a command that is not there is a failure, not a throw", async () => {
    const r = await runInstall(["toyon-no-such-command"]);
    expect(r.ok).toBe(false);
  });
});
