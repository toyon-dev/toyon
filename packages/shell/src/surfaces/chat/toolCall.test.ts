import { describe, expect, test } from "bun:test";
import { diffLineKind, parseToolOutput, relPath, toolBlocks, toolLabel } from "./toolCall.ts";

describe("parseToolOutput", () => {
  test("splits prose from a fenced block and drops the fences", () => {
    const blocks = parseToolOutput("Locate the usages\n```console\nsrc/a.ts:19: hit\n```");
    expect(blocks).toEqual([
      { code: false, diff: false, text: "Locate the usages" },
      { code: true, diff: false, text: "src/a.ts:19: hit" },
    ]);
  });

  test("plain output stays one block", () => {
    expect(parseToolOutput("built in 99ms")).toEqual([{ code: false, diff: false, text: "built in 99ms" }]);
  });

  test("an unclosed fence still ends the block", () => {
    const blocks = parseToolOutput("note\n```\nrunning…");
    expect(blocks.map((b) => b.code)).toEqual([false, true]);
  });

  test("empty output has no blocks", () => {
    expect(parseToolOutput("")).toEqual([]);
    expect(parseToolOutput("```\n```")).toEqual([]);
  });

  test("marks git diffs, hunks and the daemon's own diff blocks", () => {
    expect(parseToolOutput("diff --git a/x b/x\n+one")[0]?.diff).toBe(true);
    expect(parseToolOutput("@@ -1,2 +1,3 @@\n+one")[0]?.diff).toBe(true);
    expect(parseToolOutput("--- src/a.ts\n-old\n+new")[0]?.diff).toBe(true);
    expect(parseToolOutput("```diff\n+one\n```")[0]?.diff).toBe(true);
  });

  test("output that merely starts lines with a dash is not a diff", () => {
    expect(parseToolOutput("usage:\n-v verbose\n-q quiet")[0]?.diff).toBe(false);
    expect(parseToolOutput("PLAN.md | 3 +--\n1 file changed")[0]?.diff).toBe(false);
  });
});

describe("diffLineKind", () => {
  test("headers beat the +/- they start with", () => {
    expect(diffLineKind("+++ b/index.html")).toBe("meta");
    expect(diffLineKind("--- a/index.html")).toBe("meta");
    expect(diffLineKind("@@ -12,14 +12,6 @@")).toBe("hunk");
    expect(diffLineKind("+ added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("del");
    expect(diffLineKind(" context")).toBe("");
  });

  test("the rest of git's file headers are meta too", () => {
    expect(diffLineKind("index 30a7cdc..1dbd6d8 100644")).toBe("meta");
    expect(diffLineKind("new file mode 100644")).toBe("meta");
    expect(diffLineKind("Binary files a/x and b/x differ")).toBe("meta");
    expect(diffLineKind("indexed by name")).toBe("");
  });
});

describe("toolLabel", () => {
  const wt = "/Users/k/.toyon/worktrees/cookbook/spare-0c0d";

  test("an agent that sends no name gets one from the call's kind", () => {
    const call = {
      name: "grep -rn dark .",
      title: "grep -rn dark .",
      toolKind: "search" as const,
      input: { command: "grep -rn dark ." },
    };
    expect(toolLabel(call)).toEqual({ name: "search", hint: "grep -rn dark .", command: "" });
  });

  test("the agent's description labels the row and the command moves into it", () => {
    const call = {
      name: "npm run build",
      title: "npm run build",
      toolKind: "execute" as const,
      input: { command: "npm run build", description: "Build the project" },
    };
    expect(toolLabel(call)).toEqual({ name: "run", hint: "Build the project", command: "npm run build" });
  });

  test("an agent that names its tools keeps the name, and the command is not repeated inside", () => {
    const call = { name: "Bash", title: "ls -la", toolKind: "execute" as const, input: { command: "ls -la" } };
    expect(toolLabel(call)).toEqual({ name: "Bash", hint: "ls -la", command: "" });
  });

  test("falls back to the title when there is no usable input", () => {
    expect(toolLabel({ name: "Task", title: "Explore the repo", input: null })).toEqual({
      name: "Task",
      hint: "Explore the repo",
      command: "",
    });
  });

  test("a title that only repeats the name leaves the row one word", () => {
    expect(toolLabel({ name: "think", title: "think", input: null })).toEqual({
      name: "think",
      hint: "",
      command: "",
    });
  });

  test("a file path is shown relative to the worktree", () => {
    const call = { name: "edit", title: "edit", toolKind: "edit" as const, input: { file_path: `${wt}/PLAN.md` } };
    expect(toolLabel(call, [wt])).toEqual({ name: "edit", hint: "PLAN.md", command: "" });
  });
});

describe("relPath", () => {
  test("strips a worktree root, and only a whole one", () => {
    expect(relPath("/a/b/src/x.ts", ["/a/b"])).toBe("src/x.ts");
    expect(relPath("/a/bc/src/x.ts", ["/a/b"])).toBe("/a/bc/src/x.ts");
    expect(relPath("/elsewhere/x.ts", ["/a/b"])).toBe("/elsewhere/x.ts");
    expect(relPath("npm run build", ["/a/b"])).toBe("npm run build");
  });
});

describe("toolBlocks", () => {
  const call = { name: "x", title: "x", input: { command: "npm run build", description: "Build the project" } };

  test("drops the description the adapter repeats as the output's first line", () => {
    expect(toolBlocks(call, "Build the project\n```console\nbuilt in 99ms\n```")).toEqual([
      { code: true, diff: false, text: "built in 99ms" },
    ]);
  });

  test("keeps prose the agent actually wrote", () => {
    expect(toolBlocks(call, "Nothing to build\n```console\nup to date\n```")).toEqual([
      { code: false, diff: false, text: "Nothing to build" },
      { code: true, diff: false, text: "up to date" },
    ]);
  });
});
