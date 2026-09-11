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
import { designRowItems, designTokenItems } from "../../state/actions/design.ts";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { localOf } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { Pane } from "../../ui/Pane.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { wtDir } from "../util.ts";
import { contrastRatio, parseHex } from "./contrast.ts";
import "./design.css";
import { cx } from "../../ui/cx.ts";

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
    open: (path: string) => openFile({ sock, dispatch }, { worktreeId, path }),
  };

  return (
    <Pane
      className={cx("design-pane", full && "full")}
      height={full ? undefined : height}
      resizable={!full}
      onDragStart={onDragStart}
      // The other panes put what you are looking at here: the diff its file path, the terminal its
      // tabs. This one says how far the scan reached, the one thing the body cannot say for itself.
      title={index ? <span>{reach(index)}</span> : undefined}
      onClose={() => dispatch({ a: "toggle-design" })}
      full={full}
      onToggleFull={onToggleFull}
      actions={
        <Button
          variant="outline"
          onClick={() => sock?.send({ t: "design-scan", worktreeId })}
          data-tip="Scan this worktree again"
        >
          <Icon name="reload" className="icon-inline" /> rescan
        </Button>
      }
    >
      {index ? (
        <div className="design-body" style={LAYOUT} onMouseLeave={live.clear}>
          <Tokens tokens={index.tokens} outline={live.outline} clear={live.clear} />
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

/**
 * The text measure and the cell the grids lay out on, defined once.
 *
 * They are handed to the stylesheet as custom properties on the body rather than written in both
 * places: the lattice only works while the two agree, and a measure widened in the CSS with the
 * cell left behind here would put every grid quietly out of step with the column again. Set inline
 * rather than declared in the stylesheet so they do not turn up as tokens when the pane scans
 * toyon itself.
 */
const COLUMN = 720;
const CELL = 132;
const LAYOUT = { "--design-column": `${COLUMN}px`, "--design-cell": `${CELL}px` } as React.CSSProperties;

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

/**
 * Grouped by what a token *is*, not by what it is called: name prefixes make every colour a
 * section of one (`--accent`, `--aqua`, `--blue`), while kind gives four groups for any project.
 *
 * Order inside a group is the order the stylesheet declares them, which is the grouping the author
 * already made and the only one worth trusting: a token file writes the surface rungs together,
 * then the elements, then the text ladder, because that is the order they mean something in.
 */
const GROUPS: Array<{ kind: DesignToken["kind"]; label: string }> = [
  { kind: "font", label: "type" },
  { kind: "color", label: "color" },
  { kind: "length", label: "size & radius" },
  { kind: "shadow", label: "shadow" },
  { kind: "other", label: "computed" },
];

/** The project's own ground to measure contrast against: the first colour its token file declares,
 * which in every token file we have seen is the base surface, because that is the one you decide
 * first. A guess, so the section says which token it used and you can see when it is the wrong one.
 * The running page's actual body background is the real answer, and only the live half has it. */
function groundOf(tokens: DesignToken[]): DesignToken | undefined {
  return tokens.find((t) => t.kind === "color" && parseHex(t.resolved ?? t.value) !== null);
}

// `index.live` is deliberately unread: it is false for every scan until the live half lands, and a
// header saying "declared, not resolved" on every scan tells a reader nothing. When the two can
// differ, the difference is worth a word and this is where it goes.
function Tokens({ tokens, outline, clear }: { tokens: DesignToken[]; outline: Outline; clear: () => void }) {
  const ground = groundOf(tokens);
  /* Which other tokens carry this one's value. Built once for the whole set rather than per swatch,
     because every swatch would otherwise walk every token. */
  const byValue = new Map<string, string[]>();
  for (const t of tokens) {
    const v = (t.resolved ?? t.value).trim().toLowerCase();
    byValue.set(v, [...(byValue.get(v) ?? []), t.name]);
  }
  const sharesWith = (t: DesignToken) =>
    (byValue.get((t.resolved ?? t.value).trim().toLowerCase()) ?? []).filter((n) => n !== t.name);
  return (
    <Section title="Tokens">
      {tokens.length === 0 ? (
        <Gap>
          No custom properties found. A project on Sass or Less variables keeps its scale somewhere this scan does not
          read yet.
        </Gap>
      ) : (
        GROUPS.map(({ kind, label }) => {
          const group = tokens.filter((t) => t.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="design-group">
              {kind !== "font" && <span className="design-group-name">{label}</span>}
              {kind === "font" ? (
                <Faces tokens={group} outline={outline} clear={clear} />
              ) : (
                <div className="design-breakout" style={breakout(group.length)}>
                  <div className="design-grid">
                    {group.map((t) => (
                      <Swatch
                        key={t.name}
                        token={t}
                        ground={ground}
                        largest={largestIn(group)}
                        outline={outline}
                        clear={clear}
                        sharing={sharesWith(t)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </Section>
  );
}

/**
 * Where a group's row sits, in whole cells.
 *
 * The row is as wide as its own cells, or as many as the section holds, whichever is fewer. Its
 * left edge is the text column's, pulled back one cell for every two the row has outgrown the
 * column by: the first cell that will not fit hangs off the right, the second moves the row a cell
 * to the left, and so on.
 *
 * Written as CSS rather than numbers because the count of cells in a row depends on a width only
 * the layout knows, and round() snaps with the row's own width in hand.
 */
function breakout(count: number): React.CSSProperties {
  const cell = "var(--design-cell)";
  const row = `min(round(down, 100%, ${cell}), calc(${count} * ${cell}))`;
  // how far past the column the row runs, in whole cells: half of it goes to each side
  const fits = `round(down, var(--design-column), ${cell})`;
  const over = `round(down, max(0px, calc((${row} - ${fits}) / 2)), ${cell})`;
  return { width: row, marginLeft: `max(0px, calc((100% - var(--design-column)) / 2 - ${over}))` };
}

/** the biggest length in a group, so the scale bars can be drawn relative to their own scale */
function largestIn(group: DesignToken[]): number {
  return group.reduce((max, t) => Math.max(max, Math.abs(Number.parseFloat(t.value)) || 0), 0);
}

/** A colour lands on a background, a border or the text itself, so any of these matching is a use.
 * Kept to the seven that actually carry a token; the resolved style object is shared across the
 * reads, so the length of this list is not what the sweep costs. */
const COLOR_PROPS = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
];

/** What a token computes to, taken off the element the pane is already showing it on. Sending the
 * browser's own serialisation means the bridge compares strings and never has to parse a colour,
 * which it has no room for. */
function computedFrom(el: Element | null, props: string[]): Array<[string, string]> {
  if (!el) return [];
  const cs = getComputedStyle(el);
  return props.map((p) => [p, cs.getPropertyValue(p)] as [string, string]);
}

/** A type token is either a stack (`--face-mono`) or a whole `font` shorthand (`--type-mono`). A
 * shorthand is not a valid font-family, so setting it as one fell back to the pane's own face and
 * every sample rendered identical sans. */
const _isFontShorthand = (v: string) => /^[1-9]00\s/.test(v.trim());
const firstFamily = (list: string) => (list.split(",")[0] ?? list).replace(/["']/g, "").trim();

/** What the sample says, in the face it says it in: `-apple-system 13/19.5`. A ratio is multiplied
 * out, because a leading you have to do arithmetic on is not one you can compare down a column, and
 * comparing them is the whole reason these are stacked. */
function parseFace(v: string): { family: string; size: number | null; lead: number | null } {
  const m = /^[1-9]00\s+([\d.]+)px(?:\s*\/\s*([\d.]+)(px)?)?\s+(.+)$/.exec(v.trim());
  if (!m) return { family: firstFamily(v), size: null, lead: null };
  const size = Number(m[1]);
  const raw = m[2] ? Number(m[2]) : null;
  const lead = raw === null ? null : Math.round((m[3] ? raw : size * raw) * 100) / 100;
  return { family: firstFamily(m[4] ?? ""), size, lead };
}

/**
 * The type group reads down the column rather than across a lattice of chips. A colour is one value
 * and fits in a swatch; a type token is a face, a size and a leading at once, and none of those are
 * legible in a 148px cell.
 *
 * Each face heads its own block, named in the same quiet label the other groups use for their
 * heading, because that is what a face token is: the thing the sizes under it are cut from. The
 * sizes then run large to small, each rendered in itself, so the scale is a scale on screen.
 */
function Faces({ tokens, outline, clear }: { tokens: DesignToken[]; outline: Outline; clear: () => void }) {
  /* A face is a family and nothing else, so it matches on family alone: hover the heading and every
     element set in that face lights up, whatever size it is. A sized token matches on all three,
     because a face, a size and a leading only name a tier together. */
  const hover = (e: React.MouseEvent<HTMLElement>, sized: boolean, label: string) =>
    outline({
      type: "highlight-computed",
      props: computedFrom(
        e.currentTarget.querySelector(".design-face-sample"),
        sized ? ["font-family", "font-size", "line-height"] : ["font-family"],
      ),
      match: "all",
      label,
    });
  const rows = tokens.map((t) => ({ token: t, actual: t.resolved ?? t.value, ...parseFace(t.resolved ?? t.value) }));
  const families = [...new Set(rows.map((r) => r.family))];
  const cm = useContextMenu("design");
  return (
    <div className="design-faces">
      {families.map((family) => {
        const group = rows.filter((r) => r.family === family);
        // the stack token, if the project declares one. A project can set a family inline in every
        // rule and never name it, and then the heading is the family with no token to point at.
        const face = group.find((r) => r.size === null);
        const sized = group.filter((r) => r.size !== null).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
        return (
          <div key={family} className="design-face-group">
            <div
              className="design-face-head row-edge"
              onMouseEnter={(e) => hover(e, false, face ? face.token.name : family)}
              onMouseLeave={clear}
              {...cm.contextMenu(() => (face ? designTokenItems(face.token.name, face.actual) : []))}
              {...(face ? tip(`${face.token.name}\n${face.actual}`, undefined, { placement: "follow" }) : {})}
            >
              {/* the whole stack, not the first name in it: `ui-monospace` on its own resolves to
                  nothing here and falls back to the default serif, so the mono heading rendered in
                  a face that appears nowhere in the project */}
              <span
                className="design-face-sample design-face-family"
                style={{ fontFamily: face ? face.actual : family }}
              >
                {family}
              </span>
              {face && <span className="design-face-name row-dim">{face.token.name}</span>}
            </div>
            {sized.map((r) => (
              <div
                key={r.token.name}
                className="design-face row-edge"
                onMouseEnter={(e) => hover(e, true, r.token.name)}
                onMouseLeave={clear}
                {...cm.contextMenu(() => designTokenItems(r.token.name, r.actual))}
                {...tip(`${r.token.name}\n${r.actual}`, undefined, { placement: "follow" })}
              >
                <span className="design-face-sample" style={{ font: r.actual }}>
                  {`${r.family} ${r.size}${r.lead === null ? "" : `/${r.lead}`}`}
                </span>
                <span className="design-face-name row-dim">{r.token.name}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Swatch({
  token,
  ground,
  largest,
  outline,
  clear,
  sharing,
}: {
  token: DesignToken;
  ground: DesignToken | undefined;
  largest: number;
  outline: Outline;
  clear: () => void;
  sharing: string[];
}) {
  // what it resolves to is what to paint and measure; what it says is what to go and edit
  const actual = token.resolved ?? token.value;
  const groundValue = ground && (ground.resolved ?? ground.value);
  const ratio = token.kind === "color" && groundValue ? contrastRatio(actual, groundValue) : null;
  // Painting a value nothing can resolve would paint it with the *shell's* token of that name.
  // A translucent colour still paints; it just has no ratio to print.
  const paintable = token.kind === "color" && parseHex(actual) !== null;
  const sample = token.kind === "color";
  const size = token.kind === "length" ? Number.parseFloat(actual) : Number.NaN;
  const cm = useContextMenu("design");

  return (
    <div
      className="design-cell"
      data-kind={token.kind}
      {...cm.contextMenu(() => designTokenItems(token.name, actual))}
      onMouseEnter={
        paintable
          ? (e) => {
              const fill = e.currentTarget.querySelector(".design-fill");
              const bg = fill ? getComputedStyle(fill).backgroundColor : "";
              outline({
                type: "highlight-computed",
                props: COLOR_PROPS.map((p) => [p, bg]),
                match: "any",
                label: token.name,
              });
            }
          : undefined
      }
      onMouseLeave={paintable ? clear : undefined}
      {...tip(describe(token, ratio, ground, sharing))}
    >
      {sample && (
        <div className="design-sample">
          {paintable && <span className="design-fill" style={{ background: actual }} />}
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

/**
 * The whole chip, three facts on three lines. The value repeats even though the cell shows it,
 * because the cell truncates and this is where you come to read it in full.
 */
function describe(
  token: DesignToken,
  ratio: string | null,
  ground: DesignToken | undefined,
  sharing: string[] = [],
): string {
  const lines = [token.name, token.resolved ? `${token.value} resolves to ${token.resolved}` : token.value];
  // Two tokens with one value are the same colour for different reasons, which is a deliberate thing
  // for a palette to do and an invisible one on screen: nothing survives to the DOM but the value, so
  // hovering this lights every use of all of them. Saying whose value it also is turns that from a
  // bug you report into a fact about the palette.
  if (sharing.length > 0) lines.push(`same value as ${sharing.join(", ")}`);
  if (ratio && ground) {
    // a token measured against itself is the ground, and "1.00:1 against --surface0" written on
    // --surface0 explains nothing
    const self = token.name === ground.name;
    lines.push(self ? "the ground these ratios are measured against" : `${ratio} against ${ground.name}`);
  }
  return lines.join("\n");
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
          <summary className="row-edge">
            <span className="design-count row-dim">{rest.length}</span>
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
  // said once, in the header, and marked on the rows it is about
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
              <summary className="row-edge">
                <span className="design-count row-dim">{rest.length}</span>
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
  // the pane is the active worktree's (Center mounts it so), which is where the source file is
  const active = useActive();
  const sock = useSock();
  const dispatch = useDispatch();
  const cm = useContextMenu("design");
  return (
    <li>
      <button
        type="button"
        className="design-row row-edge"
        onMouseEnter={onEnter}
        onFocus={onEnter}
        onMouseLeave={onLeave}
        onBlur={onLeave}
        onClick={onOpen}
        disabled={!path}
        {...cm.contextMenu(() =>
          active
            ? designRowItems({ id: active.worktree.id, dir: wtDir(active.worktree) }, path, { sock, dispatch }, onOpen)
            : [],
        )}
      >
        <span className="design-count row-dim">{count}</span>
        <span className="design-name">{name}</span>
        <span className="design-path row-dim">{path}</span>
        {children}
      </button>
    </li>
  );
}
