import { describe, expect, test } from "bun:test";
import { componentName, type Fiber, pickedAt, pickTarget, sourceAt } from "./fiber.ts";

// fake fibers: only the links and debug fields the reader follows. The owner defaults to a render;
// null marks JSX written outside one, which is the root `<App />`
let nodes = 0;
function el(type: unknown, at: string | null, children: Fiber[] = [], owner: unknown = "render"): Fiber {
  const [file, line] = at?.split(":") ?? [];
  const f: Fiber = {
    type,
    return: null,
    child: children[0] ?? null,
    sibling: null,
    stateNode: typeof type === "string" ? { node: nodes++ } : null,
    _debugSource: file ? { fileName: `/app/src/${file}`, lineNumber: Number(line) } : undefined,
    _debugOwner: owner,
  };
  children.forEach((c, i) => {
    c.return = f;
    c.sibling = children[i + 1] ?? null;
  });
  return f;
}

const opens = (f: Fiber, shift = false) => {
  const s = pickTarget(pickedAt(f), shift);
  return s ? `${s.file.slice(s.file.lastIndexOf("/src/") + 5)}:${s.line}` : null;
};

const STRICT = Symbol.for("react.strict_mode");
const App = () => null;
const Page = () => null;
const Card = () => null;
const Button = () => null;
const PrimaryButton = () => null;
const Toolbar = () => null;
const Form = () => null;
const Field = () => null;
const Link = () => null;
const Fancy = () => null;

describe("pickedAt and pickTarget", () => {
  test("text in a page opens its own line, not the root render that mounts the page", () => {
    const p = el("p", "App.tsx:30");
    const app = el(App, "main.tsx:8", [el("div", "App.tsx:22", [el("h1", "App.tsx:23"), p])], null);
    el(STRICT, null, [app]);
    expect(opens(p)).toBe("App.tsx:30");
    expect(opens(p, true)).toBe("App.tsx:30");
    expect(pickedAt(p).comp).toBe("App");
  });

  test("the page's own root element opens the page, and main.tsx is never offered", () => {
    const root = el("div", "App.tsx:22", [el("p", "App.tsx:23")]);
    el(App, "main.tsx:8", [root], null);
    expect(opens(root)).toBe("App.tsx:22");
    expect(pickedAt(root).call).toBeNull();
  });

  test("a shared button opens where it is used, and shift opens the component", () => {
    const button = el("button", "Button.tsx:5");
    const nav = el("nav", "Toolbar.tsx:10", [
      el(Button, "Toolbar.tsx:12", [button]),
      el(Button, "Toolbar.tsx:13", [el("button", "Button.tsx:5")]),
    ]);
    el(Toolbar, "App.tsx:9", [nav]);
    expect(opens(button)).toBe("Toolbar.tsx:12");
    expect(opens(button, true)).toBe("Button.tsx:5");
    expect(pickedAt(button)).toMatchObject({ comp: "Button", wraps: true });
  });

  test("text inside a shared component opens the component, and shift opens where it is used", () => {
    const title = el("h2", "Card.tsx:7");
    el(Page, "App.tsx:14", [el(Card, "Page.tsx:20", [el("section", "Card.tsx:6", [title])])]);
    expect(opens(title)).toBe("Card.tsx:7");
    expect(opens(title, true)).toBe("Page.tsx:20");
    expect(pickedAt(title)).toMatchObject({ comp: "Card", wraps: false });
  });

  test("a wrapper over a wrapper opens the outermost call site", () => {
    const button = el("button", "Button.tsx:5");
    const primary = el(PrimaryButton, "Toolbar.tsx:11", [el(Button, "PrimaryButton.tsx:3", [button])]);
    el(Toolbar, "App.tsx:9", [el("nav", "Toolbar.tsx:10", [primary])]);
    expect(opens(button)).toBe("Toolbar.tsx:11");
    expect(pickedAt(button).comp).toBe("PrimaryButton");
  });

  test("a component that renders two nodes is not either of them", () => {
    const label = el("label", "Field.tsx:4");
    const field = el(Field, "Form.tsx:9", [label, el("input", "Field.tsx:5")]);
    el(Form, "App.tsx:5", [el("form", "Form.tsx:8", [field])]);
    expect(opens(label)).toBe("Field.tsx:4");
    expect(opens(label, true)).toBe("Form.tsx:9");
  });

  test("a forwardRef button is named and treated like any other", () => {
    const button = el("button", "Button.tsx:5");
    const fancy = { $$typeof: Symbol.for("react.forward_ref"), render: Fancy };
    el(Toolbar, "App.tsx:9", [el("nav", "Toolbar.tsx:10", [el(fancy, "Toolbar.tsx:12", [button])])]);
    expect(opens(button)).toBe("Toolbar.tsx:12");
    expect(pickedAt(button).comp).toBe("Fancy");
  });

  test("the element's fiber may be the alternate of the one its component's tree holds", () => {
    const button = el("button", "Button.tsx:5");
    el(Toolbar, "App.tsx:9", [el("nav", "Toolbar.tsx:10", [el(Button, "Toolbar.tsx:12", [button])])]);
    // same DOM node, a different fiber object
    const stale: Fiber = { ...button };
    expect(opens(stale)).toBe("Toolbar.tsx:12");
  });

  test("a library component with no source of its own opens the line that writes it", () => {
    const a = el("a", null);
    el(Page, "App.tsx:3", [el("nav", "Page.tsx:4", [el(Link, "Page.tsx:5", [a])])]);
    expect(opens(a)).toBe("Page.tsx:5");
    expect(pickedAt(a).call).toBeNull();
  });
});

describe("componentName", () => {
  test("names functions, memo and forwardRef, and prefers a displayName", () => {
    expect(componentName(Button)).toBe("Button");
    expect(componentName({ $$typeof: Symbol.for("react.memo"), type: Button })).toBe("Button");
    expect(componentName({ $$typeof: Symbol.for("react.forward_ref"), render: Fancy })).toBe("Fancy");
    expect(componentName({ $$typeof: Symbol.for("react.forward_ref"), render: Fancy, displayName: "Input" })).toBe(
      "Input",
    );
  });

  test("a context rendered as its own provider is not a component", () => {
    expect(componentName({ $$typeof: Symbol.for("react.context"), displayName: "Theme" })).toBeNull();
    expect(componentName("div")).toBeNull();
  });
});

describe("sourceAt", () => {
  test("reads a React 19 debug stack's first frame under /src/", () => {
    const stack =
      "Error: react-stack-top-frame\n" +
      "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n" +
      "    at App (http://localhost:5173/src/App.tsx?t=1712:22:7)";
    expect(sourceAt({ type: "div", return: null, _debugStack: { stack } })).toEqual({ file: "/src/App.tsx", line: 22 });
  });
});
