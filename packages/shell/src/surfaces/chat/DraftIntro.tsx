import type { OwnedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { type Draft, repoById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { ProfileChip, useNewWorktreeProfile } from "../chips/ProfileChip.tsx";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands where a transcript would on main, which has none: one row of the choices that are
 * fixed at birth (batch or variants, the profile). What can still change afterwards (mode, model,
 * effort) stays in the composer's own row under the box, and so does the agent, which is picked
 * there with its model; what happens to main's uncommitted files is the row under those, since it
 * has a button. Nothing else: the box's placeholder says what to do. */
export function DraftIntro({ draft, main }: { draft: Draft; main: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const repo = useStore((s) => repoById(s, main?.repoId));
  // the per-repo memory the send uses when nothing is picked here
  const [remembered] = useNewWorktreeProfile(repo);
  return (
    <div className="chat-wrap">
      <div className="draft-intro">
        <div className="draft-row hint">
          <Button
            variant="ghost"
            tone="chrome"
            on={draft.batch}
            data-tip="An agent splits the prompt into a worktree per task"
            onClick={() => dispatch({ a: "draft-batch", v: !draft.batch })}
          >
            batch
          </Button>
          <span className="draft-variants">
            {VARIANTS.map((n) => (
              <Button
                key={n}
                variant="ghost"
                on={draft.variants === n}
                disabled={draft.batch}
                onClick={() => dispatch({ a: "draft-variants", n })}
              >
                {n}
              </Button>
            ))}
            <span data-tip="Run the same prompt in N parallel worktrees, keep the best">variants</span>
          </span>
          <span className="draft-runs">
            <ProfileChip
              repo={repo}
              value={draft.profile ?? remembered}
              onChange={(profile) => dispatch({ a: "draft-profile", profile })}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
