import type { OwnedWorktree } from "@toyon/shared";
import { useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { Composer } from "../chat/Composer.tsx";
import { DEFAULT_STACK, STACKS } from "./stacks.ts";

/** What fills the preview column for a project with nothing in it yet. The same slot the setup
 * and discovered panes use, and the one time the composer sits here instead of in its dock: there
 * is nothing else to look at, and a page with one box on it says where to start. */
export function GreenfieldPane({ active }: { active: OwnedWorktree }) {
  const [preset, setPreset] = useState(DEFAULT_STACK);
  return (
    <div className="greenfield-pane">
      <p className="greenfield-lead">what should {active.worktree.title} become?</p>
      <div className="greenfield-stacks">
        {STACKS.map((s) => (
          <Button key={s.id} variant="outline" on={s.id === preset.id} onClick={() => setPreset(s)}>
            {s.label}
          </Button>
        ))}
      </div>
      <Composer active={active} greenfield={{ preset }} />
    </div>
  );
}
