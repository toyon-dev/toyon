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
  useOffline,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { asksSetup } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CommandPalette } from "../overlays/CommandPalette.tsx";
import { ProjectPicker } from "../overlays/ProjectPicker.tsx";
import { rowLine } from "../rail/rowLine.ts";
import { ago, dotClass } from "../util.ts";

/**
 * The strip at the top of the phone. The list and a worktree are a master and its detail, so the
 * way between them is back, not tabs; a worktree's chat, app and changes are tabs within the
 * detail, under this bar. The plus stands in for the lead's row, which the screen does not list.
 *
 * The line under a worktree's title is the row's line from the list (rowLine), in the same words,
 * so the screen reads as the row opened. The count before the menu says what needs you; the rows
 * themselves never reorder for it, since the rail's order is a send's. The menu is the palette:
 * with no chords, every verb without a visible control is reachable only through it.
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
  const lead = visible.find((w) => isLead(w.worktree));
  const home = screen === "home";
  const title = home ? (repo?.name ?? null) : (archivedPage?.title ?? active?.worktree.title ?? null);
  const tasks = visible.filter((w) => !isLead(w.worktree)).length;
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
            path: active.worktree.path,
            at: isLead(active.worktree) ? undefined : ago(sentAt(active.worktree)),
          })
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
        <div className="phone-title">
          {home && repos.length > 1 ? (
            // the desk pill's form: the switcher opens over the name that was tapped, not in the
            // middle of a screen the thumb is nowhere near
            <span className="phone-drop phone-switch">
              <Button
                size="md"
                tone="chrome"
                on={switching}
                onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects", form: "pill" } })}
              >
                {title}
                <Icon name="caret" className="icon-inline" />
              </Button>
              {switching && <ProjectPicker form="pill" />}
            </span>
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
      {tabs && <div className="phone-tabs">{tabs}</div>}
    </div>
  );
}
