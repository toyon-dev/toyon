import { describe, expect, test } from "bun:test";
import { changedTests } from "./testNames.ts";

const said = (path: string, before: string, after: string) =>
  changedTests(path, before, after).map((t) => `${t.change} ${[...t.group, t.name].join(" / ")} @${t.line}`);

const JS = `import { expect, test } from "bun:test";

describe("sum", () => {
  test("adds two numbers", () => {
    expect(sum(1, 2)).toBe(3);
  });

  test("takes none", () => {
    expect(sum()).toBe(0);
  });
});
`;

describe("changedTests", () => {
  test("a new file's tests are all added, each under its group", () => {
    expect(said("a.test.ts", "", JS)).toEqual(["added sum / adds two numbers @4", "added sum / takes none @8"]);
  });

  test("a deleted file's tests are all removed", () => {
    expect(said("a.test.ts", JS, "")).toEqual(["removed sum / adds two numbers @1", "removed sum / takes none @1"]);
  });

  test("only the test whose body moved is changed", () => {
    expect(said("a.test.ts", JS, JS.replace("toBe(0)", "toBe(1)"))).toEqual(["changed sum / takes none @8"]);
  });

  test("a change outside every test names none", () => {
    expect(said("a.test.ts", JS, JS.replace("bun:test", "vitest"))).toEqual([]);
  });

  test("a removed test sits where the test before it ends, ahead of what follows", () => {
    const after = JS.replace(/ {2}test\("adds[\s\S]*?\n {2}}\);\n\n/, "").replace("toBe(0)", "toBe(1)");
    expect(said("a.test.ts", JS, after)).toEqual(["removed sum / adds two numbers @1", "changed sum / takes none @4"]);
    const tail = JS.replace(/\n {2}test\("takes[\s\S]*?\n {2}}\);\n/, "");
    expect(said("a.test.ts", JS, tail)).toEqual(["removed sum / takes none @7"]);
  });

  test("a renamed test is one removed and one added", () => {
    expect(said("a.test.ts", JS, JS.replace("takes none", "takes nothing"))).toEqual([
      "removed sum / takes none @7",
      "added sum / takes nothing @8",
    ]);
  });

  test("a test moved into a group is that group's, and its body is the same body", () => {
    const flat = `test("a", () => {\n  expect(1).toBe(1);\n});\n`;
    const held = `describe("g", () => {\n  test("a", () => {\n    expect(1).toBe(1);\n  });\n});\n`;
    expect(said("a.test.ts", flat, held)).toEqual(["removed a @1", "added g / a @2"]);
  });

  test("modifiers and each are read through, and a name twice is two tests", () => {
    const text = `it.only('one', () => {});\ntest.each([["a"], ["b"]])("row %s", (x) => {});\ntest("dup", () => {});\ntest("dup", () => {});\n`;
    expect(said("a.spec.js", "", text)).toEqual(["added one @1", "added row %s @2", "added dup @3", "added dup @4"]);
  });

  test("python: test functions, and the class that holds them", () => {
    const text = `def helper():\n    pass\n\nclass TestSum:\n    def test_adds(self):\n        assert sum(1, 2) == 3\n\nasync def test_alone():\n    pass\n`;
    expect(said("test_sum.py", "", text)).toEqual(["added TestSum / test_adds @5", "added test_alone @8"]);
  });

  test("go: a subtest is named under its function, and a helper's is not", () => {
    const text = `func TestSum(t *testing.T) {\n\tt.Run("adds", func(t *testing.T) {\n\t})\n}\n\nfunc helper(t *testing.T) {\n\tt.Run("inner", func(t *testing.T) {})\n}\n`;
    expect(said("sum_test.go", "", text)).toEqual(["added TestSum @1", "added TestSum / adds @2", "added inner @7"]);
  });

  test("a marked language counts only what follows its mark", () => {
    const rs = `fn helper() {}\n\n#[test]\nfn adds() {\n    assert_eq!(1, 1);\n}\n`;
    expect(said("tests/sum.rs", "", rs)).toEqual(["added adds @4"]);
    const kt = "class SumTest {\n    @Test\n    fun `adds two`() {\n    }\n\n    fun helper() {}\n}\n";
    expect(said("SumTest.kt", "", kt)).toEqual(["added adds two @3"]);
  });

  test("ruby: examples under what describes them", () => {
    const text = `RSpec.describe Sum do\n  context "with two" do\n    it "adds" do\n    end\n  end\nend\n`;
    expect(said("sum_spec.rb", "", text)).toEqual(["added Sum / with two / adds @3"]);
  });

  test("a language with no rule names nothing", () => {
    expect(said("a_test.zig", "", 'test "x" {}')).toEqual([]);
  });
});
