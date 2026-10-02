import { describe, expect, test } from "bun:test";
import { isTestPath, testsLast } from "./testFiles.ts";

describe("isTestPath", () => {
  test("a file named as a test is one, in each language's convention", () => {
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.jsx",
      "pkg/a_test.go",
      "spec_helper/a_spec.rb",
      "app/test_models.py",
      "app/conftest.py",
      "src/Button.snap",
      "src/main/UserServiceTest.java",
      "src/UserServiceTests.cs",
      "test.js",
    ])
      expect([p, isTestPath(p)]).toEqual([p, true]);
  });

  test("a file in a test folder is one, whatever it is called", () => {
    for (const p of ["packages/daemon/test/helpers/git.ts", "src/__tests__/a.ts", "e2e/login.ts", "Tests/a.swift"])
      expect([p, isTestPath(p)]).toEqual([p, true]);
  });

  test("an untracked test folder listed whole is one", () => {
    expect(isTestPath("src/__tests__/")).toBe(true);
    expect(isTestPath("src/new/")).toBe(false);
  });

  test("a name that only contains the word is not", () => {
    for (const p of ["src/Latest.ts", "src/contest.py", "src/testing.ts", "src/attest.go", "docs/inspect.md"])
      expect([p, isTestPath(p)]).toEqual([p, false]);
  });
});

describe("testsLast", () => {
  const list = (...paths: string[]) => paths.map((path) => ({ path }));

  test("tests move to the end and each half keeps its order", () => {
    const got = testsLast(list("a.test.ts", "a.ts", "b.test.ts", "b.ts"));
    expect(got.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "a.test.ts", "b.test.ts"]);
    expect(got.source).toBe(2);
  });

  test("a list of one kind comes back as it was", () => {
    const tests = list("a.test.ts", "b.test.ts");
    expect(testsLast(tests)).toEqual({ files: tests, source: 0 });
    expect(testsLast(tests).files).toBe(tests);
    const source = list("a.ts");
    expect(testsLast(source).files).toBe(source);
    expect(testsLast(source).source).toBe(1);
  });
});
