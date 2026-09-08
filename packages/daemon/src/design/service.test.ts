// Real files in a throwaway repo: the scan reads what `git ls-files` reports, so a fake fs would
// only be testing the fake.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { StateStore } from "../core/state.ts";
import { DesignService } from "./service.ts";

type World = ReturnType<typeof world>;
function world() {
  const t = tmpRepo();
  const state = new StateStore(t.paths);
  state.addWorktree({
    id: "w1",
    repoId: "r1",
    path: t.repo,
    branch: "main",
    kind: "main",
    proxyPort: 1,
    title: "main",
    createdAt: 0,
  });
  return { ...t, state, design: new DesignService(state) };
}

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => {
  w.cleanup();
});

function write(rel: string, text: string) {
  const full = join(w.repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

const flagged = (i: Awaited<ReturnType<DesignService["scan"]>>) =>
  i.classes.filter((c) => c.unwrapped).map((c) => c.name);

describe("DesignService.scan", () => {
  test("reads tokens, components and classes off the worktree", async () => {
    write("src/styles.css", `:root { --accent: #6fae5f; --r-sm: 4px }\n.btn { color: red }`);
    write("src/ui/Button.tsx", `export function Button() { return <b className="btn" />; }`);
    write("src/App.tsx", `import { Button } from "./ui/Button.tsx";\nexport function App() { return <Button />; }`);

    const index = await w.design.scan("w1");

    expect(index.tokens.map((t) => t.name)).toEqual(["--accent", "--r-sm"]);
    expect(index.tokens.find((t) => t.name === "--accent")?.kind).toBe("color");
    expect(index.components.find((c) => c.name === "Button")?.imports).toBe(1);
    expect(index.classes.find((c) => c.name === "btn")?.uses).toBe(1);
    // the static half only; a harvest off the running page has not run
    expect(index.live).toBe(false);
  });

  test("marks a class carrying a control that no component is named for", async () => {
    write("src/styles.css", `.btn { color: red }`);
    // spread across files: the finding is about repetition, so it takes more than one place
    for (const page of ["a", "b", "c"]) {
      const uses = Array.from(
        { length: 3 },
        (_, i) => `export function P${page}${i}() { return <b className="btn" />; }`,
      );
      write(`src/page-${page}.tsx`, uses.join("\n"));
    }

    const index = await w.design.scan("w1");
    expect(flagged(index)).toEqual(["btn"]);
  });

  test("a class that never rides alone is a modifier, and is never marked", async () => {
    // `.btn-outline` only ever appears beside `.btn`: no component was going to be named for it
    write("src/styles.css", `.btn { color: red }\n.btn-outline { color: blue }`);
    // .btn stands alone somewhere, so it is a thing; .btn-outline never does, so it is a modifier
    for (const page of ["a", "b", "c"]) {
      const paired = Array.from(
        { length: 3 },
        (_, i) => `export function P${page}${i}() { return <b className="btn btn-outline" />; }`,
      );
      write(
        `src/page-${page}.tsx`,
        [...paired, `export function Plain${page}() { return <b className="btn" />; }`].join("\n"),
      );
    }

    const index = await w.design.scan("w1");
    expect(flagged(index)).toEqual(["btn"]);
  });

  test("a class confined to one file is that file's styling, not an unwrapped control", async () => {
    // nine uses, nowhere else: there is no repetition across the project to complain about
    const uses = Array.from({ length: 9 }, (_, i) => `export function P${i}() { return <b className="pane-row" />; }`);
    write("src/styles.css", `.pane-row { color: red }`);
    write("src/Pane.tsx", uses.join("\n"));

    const index = await w.design.scan("w1");
    expect(flagged(index)).toEqual([]);
    expect(index.classes.find((c) => c.name === "pane-row")?.files).toBe(1);
  });

  test("a class a component is named for is not marked", async () => {
    write("src/styles.css", `.btn { color: red }`);
    for (const page of ["a", "b"]) {
      const uses = Array.from(
        { length: 4 },
        (_, i) => `export function P${page}${i}() { return <b className="btn" />; }`,
      );
      write(`src/page-${page}.tsx`, uses.join("\n"));
    }
    write("src/ui/Btn.tsx", `export function Btn() { return <b className="btn" />; }`);

    const index = await w.design.scan("w1");
    expect(flagged(index)).toEqual([]);
  });

  test("counts how many files reach for each component, so the pane can split on it", async () => {
    write("src/ui/Lonely.tsx", `export function Lonely() { return null; }`);
    write("src/ui/Busy.tsx", `export function Busy() { return null; }`);
    write("src/ui/Spare.tsx", `export function Spare() { return null; }`);
    write(
      "src/App.tsx",
      `import { Lonely } from "./ui/Lonely.tsx";\nimport { Busy } from "./ui/Busy.tsx";\nexport function App() { return <Lonely />; }`,
    );
    write("src/Page.tsx", `import { Busy } from "./ui/Busy.tsx";\nexport function Page() { return <Busy />; }`);
    write("src/main.tsx", `import { App } from "./App.tsx";\nexport const Root = App;`);

    const index = await w.design.scan("w1");
    const by = (n: string) => index.components.find((c) => c.name === n)?.imports;
    expect(by("Busy")).toBe(2);
    expect(by("Lonely")).toBe(1);
    expect(by("Spare")).toBe(0);
    // Lonely and Spare are reached for once and never; neither is a problem, and an app root has
    // one caller by design, so nothing here is marked
    expect(flagged(index)).toEqual([]);
  });

  test("says what it recognised, so an empty section can explain itself", async () => {
    write("src/styles.css", `.btn { color: red }`);
    write("src/Card.tsx", `export function Card() { return <b className={styles.btn} />; }`);

    const index = await w.design.scan("w1");
    expect(index.coverage.stylesheets).toBe(1);
    expect(index.coverage.files).toEqual({ css: 1, tsx: 1 });
    // the attribute was seen, it just names no class this scan can read: that is a CSS Modules
    // project, not a project with no classes
    expect(index.coverage.classAttrs).toBe(1);
    expect(index.classes.find((c) => c.name === "btn")?.uses).toBe(0);
  });

  test("without TypeScript in the project, prop unions are skipped rather than fatal", async () => {
    write(
      "src/ui/Button.tsx",
      `interface Props { variant?: "a" | "b" }\nexport function Button(p: Props) { return null; }`,
    );

    const index = await w.design.scan("w1");
    // tmpRepo has no node_modules, so there is no compiler to parse with
    expect(index.typed).toBe(false);
    expect(index.components.find((c) => c.name === "Button")?.variants).toEqual([]);
  });

  test("refuses a worktree it does not know", () => {
    expect(w.design.scan("nope")).rejects.toThrow();
  });
});
