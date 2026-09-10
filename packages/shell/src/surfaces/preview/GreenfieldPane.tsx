import type { OwnedWorktree } from "@toyon/shared";
import { useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { Composer } from "../chat/Composer.tsx";
import { KINDS, type Kind } from "./kinds.ts";

/** What fills the preview column for a project with nothing in it yet. The same slot the setup
 * and discovered panes use, and the one time the composer sits here instead of in its dock: there
 * is nothing else to look at, and a page with one box on it says where to start. */
export function GreenfieldPane({ active }: { active: OwnedWorktree }) {
  // none chosen is a choice too: the agent picks for what the message describes
  const [kind, setKind] = useState<Kind | null>(null);
  return (
    <div className="greenfield-pane">
      <p className="greenfield-lead">what should {active.worktree.title} become?</p>
      <div className="greenfield-stacks">
        {KINDS.map((k) => (
          <Button
            key={k.id}
            variant="outline"
            on={k.id === kind?.id}
            onClick={() => setKind(k.id === kind?.id ? null : k)}
          >
            {k.label}
          </Button>
        ))}
      </div>
      <Composer active={active} greenfield={{ kind }} />
    </div>
  );
}
