import { isMain, type OwnedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { type Draft, repoById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { chord } from "../util.ts";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands where the transcript would while a worktree is being drafted: what to do, and the
 * two choices that only exist before the first message. The preview beside it is the code the
 * worktree starts from, so pointing at it is the other way to begin. */
export function DraftIntro({ draft, base }: { draft: Draft; base: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const repo = useStore((s) => repoById(s, base?.repoId));
  const stacked = base && !isMain(base.worktree) ? base.worktree.title : null;
  return (
    <div className="chat-wrap">
      <div className="draft-intro">
        <p className="draft-lead">
          describe a change to {repo?.name ?? "the project"}, or pick something on the page{" "}
          <Kbd k={chord("pick")} chip />
        </p>
        {stacked && (
          <p className="hint">
            from <b>{stacked}</b>: the new worktree starts on its branch, work not landed included
          </p>
        )}
        <div className="draft-row hint">
          <span data-tip="Run the same prompt in N parallel worktrees, keep the best">variants</span>
          {VARIANTS.map((n) => (
            <Button
              key={n}
              variant="outline"
              on={draft.variants === n}
              disabled={draft.batch}
              onClick={() => dispatch({ a: "draft-variants", n })}
            >
              {n}
            </Button>
          ))}
        </div>
        <label className="draft-row hint">
          <input
            type="checkbox"
            checked={draft.batch}
            onChange={(e) => dispatch({ a: "draft-batch", v: e.target.checked })}
          />
          <span>batch: an agent splits this into a worktree per task</span>
        </label>
      </div>
    </div>
  );
}
