// The worktree's design system, read forward: what it noticed first, then the inventory.
//
// Sections render from whatever the index has and say so when a half is missing. An empty section
// is never shown as an answer: the scan's coverage record is what tells a project with no classes
// apart from one whose classes this scan cannot read.

import type { DesignFinding, DesignIndex, DesignToken } from "@toyon/shared";
import { useEffect } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { localOf } from "../../state/store.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Pane } from "../../ui/Pane.tsx";

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

  // scan on open, and on demand from the header. The result is cached per worktree, so switching
  // back to a pane that has already run shows its last answer rather than a blank while it reruns.
  useEffect(() => {
    if (!index) sock?.send({ t: "design-scan", worktreeId });
  }, [index, worktreeId, sock]);

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
      {index ? <DesignBody index={index} /> : <div className="empty">reading the design system…</div>}
    </Pane>
  );
}

function DesignBody({ index }: { index: DesignIndex }) {
  return (
    <div className="design-body">
      <Findings findings={index.findings} />
      <Tokens tokens={index.tokens} live={index.live} />
      <Components index={index} />
      <Classes index={index} />
    </div>
  );
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

function Findings({ findings }: { findings: DesignFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <Section title="Noticed">
      <ul className="design-findings">
        {findings.map((f) => (
          <li key={`${f.kind}:${f.title}`} className="design-finding">
            <span className="design-finding-title">{f.title}</span>
            <span className="design-finding-detail">{f.detail}</span>
            {f.path && <span className="design-path">{f.path}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

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
            <span className="design-family-name">{family}</span>
            <div className="design-swatches">
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
  const paint = token.kind === "color" ? token.value : undefined;
  return (
    <div className="design-swatch" title={`${token.name}: ${token.value}`}>
      {paint ? (
        <span className="design-chip" style={{ background: paint }} />
      ) : token.kind === "length" ? (
        <span className="design-chip design-rule" style={{ borderRadius: token.value }} />
      ) : (
        <span className="design-chip design-chip-text">{token.kind}</span>
      )}
      <span className="design-swatch-name">{token.name}</span>
      <span className="design-swatch-value">{token.value}</span>
    </div>
  );
}

function Components({ index }: { index: DesignIndex }) {
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
              <li key={`${c.path}:${c.name}`} className="design-row">
                <span className="design-count">{c.imports}</span>
                <span className="design-name">{c.name}</span>
                <span className="design-path">{c.path}</span>
                {c.variants.length > 0 && (
                  <span className="design-variants">
                    {c.variants.map((v) => (
                      <span key={v.prop} className="design-variant">
                        {v.prop}: {v.values.join(" · ")}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Classes({ index }: { index: DesignIndex }) {
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
            <li key={c.name} className="design-row">
              <span className="design-count">{c.uses}</span>
              <span className="design-name">.{c.name}</span>
              <span className="design-path">{c.path}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
