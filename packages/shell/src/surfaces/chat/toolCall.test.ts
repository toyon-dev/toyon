import { describe, expect, test } from "bun:test";
import type { ToolKind } from "@toyon/shared";
import { composing, diffLineKind, diffLines, parseToolOutput, relPath, toolBlocks, toolLabel } from "./toolCall.ts";

describe("parseToolOutput", () => {
  test("splits prose from a fenced block and drops the fences", () => {
    const blocks = parseToolOutput("Locate the usages\n```console\nsrc/a.ts:19: hit\n```");
    expect(blocks).toEqual([
      { code: false, diff: false, lang: "", text: "Locate the usages" },
      { code: true, diff: false, lang: "console", text: "src/a.ts:19: hit" },
    ]);
  });

  test("plain output stays one block", () => {
    expect(parseToolOutput("built in 99ms")).toEqual([{ code: false, diff: false, lang: "", text: "built in 99ms" }]);
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

describe("diffLines", () => {
  test("drops the marker column and the file headers, keeping the kinds", () => {
    const block = ["--- a/src/x.ts", "@@ -1,3 +1,3 @@", " keep me", "-was", "+is"].join("\n");
    expect(diffLines(block)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "", text: "keep me" },
      // two lines with nothing in common: the band is the whole of what each says
      { kind: "del", text: "was", spans: [] },
      { kind: "add", text: "is", spans: [] },
    ]);
  });

  test("keeps git's own per-file header, since a block can cover several", () => {
    expect(diffLines("diff --git a/x b/x\nindex 1a2b3c4..5d6e7f8 100644\n+one")).toEqual([
      { kind: "meta", text: "diff --git a/x b/x" },
      { kind: "add", text: "one", spans: [] },
    ]);
  });

  test("a line rewritten in place marks the words that differ, not the line", () => {
    const lines = diffLines(['-  assert metrics[0]["visibility"]', '+  assert metrics[1]["visibility"]'].join("\n"));
    expect(lines.map((l) => l.spans)).toEqual([
      [
        { text: "  assert metrics[", changed: false },
        { text: "0", changed: true },
        { text: ']["visibility"]', changed: false },
      ],
      [
        { text: "  assert metrics[", changed: false },
        { text: "1", changed: true },
        { text: ']["visibility"]', changed: false },
      ],
    ]);
  });

  test("two lines with nothing in common are two whole changes, marked by the band alone", () => {
    const lines = diffLines(["-const port = 3000;", '+import { serve } from "bun";'].join("\n"));
    expect(lines.map((l) => l.spans)).toEqual([[], []]);
  });

  test("a rewrite that dropped a line lines the rest of itself back up", () => {
    const block = [
      "-.image-header img {",
      "-    height: 75px;",
      "-    filter: brightness(var(--logo-brightness));",
      "-}",
      "+.image-header img {",
      "+    height: 75px;",
      "+}",
    ].join("\n");
    const marked = diffLines(block).map((l) => l.spans?.some((s) => s.changed) ?? false);
    // only the line that went is the change; the three around it carried over
    expect(marked).toEqual([false, false, true, false, false, false, false]);
  });

  test("a file added whole is one band, not a mark on every line of it as well", () => {
    const lines = diffLines(["+const a = 1;", "+const b = 2;", "+"].join("\n"));
    expect(lines.map((l) => l.spans)).toEqual([[], [], []]);
  });

  test("a blank line that came or went is the band alone", () => {
    expect(diffLines("+").map((l) => l.spans)).toEqual([[]]);
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

  test("an unnamed semantic call keeps its title as the row detail", () => {
    expect(
      toolLabel({
        name: "",
        title: "Read file '/repo/src/app.ts'",
        toolKind: "read",
        input: { locations: [{ path: "/repo/src/app.ts" }] },
      }),
    ).toEqual({
      label: "read",
      name: "",
      icon: "book",
      hint: "Read file '/repo/src/app.ts'",
      command: "",
    });
  });

  test("an agent that sends no name gets one from the call's kind", () => {
    const call = {
      name: "grep -rn dark .",
      title: "grep -rn dark .",
      toolKind: "search" as const,
      input: { command: "grep -rn dark ." },
    };
    expect(toolLabel(call)).toEqual({
      label: "search",
      name: "",
      icon: "search",
      hint: "grep -rn dark .",
      command: "",
    });
  });

  test("the agent's description labels the row and the command moves into it", () => {
    const call = {
      name: "npm run build",
      title: "npm run build",
      toolKind: "execute" as const,
      input: { command: "npm run build", description: "Build the project" },
    };
    expect(toolLabel(call)).toEqual({
      label: "run",
      name: "",
      icon: "run",
      hint: "Build the project",
      command: "npm run build",
    });
  });

  test("an agent that names its tools keeps the name, and the command is not repeated inside", () => {
    const call = { name: "Bash", title: "ls -la", toolKind: "execute" as const, input: { command: "ls -la" } };
    expect(toolLabel(call)).toEqual({ label: "run", name: "Bash", icon: "folder", hint: "ls -la", command: "" });
  });

  test("falls back to the title when there is no usable input", () => {
    expect(toolLabel({ name: "Task", title: "Explore the repo", input: null })).toEqual({
      label: "tool",
      name: "Task",
      icon: "dot",
      hint: "Explore the repo",
      command: "",
    });
  });

  test("a network ask reads as the host it asked for, under a globe and nothing else", () => {
    const call = {
      name: "",
      title: "registry.npmjs.org",
      toolKind: "fetch" as const,
      input: { host: "registry.npmjs.org" },
    };
    expect(toolLabel(call)).toEqual({
      label: "fetch",
      name: "",
      icon: "globe",
      hint: "registry.npmjs.org",
      command: "",
    });
  });

  test("toyon's own rows print the glyph and the command, never their tool name", () => {
    const shell = { name: "shell", title: undefined, toolKind: "execute" as const, input: { command: "git status" } };
    expect(toolLabel(shell)).toEqual({ label: "run", name: "", icon: "branch", hint: "git status", command: "" });
    const check = {
      name: "check",
      title: undefined,
      toolKind: "execute" as const,
      input: { command: "bun run check" },
    };
    expect(toolLabel(check)).toEqual({ label: "run", name: "", icon: "run", hint: "bun run check", command: "" });
  });

  test("a title that only repeats the name leaves the row one word", () => {
    expect(toolLabel({ name: "think", title: "think", input: null })).toEqual({
      label: "tool",
      name: "think",
      icon: "dot",
      hint: "",
      command: "",
    });
  });

  test("a kind no longer in ACP (an old transcript line) falls back to the generic row", () => {
    const call = {
      name: "compile main.c",
      title: "compile main.c",
      toolKind: "compile" as unknown as ToolKind,
      input: { command: "cc main.c" },
    };
    expect(toolLabel(call)).toEqual({ label: "tool", name: "", icon: "dot", hint: "cc main.c", command: "" });
  });

  test("a call whose input has not streamed yet says what is being written, not the tool's name", () => {
    // the adapter's placeholder rows: Bash before its command closes, Write before its path
    expect(composing({ name: "Terminal", title: "Terminal", toolKind: "execute", input: {} })).toBe(
      "writing the command",
    );
    expect(composing({ name: "Preparing file…", title: "Preparing file…", toolKind: "edit", input: {} })).toBe(
      "writing the change",
    );
    expect(composing({ name: "Read File", title: "Read File", toolKind: "read", input: { locations: [] } })).toBe(
      "writing the path",
    );
    // the input landing ends it: the row has a path to print
    expect(composing({ name: "Edit", title: "Edit x.ts", toolKind: "edit", input: { file_path: "/r/x.ts" } })).toBe("");
    // a call with nothing to write is whole on arrival, however empty its input
    expect(
      composing({ name: "Compact conversation", title: "Compact conversation", toolKind: "think", input: {} }),
    ).toBe("");
    expect(composing({ name: "tool", title: "tool", input: {} })).toBe("");
  });

  test("the glyph follows the command's verb where the kind only says `run`", () => {
    const call = {
      name: "Bash",
      title: "grep -rn dark .",
      toolKind: "execute" as const,
      input: { command: "grep -rn dark ." },
    };
    expect(toolLabel(call).icon).toBe("search");
    expect(toolLabel({ ...call, input: { command: "/usr/bin/git commit -m x" } }).icon).toBe("branch");
    expect(toolLabel({ ...call, input: { command: "rm -rf dist" } }).icon).toBe("trash");
    // a verb with no entry, and a kind the agent named itself, both keep the kind's own glyph
    expect(toolLabel({ ...call, input: { command: "bun run check" } }).icon).toBe("run");
    expect(toolLabel({ ...call, toolKind: "read", input: { command: "cat x" } }).icon).toBe("book");
  });

  test("a file path is shown relative to the worktree", () => {
    const call = { name: "edit", title: "edit", toolKind: "edit" as const, input: { file_path: `${wt}/PLAN.md` } };
    expect(toolLabel(call, [wt])).toEqual({ label: "edit", name: "", icon: "edit", hint: "PLAN.md", command: "" });
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
      { code: true, diff: false, lang: "console", text: "built in 99ms" },
    ]);
  });

  test("keeps prose the agent actually wrote", () => {
    expect(toolBlocks(call, "Nothing to build\n```console\nup to date\n```")).toEqual([
      { code: false, diff: false, lang: "", text: "Nothing to build" },
      { code: true, diff: false, lang: "console", text: "up to date" },
    ]);
  });

  // a command that printed nothing, and one whose whole output was the description: the row has
  // nothing to draw under it, and drawing the panel anyway was an empty bar under the command
  test("a call with nothing left to show has no blocks", () => {
    expect(toolBlocks(call, "\n \n")).toEqual([]);
    expect(toolBlocks(call, "Build the project")).toEqual([]);
  });
});
