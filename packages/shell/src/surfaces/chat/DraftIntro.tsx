import type { OwnedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { type Draft, repoById, trunkOf } from "../../state/store.ts";
import { Check } from "../../ui/Check.tsx";
import { ProfileChip, useNewWorktreeProfile } from "../chips/ProfileChip.tsx";

/** What stands between the lead row's empty transcript and its box: what the message will be. The
 * one choice fixed at birth, the profile, on a row of its own, and under a rule whether main's
 * uncommitted files come along. What can still change afterwards (mode, model, effort) stays in
 * the composer's own row under the box, and so does the agent, which is picked there with its
 * model; the state of main itself (how far it trails origin, with the pull) is the composer's too,
 * under the knobs, where a worktree's own state reads. Nothing else: the box's placeholder says
 * what to do, and a repo without profiles over a clean main shows nothing here at all. */
export function DraftIntro({ draft, lead }: { draft: Draft; lead: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const repo = useStore((s) => repoById(s, lead?.repoId));
  // the per-repo memory the send uses when nothing is picked here; undefined for a repo without
  // profiles, and then there is no row
  const [remembered] = useNewWorktreeProfile(repo);
  const profile = draft.profile ?? remembered;
  // main's uncommitted files, as the daemon last counted them: the lead row's own status is the
  // spare's, which sits on main clean
  const dirty = useStore((s) => trunkOf(s, lead?.repoId)?.dirty ?? 0);
  const note = !!lead && !!repo && dirty > 0;
  if (!profile && !note) return null;
  // its own flex child under the log, not a second chat-wrap: two of those split the panel's
  // height between them and the intro sat mid-panel with room under it
  return (
    <div className="draft-intro">
      {profile && (
        <div className="draft-row hint">
          <ProfileChip repo={repo} value={profile} onChange={(p) => dispatch({ a: "draft-profile", profile: p })} />
        </div>
      )}
      {/* What main's uncommitted files do when the box starts a worktree. Default: stay, since main
            is dirty for reasons that often have nothing to do with the message (a local config tweak,
            last week's debug line), and files leaving main unasked is the one surprise this line exists
            to rule out. A checkbox and not a button: nothing happens until Enter, and a verb on a
            button promises otherwise. The count wears the rail's dirty colour. */}
      {note && (
        <div className="draft-notes">
          <Check
            className="hint draft-note"
            checked={!!draft.carry}
            tip={`Move the ${dirty} uncommitted ${dirty === 1 ? "file" : "files"} into the new worktree, leaving ${repo.defaultBranch} clean`}
            onChange={(e) => dispatch({ a: "draft-carry", v: e.currentTarget.checked })}
          >
            <span className="badge-dirty">~{dirty}</span> on {repo.defaultBranch} come along
          </Check>
        </div>
      )}
    </div>
  );
}
