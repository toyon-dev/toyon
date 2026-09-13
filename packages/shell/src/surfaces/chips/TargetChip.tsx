import { ChipPicker } from "../../ui/ChipPicker.tsx";
import "./chips.css";

export type Target = "new" | "here";

/** Where a message from main goes: into a new worktree from it, or to main's own agent. The first
 * chip on the knobs row, since every chip after it is about the place it names. The chip carries
 * the place alone, so the base it forks from is in its tooltip and its rows. It defaults to a new
 * worktree, which is what keeps the working copy out of an agent's hands unless asked; a worktree's
 * messages only ever go to that worktree, so only main has this chip. */
export function TargetChip({
  title,
  value,
  onChange,
  onClose,
}: {
  title: string;
  value: Target;
  onChange: (t: Target) => void;
  onClose?: () => void;
}) {
  return (
    <ChipPicker<Target>
      value={value}
      options={[
        { id: "new", label: "new worktree", description: `starts an agent in a new worktree from ${title}` },
        { id: "here", label: title, description: `the agent edits ${title} directly` },
      ]}
      onChange={onChange}
      onClose={onClose}
      className="target-chip"
      hint={value === "new" ? `The agent works in a new worktree from ${title}` : `The agent edits ${title} directly`}
      placeholder="where the message goes"
    />
  );
}
