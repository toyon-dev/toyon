import { isLead, sentAt } from "@toyon/shared";
import type { ReactNode } from "react";
import { needsYou, unseenJump } from "../../app/unseenJump.ts";
import { archivedHint } from "../../state/actions/archive.ts";
import { useDispatch, useStore } from "../../state/context.tsx";
import {
  useActive,
  useActiveId,
  useActiveRepo,
  useArchivedPage,
  useFoundPage,
  useOffline,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { asksSetup } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CommandPalette } from "../overlays/CommandPalette.tsx";
import { ProjectPicker } from "../overlays/ProjectPicker.tsx";
import { LEAD_LINE, OFFLINE_LINE, rowLine } from "../rail/rowLine.ts";
import { ago, dotClass, shipLabel, shipShown } from "../util.ts";

/**
 * The strip at the top of the phone. The list and a worktree are a master and its detail, so the
 * way between them is back, not tabs; a worktree's chat, app and changes are tabs within the
 * detail, under this bar. The plus stands in for the lead's row, which the screen does not list.
 *
 * The line under a worktree's title is the row's line from the list (rowLine), in the same words,
 * so the screen reads as the row opened. The lead is the exception, as it is on the list: its name
 * is a directory nobody chose and a send replaces, so the title says what the page is for and the
 * line says which project the worktree will be made in. The count before the menu says what needs you; the rows
 * themselves never reorder for it, since the rail's order is a send's. The menu is the palette:
 * with no chords, every verb without a visible control is reachable only through it.
 */
export function PhoneBar({
  screen,
  tabs,
  fold,
}: {
  screen: "home" | "chat";
  tabs?: ReactNode;
  /** The tabs sit in the row, in the name's seat, and the bar is that one row: for the app and the
   * code, which want the screen and say whose they are themselves. A transcript folds the bar
   * itself, while it is scrolled away from its end; there the tabs' own strip hangs over the top
   * of the log instead of standing on it, so the fold moves no text under the thumb. */
  fold?: boolean;
}) {
  const dispatch = useDispatch();
  const reading = useStore((s) => s.reading);
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  const active = useActive();
  const activeId = useActiveId();
  const archivedPage = useArchivedPage();
  const foundPage = useFoundPage();
  const visible = useVisibleWorktrees();
  const offline = useOffline();
  const owed = needsYou(visible, activeId);
  const lead = visible.find((w) => isLead(w.worktree));
  const home = screen === "home";
  const onLead = !home && !archivedPage && !!active && isLead(active.worktree);
  const leadOp = useStore((s) => (onLead && active ? shipShown(active, s.shipping[active.id]?.op) : null));
  const title = home
    ? (repo?.name ?? null)
    : onLead
      ? LEAD_LINE
      : (archivedPage?.title ?? active?.worktree.title ?? foundPage?.name ?? null);
  const tasks = visible.filter((w) => !isLead(w.worktree)).length;
  const line = home
    ? tasks === 0
      ? "no worktrees yet"
      : `${tasks} ${tasks === 1 ? "worktree" : "worktrees"}`
    : archivedPage
      ? archivedHint(archivedPage)
      : onLead
        ? offline
          ? OFFLINE_LINE
          : leadOp
            ? shipLabel(leadOp)
            : (repo?.name ?? null)
        : active
          ? rowLine(active, {
              offline,
              needsSetup: asksSetup(repo),
              path: active.worktree.path,
              at: ago(sentAt(active.worktree)),
            })
          : foundPage
            ? rowLine(foundPage, { offline, needsSetup: false, path: foundPage.path })
            : null;
  const asks = !home && !archivedPage && !!active && dotClass(active) === "waiting";
  const switching = useStore((s) => s.overlay?.kind === "projects" && s.overlay.form === "pill");
  const commands = useStore((s) => s.overlay?.kind === "commands");
  return (
    <div className="phone-bar">
      <div className="phone-bar-row">
        {!home && (
          <IconButton
            icon="back"
            label="Worktrees"
            tone="chrome"
            onClick={() => dispatch({ a: "screen", to: "home" })}
          />
        )}
        {/* folded, the row holds the tabs where the name was: the name is the one thing in the bar
            that is only read, and by then it has been */}
        {tabs && (fold || reading) ? (
          <div className="phone-row-tabs">{tabs}</div>
        ) : (
          <div className="phone-title">
            {home && repos.length > 1 ? (
              // the desk pill's form: the switcher opens over the name that was tapped, not in the
              // middle of a screen the thumb is nowhere near
              <span className="phone-drop phone-switch">
                {/* the name inside keeps the name's face, as the desk pill's does, so this row and
                    a worktree's read as one bar: the control's own box at the compact size adds
                    a pixel to the title, where the thumb size stood the name four lower and the
                    row taller than the one a worktree gets */}
                <Button
                  tone="chrome"
                  on={switching}
                  onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects", form: "pill" } })}
                >
                  <span className="phone-name">{title}</span>
                  <Icon name="caret" className="icon-inline" />
                </Button>
                {switching && <ProjectPicker form="pill" />}
              </span>
            ) : (
              <span className="phone-name">{title}</span>
            )}
            {line && <span className={cx("phone-sub", asks && "phone-sub-asks")}>{line}</span>}
          </div>
        )}
        {/* over the app and the code the row is the tabs', and the count beside them squeezes the
            three out of their seat; the list and the chat still say it */}
        {owed && !fold && (
          <Button
            size="md"
            tone="primary"
            onClick={() => {
              const to = unseenJump(visible, activeId, 1);
              if (to) dispatch({ a: "activate", id: to.activate });
            }}
          >
            {owed.n} {owed.tier}
          </Button>
        )}
        {home && lead && (
          <IconButton
            icon="plus"
            label="New worktree"
            tone="chrome"
            onClick={() => dispatch({ a: "activate", id: lead.id })}
          />
        )}
        {/* the palette hangs from this button on a phone, from either end of the window it turns
            to fit; Overlays leaves it out of the frame's centre */}
        <span className="phone-drop">
          <IconButton
            icon="more"
            label="Menu"
            tone="chrome"
            on={commands}
            onClick={() => dispatch({ a: "toggle", overlay: { kind: "commands" } })}
          />
          {commands && (
            <CommandPalette
              // the bar's inset less the strip's, so the close can land on the menu button exactly
              anchored={{ flip: "align", margin: 6 }}
              // the panel covers the button that opened it, so its close takes that button's place:
              // the same spot, the one a thumb just used
              trailing={
                <IconButton icon="close" label="Close" tone="chrome" onClick={() => dispatch({ a: "close" })} />
              }
            />
          )}
        </span>
      </div>
      {/* the worktree's faces, in the header rather than under it: the bar's own edge then runs
          under the control, and the control sits on the bar's ground, where a sunken track and a
          raised pill are both a rung away from what they stand on */}
      {tabs && !fold && (
        <div className="phone-tabs-seat" data-away={reading || undefined}>
          <div className="phone-tabs">{tabs}</div>
        </div>
      )}
    </div>
  );
}
