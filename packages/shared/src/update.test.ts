import { describe, expect, test } from "bun:test";
import { installCommand, installMethod, newer, registryHost, restartCommand } from "./update.ts";

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

describe("restartCommand", () => {
  test("an npx copy names itself, since the toyon on PATH is another install or none", () => {
    expect(restartCommand("npx", "0.9.0")).toBe("npx toyon@0.9.0 restart");
    expect(restartCommand("npm", "0.9.0")).toBe("toyon restart");
    expect(restartCommand("bun", "0.9.0")).toBe("toyon restart");
    expect(restartCommand("none", "0.9.0")).toBe("toyon restart");
  });

  test("an npx copy beside a global install moves that install, from the registry npx used", () => {
    expect(restartCommand("npx", "0.9.0", "npm", "https://registry.npmjs.org/")).toBe(
      "npm install -g toyon@0.9.0 --registry=https://registry.npmjs.org/ && toyon restart",
    );
    expect(restartCommand("npx", "0.9.0", "bun")).toBe("bun add -g toyon@0.9.0 && toyon restart");
    expect(restartCommand("npm", "0.9.0", "npm", "https://registry.npmjs.org/")).toBe("toyon restart");
  });
});

describe("registryHost", () => {
  test("a registry is named by its host, and nothing known is the npm registry", () => {
    expect(registryHost("https://artifacts.dropbox.dev/artifactory/api/npm/npm-packages/")).toBe(
      "artifacts.dropbox.dev",
    );
    expect(registryHost("https://registry.npmjs.org/")).toBe("registry.npmjs.org");
    expect(registryHost("the npm registry")).toBe("the npm registry");
    expect(registryHost(null)).toBe("the npm registry");
    expect(registryHost("")).toBe("the npm registry");
  });
});

describe("newer", () => {
  test("compares each part as a number, not as text", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.2.0", "0.2.1")).toBe(false);
  });

  test("a prerelease is older than its release", () => {
    expect(newer("0.3.0", "0.3.0-beta.1")).toBe(true);
    expect(newer("0.3.0-beta.1", "0.3.0")).toBe(false);
    expect(newer("0.3.0-beta.2", "0.3.0-beta.1")).toBe(true);
    expect(newer("0.3.0-beta.1", "0.2.9")).toBe(true);
  });

  test("anything that is not a version is never newer", () => {
    expect(newer("latest", "0.2.0")).toBe(false);
    expect(newer("0.3.0", "")).toBe(false);
  });
});
