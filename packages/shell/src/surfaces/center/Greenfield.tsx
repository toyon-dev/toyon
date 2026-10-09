import type { OwnedWorktree } from "@toyon/shared";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveWorktreeRepo } from "../../state/selectors.ts";
import { NEW_PROJECT_BOX, newProjectState } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { View } from "../../ui/View.tsx";
import { Composer } from "../chat/Composer.tsx";
import { parentFolder } from "../overlays/projectPicker.ts";

/** What fills the centre for a project with nothing in it yet. The same slot the setup
 * and discovered panes use, and the one time the composer sits here instead of in its dock: there
 * is nothing else to look at, and a page with one box on it says where to start.
 *
 * A project made a moment ago can still be renamed or moved, so its name in the question is the way
 * back to the page it was made on: the name goes back into the field, and the daemon takes back what
 * it made. The daemon also checks the project is still untouched, and says so if it is not. */
export function Greenfield({ active }: { active: OwnedWorktree }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useActiveWorktreeRepo();
  const home = useStore((s) => s.home);
  const title = active.worktree.title;

  const back = () => {
    if (!repo?.made) return;
    dispatch({
      a: "new-project",
      v: {
        ...newProjectState({
          mode: repo.made === "git" ? "init" : "create",
          name: repo.name,
          parent: parentFolder(repo.path, home) ?? repo.path,
        }),
        phase: "unmaking",
        repoId: repo.id,
      },
    });
    // what was typed and attached here goes back with the page, which is still this project to the person
    dispatch({ a: "move-box", from: active.worktree.id, to: NEW_PROJECT_BOX });
    sock?.send({ t: "unmake-repo", repoId: repo.id });
  };

  return (
    <View
      anchor="line"
      // the composer at the foot, in the box the description was typed into a moment ago
      foot={
        <div className="composer view-foot">
          <Composer active={active} greenfield />
        </div>
      }
    >
      <p className="form-title">
        {repo?.made ? (
          <Button variant="inline" onClick={back} {...tip("Rename or move this project")}>
            {title}
          </Button>
        ) : (
          title
        )}
      </p>
    </View>
  );
}
