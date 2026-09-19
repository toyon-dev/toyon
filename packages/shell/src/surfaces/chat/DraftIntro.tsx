import type { OwnedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { canCarry, type Draft, repoById, trunkOf } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Check } from "../../ui/Check.tsx";
import { ProfileChip, useNewWorktreeProfile } from "../chips/ProfileChip.tsx";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands between the lead row's empty transcript and its box: what the message will be. The
 * choices fixed at birth (batch or variants, the profile) on one row, and under a rule whether
 * main's uncommitted files come along. What can still change afterwards (mode, model, effort)
 * stays in the composer's own row under the box, and so does the agent, which is picked there
 * with its model; the state of main itself (how far it trails origin, with the pull) is the
 * composer's too, under the knobs, where a worktree's own state reads. Nothing else: the box's
 * placeholder says what to do. */
export function DraftIntro({ draft, lead }: { draft: Draft; lead: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const repo = useStore((s) => repoById(s, lead?.repoId));
  // the per-repo memory the send uses when nothing is picked here
  const [remembered] = useNewWorktreeProfile(repo);
  // main's uncommitted files, as the daemon last counted them: the lead row's own status is the
  // spare's, which sits on main clean
  const dirty = useStore((s) => trunkOf(s, lead?.repoId)?.dirty ?? 0);
  // one set of changes can only go into one worktree, so variants and batch put the choice off
  const carryable = !draft.batch && draft.variants === 1;
  // its own flex child under the log, not a second chat-wrap: two of those split the panel's
  // height between them and the intro sat mid-panel with room under it
  return (
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
      {/* What main's uncommitted files do when the box starts a worktree. Default: stay, since main
            is dirty for reasons that often have nothing to do with the message (a local config tweak,
            last week's debug line), and files leaving main unasked is the one surprise this line exists
            to rule out. A checkbox and not a button: nothing happens until Enter, and a verb on a
            button promises otherwise. The count wears the rail's dirty colour. Under the row above,
            since the choice is fixed at birth like batch and variants, and they are what put it off:
            the greying then sits a line under its cause. */}
      {lead && repo && dirty > 0 && (
        <div className="draft-notes">
          <Check
            className="hint draft-note"
            checked={canCarry(draft)}
            disabled={!carryable}
            tip={
              carryable
                ? `Move the ${dirty} uncommitted ${dirty === 1 ? "file" : "files"} into the new worktree, leaving ${repo.defaultBranch} clean`
                : "One set of changes can only go into one worktree"
            }
            onChange={(e) => dispatch({ a: "draft-carry", v: e.currentTarget.checked })}
          >
            <span className="badge-dirty">~{dirty}</span> on {repo.defaultBranch} come along
          </Check>
        </div>
      )}
    </div>
  );
}
