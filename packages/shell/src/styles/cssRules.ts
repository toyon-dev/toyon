import { Glob } from "bun";
import postcss, { type Container } from "postcss";

/**
 * The stylesheets as the tests read them: every rule, with its selectors resolved through any
 * nesting and at-rule it sits in, and its declarations as property/value pairs. Resolving the
 * selector is what lets a test keep saying `.ask-closed .ask-lead` in its allowlist after that
 * rule is written as `.ask-closed { & .ask-lead { … } }`.
 *
 * PostCSS rather than css-tree: css-tree 3 only parses a nested rule that opens with `&`, and turns
 * `.row { … }` inside a block into a Raw node the walk never sees, which is a rule a test has
 * quietly stopped checking. PostCSS parses nesting syntactically and keeps the selector as written,
 * so `.design-tail > summary` stays spelled the way the allowlist spells it.
 */
export type CssRule = {
  /** each selector of the rule, fully resolved: `.rail .row`, never `& .row` */
  selectors: string[];
  /** property to value, last declaration wins as it does in the cascade */
  decls: Map<string, string>;
};

/** the shell's stylesheets: every .css under src, whichever file a rule has moved to */
export async function shellCss(): Promise<string> {
  const root = new URL("..", import.meta.url).pathname;
  const files = [...new Glob("**/*.css").scanSync({ cwd: root })].sort();
  const texts = await Promise.all(files.map((f) => Bun.file(`${root}${f}`).text()));
  return texts.join("\n");
}

/** a selector's declarations across every rule that names it, later ones winning as they cascade */
export function declsOf(rules: CssRule[], selector: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const r of rules) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) decls.set(k, v);
  if (decls.size === 0) throw new Error(`no rule for ${selector}`);
  return decls;
}

export function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  visit(postcss.parse(css), [], out);
  return out;
}

/** what every :hover rule opens with (base.css): it adds no weight and names no element, so a test
 * reads `.btn:hover` whether or not the rule was written behind it */
export const HOVER_GATE = ":where([data-hover]) ";

/** `&` takes the parent; a selector without one is a descendant of it, as in the spec */
function resolve(parents: string[], own: string[]): string[] {
  if (parents.length === 0) return own.map((c) => c.replace(HOVER_GATE, ""));
  const out: string[] = [];
  for (const p of parents) {
    for (const c of own.map((s) => s.replace(HOVER_GATE, ""))) {
      out.push(c.includes("&") ? c.replaceAll("&", p) : `${p} ${c}`);
    }
  }
  return out;
}

function visit(container: Container, parents: string[], out: CssRule[]) {
  container.each((node) => {
    // @layer, @media and the like: transparent to the selector, so their rules resolve as if bare
    if (node.type === "atrule") {
      if (node.nodes) visit(node, parents, out);
      return;
    }
    if (node.type !== "rule") return;
    const selectors = resolve(
      parents,
      node.selectors.map((s) => s.replace(/\s+/g, " ").trim()),
    );
    const decls = new Map<string, string>();
    for (const child of node.nodes) if (child.type === "decl") decls.set(child.prop, child.value.trim());
    visit(node, selectors, out);
    out.push({ selectors, decls });
  });
}
