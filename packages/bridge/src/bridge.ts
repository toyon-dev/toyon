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

// SPA navigation reporting
const origPush = history.pushState.bind(history);
history.pushState = (...args) => {
  origPush(...args);
  post({ type: "navigated", url: location.href });
};
window.addEventListener("popstate", () => post({ type: "navigated", url: location.href }));

// forward Orchardist chords to the shell even when the preview has focus
const CHORD_KEYS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "k", "p", "b", "j", "e"]);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.metaKey && !e.ctrlKey && !e.altKey && CHORD_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: "key", key: e.key, meta: true });
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

function shortFile(f: string): string {
  const i = f.lastIndexOf("/src/");
  return i >= 0 ? f.slice(i + 1) : f.split("/").slice(-2).join("/");
}

// ---- file highlight (hover a changed file -> outline what it renders) ----

function highlightFile(path: string) {
  clearOverlay();
  let count = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (count >= 40) break;
    const src = sourceOf(fiberOf(el));
    if (src && (src.file.endsWith(path) || path.endsWith(shortFile(src.file)))) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        drawBox(rect);
        count++;
      }
    }
  }
}

// ---- commands from the shell ----

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || !d.__orchardist) return;
  switch (d.type) {
    case "reload":
      location.reload();
      break;
    case "pick-start":
      startPicking();
      break;
    case "pick-cancel":
      stopPicking();
      break;
    case "highlight-file":
      highlightFile(String(d.path ?? ""));
      break;
    case "highlight-clear":
      clearOverlay();
      break;
  }
});
