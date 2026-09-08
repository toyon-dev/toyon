// The worktree's design system, read forward: what it noticed first, then the inventory.
//
// Sections render from whatever the index has and say so when a half is missing. An empty section
// is never shown as an answer: the scan's coverage record is what tells a project with no classes
// apart from one whose classes this scan cannot read.
//
// Rows are live against the preview. Hovering one outlines what it is in the running app (a class
// by selector, a component by the file its fibers came from), and clicking one opens its source.
// That is the whole reason this sits beside the preview rather than in a docs tab.

import type { DesignClass, DesignComponent, DesignFinding, DesignIndex, DesignToken } from "@toyon/shared";
import { useEffect } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { localOf } from "../../state/store.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";
import { contrastRatio } from "./contrast.ts";

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
      title="Design system"
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
          <Findings findings={index.findings} onOpen={live.open} />
          <Tokens tokens={index.tokens} live={index.live} />
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

function Findings({ findings, onOpen }: { findings: DesignFinding[]; onOpen: (path: string) => void }) {
  if (findings.length === 0) return null;
  return (
    <Section title="Noticed">
      <ul className="design-findings">
        {findings.map((f) => (
          <li key={`${f.kind}:${f.title}`}>
            <button
              type="button"
              className="design-finding"
              disabled={!f.path}
              onClick={() => f.path && onOpen(f.path)}
            >
              <span className="design-finding-title">{f.title}</span>
              <span className="design-finding-detail">{f.detail}</span>
              {f.path && <span className="design-path">{f.path}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * A wall of swatches, not a list of chips. Each cell is a full-bleed sample over a plate carrying
 * the name, the value, and what the value means: for a color that is its contrast against the
 * ground it sits on, which is the number you actually want when you are looking at a palette.
 */
function Tokens({ tokens, live }: { tokens: DesignToken[]; live: boolean }) {
  const families = new Map<string, DesignToken[]>();
  for (const t of tokens) families.set(t.family, [...(families.get(t.family) ?? []), t]);

  return (
    <Section title="Tokens" note={live ? undefined : "declared values; the preview was not running"}>
      {tokens.length === 0 ? (
        <Gap>
          No custom properties found. A project on Sass or Less variables keeps its scale somewhere this scan does not
          read yet.
        </Gap>
      ) : (
        [...families].map(([family, group]) => (
          <div key={family} className="design-family">
            <h3 className="design-family-name">{family}</h3>
            <div className="design-grid">
              {group.map((t) => (
                <Swatch key={t.name} token={t} />
              ))}
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function Swatch({ token }: { token: DesignToken }) {
  const ratio = token.kind === "color" ? contrastRatio(token.value) : null;
  return (
    <div className="design-cell">
      <div className="design-sample" data-kind={token.kind}>
        {token.kind === "color" && <span className="design-fill" style={{ background: token.value }} />}
        {token.kind === "length" && <span className="design-corner" style={{ borderRadius: token.value }} />}
        {token.kind === "font" && <span style={{ fontFamily: token.value }}>Ag</span>}
        {(token.kind === "shadow" || token.kind === "other") && (
          <span className="design-corner" style={{ boxShadow: token.kind === "shadow" ? token.value : undefined }} />
        )}
      </div>
      <div className="design-plate">
        <span className="design-cell-name">{token.name.replace(/^--/, "")}</span>
        <span className="design-cell-value">{token.value}</span>
        {ratio && <span className="design-cell-note">{ratio}</span>}
      </div>
    </div>
  );
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
  return (
    <Section
      title="Components"
      note={components.length ? `${components.length}, by how many files reach for them` : undefined}
    >
      {components.length === 0 ? (
        <Gap>
          Nothing that looks like an exported component. Vue and Svelte name a component by its file rather than by an
          export, which this scan does not read yet.
        </Gap>
      ) : (
        <>
          {!typed && <Gap>No TypeScript in this project, so the values each prop allows are not listed.</Gap>}
          <ul className="design-rows">
            {components.map((c) => (
              <Row
                key={`${c.path}:${c.name}`}
                count={c.imports}
                name={c.name}
                path={c.path}
                // fibers carry the file they were rendered from, so this outlines every instance
                // of the component that is on the page right now
                onEnter={() => outline({ type: "highlight-file", path: c.path, ranges: null })}
                onLeave={clear}
                onOpen={() => onOpen(c.path)}
              >
                {c.variants.length > 0 && (
                  <span className="design-variants">
                    {c.variants.map((v) => (
                      <span key={v.prop} className="design-variant">
                        {v.prop}: {v.values.join(" · ")}
                      </span>
                    ))}
                  </span>
                )}
              </Row>
            ))}
          </ul>
        </>
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
  return (
    <Section title="Classes" note={classes.length ? `${used.length} of ${classes.length} used` : undefined}>
      {classes.length === 0 ? (
        <Gap>No stylesheet in this project defines a class. Utility-first CSS generates its own.</Gap>
      ) : used.length === 0 ? (
        <Gap>
          {coverage.classAttrs > 0
            ? `${coverage.classAttrs} class attributes were read, and none names a class this scan can follow. That is what a CSS Modules project looks like from here.`
            : "No class attribute anywhere in the source that was read. The markup may live in a file type this scan does not open."}
        </Gap>
      ) : (
        <ul className="design-rows">
          {used.map((c) => (
            <ClassRow key={c.name} cls={c} outline={outline} clear={clear} onOpen={onOpen} />
          ))}
        </ul>
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
    />
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
