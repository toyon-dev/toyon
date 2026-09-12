import type { RepoInfo } from "@toyon/shared";
import { useDispatch } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";

/** The centre of a project that was set up with nothing to run: a library, a CLI, a backend with
 * no HTTP server. Says so, and says what still works, rather than waiting on a server that will
 * never come. The way to a preview later is the setup pane. */
export function NoPreviewPane({ repo }: { repo: RepoInfo }) {
  const dispatch = useDispatch();
  return (
    <div className="boot-pane">
      <div className="boot-line">
        {repo.name} has nothing to run, so there is no preview. Chat, changes and the terminal all work here.
      </div>
      <div className="boot-actions">
        <Button onClick={() => dispatch({ a: "open", overlay: { kind: "setup", repoId: repo.id } })}>
          add a dev server
        </Button>
      </div>
    </div>
  );
}
