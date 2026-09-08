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
/** a class used at least this often is load-bearing enough to be worth a finding */
const UNWRAPPED_MIN = 8;
/** the pane shows findings first, so keep the list to what someone will actually read */
const MAX_FINDINGS = 12;

/** where a project keeps things meant to be used more than once, by every convention we have seen */
const REUSABLE_DIR = /(^|\/)(ui|components|shared|common|design-system|primitives)\//;

const SOURCE_EXT = /\.(tsx|jsx|ts|js|vue|svelte|astro)$/;
const COMPONENT_EXT = /\.(tsx|jsx|vue|svelte|astro)$/;
const CSS_EXT = /\.(css|scss|sass|less)$/;

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
    const components = collectComponents(srcFiles, ts);
    const classes = collectClasses(cssFiles, srcFiles);

    return {
      scannedAt: Date.now(),
      live: false,
      typed: ts !== null,
      tokens,
      components,
      classes,
      findings: findings(components, classes),
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

/** The first declaration of a name wins. Stylesheets redeclare tokens per theme, and the pane
 * wants one row per token, not one per theme. */
function collectTokens(css: SourceFile[]): DesignToken[] {
  const out = new Map<string, DesignToken>();
  for (const file of css) {
    for (const token of cssTokens(file.text)) if (!out.has(token.name)) out.set(token.name, token);
  }
  return [...out.values()].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

// biome-ignore lint/suspicious/noExplicitAny: the compiler module comes from the target repo at runtime
function collectComponents(src: SourceFile[], ts: any): DesignComponent[] {
  const imports = new Map<string, number>();
  for (const file of src) {
    // one file importing a name twice still only means one file reaches for it
    for (const name of new Set(importedNames(file.text))) imports.set(name, (imports.get(name) ?? 0) + 1);
  }

  const out: DesignComponent[] = [];
  for (const file of src) {
    if (!COMPONENT_EXT.test(file.path)) continue;
    const variants = ts ? safePropUnions(ts, file.path, file.text) : [];
    for (const name of exportedComponents(file.text)) {
      out.push({ name, path: file.path, imports: imports.get(name) ?? 0, variants });
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

function collectClasses(css: SourceFile[], src: SourceFile[]): DesignClass[] {
  const defined = new Map<string, string>();
  for (const file of css) {
    for (const name of cssClasses(file.text)) if (!defined.has(name)) defined.set(name, file.path);
  }

  // one pass over the source, not one per class: a stylesheet with a few hundred classes against a
  // few thousand files is a lot of scanning to do the other way round
  const applied = new Map<string, number>();
  for (const file of src) {
    for (const [name, n] of appliedClasses(file.text)) applied.set(name, (applied.get(name) ?? 0) + n);
  }

  const out: DesignClass[] = [];
  for (const [name, path] of defined) out.push({ name, uses: applied.get(name) ?? 0, path });
  return out.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}

/** Normalised so a `.button` class and a `Button` component read as the same thing. Nothing
 * clever: `.btn` and `Button` stay different, which is the point of the finding. */
const normal = (s: string) => s.replace(/[-_]/g, "").toLowerCase();

function findings(components: DesignComponent[], classes: DesignClass[]): DesignFinding[] {
  const out: DesignFinding[] = [];
  const componentNames = new Set(components.map((c) => normal(c.name)));

  for (const cls of classes) {
    if (cls.uses < UNWRAPPED_MIN || componentNames.has(normal(cls.name))) continue;
    out.push({
      kind: "unwrapped-class",
      title: `.${cls.name} is used ${cls.uses} times, with no component of its name`,
      detail: "If this is a control, the class is its only definition. Every use restates the markup.",
      path: cls.path,
    });
  }

  for (const c of components) {
    // Only where components are kept to be reused. Every app has a root and a dock with exactly
    // one caller by design, and reporting those buries the one finding worth reading.
    if (c.imports !== 1 || !REUSABLE_DIR.test(c.path)) continue;
    out.push({
      kind: "lone-consumer",
      title: `${c.name} has one consumer`,
      detail: "It sits where shared components live, but only one file reaches for it.",
      path: c.path,
    });
  }

  return out.slice(0, MAX_FINDINGS);
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
