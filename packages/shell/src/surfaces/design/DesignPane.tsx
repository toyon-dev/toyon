// The worktree's design system, read forward: what it noticed first, then the inventory.
//
// Sections render from whatever the index has and say so when a half is missing. An empty section
// is never shown as an answer: the scan's coverage record is what tells a project with no classes
// apart from one whose classes this scan cannot read.
//
// Rows are live against the preview. Hovering one outlines what it is in the running app (a class
// by selector, a component by the file its fibers came from), and clicking one opens its source.
// That is the whole reason this sits beside the preview rather than in a docs tab.

import type { DesignClass, DesignComponent, DesignIndex, DesignToken } from "@toyon/shared";
import { useEffect } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { localOf } from "../../state/store.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { contrastRatio, parseHex } from "./contrast.ts";

export function DesignPane({
  worktreeId,
  height,
  full,
  onToggleFull,
  onDragStart,
}: {
  worktreeId: string;
  height: number | string;
  full: boolean;
  onToggleFull: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const index = useStore((s) => localOf(s, worktreeId).design);

  // scan on open. The result is cached per worktree, so coming back to a pane that has already run
  // shows its last answer rather than a blank while it reruns.
  useEffect(() => {
    if (!index) sock?.send({ t: "design-scan", worktreeId });
  }, [index, worktreeId, sock]);

  // a pane that closes while an outline is up would leave it painted over the app
  useEffect(() => () => previewBus.post(worktreeId, { type: "highlight-clear" }), [worktreeId]);

  const live = {
    outline: (msg: Parameters<typeof previewBus.post>[1]) => previewBus.post(worktreeId, msg),
    clear: () => previewBus.post(worktreeId, { type: "highlight-clear" }),
    open: (path: string) => sock?.send({ t: "file-diff", worktreeId, path }),
  };

  return (
    <Pane
      className={`design-pane ${full ? "full" : ""}`}
      height={full ? undefined : height}
      resizable={!full}
      onDragStart={onDragStart}
      // The other panes put what you are looking at here: the diff its file path, the terminal its
      // tabs. Naming this one "Design system" was the only header in the app that said what the
      // thing already obviously is. What it cannot say for itself is how far the scan reached.
      title={index ? <span>{reach(index)}</span> : undefined}
      onClose={() => dispatch({ a: "toggle-design" })}
      actions={
        <>
          <button
            className="btn btn-outline"
            onClick={() => sock?.send({ t: "design-scan", worktreeId })}
            data-tip="Scan this worktree again"
          >
            <Icon name="reload" className="icon-inline" /> rescan
          </button>
          <button
            className="btn btn-outline deep-link"
            onClick={onToggleFull}
            data-tip={full ? "Split view: show the preview above" : "Full height: hide the preview"}
          >
            <Icon name={full ? "split" : "full"} className="icon-inline" /> {full ? "split" : "full"}
          </button>
        </>
      }
    >
      {index ? (
        <div className="design-body" onMouseLeave={live.clear}>
          <Tokens tokens={index.tokens} />
          <Components index={index} outline={live.outline} clear={live.clear} onOpen={live.open} />
          <Classes index={index} outline={live.outline} clear={live.clear} onOpen={live.open} />
        </div>
      ) : (
        <div className="empty">reading the design system…</div>
      )}
    </Pane>
  );
}

type Outline = (msg: Parameters<typeof previewBus.post>[1]) => void;

/** what the scan actually opened, which is the one thing about this pane the body never says and
 * the first thing to doubt when a section comes back thinner than you expected */
function reach(index: DesignIndex): string {
  const files = Object.values(index.coverage.files).reduce((a, b) => a + b, 0);
  const sheets = index.coverage.stylesheets;
  return `${files} file${files === 1 ? "" : "s"} read, ${sheets} stylesheet${sheets === 1 ? "" : "s"}`;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="design-section">
      <h2 className="design-h">
        {title}
        {note && <span className="design-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

/** what the scan could not read, said plainly. An empty section with no explanation reads as a
 * verdict on the project rather than on the scan. */
function Gap({ children }: { children: React.ReactNode }) {
  return <p className="design-gap">{children}</p>;
}

/** Collapsed to its headline. A finding is one sentence about the project; the instances behind it
 * are what you open when you want to go and look, and they were burying the rest of the pane. */
/**
 * Grouped by what a token *is*, not by what it is called.
 *
 * Name prefixes looked like the obvious grouping and are not: `--accent`, `--aqua` and `--blue`
 * are each their own prefix, so every colour became a section of one, and a page of colours turned
 * into forty headed bands with one swatch apiece. Kind gives four groups for any project.
 *
 * Order inside a group is the order the stylesheet declares them, which is the grouping the author
 * already made and the only one worth trusting: a token file writes the surface rungs together,
 * then the elements, then the text ladder, because that is the order they mean something in.
 */
const GROUPS: Array<{ kind: DesignToken["kind"]; label: string; tight?: boolean }> = [
  { kind: "color", label: "color" },
  { kind: "length", label: "size & radius", tight: true },
  { kind: "font", label: "type" },
  { kind: "shadow", label: "shadow" },
  { kind: "other", label: "computed", tight: true },
];

/** The project's own ground to measure contrast against: the first colour its token file declares,
 * which in every token file we have seen is the base surface, because that is the one you decide
 * first. A guess, so the section says which token it used and you can see when it is the wrong one.
 * The running page's actual body background is the real answer, and only the live half has it. */
function groundOf(tokens: DesignToken[]): DesignToken | undefined {
  return tokens.find((t) => t.kind === "color" && parseHex(t.resolved ?? t.value) !== null);
}

// `index.live` is not read here on purpose. It said "declared, not resolved" in the header, which
// is true of every scan so far and so told a reader nothing; when the live half lands and the two
// actually differ, the difference is worth a word and this is where it goes.
function Tokens({ tokens }: { tokens: DesignToken[] }) {
  const ground = groundOf(tokens);
  return (
    <Section title="Tokens">
      {tokens.length === 0 ? (
        <Gap>
          No custom properties found. A project on Sass or Less variables keeps its scale somewhere this scan does not
          read yet.
        </Gap>
      ) : (
        GROUPS.map(({ kind, label, tight }) => {
          const group = tokens.filter((t) => t.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="design-group">
              <span className="design-group-name">{label}</span>
              {/* a group that fits sits in the column; one that does not fills the section, with
                  its lattice still anchored to the column's left edge (see the stylesheet) */}
              <div className={`design-breakout ${group.length <= (tight ? 6 : 5) ? "fits" : ""}`}>
                <div className={`design-grid ${tight ? "tight" : ""}`}>
                  {group.map((t) => (
                    <Swatch key={t.name} token={t} ground={ground} largest={largestIn(group)} />
                  ))}
                </div>
              </div>
            </div>
          );
        })
      )}
    </Section>
  );
}

/** the biggest length in a group, so the scale bars can be drawn relative to their own scale */
function largestIn(group: DesignToken[]): number {
  return group.reduce((max, t) => Math.max(max, Math.abs(Number.parseFloat(t.value)) || 0), 0);
}

function Swatch({ token, ground, largest }: { token: DesignToken; ground: DesignToken | undefined; largest: number }) {
  // what it resolves to is what to paint and measure; what it says is what to go and edit
  const actual = token.resolved ?? token.value;
  const groundValue = ground && (ground.resolved ?? ground.value);
  const ratio = token.kind === "color" && groundValue ? contrastRatio(actual, groundValue) : null;
  // Painting a value nothing can resolve would paint it with the *shell's* token of that name.
  // A translucent colour still paints; it just has no ratio to print.
  const paintable = token.kind === "color" && parseHex(actual) !== null;
  const sample = token.kind === "color" || token.kind === "font";
  const size = token.kind === "length" ? Number.parseFloat(actual) : Number.NaN;

  return (
    <div className="design-cell" data-kind={token.kind} {...tip(describe(token, ratio, ground))}>
      {sample && (
        <div className="design-sample">
          {paintable && <span className="design-fill" style={{ background: actual }} />}
          {token.kind === "font" && (
            <span className="design-specimen" style={{ fontFamily: actual }}>
              Ag
            </span>
          )}
        </div>
      )}
      <div className="design-plate">
        <span className="design-cell-name">{token.name}</span>
        <span className="design-cell-line">
          <span className="design-cell-value">{token.value}</span>
          {ratio && <span className="design-cell-note">{ratio}</span>}
        </span>
        {token.resolved && (
          <span className="design-cell-line">
            <span className="design-cell-value">{token.resolved}</span>
          </span>
        )}
        {Number.isFinite(size) && largest > 0 && (
          <span className="design-scale" style={{ width: `${Math.max(2, (Math.abs(size) / largest) * 100)}%` }} />
        )}
      </div>
    </div>
  );
}

/** The whole chip in a sentence. Every line in a cell used to carry its own `title`, so a value and
 * the ratio beside it were two separate hovers of two separate fragments; the cell is one thing. */
function describe(token: DesignToken, ratio: string | null, ground: DesignToken | undefined): string {
  const parts = [`${token.name} is ${token.value}`];
  if (token.resolved) parts.push(`which resolves to ${token.resolved}`);
  const sentence = parts.join(", ");
  return ratio && ground ? `${sentence}. ${ratio} against ${ground.name}` : sentence;
}

function Components({
  index,
  outline,
  clear,
  onOpen,
}: {
  index: DesignIndex;
  outline: Outline;
  clear: () => void;
  onOpen: (path: string) => void;
}) {
  const { components, typed } = index;
  // A section with nothing under it is a heading, not an answer. What the scan reached is in the
  // pane's own header, so a project it found no components in says so there rather than here.
  if (components.length === 0) return null;
  // The split that matters: a component two or more files reach for is shared vocabulary, and the
  // rest is a page, a root, or a one-off. That tail is long in every project and is not a problem,
  // so it collapses here rather than being reported as one above.
  const shared = components.filter((c) => c.imports >= 2);
  const rest = components.filter((c) => c.imports < 2);

  const row = (c: DesignComponent) => (
    <Row
      key={`${c.path}:${c.name}`}
      count={c.imports}
      name={c.name}
      path={c.path}
      // fibers carry the file they were rendered from, so this outlines every instance of the
      // component that is on the page right now
      onEnter={() => outline({ type: "highlight-file", path: c.path, ranges: null })}
      onLeave={clear}
      onOpen={() => onOpen(c.path)}
    >
      {c.variants.length > 0 && (
        <span className="design-variants">
          {c.variants.map((v) => (
            <span key={v.prop} className="design-variant">
              {v.prop}: {v.values.join(" \u00b7 ")}
            </span>
          ))}
        </span>
      )}
    </Row>
  );

  return (
    <Section title="Components" note={`${shared.length} reused of ${components.length}`}>
      {!typed && <Gap>No TypeScript in this project, so the values each prop allows are not listed.</Gap>}
      <ul className="design-rows">{shared.map(row)}</ul>
      {rest.length > 0 && (
        <details className="design-tail">
          <summary>
            <span className="design-count">{rest.length}</span>
            used once or never
          </summary>
          <ul className="design-rows">{rest.map(row)}</ul>
        </details>
      )}
    </Section>
  );
}

function Classes({
  index,
  outline,
  clear,
  onOpen,
}: {
  index: DesignIndex;
  outline: Outline;
  clear: () => void;
  onOpen: (path: string) => void;
}) {
  const { classes, coverage } = index;
  const used = classes.filter((c) => c.uses > 0);
  // The same split the components get: a class two or more places reach for is shared vocabulary,
  // and the long tail of one-offs and dead selectors is real but not what you came to read.
  const shared = classes.filter((c) => c.uses >= 2);
  const rest = classes.filter((c) => c.uses < 2);
  const unwrapped = shared.filter((c) => c.unwrapped).length;
  // said once, in the header, and marked on the rows it is about. Listing them again underneath
  // was the same names twice on one screen.
  const note = classes.length
    ? `${shared.length} reused of ${classes.length}` +
      (unwrapped ? `, ${unwrapped} with no component of their name` : "")
    : undefined;
  return (
    <Section title="Classes" note={note}>
      {classes.length === 0 ? (
        <Gap>No stylesheet in this project defines a class. Utility-first CSS generates its own.</Gap>
      ) : used.length === 0 ? (
        <Gap>
          {coverage.classAttrs > 0
            ? `${coverage.classAttrs} class attributes were read, and none names a class this scan can follow. That is what a CSS Modules project looks like from here.`
            : "No class attribute anywhere in the source that was read. The markup may live in a file type this scan does not open."}
        </Gap>
      ) : (
        <>
          <ul className="design-rows">
            {shared.map((c) => (
              <ClassRow key={c.name} cls={c} outline={outline} clear={clear} onOpen={onOpen} />
            ))}
          </ul>
          {rest.length > 0 && (
            <details className="design-tail">
              <summary>
                <span className="design-count">{rest.length}</span>
                used once or never
              </summary>
              <ul className="design-rows">
                {rest.map((c) => (
                  <ClassRow key={c.name} cls={c} outline={outline} clear={clear} onOpen={onOpen} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Section>
  );
}

function ClassRow({
  cls,
  outline,
  clear,
  onOpen,
}: {
  cls: DesignClass;
  outline: Outline;
  clear: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <Row
      count={cls.uses}
      name={`.${cls.name}`}
      path={cls.path}
      onEnter={() => outline({ type: "highlight-selector", selector: `.${cls.name}`, label: `.${cls.name}` })}
      onLeave={clear}
      onOpen={() => cls.path && onOpen(cls.path)}
    >
      {cls.unwrapped && <span className="design-tag">no component</span>}
    </Row>
  );
}

/** one inventory row: count in a fixed gutter, name, source path, and whatever the section adds.
 * The whole row is the hit target, because the thing you want to click is the thing you read. */
function Row({
  count,
  name,
  path,
  onEnter,
  onLeave,
  onOpen,
  children,
}: {
  count: number;
  name: string;
  path?: string;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        className="design-row"
        onMouseEnter={onEnter}
        onFocus={onEnter}
        onMouseLeave={onLeave}
        onBlur={onLeave}
        onClick={onOpen}
        disabled={!path}
      >
        <span className="design-count">{count}</span>
        <span className="design-name">{name}</span>
        <span className="design-path">{path}</span>
        {children}
      </button>
    </li>
  );
}
