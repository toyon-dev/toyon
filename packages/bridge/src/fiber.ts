// Reading React's fibers for the picker and the change highlight. Pure, so the rules are tested
// against fake fibers with no DOM, and dependency-free because the bridge bundle imports it.

export type Fiber = {
  return: Fiber | null;
  child?: Fiber | null;
  sibling?: Fiber | null;
  /** React's work tag; only HostText is read, so a bare text node counts as something rendered */
  tag?: number;
  type: unknown;
  /** the DOM node of a host fiber. The fiber a node holds may be the alternate of the one its
   * parent's child walk reaches, so two fibers are the same element when these match */
  stateNode?: unknown;
  _debugSource?: { fileName: string; lineNumber: number };
  _debugStack?: { stack?: string } | Error;
  /** the fiber whose render created this one's element: null for JSX written outside any render,
   * which is the root `<App />` handed to createRoot */
  _debugOwner?: unknown;
};

export type Source = { file: string; line?: number };

const HOST_TEXT = 6;
const FORWARD_REF = Symbol.for("react.forward_ref");
const MEMO = Symbol.for("react.memo");

/** where this one fiber's JSX was written */
export function sourceAt(f: Fiber): Source | null {
  if (f._debugSource?.fileName) return { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
  // React 19 dropped _debugSource; _debugStack frames carry served-module URLs
  const stack = (f._debugStack as Error | undefined)?.stack;
  if (stack) {
    const m = stack.match(/https?:\/\/[^/]+(\/src\/[^)\s?]+)(?:\?[^:)\s]*)?:(\d+):\d+/);
    if (m?.[1]) return { file: m[1], line: Number(m[2]) || undefined };
  }
  return null;
}

export function sourceOf(fiber: Fiber | null): Source | null {
  for (let f = fiber; f; f = f.return) {
    const s = sourceAt(f);
    if (s) return s;
  }
  return null;
}

/** a component's name through the wrappers design systems put on it. Only functions and those two
 * wrappers count: a React 19 context is its own provider and can carry a displayName, and nobody
 * wants a provider's call site. */
export function componentName(t: unknown): string | null {
  if (typeof t === "function") return (t as { displayName?: string }).displayName || t.name || null;
  const o = t as { $$typeof?: unknown; displayName?: string; render?: unknown; type?: unknown } | null;
  if (o?.$$typeof === FORWARD_REF) return o.displayName || componentName(o.render);
  if (o?.$$typeof === MEMO) return o.displayName || componentName(o.type);
  return null;
}

const isDom = (f: Fiber) => typeof f.type === "string" || f.tag === HOST_TEXT;
const sameNode = (a: Fiber | null, b: Fiber) => !!a && (a === b || (!!a.stateNode && a.stateNode === b.stateNode));

/** the one DOM node a component renders at its top, or null when it renders several or none: down
 * through everything that is not DOM (components, fragments, providers), stopping at the first DOM
 * node on each branch, so a page's whole tree is never walked */
function onlyNode(comp: Fiber): Fiber | null {
  let found: Fiber | null = null;
  const walk = (f: Fiber): boolean => {
    for (let c = f.child ?? null; c; c = c.sibling ?? null) {
      if (isDom(c)) {
        if (found) return false;
        found = c;
      } else if (!walk(c)) return false;
    }
    return true;
  };
  return walk(comp) ? found : null;
}

/** where a component is written: its own JSX, or the nearest above it when it has none (a library
 * component's fiber carries no source). Null when that JSX sits outside any render: the `<App />`
 * in main.tsx is never the line anyone means. */
function callSite(f: Fiber): Source | null {
  for (let g: Fiber | null = f; g; g = g.return) {
    const s = sourceAt(g);
    if (s) return g._debugOwner === null ? null : s;
  }
  return null;
}

export type Picked = {
  /** the JSX the element itself was rendered from */
  src: Source | null;
  /** the component the element belongs to */
  comp: string | null;
  /** where that component is written */
  call: Source | null;
  /** the component is nothing but this element, the way a `<Button>` is its `<button>` */
  wraps: boolean;
};

/** Which component an element belongs to, and the line that writes it. The name and the call site
 * come off the same fiber so they talk about the same thing: children handed to a shared component
 * are written in the outer file, so taking the next file up would answer `<Button>` with a line
 * inside Button.tsx.
 *
 * An element that is the whole of its component belongs to that component's call site, and a
 * component that is the whole of the one above it passes outward again, so `<PrimaryButton>` over
 * `<Button>` over `<button>` names the line writing `<PrimaryButton>`. An element inside a component
 * (a paragraph in a page) stops at the first component: its call site is still carried for shift,
 * but a nearest-component rule alone sent every paragraph of App to the `<App />` in main.tsx. */
export function pickedAt(fiber: Fiber | null): Picked {
  const src = sourceOf(fiber);
  let comp: string | null = null;
  let call: Source | null = null;
  let wraps = false;
  for (let f = fiber; f; f = f.return) {
    const name = componentName(f.type);
    if (!name) continue;
    const whole = !!fiber && sameNode(onlyNode(f), fiber);
    const site = callSite(f);
    // past the first component, only one that is still nothing but this element moves outward, and
    // only to a line that exists: the root render's call site is dropped, never taken over a real one
    if (comp && !(whole && site)) break;
    comp = name;
    call = site;
    wraps = whole;
    if (!whole) break;
  }
  // one source, named once: a plain element written where it renders has nowhere else to send you
  if (call && src && call.file === src.file && call.line === src.line) call = null;
  return { src, comp, call, wraps };
}

/** which file opening the element goes to. A component that is nothing but this element opens
 * where the component is written, the line being edited; an element inside a component opens its
 * own JSX. Shift asks for the other, and either falls back to the one there is. */
export function pickTarget({ src, call, wraps }: Picked, shift: boolean): Source | null {
  const first = wraps ? call : src;
  const second = wraps ? src : call;
  return (shift ? (second ?? first) : (first ?? second)) ?? null;
}
