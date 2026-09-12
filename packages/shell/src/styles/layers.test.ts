import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * What covers what, and who is allowed to say so.
 *
 * Anything that covers something it does not own is a `Float` (ui/Float.tsx): the browser's top
 * layer, where the box shown last is on top, no ancestor's transform or overflow can trap or clip
 * it, and no rule needs a z-index at all. What is left is a component layering its own children,
 * which isolates its root so its rungs are counted nowhere but inside it.
 *
 * The ladder that used to hold this line was a paragraph in tokens.css and a habit. It broke twice:
 * once when a centring transform trapped a dropdown, and once when two floats held the same rung and
 * the later one in the page won.
 */

const SRC = new URL("..", import.meta.url).pathname;

/** every z-index the shell keeps, and the isolated root it counts inside */
const LOCAL_LAYERS: Record<string, { root: string; why: string }> = {
  ".dock-resize": { root: ".docks", why: "the grab strip over the seam between two docks" },
  ".rail-panel": { root: ".docks", why: "the peek covers the chat dock and its grab strip" },
  ".pane-resize": { root: ".pane", why: "the drag strip over the pane's own head" },
  ".overlay": { root: ".center", why: "the palette's scrim over the panes of the preview column" },
  ".image-chip.in-chat:hover .image-thumb": { root: ".chat-log", why: "the transcript's own image, larger" },
};

/** Still on the old ladder, each with the float that takes it. A phase empties its own entries, and
 * the map goes with the last of them. */
const NOT_YET: Record<string, string> = {
  ".inline-picker": "the composer's @ and / menu becomes a Float",
  ".overlay-box.anchored": "the pickers' panels become Floats",
  ".overlay": "the scrim drops to a rung inside an isolated .center",
  ".pane-resize": "the strip drops to a rung inside an isolated .pane",
  ".rail-panel": "the peek drops to a rung inside the isolated .docks",
  ".toast": "the toast becomes a Float",
};

/** the roots that do not isolate yet, for the same reason */
const ISOLATION_PENDING = new Set([".docks", ".center", ".pane", ".chat-log"]);

/** a float still placing itself, until its phase moves it into the top layer */
const FIXED_PENDING = new Set([".toast"]);

const cssFiles = () => [...new Glob("**/*.css").scanSync({ cwd: SRC })].sort();
const codeFiles = () => [...new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })].filter((f) => !f.endsWith(".test.ts"));

describe("layers", () => {
  test("a z-index is 1 or 2, and only inside a component that isolates its own root", async () => {
    const rules = cssRules(await shellCss());
    const isolates = new Set(rules.filter((r) => r.decls.get("isolation") === "isolate").flatMap((r) => r.selectors));
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const rule of rules) {
      const z = rule.decls.get("z-index");
      if (z === undefined) continue;
      for (const selector of rule.selectors) {
        seen.add(selector);
        if (NOT_YET[selector]) continue;
        const layer = LOCAL_LAYERS[selector];
        if (!layer) {
          offenders.push(`${selector}: z-index ${z} belongs to a float, which takes none`);
          continue;
        }
        if (z !== "1" && z !== "2") offenders.push(`${selector}: z-index ${z} is not 1 or 2`);
        if (!isolates.has(layer.root) && !ISOLATION_PENDING.has(layer.root)) {
          offenders.push(`${selector}: its root ${layer.root} does not isolate`);
        }
      }
    }
    // a name left in a map here outlives the rule it was written for
    for (const selector of [...Object.keys(LOCAL_LAYERS), ...Object.keys(NOT_YET)]) {
      if (!seen.has(selector)) offenders.push(`${selector}: named here but declares no z-index`);
    }
    expect(offenders).toEqual([]);
  });

  test("nothing but a float is fixed to the window", async () => {
    const offenders: string[] = [];
    for (const file of cssFiles()) {
      if (file === "ui/float.css") continue;
      for (const rule of cssRules(await Bun.file(`${SRC}${file}`).text())) {
        if (rule.decls.get("position") !== "fixed") continue;
        for (const selector of rule.selectors) {
          if (!FIXED_PENDING.has(selector)) offenders.push(`${file} ${selector}: a float is placed by Float.tsx`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the top layer is reached through Float alone", async () => {
    const offenders: string[] = [];
    for (const file of codeFiles()) {
      const code = await Bun.file(`${SRC}${file}`).text();
      if (file !== "ui/Float.tsx" && /\b(show|hide|toggle)Popover\b|\.popover\s*=|\bpopover=/.test(code)) {
        offenders.push(`${file}: only ui/Float.tsx opens the top layer`);
      }
      if (/createPortal/.test(code)) offenders.push(`${file}: a float is in the top layer, not a portal`);
    }
    for (const file of cssFiles()) {
      if (file === "ui/float.css") continue;
      const css = await Bun.file(`${SRC}${file}`).text();
      if (/:popover-open|\[popover|::backdrop/.test(css)) offenders.push(`${file}: float.css dresses the top layer`);
    }
    expect(offenders).toEqual([]);
  });
});
