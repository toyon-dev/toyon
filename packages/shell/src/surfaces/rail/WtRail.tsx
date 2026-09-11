import { canGraft, isMain, isOwned, type OwnedWorktree, type WorktreeStatus } from "@toyon/shared";
import { useRef, useState } from "react";
import {
  discoveredItems,
  removeWorktrees,
  shipOp,
  worktreeActions,
  worktreeItems,
} from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileOf } from "../../state/profiles.ts";
import {
  useActiveId,
  useDiscoveredOpen,
  useGreenfield,
  useOffline,
  useVisibleDiscovered,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { useContextMenu, useMenu } from "../../ui/menu.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { dollars, tokens } from "../chat/usage.ts";
import { chord, dotClass, procTrouble, stateLabel } from "../util.ts";
import "./rail.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { rowState } from "../../ui/rowState.ts";

/** a count in its 3ch column; past three digits the exact number stops meaning anything here */
const count = (n: number) => (n > 999 ? "1k+" : String(n));

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "graft with…"
 * enters a multi-select for grafting, bulk sync and bulk remove */
export function WtRail() {
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useVisibleWorktrees();
  const greenfield = useGreenfield();
  // the draft tab: the new-worktree row is the selected one while a worktree is being drafted
  const draftOpen = useStore((s) => s.draft !== null);
  const discovered = useVisibleDiscovered();
  const discOpen = useDiscoveredOpen();
  const clientId = useStore((s) => s.clientId);
  const activeId = useActiveId();
  // the list only dims: what the socket is doing is the bar's to say, not the rail's
  const offline = useOffline();
  const leftOpen = useStore((s) => s.leftOpen);
  const railOpen = useStore((s) => s.railOpen);
  // ⌘⇧K hands the keyboard to the row marked current (the active worktree, or the new-worktree row
  // while drafting) so ↑↓ walk on from there; only a bump seen after mount counts
  const focusReq = useStore((s) => s.focusRail);
  const answered = useRef(focusReq);
  const listRef = useRef<HTMLDivElement>(null);
  useOnChange([focusReq], () => {
    if (focusReq === answered.current) return;
    answered.current = focusReq;
    const f = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>('[data-state~="current"]')?.focus(),
    );
    return () => cancelAnimationFrame(f);
  });
  const termOpen = useStore((s) => s.termOpen);
  const repos = useStore((s) => s.repos);
  const shipping = useStore((s) => s.shipping);
  const repoOf = (w: OwnedWorktree) => repos.find((r) => r.id === w.repoId) ?? null;
  const cm = useContextMenu("rail");
  // the one menu, read here for two things: the peek stays open while the menu is the rail's, and
  // the row it is about stays lifted while the pointer is over the menu rather than the row
  const menu = useMenu();
  // the daemon sends absolute paths; ~ is how the person wrote it and how the picker shows it back
  const home = useStore((s) => s.home);
  const wtDirLabel = (d: WorktreeStatus) =>
    home && d.path.startsWith(`${home}/`) ? `~${d.path.slice(home.length)}` : d.path;
  // the tip's second line: where the worktree is, and what its agent has cost and filled so far
  const detailOf = (d: WorktreeStatus) => {
    const u = d.usage;
    if (!u) return wtDirLabel(d);
    const figures = [u.cost !== undefined ? dollars(u.cost) : null, `${tokens(u.used)} of ${tokens(u.size)}`].filter(
      Boolean,
    );
    return `${wtDirLabel(d)} · ${figures.join(" · ")}`;
  };
  const [graftMode, setGraftMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  const toggleSel = (w: OwnedWorktree) => {
    if (!canGraft(w.worktree)) return;
    setGraftMode(true);
    setSel((s) => (s.includes(w.worktree.id) ? s.filter((x) => x !== w.worktree.id) : [...s, w.worktree.id]));
  };
  const cancelGraft = () => {
    setGraftMode(false);
    setSel([]);
  };
  useOnChange([graftMode], () => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && cancelGraft();
    if (graftMode) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  });

  const acts = worktreeActions(sock, dispatch);
  const deps = { sock, dispatch };
  const graftWith = (id: string) => {
    setGraftMode(true);
    // on the row you are on it means "graft others onto this": nothing to check yet
    setSel((s) => (id === activeId || s.includes(id) ? s : [...s, id]));
  };
  /** what a row can do: the long list for ours, the short one for a found worktree */
  const rowItems = (w: WorktreeStatus) =>
    isOwned(w)
      ? worktreeItems(w, repoOf(w), { leftOpen, termOpen, shipping }, deps, { graft: graftWith })
      : discoveredItems(w, { termOpen, clientId }, deps);

  /* The count columns are reserved list-wide, so a row with no dirty files still leaves the dirty
   * column empty and every number sits under the one above it. A column nobody uses is not drawn,
   * and the name takes its width. */
  const all = [...worktrees, ...discovered];
  const cols = {
    dirty: all.some((w) => (w.dirty ?? 0) > 0),
    behind: all.some((w) => (w.behind ?? 0) > 0),
    ahead: all.some((w) => (w.ahead ?? 0) > 0),
  };

  /** One row for both sections. Ownership decides what the row can do, not what it looks like: a
   * found worktree wears the same counts, since they are as real as anyone's, and its menu is the
   * short one. The dot is hollow, which is the one place the row says whose it is.
   *
   * Nothing on the right end of the row does anything but switch. In the strip the pointer lands on
   * the dot, the panel unfurls leftward under it, and a small drift while it opens used to land on
   * the kebab or on a count's verb; the counts are read now and the kebab sits in the control
   * column at the far left, the column the plus and the caret already share. */
  const railRow = (w: WorktreeStatus) => {
    const owned = isOwned(w) ? w : null;
    const id = w.id;
    const menuOpen = menu?.owner === "rail" && menu.key === id;
    const showCheck = owned && graftMode && canGraft(owned.worktree) && id !== activeId;
    return (
      <button
        key={id}
        type="button"
        className={cx("row row-edge", owned ? "rail-item" : "row-quiet rail-disc-item", menuOpen && "menu-open")}
        // while a worktree is being drafted the draft's row is the selected one, and the base it
        // branches from stays the active id underneath without reading as picked
        data-state={rowState({ current: id === activeId && !draftOpen, checked: sel.includes(id) })}
        // one tip per row, on the row: the dot's state in words with the dot restated beside it,
        // since the real one is at the far end of the row from where the tip sits, and where the
        // worktree is on the line under. A tip per element would swap fifty times as the mouse
        // crosses the panel.
        // Badges and the crashed dot keep their own, since those are what a hover over them is
        // asking about. A found row has no state to name, so the path is its text, unless
        // something holds it. The main checkout is named ahead of its state: its path alone reads
        // as one more worktree.
        {...(owned
          ? tip(stateLabel(w, repoOf(owned)?.needsSetup), undefined, {
              placement: "left",
              detail: detailOf(w),
              dot: dotClass(w),
              lead: isMain(owned.worktree) ? "main" : undefined,
            })
          : w.locked
            ? tip(`Held by ${w.lockReason ?? "another tool"}`, undefined, { placement: "left", detail: wtDirLabel(w) })
            : tip(wtDirLabel(w), undefined, { placement: "left" }))}
        data-wt={id}
        // ↑↓ walk the rows while one has focus, the way the changes panel's files do: the next row
        // is picked and takes the focus, so the next press keeps walking. Down from the last row
        // is the new-worktree row, the ends stop the way a list's do, and the found list below is
        // its own section. ⌥↑/↓ and ⌃Tab are the walk from anywhere, and that one wraps (app/keys.ts).
        onKeyDown={(e) => {
          if (!owned || graftMode || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          // a modified arrow is the global walk's, which runs after this: stepping here too moved two rows
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          const list = e.currentTarget.parentElement;
          const at = worktrees.findIndex((w) => w.id === id);
          const next = worktrees[at + (e.key === "ArrowDown" ? 1 : -1)];
          if (next) {
            dispatch({ a: "activate", id: next.id });
            list?.querySelector<HTMLElement>(`[data-wt="${next.id}"]`)?.focus();
          } else if (e.key === "ArrowDown" && !draftOpen) {
            // the draft hands the keyboard to the composer, which is what it is for; ⌥↑ comes back
            dispatch({ a: "open-draft" });
          }
        }}
        onClick={(e) => {
          // in graft mode the row you are on is the stock the others go onto, marked by its edge,
          // and has nothing to check; every other graftable row is a source to check or uncheck.
          // A shift-click on it opens the mode with nothing checked yet.
          if (owned && (graftMode || e.shiftKey)) {
            if (id === activeId) setGraftMode(true);
            else toggleSel(owned);
          } else dispatch({ a: "activate", id });
        }}
        {...cm.contextMenu(() => rowItems(w), id)}
      >
        <span className="rail-gut">
          {showCheck ? (
            <input type="checkbox" className="rail-graft-check" checked={sel.includes(id)} readOnly tabIndex={-1} />
          ) : (
            !graftMode && (
              // not .row-dim: it is only there while the row is lifted, and its three dots are the
              // thinnest mark in the column, so it takes the row's own colour rather than a tier
              // under it. Full size for the same reason: at the inline size the dots go hairline.
              // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
              <span
                className="rail-more"
                {...tip("Actions")}
                onClick={(e) => {
                  e.stopPropagation();
                  cm.openUnder(e.currentTarget, () => rowItems(w), id);
                }}
              >
                <Icon name="more" />
              </span>
            )
          )}
        </span>
        <span className="branch">{w.name}</span>
        {owned?.worktree.mode && owned.worktree.mode !== "auto" && (
          // auto is the default and says nothing; ask and plan change what happens when you look away
          <span className="rail-badge badge-mode" data-tip={`${owned.worktree.mode} mode: the agent waits for you`}>
            {owned.worktree.mode}
          </span>
        )}
        {owned &&
          (() => {
            // only the non-default profile is worth a tag: it is the one you need to notice
            const repo = repoOf(owned);
            const p = profileOf(owned.worktree, repo);
            return p && p !== repo?.config.defaultProfile ? (
              <span className="rail-badge badge-profile" data-tip={`runs the ${p} profile`}>
                {p}
              </span>
            ) : null;
          })()}
        {owned?.worktree.variant && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
          <span
            className="rail-badge badge-variant clickable"
            data-tip="Keep this variant, remove the others"
            onClick={(e) => {
              e.stopPropagation();
              acts.pickVariant(owned);
            }}
          >
            <span className="num">
              v{owned.worktree.variant.index}/{owned.worktree.variant.of}
            </span>
            <span className="act">pick</span>
          </span>
        )}
        {/* dirty and ahead in colour: they are the two you act on. Behind is nearly always there and
            nearly always in the hundreds, so as a number it only says "stale", and it says that
            from the quiet tier. The columns say which count is which, so no glyph does. */}
        <span className="rail-counts">
          {cols.dirty && (
            <span className="rail-count badge-dirty" data-tip={w.dirty ? `${w.dirty} uncommitted` : undefined}>
              {w.dirty ? `~${count(w.dirty)}` : ""}
            </span>
          )}
          {cols.behind && (
            <span
              className="rail-count row-dim"
              data-tip={
                w.behind ? `${w.behind} behind ${w.worktree && isMain(w.worktree) ? "origin" : "main"}` : undefined
              }
            >
              {w.behind ? count(w.behind) : ""}
            </span>
          )}
          {cols.ahead && (
            <span className="rail-count badge-ahead" data-tip={w.ahead ? `${w.ahead} ahead of main` : undefined}>
              {w.ahead ? `+${count(w.ahead)}` : ""}
            </span>
          )}
        </span>
        {(() => {
          // a landing op is out: the dot's slot shows it working, since the op was started from
          // this row and the control that started it may be off screen in the strip. `waiting`
          // still wins: a person being needed outranks a git op that finishes on its own.
          if (shipping[id] && dotClass(w) !== "waiting") return <Spinner size="dot" />;
          // held by another tool: that is its status, so the lock takes the dot's slot rather
          // than adding a column, and the hover on the row says who holds it
          if (w.locked)
            return (
              <span className="rail-glyph rail-lock row-dim">
                <Icon name="lock" className="icon-inline" />
              </span>
            );
          // hollow: git knows about it, toyon does not run it, so there is no activity to colour
          if (!owned) return <span className="dot discovered" />;
          // a red dot means a proc died, and the only thing anyone wants next is its log. The
          // dot is the click target because in the collapsed strip it is the whole row you
          // can see; offline the colour is the socket's, not the proc's, so it stays inert.
          const trouble = graftMode || offline ? null : procTrouble(w.procs);
          // the ring is a modifier, not a state: it rides on whatever the dot already says
          const unseen = w.unseen ? " unseen" : "";
          if (!trouble || dotClass(w) !== "crashed") return <span className={`dot ${dotClass(w)}${unseen}`} />;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
            <span
              className={`dot crashed clickable${unseen}`}
              {...tip(trouble.tip)}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ a: "activate", id });
                dispatch({ a: "term-stream", id, stream: trouble.stream });
              }}
            />
          );
        })()}
      </button>
    );
  };

  return (
    <div
      className={cx(
        "rail",
        (graftMode || menu?.owner === "rail") && "hold",
        railOpen && "pinned",
        offline && "offline",
      )}
    >
      {/* the rows carry the socket's state, so the explanation hangs off the panel: a row has no
          tip of its own, and the tooltip walks up to the nearest one */}
      <div
        className="rail-panel"
        data-tip={offline ? "Lost the daemon; retrying" : undefined}
        data-tip-placement="follow"
      >
        <div className="rail-list" ref={listRef}>
          {worktrees.map(railRow)}
          {graftMode && (
            <div className="rail-graft">
              {(() => {
                // the row you are on takes the others: it keeps its agent, procs and port, and
                // the checked ones are merged into it and removed
                const target = worktrees.find((w) => w.worktree.id === activeId && canGraft(w.worktree));
                const sources = sel.filter((id) => id !== target?.worktree.id);
                const names = sources
                  .map((id) => worktrees.find((w) => w.worktree.id === id)?.worktree.title ?? id)
                  .join(", ");
                // the count alone, no icon: the stock is the row marked current, and its name or a glyph
                // on the button pushed sync, remove and cancel off the rail's width
                return (
                  <Button
                    size="md"
                    tone="primary"
                    disabled={!target || sources.length === 0}
                    data-tip={
                      target
                        ? `Merge the checked worktrees into ${target.worktree.title} and remove them`
                        : "Select a worktree to graft onto"
                    }
                    onClick={() => {
                      if (!target) return;
                      if (
                        window.confirm(
                          `Graft ${names} onto ${target.worktree.title}?\n\nTheir branches are merged in, then their directories and branches are removed.`,
                        )
                      ) {
                        sock?.send({ t: "graft", targetId: target.worktree.id, sourceIds: sources });
                        cancelGraft();
                      }
                    }}
                  >
                    graft {sources.length}
                  </Button>
                );
              })()}
              <Button
                size="md"
                disabled={!sel.some((id) => (worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  for (const id of sel) {
                    const w = worktrees.find((x) => x.worktree.id === id);
                    if ((w?.behind ?? 0) > 0)
                      shipOp(sock, dispatch, {
                        t: w && isMain(w.worktree) ? "pull-main" : "sync-main",
                        worktreeId: id,
                      });
                  }
                  cancelGraft();
                }}
              >
                <Icon name="pull" className="icon-inline" /> sync
              </Button>
              <Button
                size="md"
                tone="danger"
                disabled={sel.length === 0}
                data-tip="Remove all selected worktrees (branches and changes deleted)"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${sel.length} worktree(s)?\n\nTheir directories and branches are deleted. Unmerged changes are lost.`,
                    )
                  ) {
                    removeWorktrees(sock, dispatch, sel);
                    cancelGraft();
                  }
                }}
              >
                remove…
              </Button>
              <IconButton icon="close" label="Cancel" hint="esc" onClick={cancelGraft} />
            </div>
          )}
          {/* not on an empty project: a worktree off the root commit would take the scaffold to a
              branch while main stayed blank, and the row comes back with the first message */}
          {!graftMode && !greenfield && (
            <button
              // a row like the worktree rows above it, since the draft tab it opens is one: the
              // same seat under the pointer and the same edge and lift when it is the one picked
              className="row row-edge rail-new"
              data-state={rowState({ current: draftOpen })}
              data-tip={draftOpen ? "The worktree being drafted; esc leaves it" : "New worktree"}
              data-tip-key={draftOpen ? undefined : chord("new")}
              data-tip-placement="left"
              onClick={() => dispatch({ a: "open-draft" })}
              // the last stop on the walk: up is the last worktree, and down is the end
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                // a modified arrow is the global walk's, as on the rows above
                if (e.altKey || e.ctrlKey || e.metaKey) return;
                e.preventDefault();
                const last = worktrees[worktrees.length - 1];
                if (e.key !== "ArrowUp" || !last) return;
                dispatch({ a: "activate", id: last.id });
                e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-wt="${last.id}"]`)?.focus();
              }}
            >
              <span className="rail-gut">
                <Icon name="plus" className="icon-inline" />
              </span>
              <span className="rail-label">new worktree</span>
              <Kbd k={chord("new")} className="rail-new-kbd" />
              {/* the strip has no left edge to show a plus on, so a second one waits in the dot
                  column and hands off to the one above as the panel opens */}
              <span className="rail-glyph rail-new-strip">
                <Icon name="plus" />
              </span>
            </button>
          )}
          {/* Below "new worktree", not above it: the whole section is hidden in the strip (see
              rail.css), so what appears when the panel opens pushes nothing anyone is aiming
              at. The rows are divs, not .rail-item buttons, so a shift-click never drags one into
              the graft selection. */}
          {!graftMode && discovered.length > 0 && (
            <>
              <button
                className="rail-disc-head"
                aria-expanded={discOpen}
                {...tip(
                  `${discovered.length} worktree${discovered.length === 1 ? "" : "s"} here that toyon did not make`,
                  undefined,
                  { placement: "left" },
                )}
                onClick={() => dispatch({ a: "toggle-discovered" })}
              >
                <span className="rail-gut">
                  <Icon name="caret" className={cx("icon-inline rail-disc-caret", !discOpen && "shut")} />
                </span>
                <span className="rail-label">discovered · {discovered.length}</span>
              </button>
              {discOpen && discovered.map(railRow)}
            </>
          )}
        </div>
        <div className="rail-foot">
          <IconButton
            icon="worktrees"
            label="Worktree panel"
            hint={chord("rail")}
            tone="chrome"
            on={railOpen}
            onClick={() => dispatch({ a: "toggle-rail" })}
          />
        </div>
      </div>
    </div>
  );
}
