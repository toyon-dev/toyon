// The design system of the worktree, read off its own source: custom properties, the classes its
// stylesheets define, the components it exports, and how much of the project reaches for each.
//
// This is the static half. The live half (resolved token values, rendered icons, drift) comes from
// a harvest off the running preview and merges in on top; `live: false` says it has not.

import { join } from "node:path";
import type { DesignClass, DesignComponent, DesignFinding, DesignIndex, DesignToken } from "@toyon/shared";
import type { StateStore } from "../core/state.ts";
import { git } from "../git/exec.ts";
import { appliedClasses, cssClasses, cssTokens, exportedComponents, importedNames, propUnions } from "./scan.ts";

/** Enough for a large app, small enough that a scan of a repo with a vendored tree stays quick. */
const MAX_SOURCE_FILES = 4_000;
const MAX_CSS_FILES = 200;
/** a minified bundle checked into source would otherwise dominate every count */
const MAX_FILE_BYTES = 400_000;

/** A component this alone in its directory is a one-off, not a piece of a kit. Used instead of a
 * list of blessed directory names ("ui", "components"): the shape of the tree is the project's own
 * evidence, where the names are a guess at its conventions. */
const KIT_SIBLINGS = 3;
/** a class has to beat the typical used class before "nothing is named for it" is worth saying */
const UNWRAPPED_FLOOR = 3;

/** Anything that can carry a `class` attribute. Server-rendered templates parse with the same
 * recogniser as JSX does; leaving them out of this list was the whole reason a Rails or Django
 * project reported no classes at all. */
const SOURCE_EXT =
  /\.(tsx|jsx|ts|js|mjs|cjs|mts|cts|vue|svelte|astro|html?|erb|ejs|hbs|handlebars|pug|jade|php|py|rb|templ|heex|eex|twig|liquid|cshtml|razor|blade)$/;
const COMPONENT_EXT = /\.(tsx|jsx|mjs|cjs|mts|vue|svelte|astro)$/;
const CSS_EXT = /\.(css|scss|sass|less|styl)$/;

export class DesignService {
  constructor(private state: StateStore) {}

  async scan(worktreeId: string): Promise<DesignIndex> {
    const wt = this.state.requireWorktree(worktreeId);
    const listed = await git(wt.path, "ls-files", "-co", "--exclude-standard");
    const paths = listed.out.split("\n").filter(Boolean);

    const cssPaths = paths.filter((p) => CSS_EXT.test(p)).slice(0, MAX_CSS_FILES);
    const srcPaths = paths.filter((p) => SOURCE_EXT.test(p)).slice(0, MAX_SOURCE_FILES);

    const cssFiles = await readAll(wt.path, cssPaths);
    const srcFiles = await readAll(wt.path, srcPaths);

    const tokens = collectTokens(cssFiles);
    const ts = await loadProjectTypescript(wt.path);
    const importers = collectImporters(srcFiles);
    const components = collectComponents(srcFiles, ts, importers);
    const { classes, attrs } = collectClasses(cssFiles, srcFiles);

    return {
      scannedAt: Date.now(),
      live: false,
      typed: ts !== null,
      tokens,
      components,
      classes,
      findings: findings(components, classes, importers),
      coverage: {
        files: byExtension([...cssFiles, ...srcFiles]),
        stylesheets: cssFiles.length,
        customProps: tokens.length,
        classAttrs: attrs,
      },
    };
  }
}

interface SourceFile {
  path: string;
  text: string;
}

async function readAll(root: string, paths: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const path of paths) {
    const file = Bun.file(join(root, path));
    // a path from `ls-files -o` can be gone by the time we read it, and a symlink into nothing
    // reads as a miss rather than throwing
    if (file.size === 0 || file.size > MAX_FILE_BYTES) continue;
    try {
      out.push({ path, text: await file.text() });
    } catch {
      // unreadable (a broken symlink, a permission bite): it contributes nothing and blocks nothing
    }
  }
  return out;
}

/**
 * The first declaration of a name wins, and declaration order is kept.
 *
 * Sorting by name looked tidier and threw away the only grouping anyone had actually made: a token
 * file puts `surface0..2`, then `element0..1`, then `border`, then `text`, because that is the
 * order they mean something in. Alphabetical scatters those four families through the hues. The
 * file with the most custom properties leads, since that is the one that exists to hold them.
 */
function collectTokens(css: SourceFile[]): DesignToken[] {
  const byDensity = [...css].sort((a, b) => cssTokens(b.text).length - cssTokens(a.text).length);
  const out = new Map<string, DesignToken>();
  for (const file of byDensity) {
    for (const token of cssTokens(file.text)) if (!out.has(token.name)) out.set(token.name, token);
  }
  return [...out.values()];
}

const dirOf = (path: string) => path.replace(/\/?[^/]*$/, "");

/** Which files import each name. The set of *files* is what ranks a component; where those files
 * sit is what separates a kit from a directory that merely holds several things. */
function collectImporters(src: SourceFile[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of src) {
    // one file importing a name twice still only means one file reaches for it
    for (const name of new Set(importedNames(file.text))) {
      const seen = out.get(name) ?? new Set<string>();
      seen.add(file.path);
      out.set(name, seen);
    }
  }
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: the compiler module comes from the target repo at runtime
function collectComponents(src: SourceFile[], ts: any, importers: Map<string, Set<string>>): DesignComponent[] {
  const out: DesignComponent[] = [];
  for (const file of src) {
    if (!COMPONENT_EXT.test(file.path)) continue;
    const variants = ts ? safePropUnions(ts, file.path, file.text) : [];
    for (const name of exportedComponents(file.text)) {
      out.push({ name, path: file.path, imports: importers.get(name)?.size ?? 0, variants });
    }
  }
  return out.sort((a, b) => b.imports - a.imports || a.name.localeCompare(b.name));
}

/** A parse throw must not take the whole scan down: one file with syntax the project's own
 * TypeScript rejects is not a reason to show an empty pane. */
// biome-ignore lint/suspicious/noExplicitAny: as above
function safePropUnions(ts: any, path: string, text: string) {
  try {
    return propUnions(ts, path, text);
  } catch {
    return [];
  }
}

function collectClasses(css: SourceFile[], src: SourceFile[]): { classes: DesignClass[]; attrs: number } {
  const defined = new Map<string, string>();
  for (const file of css) {
    for (const name of cssClasses(file.text)) if (!defined.has(name)) defined.set(name, file.path);
  }

  // one pass over the source, not one per class: a stylesheet with a few hundred classes against a
  // few thousand files is a lot of scanning to do the other way round
  const applied = new Map<string, number>();
  const solo = new Set<string>();
  let attrs = 0;
  for (const file of src) {
    const found = appliedClasses(file.text);
    attrs += found.attrs;
    for (const [name, n] of found.classes) applied.set(name, (applied.get(name) ?? 0) + n);
    for (const name of found.solo) solo.add(name);
  }

  const out: DesignClass[] = [];
  for (const [name, path] of defined) {
    out.push({ name, uses: applied.get(name) ?? 0, path, solo: solo.has(name) });
  }
  out.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  return { classes: out, attrs };
}

function byExtension(files: SourceFile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) {
    const ext = /\.([^./]+)$/.exec(file.path)?.[1]?.toLowerCase();
    if (ext) out[ext] = (out[ext] ?? 0) + 1;
  }
  return out;
}

/** The middle of the used classes, so "a lot" scales with the project instead of being a number
 * picked here. A design system with nine classes and one with nine hundred both have a typical
 * class, and in neither is it the same count. */
function typicalUse(classes: DesignClass[]): number {
  const used = classes.filter((c) => c.uses > 0).map((c) => c.uses);
  if (used.length === 0) return UNWRAPPED_FLOOR;
  return Math.max(UNWRAPPED_FLOOR, used[Math.floor(used.length / 2)] ?? UNWRAPPED_FLOOR);
}

/** Normalised so a `.button` class and a `Button` component read as the same thing. Nothing
 * clever: `.btn` and `Button` stay different, which is the point of the finding. */
const normal = (s: string) => s.replace(/[-_]/g, "").toLowerCase();

function findings(
  components: DesignComponent[],
  classes: DesignClass[],
  importers: Map<string, Set<string>>,
): DesignFinding[] {
  const out: DesignFinding[] = [];
  const componentNames = new Set(components.map((c) => normal(c.name)));
  const busy = typicalUse(classes);

  // how many components share each directory: a kit has several, a one-off sits by itself
  const siblings = new Map<string, number>();
  for (const c of components) siblings.set(dirOf(c.path), (siblings.get(dirOf(c.path)) ?? 0) + 1);

  const unwrapped = classes.filter(
    // at least as used as the typical one, not more: in a project with a single class that class
    // is also the median, and a strict comparison would never report anything at all. `solo` drops
    // the modifiers: `.btn-outline` and `.on` never appear without something to modify, so no
    // component was ever going to be named for them.
    (c) => c.uses >= busy && c.solo && !componentNames.has(normal(c.name)),
  );
  if (unwrapped.length > 0) {
    out.push({
      kind: "unwrapped-class",
      title:
        unwrapped.length === 1
          ? `.${unwrapped[0]!.name} carries a control that no component is named for`
          : `${unwrapped.length} classes carry a control that no component is named for`,
      items: unwrapped.map((c) => ({ label: `.${c.name}  ${c.uses}`, path: c.path })),
    });
  }

  const lonely = components.filter((c) => {
    // Two conditions, and both matter. A kit holds several components, but so does the directory an
    // app's root lives in; what separates them is that a kit's components are reached for from
    // outside it. An app root imported only by the file beside it is not a design system finding.
    if (c.imports !== 1) return false;
    const dir = dirOf(c.path);
    if ((siblings.get(dir) ?? 0) < KIT_SIBLINGS) return false;
    return [...(importers.get(c.name) ?? [])].some((p) => dirOf(p) !== dir);
  });
  if (lonely.length > 0) {
    out.push({
      kind: "lone-consumer",
      title:
        lonely.length === 1
          ? `${lonely[0]!.name} sits among shared components but has one consumer`
          : `${lonely.length} shared components have one consumer`,
      items: lonely.map((c) => ({ label: c.name, path: c.path })),
    });
  }

  return out;
}

/**
 * TypeScript from the *target* repo, used only as a parser. Bundling a compiler to read prop
 * unions would put tens of megabytes into toyon's install for a feature most projects use once,
 * and a project that has no TypeScript has no unions to read anyway: the index says `typed: false`
 * and the pane says which section is missing.
 */
// biome-ignore lint/suspicious/noExplicitAny: there is no type for a module resolved at runtime
async function loadProjectTypescript(root: string): Promise<any> {
  try {
    return await import(join(root, "node_modules", "typescript", "lib", "typescript.js"));
  } catch {
    // no TypeScript in the project, or a layout we do not know: prop unions are skipped, not fatal
    return null;
  }
}
