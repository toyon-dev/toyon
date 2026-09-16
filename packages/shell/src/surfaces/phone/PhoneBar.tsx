import { isMain, sentAt } from "@toyon/shared";
import type { ReactNode } from "react";
import { needsYou, unseenJump } from "../../app/unseenJump.ts";
import { archivedHint } from "../../state/actions/archive.ts";
import { useDispatch, useStore } from "../../state/context.tsx";
import {
  useActive,
  useActiveId,
  useActiveRepo,
  useArchivedPage,
  useOffline,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { asksSetup } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { rowLine } from "../rail/rowLine.ts";
import { ago, dotClass, wtDir } from "../util.ts";

/**
 * The strip at the top of the phone.
 *
 * On the list: the project, which is the switcher when there is more than one, over how many
 * worktrees it has; the plus that starts new work, which is main's box (a plain selection of main,
 * whose draft opens on its own; main has no row on the screen, since the plus is what its row
 * would say); and the menu. On a worktree: the way back, its title over its state, and the menu.
 * The list and the worktree are a master and its detail, so the way between them is back, not
 * tabs. What the worktree shows (its chat, its app, its changes) are tabs *within* the detail, a
 * control under this bar, and this bar stays what it is: the detail's header.
 *
 * The line under the title is the row's line from the list (rowLine): the state a desk says on
 * hover, said here because a thumb never hovers, and said in the same words the row used so the
 * screen reads as the row opened.
 *
 * Before the menu, what the rail owes you: a count of the rows waiting on an answer or finished
 * unseen, and a tap that goes to the next one the way the desk's chord does. The rows themselves
 * never move for it; the rail's order is a send's, and what needs you is said here and by the
 * dots, not by shuffling the list under a thumb.
 *
 * The menu is the palette. A phone has no chords, so every verb without a visible control is
 * reachable only through it, which makes that button the way to most of what toyon can do.
 */
export function PhoneBar({ screen, tabs }: { screen: "home" | "chat"; tabs?: ReactNode }) {
  const dispatch = useDispatch();
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  const active = useActive();
  const activeId = useActiveId();
  const archivedPage = useArchivedPage();
  const visible = useVisibleWorktrees();
  const offline = useOffline();
  const owed = needsYou(visible, activeId);
  const main = visible.find((w) => isMain(w.worktree));
  const home = screen === "home";
  const title = home ? (repo?.name ?? null) : (archivedPage?.title ?? active?.worktree.title ?? null);
  const tasks = visible.filter((w) => !isMain(w.worktree)).length;
  const line = home
    ? tasks === 0
      ? "no worktrees yet"
      : `${tasks} ${tasks === 1 ? "worktree" : "worktrees"}`
    : archivedPage
      ? archivedHint(archivedPage)
      : active
        ? rowLine(active, {
            offline,
            needsSetup: asksSetup(repo),
            path: wtDir(active.worktree),
            at: isMain(active.worktree) ? undefined : ago(sentAt(active.worktree)),
          })
        : null;
  const asks = !home && !archivedPage && !!active && dotClass(active) === "waiting";
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
        <div className="phone-title">
          {home && repos.length > 1 ? (
            <Button
              size="md"
              tone="chrome"
              className="phone-switch"
              onClick={() => dispatch({ a: "open", overlay: { kind: "projects", form: "center" } })}
            >
              {title}
              <Icon name="caret" className="icon-inline" />
            </Button>
          ) : (
            <span className="phone-name">{title}</span>
          )}
          {line && <span className={cx("phone-sub", asks && "phone-sub-asks")}>{line}</span>}
        </div>
        {owed && (
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
        {home && main && (
          <IconButton
            icon="plus"
            label="New worktree"
            tone="chrome"
            onClick={() => dispatch({ a: "activate", id: main.id })}
          />
        )}
        <IconButton
          icon="more"
          label="Menu"
          tone="chrome"
          onClick={() => dispatch({ a: "open", overlay: { kind: "commands" } })}
        />
      </div>
      {/* the worktree's faces, in the header rather than under it: the bar's own edge then runs
          under the control, and the control sits on the bar's ground, where a sunken track and a
          raised pill are both a rung away from what they stand on */}
      {tabs && <div className="phone-tabs">{tabs}</div>}
    </div>
  );
}
