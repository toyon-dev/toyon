import { describe, expect, test } from "bun:test";
import { diffSeq } from "@toyon/shared";
import { mergeDiffs, netOfCalls } from "./mergeDiffs.ts";
import { parseToolOutput } from "./toolCall.ts";

/** the daemon's own generator (agent/acp/diff.ts), which is what produced every diff this composes.
 * Having it here lets a test say what it means: three versions of a file, the calls between them,
 * and the one diff the run should read as, which is the diff of the ends. */
function ud(oldText: string, newText: string, context = 3): string {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const ops = diffSeq(a, b).map((op) => ({ mark: op.mark, text: op.value }));
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.mark !== "+") o++;
    if (op.mark !== "-") n++;
  }
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.mark === " ") {
      k++;
      continue;
    }
    const start = k;
    let end = k;
    let j = k;
    while (j < ops.length) {
      if (ops[j]?.mark !== " ") {
        end = j;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run]?.mark === " ") run++;
      if (run > context * 2 || j + run >= ops.length) break;
      j += run;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context + 1);
    const body = ops.slice(from, to);
    out.push(
      `@@ -${oldNo[from]},${body.filter((x) => x.mark !== "+").length} +${newNo[from]},${
        body.filter((x) => x.mark !== "-").length
      } @@`,
      ...body.map((op) => `${op.mark}${op.text}`),
    );
    k = to;
  }
  return out.join("\n");
}

/** the run's calls, and what the whole run comes to */
function run(...versions: string[]): { calls: string[]; net: string } {
  const calls = versions.slice(1).map((after, i) => ud(versions[i]!, after));
  return { calls, net: ud(versions[0]!, versions.at(-1)!) };
}

const FILE = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11", "l12", "l13", "l14", "l15", "l16"];
const file = (...edits: [string, string][]) => {
  let text = FILE.join("\n");
  for (const [from, to] of edits) text = text.replace(from, to);
  return text;
};

describe("mergeDiffs", () => {
  test("two edits far apart come to the diff of the ends", () => {
    const { calls, net } = run(file(), file(["l2", "L2"]), file(["l2", "L2"], ["l14", "L14"]));
    expect(mergeDiffs(calls, 3)).toBe(net);
  });

  test("an edit above an earlier one is placed by where it was, not by where it landed", () => {
    const { calls, net } = run(file(), file(["l14", "L14"]), file(["l14", "L14"], ["l2", "L2"]));
    expect(mergeDiffs(calls, 3)).toBe(net);
  });

  test("an insertion carries the lines below it, so a later edit rebases onto the original", () => {
    const { calls, net } = run(file(), file(["l3", "INS\nl3"]), file(["l3", "INS\nl3"], ["l15", "L15"]));
    expect(mergeDiffs(calls, 3)).toBe(net);
  });

  test("edits in the same neighbourhood are one stretch, old side first", () => {
    const one = file(["l8", "L8"]);
    const two = file(["l8", "L8"], ["l9", "L9"]);
    const { calls, net } = run(file(), one, two, file(["l8", "L8"], ["l9", "L9"], ["l10", "L10"]));
    expect(mergeDiffs(calls, 3)).toBe(net);
  });

  test("a file written then adjusted is the file as it ended up, once", () => {
    const written = ["body {", "  background: #faf7f0;", "  color: #3a3530;", "}"].join("\n");
    const themed = ["body {", "  background: var(--bg);", "  color: var(--fg);", "}"].join("\n");
    const { calls, net } = run("", written, themed);
    expect(mergeDiffs(calls, 3)).toBe(net);
    expect(mergeDiffs(calls, 3)).toBe(
      ["@@ -1,0 +1,4 @@", "+body {", "+  background: var(--bg);", "+  color: var(--fg);", "+}"].join("\n"),
    );
  });

  test("a line the run added and then rewrote never reads as a line that was there", () => {
    const { calls, net } = run(file(), file(["l4", "NEW\nl4"]), file(["l4", "NEWER\nl4"]));
    expect(mergeDiffs(calls, 3)).toBe(net);
    expect(mergeDiffs(calls, 3)).not.toContain("-NEW");
  });

  test("a run that undid itself has no net change to show, so the calls stand", () => {
    const { calls } = run(file(), file(["l4", "NEW\nl4"]), file());
    expect(mergeDiffs(calls, 3)).toBeNull();
  });

  test("context is trimmed to what the row asks for", () => {
    expect(mergeDiffs([ud(file(), file(["l14", "L14"]))], 1)).toBe(
      ["@@ -13,3 +13,3 @@", " l13", "-l14", "+L14", " l15"].join("\n"),
    );
  });

  test("one call composes to itself", () => {
    const only = ud(file(), file(["l8", "L8"]));
    expect(mergeDiffs([only], 3)).toBe(only);
  });

  test("a deletion the second call makes to a line the first call left alone", () => {
    const { calls, net } = run(file(), file(["l3", "L3"]), file(["l3", "L3"]).replace("l12\n", ""));
    expect(mergeDiffs(calls, 3)).toBe(net);
  });

  describe("gives up rather than guess", () => {
    test("a block the daemon truncated mid-diff", () => {
      expect(mergeDiffs(["@@ -1,2 +1,2 @@\n l1\n-l2\n… (719 more chars)"])).toBeNull();
    });

    test("a diff that names files, which may be more than one of them", () => {
      expect(mergeDiffs(["diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b"])).toBeNull();
    });

    test("output that is not a diff at all", () => {
      expect(mergeDiffs(["applied the edit"])).toBeNull();
      expect(mergeDiffs([""])).toBeNull();
    });

    test("a call that disagrees about the line it is editing", () => {
      const first = ud(file(), file(["l4", "L4"]));
      expect(mergeDiffs([first, "@@ -4,1 +4,1 @@\n-nope\n+what"])).toBeNull();
    });

    test("hunks that do not run down the file", () => {
      expect(mergeDiffs(["@@ -9,1 +9,1 @@\n-l9\n+L9\n@@ -2,1 +2,1 @@\n-l2\n+L2"])).toBeNull();
    });
  });
});

describe("netOfCalls", () => {
  const out = (text: string) => parseToolOutput(text);
  const fenced = (patch: string) => out(`\`\`\`diff\n${patch}\n\`\`\``);
  const { calls, net } = run(FILE.join("\n"), file(["l2", "L2"]), file(["l2", "L2"], ["l14", "L14"]));

  test("a run of diffs is the change it came to", () => {
    expect(netOfCalls(calls.map(fenced))).toBe(net);
  });

  test("one call is the call, which the row already prints", () => {
    expect(netOfCalls([fenced(calls[0]!)])).toBeNull();
  });

  test("a call that wrote more than its diff keeps the row on its calls", () => {
    const wordy = out(`Rewrote the header\n\`\`\`diff\n${calls[1]}\n\`\`\``);
    expect(netOfCalls([fenced(calls[0]!), wordy])).toBeNull();
  });

  test("a run of reads has no diffs to compose", () => {
    expect(netOfCalls([out("l1\nl2\nl3"), out("l4\nl5\nl6")])).toBeNull();
  });
});
