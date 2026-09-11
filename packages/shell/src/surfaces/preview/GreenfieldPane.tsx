import type { OwnedWorktree } from "@toyon/shared";
import { Composer } from "../chat/Composer.tsx";

/** What fills the preview column for a project with nothing in it yet. The same slot the setup
 * and discovered panes use, and the one time the composer sits here instead of in its dock: there
 * is nothing else to look at, and a page with one box on it says where to start. */
export function GreenfieldPane({ active }: { active: OwnedWorktree }) {
  return (
    <div className="greenfield-pane">
      <p className="greenfield-lead">what should {active.worktree.title} become?</p>
      <Composer active={active} greenfield />
    </div>
  );
}
