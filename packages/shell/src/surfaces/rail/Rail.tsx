import {
  type ArchivedWorktree,
  canGraft,
  isMain,
  isOwned,
  type OwnedWorktree,
  type WorktreeStatus,
} from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { archivedHint, archivedItems } from "../../state/actions/archive.ts";
import {
  discoveredItems,
  removeWorktrees,
  shipOp,
  worktreeActions,
  worktreeItems,
} from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileOf } from "../../state/profiles.ts";
import { sentAt } from "../../state/railOrder.ts";
import {
  useActiveId,
  useArchivedOpen,
  useArchivedPage,
  useDiscoveredOpen,
  useOffline,
  useVisibleArchived,
  useVisibleDiscovered,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { asksSetup } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu, useMenu } from "../../ui/menu.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { dollars, tokens } from "../chat/usage.ts";
import { recapLine } from "../recap.ts";
import { ago, chord, dotClass, procTrouble, rowLabel, stateLabel } from "../util.ts";
import "./rail.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { rowState } from "../../ui/rowState.ts";

/** a count in its 3ch column; past three digits the exact number stops meaning anything here */
const count = (n: number) => (n > 999 ? "1k+" : String(n));

/** what every row and the panel's ground say while the socket is down */
const OFFLINE_TIP = "Lost the daemon; retrying";

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "graft with…"
 * enters a multi-select for grafting, bulk sync and bulk remove */
export function Rail() {
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useVisibleWorktrees();
  // main leads, above the tasks (state/railOrder.ts)
  const lead = worktrees[0] && isMain(worktrees[0].worktree) ? worktrees[0] : null;
  const tasks = lead ? worktrees.slice(1) : worktrees;
  // the gutter's times read in minutes, and a quiet rail can go a long while without a frame
  const [, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const discovered = useVisibleDiscovered();
  const discOpen = useDiscoveredOpen();
  const archived = useVisibleArchived();
  const archOpen = useArchivedOpen();
  // an archived worktree's page is up: its row is the marked one, over the active row underneath
  const archivedPage = useArchivedPage();
  const clientId = useStore((s) => s.clientId);
  const activeRepoId = useStore((s) => s.activeRepoId);
  const connected = useStore((s) => s.connected);
  // the section's count is on the rail before anyone opens it, so ask for the list on the way in;
  // the daemon pushes it again whenever a worktree is archived, restored or deleted
  useEffect(() => {
    if (sock && connected && activeRepoId) sock.send({ t: "list-archived", repoId: activeRepoId });
  }, [sock, connected, activeRepoId]);
  const activeId = useActiveId();
  // offline the dots take the fault colour and every tip names it; the bar says what the socket is doing
  const offline = useOffline();
  const changesOpen = useStore((s) => s.changesOpen);
  const railOpen = useStore((s) => s.railOpen);
  // the worktree walk holds the strip's peek open while its modifier is down (app/keys.ts)
  const railPeek = useStore((s) => s.railPeek);
  // ⌘⇧K hands the keyboard to the row marked current so ↑↓ walk on from there; only a bump seen
  // after mount counts
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
  // the tip's lead: the project's name on main, whose row goes by its branch, then what its agent has
  // cost and filled so far. Kept off the path's line so the path reads whole and the figures are
  // found in one place.
  const leadOf = (d: WorktreeStatus, project: string | null) => {
    const u = d.usage;
    const parts = [
      project,
      u?.cost !== undefined ? dollars(u.cost) : null,
      u ? `${tokens(u.used)} of ${tokens(u.size)}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : undefined;
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
      ? worktreeItems(w, repoOf(w), { changesOpen, shipping }, deps, { graft: graftWith })
      : discoveredItems(w, { clientId }, deps);

  /** A removed worktree, kept with its chat. It runs nothing, so it reads a rung down like a found
   * row and has no dot; the gutter says how long ago it was archived. A click opens its page in the
   * centre, the way a found row's does, and the restore button is there: a row that restored on
   * its own click was too easy to hit on the way past. Its menu (the kebab or a right-click) has
   * restore too, with the rest. */
  const archivedRow = (a: ArchivedWorktree) => (
    <button
      key={a.id}
      type="button"
      className={cx(
        "row row-edge row-quiet rail-disc-item",
        menu?.owner === "rail" && menu.key === a.id && "menu-open",
      )}
      data-state={rowState({ current: archivedPage?.id === a.id })}
      {...tip(a.branch, undefined, { placement: "left", detail: archivedHint(a) })}
      onClick={() => dispatch({ a: "open-archived", id: a.id })}
      {...cm.contextMenu(() => archivedItems(a, clientId, deps), a.id)}
    >
      <span className="rail-gut">
        <span className="rail-at row-dim">{ago(a.archivedAt)}</span>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu carries the same actions for the keyboard */}
        <span
          className="rail-more"
          {...tip("Actions")}
          onClick={(e) => {
            e.stopPropagation();
            cm.openUnder(e.currentTarget, () => archivedItems(a, clientId, deps), a.id);
          }}
        >
          <Icon name="more" />
        </span>
      </span>
      <span className="branch">{a.title}</span>
    </button>
  );

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
    const onMain = !!owned && isMain(owned.worktree);
    const id = w.id;
    const menuOpen = menu?.owner === "rail" && menu.key === id;
    const showCheck = owned && graftMode && canGraft(owned.worktree) && id !== activeId;
    return (
      <button
        key={id}
        type="button"
        className={cx("row row-edge", owned ? "rail-item" : "row-quiet rail-disc-item", menuOpen && "menu-open")}
        // an archived worktree's page marks its own row, and the row underneath does not read as picked
        data-state={rowState({ current: id === activeId && !archivedPage, checked: sel.includes(id) })}
        // one tip per row, on the row: the dot's state in words with the dot restated beside it,
        // since the real one is at the far end of the row from where the tip sits, and where the
        // worktree is on the line under. A tip per element would swap fifty times as the mouse
        // crosses the panel.
        // Badges and the crashed dot keep their own, since those are what a hover over them is
        // asking about. A found row has no state to name, so the path is its text, unless
        // something holds it. Main's lead names the project, at the far start of the state's line,
        // since its row goes by its branch and its path alone reads as one more worktree.
        // Offline, the state is whatever the daemon last said, and a tip restating it as live sat
        // over a row painted in the fault colour, a green "Running" over an orange dot: the tip
        // names the fault instead, with no dot, since there is no live state for one to restate.
        {...(owned
          ? tip(offline ? OFFLINE_TIP : stateLabel(w, asksSetup(repoOf(owned))), undefined, {
              placement: "left",
              // an unseen stop says what happened above the path, so a hover is enough to triage it
              detail:
                w.unseen && owned.worktree.lastTurn
                  ? `${recapLine(owned.worktree.lastTurn)}\n${wtDirLabel(w)}`
                  : wtDirLabel(w),
              dot: offline ? undefined : dotClass(w),
              lead: leadOf(w, isMain(owned.worktree) ? (repoOf(owned)?.name ?? null) : null),
            })
          : offline
            ? tip(OFFLINE_TIP, undefined, { placement: "left", detail: wtDirLabel(w) })
            : w.locked
              ? tip(`Held by ${w.lockReason ?? "another tool"}`, undefined, {
                  placement: "left",
                  detail: wtDirLabel(w),
                })
              : tip(wtDirLabel(w), undefined, { placement: "left" }))}
        data-wt={id}
        // ↑↓ walk the rows while one has focus, the way the changes panel's files do: the next row
        // is picked and takes the focus, so the next press keeps walking. The ends stop the way a
        // list's do, and the found list below is its own section. ⌥↑/↓ and ⌃Tab are the walk from
        // anywhere, and that one wraps (app/keys.ts).
        onKeyDown={(e) => {
          if (!owned || graftMode || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          // a modified arrow is the global walk's, which runs after this: stepping here too moved two rows
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          const down = e.key === "ArrowDown";
          const at = worktrees.findIndex((w) => w.id === id);
          const next = worktrees[at + (down ? 1 : -1)];
          if (!next) return;
          dispatch({ a: "activate", id: next.id });
          e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-wt="${next.id}"]`)?.focus();
        }}
        onClick={(e) => {
          // in graft mode the row you are on is the stock the others go onto, marked by its edge,
          // and has nothing to check; every other graftable row is a source to check or uncheck.
          // A shift-click on it opens the mode with nothing checked yet.
          if (owned && (graftMode || e.shiftKey)) {
            if (id === activeId) setGraftMode(true);
            else toggleSel(owned);
          }
          // main is where new work is written, so a click on it puts the caret in its box; the
          // arrows above only select it, so a walk down the list keeps the keyboard on the list
          else if (onMain) dispatch({ a: "open-draft" });
          else dispatch({ a: "activate", id });
        }}
        {...cm.contextMenu(() => rowItems(w), id)}
      >
        <span className="rail-gut">
          {showCheck ? (
            <input type="checkbox" className="rail-graft-check" checked={sel.includes(id)} readOnly tabIndex={-1} />
          ) : (
            !graftMode && (
              <>
                {owned &&
                  (onMain ? (
                    // main is never sent to: its seat says what its box does, starting new work
                    <span className="rail-at rail-plus row-dim" data-tip="New worktree" data-tip-key={chord("new")}>
                      <Icon name="plus" className="icon-inline" />
                    </span>
                  ) : (
                    // at rest the column says how long since anyone sent something here, the time
                    // the rail is sorted by; the kebab takes its seat while the row is lifted (rail.css)
                    <span className="rail-at row-dim">{ago(sentAt(owned.worktree))}</span>
                  ))}
                {/* not .row-dim: it is only there while the row is lifted, and its three dots are the
                    thinnest mark in the column, so it takes the row's own colour rather than a tier
                    under it. Full size for the same reason: at the inline size the dots go hairline. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured */}
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
              </>
            )
          )}
        </span>
        <span className="branch">{rowLabel(w, owned ? repoOf(owned) : null)}</span>
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
          // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured
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
          const state = dotClass(w);
          // Main's seat in the strip is a plus: new work starts here, and the strip has no other
          // place to say so. The dot takes the seat back whenever it has something to say (main's
          // server down, the daemon gone), and it is drawn underneath either way, since the peek
          // shows both, the plus at the far left of the row.
          if (onMain && !trouble && state !== "crashed" && !offline) {
            return (
              <>
                <span className={`dot ${state} rail-main-dot`} />
                <span className="rail-glyph rail-main-strip">
                  <Icon name="plus" />
                </span>
              </>
            );
          }
          if (!trouble || state !== "crashed") return <span className={`dot ${state}${unseen}`} />;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured
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
        (graftMode || menu?.owner === "rail" || railPeek) && "hold",
        railOpen && "pinned",
        offline && "offline",
      )}
    >
      {/* the dots carry the socket's state, and every row's tip names it; the panel's own tip covers
          the ground between and under the rows, where the tooltip walks up to the nearest one */}
      <div className="rail-panel" data-tip={offline ? OFFLINE_TIP : undefined} data-tip-placement="follow">
        <div className="rail-list" ref={listRef}>
          {lead && railRow(lead)}
          {tasks.map(railRow)}
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
                data-tip="Remove all selected worktrees (their chats and work are archived)"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${sel.length} worktree(s)?\n\nTheir directories and branches go. The chats, commits and any uncommitted changes are archived, and each can be restored.`,
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
          {/* Last, below every worktree row: the whole section is hidden in the strip (see
              rail.css), so what appears when the panel opens pushes nothing anyone is aiming
              at. The rows are divs, not .rail-item buttons, so a shift-click never drags one into
              the graft selection. */}
          {!graftMode && discovered.length > 0 && (
            <>
              <button
                className="rail-disc-head"
                aria-expanded={discOpen}
                {...tip(
                  `${discovered.length} worktree${discovered.length === 1 ? "" : "s"} here that Toyon did not make`,
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
          {/* Under discovered, for the same reason: hidden in the strip, and nothing aimed at sits below it */}
          {!graftMode && archived.length > 0 && (
            <>
              <button
                type="button"
                className="rail-disc-head"
                aria-expanded={archOpen}
                {...tip(
                  `${archived.length} removed worktree${archived.length === 1 ? "" : "s"}, kept with ${archived.length === 1 ? "its chat" : "their chats"}`,
                  undefined,
                  { placement: "left" },
                )}
                onClick={() => dispatch({ a: "toggle-archived" })}
              >
                <span className="rail-gut">
                  <Icon name="caret" className={cx("icon-inline rail-disc-caret", !archOpen && "shut")} />
                </span>
                <span className="rail-label">archived · {archived.length}</span>
              </button>
              {archOpen && archived.map(archivedRow)}
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
