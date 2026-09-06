// Injected into preview pages by the per-worktree proxy.
// Reports navigation/errors/HMR to the shell; runs the element picker and
// file-highlight overlays; forwards Orchardist keyboard chords.

const post = (msg: Record<string, unknown>) => {
  try {
    window.parent.postMessage({ __orchardist: true, ...msg }, "*");
  } catch {
    // not framed; nothing to do
  }
};

post({ type: "loaded", url: location.href, title: document.title });

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

// forward Orchardist chords to the shell even when the preview has focus
const CHORD_KEYS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "k", "p", "b", "j", "e", "."]);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.metaKey && !e.ctrlKey && !e.altKey && CHORD_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: "key", key: e.key, meta: true });
    } else if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "e")) {
      // ⌘⇧F search-in-files and ⌘⇧E command palette work even with the preview focused
      // (plain ⌘F stays the page's own find)
      e.preventDefault();
      e.stopPropagation();
      post({ type: "key", key: e.key.toUpperCase(), meta: true, shift: true });
    }
  },
  true,
);

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
  overlay.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  document.documentElement.appendChild(overlay);
  return overlay;
}

function clearOverlay() {
  if (overlay) overlay.innerHTML = "";
}

function drawBox(rect: DOMRect, label?: string) {
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #fe8019;outline-offset:-1px;background:rgba(254,128,25,0.08);border-radius:2px;`;
  if (label) {
    const tag = document.createElement("div");
    tag.textContent = label;
    tag.style.cssText =
      "position:absolute;left:0;top:-20px;background:#fe8019;color:#1d2021;font:11px -apple-system,sans-serif;padding:1px 6px;border-radius:3px;white-space:nowrap;";
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
  const label = comp ? `<${comp}>${src ? ` · ${shortFile(src.file)}${src.line ? ":" + src.line : ""}` : ""}` : el.tagName.toLowerCase();
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

  const matched = fromFile.filter((c) =>
    ranges.some(([a, b]) => c.line >= a - 8 && c.line <= b + 1),
  );
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

// ---- headless self-test hook: #__orchtest=src/App.tsx@27-27 ----
if (location.hash.startsWith("#__orchtest=")) {
  const spec = decodeURIComponent(location.hash.slice("#__orchtest=".length));
  const [path, span] = spec.split("@");
  const ranges: Array<[number, number]> | null = span
    ? [[Number(span.split("-")[0]), Number(span.split("-")[1] ?? span.split("-")[0])]]
    : null;
  setTimeout(() => {
    const { matched, fromFile, withSource } = matchElements(String(path), ranges);
    const out = document.createElement("pre");
    out.id = "__orchtest";
    out.textContent = JSON.stringify(
      {
        path, ranges, withSource, fileMatched: fromFile.length,
        matched: matched.map((m) => ({ tag: m.el.tagName.toLowerCase(), line: m.line, text: m.el.textContent?.slice(0, 30) })),
      },
      null, 1,
    );
    document.body.appendChild(out);
  }, 1500);
}

// ---- commands from the shell ----

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || !d.__orchardist) return;
  switch (d.type) {
    case "reload":
      location.reload();
      break;
    case "navigate":
      // full navigation: always correct regardless of the app's router (or lack of one)
      location.assign(String(d.path ?? "/"));
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
      highlightFile(String(d.path ?? ""), Array.isArray(d.ranges) ? d.ranges : null);
      break;
    case "highlight-selector": {
      clearOverlay();
      try {
        const el = document.querySelector(String(d.selector ?? ""));
        if (el) drawBox(el.getBoundingClientRect(), String(d.label ?? "") || undefined);
      } catch {}
      break;
    }
    case "highlight-clear":
      clearOverlay();
      break;
  }
});
