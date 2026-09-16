import { isMain } from "@toyon/shared";
import { needsYou, unseenJump } from "../../app/unseenJump.ts";
import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useActiveId, useActiveRepo, useArchivedPage, useVisibleWorktrees } from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";

/**
 * The strip at the top of the phone.
 *
 * On the list: the project, which is the switcher when there is more than one; the plus that
 * starts new work, which is main's box (a plain selection of main, whose draft opens on its own);
 * and the menu. On a worktree: the way back, its title, and the menu. The list and the worktree
 * are a master and its detail, so the way between them is back, not tabs. When the worktree grows
 * more to show than its chat (its changes, its preview) those are tabs *within* the detail, a strip
 * under this bar, and this bar stays what it is: the detail's header.
 *
 * Before the menu, what the rail owes you: a count of the rows waiting on an answer or finished
 * unseen, and a tap that goes to the next one the way the desk's chord does. The rows themselves
 * never move for it; the rail's order is a send's, and what needs you is said here and by the
 * dots, not by shuffling the list under a thumb.
 *
 * The menu is the palette. A phone has no chords, so every verb without a visible control is
 * reachable only through it, which makes that button the way to most of what toyon can do.
 */
export function PhoneBar({ screen }: { screen: "home" | "chat" }) {
  const dispatch = useDispatch();
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  const active = useActive();
  const activeId = useActiveId();
  const archivedPage = useArchivedPage();
  const visible = useVisibleWorktrees();
  const owed = needsYou(visible, activeId);
  const main = visible.find((w) => isMain(w.worktree));
  const title = screen === "chat" ? (archivedPage?.title ?? active?.worktree.title ?? null) : (repo?.name ?? null);
  return (
    <div className="phone-bar">
      {screen === "chat" && (
        <IconButton icon="back" label="Worktrees" tone="chrome" onClick={() => dispatch({ a: "screen", to: "home" })} />
      )}
      {screen === "home" && repos.length > 1 ? (
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
        <span className="phone-title">{title}</span>
      )}
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
      {screen === "home" && main && (
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
  );
}
