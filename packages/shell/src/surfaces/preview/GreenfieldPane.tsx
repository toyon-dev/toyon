import type { OwnedWorktree } from "@toyon/shared";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import { localOf, newProjectPage } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { Composer } from "../chat/Composer.tsx";
import { parentFolder } from "../palettes/projectPicker.ts";

/** What fills the preview column for a project with nothing in it yet. The same slot the setup
 * and discovered panes use, and the one time the composer sits here instead of in its dock: there
 * is nothing else to look at, and a page with one box on it says where to start.
 *
 * A project made a moment ago can still be renamed or moved, so its name in the question is the way
 * back to the page it was made on: the name goes back into the field, and the daemon takes back what
 * it made. The daemon also checks the project is still untouched, and says so if it is not. */
export function GreenfieldPane({ active }: { active: OwnedWorktree }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  const repo = useActiveRepo();
  const home = useStore((s) => s.home);
  const title = active.worktree.title;

  const back = () => {
    if (!repo?.made) return;
    dispatch({
      a: "new-project",
      v: {
        ...newProjectPage({
          mode: repo.made === "git" ? "init" : "create",
          name: repo.name,
          parent: parentFolder(repo.path, home) ?? repo.path,
        }),
        phase: "unmaking",
        repoId: repo.id,
        // what was typed here comes back with the next project, which is still this one to the person
        prompt: localOf(store.getState(), active.worktree.id).draft,
      },
    });
    sock?.send({ t: "unmake-repo", repoId: repo.id });
  };

  return (
    <div className="greenfield-pane">
      <p className="greenfield-title">
        {repo?.made ? (
          <Button variant="inline" onClick={back} {...tip("Rename or move this project")}>
            {title}
          </Button>
        ) : (
          title
        )}
      </p>
      <Composer active={active} greenfield />
    </div>
  );
}
