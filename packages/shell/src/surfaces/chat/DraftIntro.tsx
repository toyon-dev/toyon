import { isMain, type OwnedWorktree } from "@toyon/shared";
import { useDispatch } from "../../state/context.tsx";
import type { Draft } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { chord } from "../util.ts";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands where the transcript would while a worktree is being drafted: a heading, one line
 * on how to begin, and the two choices that only exist before the first message. Quiet on
 * purpose: the box under it is the point, and the preview beside it is the other way in. */
export function DraftIntro({ draft, base }: { draft: Draft; base: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const stacked = base && !isMain(base.worktree) ? base.worktree.title : null;
  return (
    <div className="chat-wrap">
      <div className="draft-intro">
        <div className="section-title">
          new worktree
          {stacked && (
            <>
              {" "}
              from <b>{stacked}</b>
            </>
          )}
        </div>
        <p className="hint">
          describe a change, or pick something on the page <Kbd k={chord("pick")} />
        </p>
        {stacked && <p className="hint">starts on its branch, work not landed included</p>}
        <div className="draft-row hint">
          <span data-tip="Run the same prompt in N parallel worktrees, keep the best">variants</span>
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
          <Button
            variant="ghost"
            tone="chrome"
            on={draft.batch}
            className="draft-batch"
            data-tip="An agent splits the prompt into a worktree per task"
            onClick={() => dispatch({ a: "draft-batch", v: !draft.batch })}
          >
            batch
          </Button>
        </div>
      </div>
    </div>
  );
}
