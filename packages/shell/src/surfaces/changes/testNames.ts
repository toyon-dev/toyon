// What a change to a test file tests: the tests it added, changed and removed, by name. Read from
// the two sides of the file the editor already holds, a line at a time, so it costs no parser and
// no trip to the daemon. A name the rules below do not see is simply not listed; the diff is still
// the row above it.

/** how one language writes a test. `group` is what holds tests and lends them its name; with a
 * `mark`, a test counts only on the mark's line or the few after it (`@Test`, `#[test]`). Each
 * expression names what it found in a `name` group. */
interface Lang {
  tests: RegExp[];
  groups?: RegExp[];
  mark?: RegExp;
}

const QUOTED = "(?<q>[\"'`])(?<name>(?:\\\\.|(?!\\k<q>).)*)\\k<q>";

/** `test("name"`, `it.only("name"`, and `test.each(rows)("name"` */
const CALL: Lang = {
  tests: [new RegExp(`^\\s*(?:test|it)(?:\\.(?!each\\b)\\w+)*(?:\\.each\\(.*\\))?\\(\\s*${QUOTED}`)],
  groups: [new RegExp(`^\\s*describe(?:\\.(?!each\\b)\\w+)*(?:\\.each\\(.*\\))?\\(\\s*${QUOTED}`)],
};

const LANGS: Record<string, Lang> = {
  js: CALL,
  py: {
    tests: [/^\s*(?:async\s+)?def\s+(?<name>test\w*)\s*\(/],
    groups: [/^\s*class\s+(?<name>Test\w*)/],
  },
  go: {
    // a subtest sits inside its function, which is what names it
    tests: [/^func\s+(?<name>(?:Test|Benchmark|Fuzz|Example)\w*)\s*\(/, /^\s+\w+\.Run\(\s*"(?<name>(?:\\.|[^"\\])*)"/],
  },
  rs: {
    mark: /^\s*#\[(?:\w+::)*(?:test|rstest|test_case)\b/,
    tests: [/\bfn\s+(?<name>\w+)/],
  },
  jvm: {
    mark: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/,
    tests: [/\b(?:void|fun)\s+(?<name>`[^`]+`|\w+)\s*\(/],
  },
  cs: {
    mark: /^\s*\[(?:Test|TestCase|Fact|Theory|TestMethod)\b/,
    tests: [/\b(?:void|Task)\s+(?<name>\w+)\s*\(/],
  },
  rb: {
    tests: [new RegExp(`^\\s*(?:it|specify|test|scenario)\\s*\\(?\\s*${QUOTED}`), /^\s*def\s+(?<name>test_\w+)/],
    groups: [/^\s*(?:RSpec\.)?(?:describe|context|feature)\s*\(?\s*(?<name>"[^"]*"|'[^']*'|[\w:]+)/],
  },
  exs: {
    tests: [/^\s*test\s+"(?<name>(?:\\.|[^"\\])*)"/],
    groups: [/^\s*describe\s+"(?<name>(?:\\.|[^"\\])*)"/],
  },
  swift: { tests: [/^\s*(?:@Test\s+)?func\s+(?<name>test\w*)\s*\(/] },
  php: { tests: [/\bfunction\s+(?<name>test\w*)\s*\(/, ...CALL.tests] },
};

const BY_EXT: Record<string, string> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  py: "py",
  go: "go",
  rs: "rs",
  java: "jvm",
  kt: "jvm",
  cs: "cs",
  rb: "rb",
  exs: "exs",
  swift: "swift",
  php: "php",
};

/** how many lines under a mark its test may start on: other annotations sit between them */
const MARK_REACH = 3;
/** the line that ends a block opened on a test's own line */
const CLOSER = /^\s*(?:[)}\]]|end\b)/;

interface Found {
  /** the names of what holds it, outermost first */
  group: string[];
  name: string;
  /** where it starts and the line after it ends, counted from 0 */
  line: number;
  end: number;
  /** its lines without their indent, so a test moved into a group reads as the same test */
  body: string;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function nameIn(line: string, exprs: readonly RegExp[] | undefined): string | null {
  for (const re of exprs ?? []) {
    const name = re.exec(line)?.groups?.name;
    if (name !== undefined) return name.replace(/^(["'`])(.*)\1$/, "$2");
  }
  return null;
}

/** every test in a file, in its order. Nesting and extent are read from the indent: what is
 * indented under a test or a group is inside it, and the first line back at its indent ends it. */
function find(lang: Lang, text: string): Found[] {
  const lines = text.split("\n");
  const out: Found[] = [];
  const holders: { indent: number; name: string }[] = [];
  let marked = Number.NEGATIVE_INFINITY;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const indent = indentOf(line);
    while (holders.length > 0 && (holders.at(-1)?.indent ?? 0) >= indent) holders.pop();
    if (lang.mark?.test(line)) marked = i;
    const isTest = !lang.mark || i - marked <= MARK_REACH;
    const test = isTest ? nameIn(line, lang.tests) : null;
    const name = test ?? nameIn(line, lang.groups);
    if (name === null) return;
    if (test !== null) {
      marked = Number.NEGATIVE_INFINITY;
      let end = i + 1;
      while (end < lines.length && (lines[end]?.trim() === "" || indentOf(lines[end] ?? "") > indent)) end++;
      if (end < lines.length && indentOf(lines[end] ?? "") === indent && CLOSER.test(lines[end] ?? "")) end++;
      const body = lines
        .slice(i, end)
        .map((l) => l.trim())
        .join("\n")
        .trim();
      out.push({ group: holders.map((h) => h.name), name, line: i, end, body });
    }
    holders.push({ indent, name });
  });
  return out;
}

/** one name per test: a name used twice under one group is told apart by which one it is */
function keyed(found: readonly Found[]): Map<string, Found> {
  const out = new Map<string, Found>();
  for (const t of found) {
    const key = [...t.group, t.name].join("\n");
    let n = 0;
    while (out.has(`${key}\n${n}`)) n++;
    out.set(`${key}\n${n}`, t);
  }
  return out;
}

export interface ChangedTest {
  name: string;
  /** the names of what holds it, outermost first */
  group: string[];
  change: "added" | "changed" | "removed";
  /** the line to show it at in the file as it is now, counted from 1. A removed test has none of
   * its own: it is where the test before it ends, which is where the diff draws what was taken. */
  line: number;
}

/** the tests a change touched, in the file's order. Empty for a language with no rule here. */
export function changedTests(path: string, before: string, after: string): ChangedTest[] {
  const lang = LANGS[BY_EXT[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? ""];
  if (!lang) return [];
  const was = keyed(find(lang, before));
  const now = keyed(find(lang, after));
  const out: ChangedTest[] = [];
  for (const [key, t] of now) {
    const prev = was.get(key);
    if (prev?.body === t.body) continue;
    out.push({ name: t.name, group: t.group, change: prev ? "changed" : "added", line: t.line + 1 });
  }
  // a removed test follows the last test before it that is still there
  const last = after.split("\n").length;
  let line = 1;
  for (const [key, t] of was) {
    const kept = now.get(key);
    if (kept) line = Math.min(kept.end + 1, last);
    else out.push({ name: t.name, group: t.group, change: "removed", line });
  }
  // what was taken from a line is drawn above what stands on it now
  const rank = (t: ChangedTest) => (t.change === "removed" ? 0 : 1);
  return out.sort((a, b) => a.line - b.line || rank(a) - rank(b));
}
