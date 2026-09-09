// Injected into preview pages by the per-worktree proxy.
// Reports navigation/errors/HMR to the shell; runs the element picker and
// file-highlight overlays; forwards Toyon keyboard chords.

// The proxy prepends the origins the shell can be served from. Outbound messages go only to those
// (postMessage drops a frame whose origin doesn't match, so posting once per candidate is safe);
// inbound commands are accepted only from the parent frame at one of them. Without the list
// (cloud with no known public host) both sides fall back to open.
import { matchChord } from "@toyon/shared/chords";
import type { BridgeToShellMsg, ShellToBridgeMsg } from "@toyon/shared/protocol/bridge";

declare global {
  interface Window {
    __toyonShellOrigins?: string[];
    __toyonBridge?: boolean;
  }
}
// injected once per document: an htmx/Turbo fragment swap re-delivers the tag and would wrap
// history and double every listener
if (window.__toyonBridge) throw new Error("toyon bridge already installed");
window.__toyonBridge = true;

const SHELL_ORIGINS: string[] = window.__toyonShellOrigins ?? [];
let shellOrigin: string | null = null;

const post = (msg: BridgeToShellMsg) => {
  try {
    const targets = shellOrigin ? [shellOrigin] : SHELL_ORIGINS.length ? SHELL_ORIGINS : ["*"];
    for (const t of targets) window.parent.postMessage({ __toyon: true, ...msg }, t);
  } catch {
    // not framed; nothing to do
  }
};

post({ type: "loaded", url: location.href, title: document.title });

// picker/highlight overlay colors follow the shell theme (sent on load and on theme change)
let accent = "#ff4929";
let accentFg = "#1d2021";

// vite announces applied hot updates on window — relay so the shell knows
// whether an agent's changes were HMR-covered or need a reload
window.addEventListener("vite:afterUpdate", () => post({ type: "hmr" }));

window.addEventListener("error", (e) => {
  post({ type: "page-error", message: String(e.message), source: e.filename, line: e.lineno });
});

window.addEventListener("unhandledrejection", (e) => {
  post({ type: "page-error", message: `unhandled rejection: ${String(e.reason)}` });
});

// SPA navigation reporting: pushState/replaceState (history routers), popstate
// (back/forward) and hashchange (hash routers, in case the browser doesn't also
// fire popstate for fragment navigations)
const navigated = () => post({ type: "navigated", url: location.href });
const origPush = history.pushState.bind(history);
history.pushState = (...args) => {
  origPush(...args);
  navigated();
};
const origReplace = history.replaceState.bind(history);
history.replaceState = (...args) => {
  origReplace(...args);
  navigated();
};
window.addEventListener("popstate", navigated);
window.addEventListener("hashchange", navigated);

// zen: the shell is out of the way and the page owns the keyboard, so the table stands down
let zen = false;

// forward Toyon chords to the shell even when the preview has focus (plain ⌘F stays the
// page's own find: it isn't in the table). Escape is forwarded too but not taken: the shell
// closes whatever it has open, and the page still gets it for its own dialogs.
window.addEventListener(
  "keydown",
  (e) => {
    // a shell framed as a preview keeps its own keyboard: forwarding from here would leave the
    // inner shell dead to every chord and act on keys meant for it
    if (window.__toyonShell) return;
    const chord = matchChord(e);
    // in zen only the chord that leaves zen is ours: a flow under test that uses Escape or ⌘E
    // has to reach the page, and the shell has no visible chrome for the rest to act on anyway
    if (zen) {
      if (chord?.id !== "zen") return;
    } else if (e.key === "Escape") {
      post({ type: "key", key: "Escape", meta: false });
      return;
    } else if (!chord) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: "key", key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey });
  },
  true,
);

// A file dropped on a page that doesn't take it navigates that frame to the file: drop a
// screenshot on the preview and the running app is gone. Swallow those and tell the shell, which
// says where the drop should have gone. A page keeps its own drop zones: a handler that called
// preventDefault has claimed the drag, and this backs off.
const fileDrag = (e: DragEvent) => !e.defaultPrevented && !!e.dataTransfer?.types.includes("Files");
window.addEventListener("dragover", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  // nothing in here takes a file, and the cursor should say so before the drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  // the shell's window sees nothing while the pointer is in here, so each dragover is also what
  // tells it the drag has left the chat panel (it coalesces them; nothing re-renders)
  post({ type: "drag-files" });
});
window.addEventListener("drop", (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  post({ type: "drop-files" });
});

// ---- React fiber source mapping ----

type Fiber = {
  return: Fiber | null;
  type: unknown;
  _debugSource?: { fileName: string; lineNumber: number };
  _debugStack?: { stack?: string } | Error;
};

function fiberOf(el: Element): Fiber | null {
  for (const k of Object.keys(el)) {
    if (k.startsWith("__reactFiber$")) return (el as unknown as Record<string, Fiber>)[k] ?? null;
  }
  return null;
}

function sourceOf(fiber: Fiber | null): { file: string; line?: number } | null {
  let f = fiber;
  while (f) {
    if (f._debugSource?.fileName) {
      return { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
    }
    // React 19 dropped _debugSource; _debugStack frames carry served-module URLs
    const stack = (f._debugStack as Error | undefined)?.stack;
    if (stack) {
      const m = stack.match(/https?:\/\/[^/]+(\/src\/[^)\s?]+)(?:\?[^:)\s]*)?:(\d+):\d+/);
      if (m?.[1]) return { file: m[1], line: Number(m[2]) || undefined };
    }
    f = f.return;
  }
  return null;
}

function componentOf(fiber: Fiber | null): string | null {
  let f = fiber;
  while (f) {
    const t = f.type as { name?: string } | string | null;
    if (typeof t === "function" && (t as { name?: string }).name) return (t as { name: string }).name;
    f = f.return;
  }
  return null;
}

// ---- overlay (picker highlight + file highlight) ----

let overlay: HTMLDivElement | null = null;
function ensureOverlay(): HTMLDivElement {
  if (overlay?.isConnected) return overlay;
  overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  document.documentElement.appendChild(overlay);
  return overlay;
}

function clearOverlay() {
  if (overlay) overlay.innerHTML = "";
}

function drawBox(rect: DOMRect, label?: string) {
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid ${accent};outline-offset:-1px;background:${accent}14;border-radius:2px;`;
  if (label) {
    const tag = document.createElement("div");
    tag.textContent = label;
    tag.style.cssText = `position:absolute;left:0;top:-20px;background:${accent};color:${accentFg};font:11px -apple-system,sans-serif;padding:1px 6px;border-radius:3px;white-space:nowrap;`;
    box.appendChild(tag);
  }
  ensureOverlay().appendChild(box);
}

// ---- element picker ----

let picking = false;
let hoverEl: Element | null = null;

function onPickMove(e: MouseEvent) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || el === hoverEl) return;
  hoverEl = el;
  clearOverlay();
  const fiber = fiberOf(el);
  const comp = componentOf(fiber);
  const src = sourceOf(fiber);
  const label = comp
    ? `<${comp}>${src ? ` · ${shortFile(src.file)}${src.line ? `:${src.line}` : ""}` : ""}`
    : el.tagName.toLowerCase();
  drawBox(el.getBoundingClientRect(), label);
}

function onPickClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const el = document.elementFromPoint(e.clientX, e.clientY);
  stopPicking();
  if (!el) return;
  const fiber = fiberOf(el);
  const src = sourceOf(fiber);
  post({
    type: "picked",
    component: componentOf(fiber),
    file: src?.file ?? null,
    line: src?.line ?? null,
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    classes: (el as HTMLElement).className?.toString?.().slice(0, 200) ?? "",
    text: el.textContent?.trim().slice(0, 120) ?? "",
    html: el.outerHTML.slice(0, 600),
    route: location.pathname + location.search,
  });
}

function onPickKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    stopPicking();
    post({ type: "pick-cancel" });
  }
}

function startPicking() {
  if (picking) return;
  picking = true;
  hoverEl = null;
  document.addEventListener("mousemove", onPickMove, true);
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
  document.documentElement.style.cursor = "crosshair";
}

function stopPicking() {
  picking = false;
  clearOverlay();
  document.removeEventListener("mousemove", onPickMove, true);
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
  document.documentElement.style.cursor = "";
}

// stable-enough CSS path for re-highlighting the picked element later
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && cur !== document.documentElement && depth < 6; depth++) {
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    const idx = parent ? Array.from(parent.children).indexOf(cur) + 1 : 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
    cur = parent;
  }
  return parts.join(" > ");
}

function shortFile(f: string): string {
  const i = f.lastIndexOf("/src/");
  return i >= 0 ? f.slice(i + 1) : f.split("/").slice(-2).join("/");
}

// ---- file/line highlight (hover a change -> outline what it renders) ----

function fileMatches(srcFile: string, path: string): boolean {
  return srcFile.endsWith(path) || path.endsWith(shortFile(srcFile));
}

/** ranges = changed line spans (post-offset numbering); null/empty = whole file.
 * A single one-line range means "the element this line belongs to": exact match,
 * else the nearest element opening above (attribute/handler lines). Multi-line
 * ranges use an ~8-line span intersect (fiber lines mark opening tags only). */
function matchElements(path: string, ranges: Array<[number, number]> | null) {
  const fromFile: Array<{ el: Element; line: number }> = [];
  let withSource = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const src = sourceOf(fiberOf(el));
    if (src) withSource++;
    if (!src || !fileMatches(src.file, path)) continue;
    fromFile.push({ el, line: src.line ?? -1 });
  }
  if (!ranges || ranges.length === 0) return { matched: fromFile, fromFile, withSource };

  const precise = ranges.length === 1 && ranges[0]![0] === ranges[0]![1];
  if (precise) {
    const target = ranges[0]![0];
    const exact = fromFile.filter((c) => c.line === target);
    if (exact.length > 0) return { matched: exact, fromFile, withSource };
    // nearest element opening above the hovered line
    const above = fromFile.filter((c) => c.line > 0 && c.line < target);
    above.sort((x, y) => y.line - x.line);
    return { matched: above.slice(0, 1), fromFile, withSource };
  }

  const matched = fromFile.filter((c) => ranges.some(([a, b]) => c.line >= a - 8 && c.line <= b + 1));
  return { matched, fromFile, withSource };
}

function highlightFile(path: string, ranges: Array<[number, number]> | null) {
  clearOverlay();
  const { matched, fromFile, withSource } = matchElements(path, ranges);
  let count = 0;
  for (const { el } of matched) {
    if (count >= 40) break;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      drawBox(rect);
      count++;
    }
  }
  if (count === 0) {
    // nothing lit up — tell the shell why so misses are diagnosable
    post({ type: "highlight-miss", path, fileMatched: fromFile.length, withSource, ranges });
  }
}

// ---- headless self-test hook: #__toyontest=src/App.tsx@27-27 ----
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
if (LOOPBACK && location.hash.startsWith("#__toyontest=")) {
  const spec = decodeURIComponent(location.hash.slice("#__toyontest=".length));
  const [path, span] = spec.split("@");
  const ranges: Array<[number, number]> | null = span
    ? [[Number(span.split("-")[0]), Number(span.split("-")[1] ?? span.split("-")[0])]]
    : null;
  setTimeout(() => {
    const { matched, fromFile, withSource } = matchElements(String(path), ranges);
    const out = document.createElement("pre");
    out.id = "__toyontest";
    out.textContent = JSON.stringify(
      {
        path,
        ranges,
        withSource,
        fileMatched: fromFile.length,
        matched: matched.map((m) => ({
          tag: m.el.tagName.toLowerCase(),
          line: m.line,
          text: m.el.textContent?.slice(0, 30),
        })),
      },
      null,
      1,
    );
    document.body.appendChild(out);
  }, 1500);
}

// ---- commands from the shell ----

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  if (SHELL_ORIGINS.length && !SHELL_ORIGINS.includes(e.origin)) return;
  const raw = e.data as { __toyon?: boolean } | null;
  if (!raw?.__toyon) return;
  shellOrigin = e.origin;
  const d = raw as unknown as ShellToBridgeMsg;
  switch (d.type) {
    case "reload":
      location.reload();
      break;
    case "navigate":
      // full navigation: always correct regardless of the app's router (or lack of one).
      // Same-origin paths only: never a scheme, so a bad frame can't send the page elsewhere
      if (/^[/?#]/.test(d.path)) location.assign(d.path);
      break;
    case "back":
      history.back();
      break;
    case "forward":
      history.forward();
      break;
    case "pick-start":
      startPicking();
      break;
    case "pick-cancel":
      stopPicking();
      break;
    case "highlight-file":
      highlightFile(d.path, d.ranges ?? null);
      break;
    case "highlight-computed": {
      clearOverlay();
      // An inherited property is on every element whether or not it puts anything on screen: the
      // root font matched a wrapper div as readily as the label inside it, and the first version of
      // this boxed the entire page. Inherited only counts where text is actually painted, which is
      // an element with a text node of its own rather than a descendant with one. Background and
      // border do not inherit, so they count wherever they land.
      const inherits = /^(color|font|line-height|letter-|text-|word-)/;
      const paints = (el: Element) => {
        // a form control draws its value and its placeholder with no child node to find, so the
        // composer's "no worktree selected" is text on screen and a text-node test says otherwise
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
        for (let n = el.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 && n.textContent && n.textContent.trim()) return true;
        }
        return false;
      };
      // one getComputedStyle per element, and the properties come off the same resolved object, so
      // the cost is the resolve and not the count of them. Measured at 11ms for ten thousand
      // elements, which is why this runs on hover with no debounce.
      const els = document.querySelectorAll("*");
      let first = true;
      for (let i = 0; i < els.length; i++) {
        const cs = getComputedStyle(els[i]!);
        const ok = ([prop, v]: [string, string]) =>
          cs.getPropertyValue(prop) === v && (!inherits.test(prop) || paints(els[i]!));
        const hit = d.match === "any" ? d.props.some(ok) : d.props.every(ok);
        // only the first carries the label, for the same reason highlight-selector does it
        if (hit) {
          drawBox(els[i]!.getBoundingClientRect(), first ? d.label || undefined : undefined);
          first = false;
        }
      }
      break;
    }
    case "highlight-selector": {
      clearOverlay();
      try {
        // every match, not the first: the design pane asks "where is this class" about a class used
        // thirty times, and one box out of thirty answers a question nobody asked. Only the first
        // carries the label, or a dense page turns into a wall of tags.
        const all = document.querySelectorAll(d.selector);
        for (let i = 0; i < all.length; i++) {
          drawBox(all[i]!.getBoundingClientRect(), i === 0 ? d.label || undefined : undefined);
        }
      } catch {
        // an invalid selector is the caller's bug, and throwing here would kill the message pump
      }
      break;
    }
    case "highlight-clear":
      clearOverlay();
      break;
    case "zen":
      zen = d.on;
      break;
    case "theme":
      // interpolated into cssText: hex colors only
      if (/^#[0-9a-f]{3,8}$/i.test(d.accent)) accent = d.accent;
      if (/^#[0-9a-f]{3,8}$/i.test(d.accentFg)) accentFg = d.accentFg;
      break;
  }
});
