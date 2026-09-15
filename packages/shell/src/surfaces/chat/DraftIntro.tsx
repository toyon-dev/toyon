import type { OwnedWorktree } from "@toyon/shared";
import { shipOp } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { canCarry, type Draft, repoById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { originNote } from "../chips/baseNote.ts";
import { ProfileChip, useNewWorktreeProfile } from "../chips/ProfileChip.tsx";

const VARIANTS: Draft["variants"][] = [1, 2, 3];

/** What stands where a transcript would on main, which has none: the choices that are fixed at
 * birth (batch or variants, the profile) on one row, and under a rule what main brings to the
 * worktree they start: its uncommitted files, with the choice of moving them, and how far it
 * trails origin, with the pull. What can still change afterwards (mode, model, effort) stays in
 * the composer's own row under the box, and so does the agent, which is picked there with its
 * model. Nothing else: the box's placeholder says what to do. */
export function DraftIntro({ draft, main }: { draft: Draft; main: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useStore((s) => repoById(s, main?.repoId));
  // the per-repo memory the send uses when nothing is picked here
  const [remembered] = useNewWorktreeProfile(repo);
  const mainId = main?.worktree.id ?? null;
  // main's uncommitted files: the live status when the row is subscribed, else the rail's
  // ten-second count
  const git = useLocalField(mainId, "git");
  const dirty = git?.files.length ?? main?.dirty ?? 0;
  const mainOp = useStore((s) => (mainId ? s.shipping[mainId] : undefined));
  // one set of changes can only go into one worktree, so variants and batch put the toggle off
  const carryable = !draft.batch && draft.variants === 1;
  // a new worktree starts from main as it is, so a main nobody has pulled today hands the agent
  // stale code
  const origin = main ? originNote(main.behind) : null;
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
        {/* What main's uncommitted files do when the box starts a worktree. Default: stay, since main
            is dirty for reasons that often have nothing to do with the message (a local config tweak,
            last week's debug line), and files leaving main unasked is the one surprise this row exists
            to rule out. The count wears the rail's dirty colour. Under the row above and not in the
            box, since the choice is fixed at birth like batch and variants, and they are what put it
            off: the greying then sits a line under its cause. */}
        {main && repo && (dirty > 0 || origin) && (
          <div className="draft-notes">
            {dirty > 0 && (
              <div className="hint draft-note">
                <span>
                  <span className="badge-dirty">~{dirty}</span> on {repo.defaultBranch}{" "}
                  {canCarry(draft) ? "come along" : "stay behind"}
                </span>
                <Button
                  variant="ghost"
                  tone="chrome"
                  on={canCarry(draft)}
                  disabled={!carryable}
                  data-tip={
                    carryable
                      ? canCarry(draft)
                        ? `Leave the ${dirty === 1 ? "file" : "files"} on ${repo.defaultBranch}`
                        : `Move the ${dirty} uncommitted ${dirty === 1 ? "file" : "files"} into the new worktree, leaving ${repo.defaultBranch} clean`
                      : "One set of changes can only go into one worktree"
                  }
                  onClick={() => dispatch({ a: "draft-carry", v: !draft.carry })}
                >
                  move
                </Button>
              </div>
            )}
            {origin && (
              <div className="hint draft-note">
                <span>{origin}</span>
                <Button
                  variant="outline"
                  busy={mainOp === "pull-main"}
                  disabled={!!mainOp || dirty > 0}
                  data-tip={
                    dirty > 0
                      ? `commit or discard the changes on ${repo.defaultBranch} first`
                      : "Fast-forward main to origin"
                  }
                  onClick={() => shipOp(sock, dispatch, { t: "pull-main", worktreeId: main.worktree.id })}
                >
                  pull
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
