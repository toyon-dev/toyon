import { isMain, type OwnedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { type Draft, repoById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { AgentChip } from "../chips/AgentChip.tsx";
import { ProfileChip, useNewWorktreeProfile } from "../chips/ProfileChip.tsx";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands where the transcript would while a worktree is being drafted: one row of the
 * choices that are fixed at birth (batch or variants, the agent, the profile). What can still
 * change afterwards (mode, model, effort) stays in the composer's own row under the box. Nothing
 * else: the box's placeholder says what to do, and the pick icon carries its own key. */
export function DraftIntro({ draft, base }: { draft: Draft; base: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const agents = useStore((s) => s.agents);
  const repo = useStore((s) => repoById(s, base?.repoId));
  // the per-repo memory main's own composer uses, as the starting value; the draft's pick lives
  // on the draft
  const [remembered] = useNewWorktreeProfile(repo);
  const stacked = base && !isMain(base.worktree) ? base.worktree.title : null;
  return (
    <div className="chat-wrap">
      <div className="draft-intro">
        {stacked && (
          <p className="hint">
            from <b>{stacked}</b>, work not landed included
          </p>
        )}
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
            {/* a stacked draft keeps its parent's agent, since the session it continues is that agent's */}
            {!stacked && agents.length > 1 && (
              <AgentChip agents={agents} value={draft.agent} onChange={(id) => dispatch({ a: "draft-agent", id })} />
            )}
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
