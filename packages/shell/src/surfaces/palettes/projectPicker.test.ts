import { describe, expect, test } from "bun:test";
import type { PathEntry, PathTarget, RepoInfo } from "@toyon/shared";
import {
  collapseHome,
  defaultParent,
  destination,
  folderName,
  folderRows,
  parentFolder,
  rowsFor,
  splitTypedPath,
} from "./projectPicker.ts";

const HOME = "/Users/k";
const repo = (name: string, path: string): RepoInfo => ({
  id: name,
  name,
  path,
  defaultBranch: "main",
  config: { procs: {} },
  needsSetup: false,
});
const dir = (name: string, path: string, isRepo = false): PathEntry => ({ name, path, isRepo });
const target = (t: Partial<PathTarget>): PathTarget => ({
  exists: false,
  isDir: false,
  isRepo: false,
  parentExists: true,
  ...t,
});

function rows(query: string, over: Partial<Parameters<typeof rowsFor>[0]> = {}) {
  return rowsFor({
    query,
    repos: [],
    pending: [],
    entries: [],
    target: target({}),
    answered: query,
    ...over,
  });
}

describe("splitTypedPath", () => {
  test("separates the folder from the leaf", () => {
    expect(splitTypedPath("~/Projects/foo")).toEqual({ parent: "~/Projects", name: "foo" });
    expect(splitTypedPath("~/Projects/foo/")).toEqual({ parent: "~/Projects", name: "foo" });
    expect(splitTypedPath("/foo")).toEqual({ parent: "/", name: "foo" });
    expect(splitTypedPath("foo")).toEqual({ parent: "", name: "foo" });
  });
});

describe("collapseHome", () => {
  test("writes a path the way it would be typed back in", () => {
    expect(collapseHome("/Users/k/Projects", HOME)).toBe("~/Projects");
    expect(collapseHome("/Users/k", HOME)).toBe("~");
    expect(collapseHome("/opt/src", HOME)).toBe("/opt/src");
    // a segment boundary, not a prefix: another person's home is not inside this one
    expect(collapseHome("/Users/kate/src", HOME)).toBe("/Users/kate/src");
    expect(collapseHome("/Users/k/Projects", "")).toBe("/Users/k/Projects");
  });
});

describe("defaultParent", () => {
  test("is wherever this person already keeps projects", () => {
    const repos = [repo("a", "/Users/k/Projects/a"), repo("b", "/Users/k/Projects/b"), repo("c", "/opt/c")];
    expect(defaultParent(repos, null, HOME)).toBe("~/Projects");
  });

  test("does not assume a Projects folder: it follows whatever is actually there", () => {
    const repos = [repo("a", "/opt/src/a"), repo("b", "/opt/src/b")];
    expect(defaultParent(repos, null, HOME)).toBe("/opt/src");
  });

  test("a tie goes to the open project's folder, and is stable without one", () => {
    const repos = [repo("a", "/opt/x/a"), repo("b", "/opt/y/b")];
    expect(defaultParent(repos, "b", HOME)).toBe("/opt/y");
    expect(defaultParent(repos, null, HOME)).toBe("/opt/x"); // first by name, not by registration order
  });

  test("falls back to home when there is nothing to learn from", () => {
    expect(defaultParent([], null, HOME)).toBe("~");
  });
});

describe("destination", () => {
  test("joins without doubling the separator", () => {
    expect(destination("~/Projects", "foo")).toBe("~/Projects/foo");
    expect(destination("~/Projects/", "foo")).toBe("~/Projects/foo");
    expect(destination("/", "foo")).toBe("/foo");
  });
});

describe("rowsFor: a name", () => {
  test("matches registered projects first, and still offers the name as a new one", () => {
    const repos = [repo("cookbook", "/Users/k/Projects/cookbook")];
    expect(rows("cook", { repos }).map((r) => r.kind)).toEqual(["repo", "create"]);
  });

  test("offers to make one when nothing by that name is open", () => {
    expect(rows("brand-new")).toEqual([{ kind: "create", name: "brand-new", parent: null }]);
  });

  test("a name that only matches a path is not taken", () => {
    // every project in ~/Projects contains "projects"; none of them is called that
    const repos = [repo("toyon", "/Users/k/Projects/toyon"), repo("toyon-site", "/Users/k/Projects/toyon-site")];
    expect(rows("projects", { repos }).at(-1)).toEqual({ kind: "create", name: "projects", parent: null });
    expect(rows("site", { repos }).map((r) => r.kind)).toEqual(["repo", "create"]);
  });

  test("a project already called exactly that is the project, not an offer to make another", () => {
    const repos = [repo("toyon", "/Users/k/Projects/toyon"), repo("toyon-site", "/Users/k/Projects/toyon-site")];
    expect(rows("Toyon", { repos }).some((r) => r.kind === "create")).toBe(false);
  });

  test("offers nothing for a name no folder could have", () => {
    expect(rows("my project")).toEqual([]);
    expect(rows(".hidden")).toEqual([]);
  });

  test("a relative path is not a name, and the daemon reports nowhere for it", () => {
    // browsePath only answers absolute paths, so `../x` comes back with parentExists false and
    // there is nothing to offer: it is neither a project name nor a place one could go
    expect(rows("../escape", { target: target({ parentExists: false }) })).toEqual([]);
  });

  test("an empty query lists the projects, then the way to start one", () => {
    expect(rows("")).toEqual([{ kind: "new" }]);
    const repos = [repo("cookbook", "/Users/k/Projects/cookbook"), repo("bike", "/Users/k/Projects/bike")];
    expect(rows("", { repos }).map((r) => r.kind)).toEqual(["repo", "repo", "new"]);
  });

  test("the standing row is only for an empty query: a typed name has its own create row", () => {
    expect(rows("brand-new").some((r) => r.kind === "new")).toBe(false);
  });

  test("a pasted git URL is a clone, not a name", () => {
    expect(rows("https://github.com/x/y.git")).toEqual([
      { kind: "clone", url: "https://github.com/x/y.git", name: "y" },
    ]);
    expect(rows("git@github.com:x/y.git")[0]?.kind).toBe("clone");
  });
});

describe("rowsFor: an import in flight", () => {
  const importing = {
    id: "i1",
    name: "my-app",
    parent: "~/Projects",
    url: "https://github.com/x/my-app",
    startedAt: 0,
    lines: [],
  };

  test("a clone in flight is listed with the projects, after the ones you can open", () => {
    const repos = [repo("cookbook", "/Users/k/Projects/cookbook")];
    const out = rows("", { repos, pending: [importing] });
    expect(out.map((r) => r.kind)).toEqual(["repo", "pending", "new"]);
  });

  test("it is findable by name and by url, since half of one is what you would type", () => {
    expect(rows("my-app", { pending: [importing] }).map((r) => r.kind)).toEqual(["pending"]);
    // "github" is also a name nobody has taken, so the create row follows it
    expect(rows("github", { pending: [importing] }).map((r) => r.kind)).toEqual(["pending", "create"]);
  });

  test("a name that matches an import is not also an offer to create that name", () => {
    // otherwise the same word would offer both "watch this" and "make another one here"
    expect(rows("my-app", { pending: [importing] }).some((r) => r.kind === "create")).toBe(false);
  });
});

describe("rowsFor: a path", () => {
  const entries = [dir("foo", "~/Projects/foo"), dir("forms", "~/Projects/forms")];

  test("a leaf that is not there yet, under a parent that is, can be created", () => {
    const out = rows("~/Projects/brand-new", { target: target({ parentExists: true }) });
    expect(out).toEqual([{ kind: "create", name: "brand-new", parent: "~/Projects" }]);
  });

  test("a typo offers nothing at all: this is the whole containment story", () => {
    expect(rows("~/Projcts/foo", { target: target({ parentExists: false }) })).toEqual([]);
    // and it does not matter how deep the typo is
    expect(rows("~/Projects/a/b", { target: target({ parentExists: false }) })).toEqual([]);
  });

  test("an existing folder is a step on the way, so enter still descends", () => {
    const out = rows("~/Projects/foo", { entries, target: target({ exists: true, isDir: true }) });
    expect(out.map((r) => r.kind)).toEqual(["dir", "dir"]);
  });

  test("an existing repo can be opened", () => {
    const out = rows("~/Projects/foo", {
      entries,
      target: target({ exists: true, isDir: true, isRepo: true }),
    });
    expect(out.at(-1)).toEqual({ kind: "open", path: "~/Projects/foo" });
  });

  test("a trailing slash is a folder to look inside, never a leaf to make", () => {
    const out = rows("~/Projects/", { entries, target: target({ exists: true, isDir: true }) });
    expect(out.every((r) => r.kind === "dir")).toBe(true);
  });

  // browse-path is debounced, so `paths` routinely describes the previous query. Without this the
  // create row appears from a stale "nothing here" and is replaced on the next keystroke.
  test("says nothing new while the daemon's answer is for an older query", () => {
    const out = rows("~/Projects/brand-new", { entries, answered: "~/Projects/bran" });
    expect(out.map((r) => r.kind)).toEqual(["dir", "dir"]);
  });
});

describe("parentFolder and folderName", () => {
  test("walk up the way a path would be typed", () => {
    expect(parentFolder("~/Projects", HOME)).toBe("~");
    expect(parentFolder("~", HOME)).toBe("/Users");
    expect(parentFolder("/Users", HOME)).toBe("/");
    expect(parentFolder("/", HOME)).toBeNull();
    // with no home known, `~` is not somewhere that can be walked out of
    expect(parentFolder("~", "")).toBeNull();
  });

  test("name a folder, including home and the top of the disk", () => {
    expect(folderName("~/Projects/", HOME)).toBe("Projects");
    expect(folderName("~", HOME)).toBe("k");
    expect(folderName("/", HOME)).toBe("/");
  });
});

describe("folderRows", () => {
  const folders = (query: string, over: Partial<Parameters<typeof folderRows>[0]> = {}) =>
    folderRows({
      query,
      entries: [],
      target: target({ exists: true, isDir: true }),
      answered: query,
      home: HOME,
      ...over,
    });
  const kinds = (rs: ReturnType<typeof folderRows>) => rs.map((r) => (r.kind === "dir" ? r.entry.name : r.kind));

  test("the folder being shown comes first, then the way up, then what is inside", () => {
    const entries = [dir("work", "~/Projects/work"), dir("toys", "~/Projects/toys")];
    const out = folders("~/Projects/", { entries });
    expect(out[0]).toEqual({ kind: "here", path: "~/Projects" });
    expect(out[1]).toEqual({ kind: "up", path: "~" });
    expect(kinds(out)).toEqual(["here", "up", "work", "toys"]);
  });

  test("a project is not a place to put one", () => {
    const entries = [dir("toyon", "~/Projects/toyon", true), dir("work", "~/Projects/work")];
    expect(kinds(folders("~/Projects/", { entries }))).toEqual(["here", "up", "work"]);
    expect(folders("~/Projects/toyon/", { target: target({ exists: true, isDir: true, isRepo: true }) })[0]?.kind).toBe(
      "up",
    );
  });

  test("a typed prefix narrows what is inside, and the folder shown is the one it is typed in", () => {
    const entries = [dir("work", "~/Projects/work"), dir("toys", "~/Projects/toys")];
    const out = folders("~/Projects/wo", { entries, target: target({ parentExists: true }) });
    expect(kinds(out)).toEqual(["here", "up", "work"]);
    expect(out[0]).toEqual({ kind: "here", path: "~/Projects" });
  });

  test("an answer still describing the folder just left lists none of it", () => {
    // clicked into ~/Projects; the daemon has only answered for ~ so far
    const stale = [dir("Desktop", "~/Desktop"), dir("Projects", "~/Projects")];
    const out = folders("~/Projects/", { entries: stale, answered: "~/" });
    expect(kinds(out)).toEqual(["here", "up"]);
  });

  test("a folder the daemon has not looked at yet is offered; one it found missing is not", () => {
    expect(folders("~/Projcts/", { answered: "~/" })[0]?.kind).toBe("here");
    expect(folders("~/Projcts/", { target: target({ exists: false }) })[0]?.kind).toBe("up");
  });

  test("compares paths the daemon collapsed against a path typed out in full", () => {
    const entries = [dir("work", "~/Projects/work")];
    expect(kinds(folders("/Users/k/Projects/", { entries }))).toEqual(["here", "up", "work"]);
  });

  test("the top of the disk has no way up, and a query that is not a path lists nothing", () => {
    expect(kinds(folders("/"))).toEqual(["here"]);
    expect(folders("projects")).toEqual([]);
    expect(folders("../")).toEqual([]);
  });
});
