// Which changed files are tests, so the changes list can show the change before what checks it.
// Read from the path alone: the list holds deleted files and files in commits, which have no
// content to ask.

/** a folder that holds tests or what only tests read */
const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "e2e",
  "__snapshots__",
  "__mocks__",
  "fixtures",
  "testdata",
]);

/** a file name that says so itself, in the conventions of the languages a worktree is likely in:
 * `a.test.ts`, `a.spec.js`, `a_test.go`, `a_spec.rb`, `test_a.py`, `conftest.py`, `a.snap`, and
 * `ATest.java` or `ATests.cs`, where the capital is what keeps `Latest.ts` out. A hyphen makes a
 * test (`a-test.js`) and not a spec: `api-spec.md` is a document. */
const TEST_NAME =
  /([._-]tests?\.[^.]+$)|([._]specs?\.[^.]+$)|(^tests?[._-])|(^conftest\.py$)|(\.snap$)|([a-z0-9](Tests?|Spec)\.[^.]+$)/;

export function isTestPath(path: string): boolean {
  // an untracked folder is listed whole, with a trailing slash
  const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  const name = parts.pop() ?? "";
  if (path.endsWith("/") && TEST_DIRS.has(name.toLowerCase())) return true;
  return parts.some((p) => TEST_DIRS.has(p.toLowerCase())) || TEST_NAME.test(name);
}

/**
 * A list of changed files with its tests moved to the end, each half in the order it came in, and
 * how many of them are not tests: where the second half starts. The same array comes back when
 * nothing moves, so a list with no tests in it keeps its identity.
 */
export function testsLast<T extends { path: string }>(files: readonly T[]): { files: readonly T[]; source: number } {
  const source = files.filter((f) => !isTestPath(f.path));
  if (source.length === 0 || source.length === files.length) return { files, source: source.length };
  return { files: [...source, ...files.filter((f) => isTestPath(f.path))], source: source.length };
}
