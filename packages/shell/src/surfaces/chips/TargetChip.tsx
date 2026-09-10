import { ChipPicker } from "../../ui/ChipPicker.tsx";
import "./chips.css";

export type Target = "new" | "here";

/** Where a message goes: into a new worktree from this one, or to this one's own agent. First in
 * the composer's row, because every chip after it is about the target. On main it defaults to a
 * new worktree, which is what keeps the working copy out of an agent's hands unless asked. */
export function TargetChip({
  title,
  main,
  value,
  onChange,
  onClose,
}: {
  title: string;
  /** the row is the main checkout, whose own option means editing the working copy */
  main: boolean;
  value: Target;
  onChange: (t: Target) => void;
  onClose?: () => void;
}) {
  return (
    <ChipPicker<Target>
      value={value}
      options={[
        { id: "new", label: "new worktree", description: `starts an agent in a new worktree from ${title}` },
        {
          id: "here",
          label: title,
          description: main ? `the agent edits ${title} directly` : "continues this conversation here",
        },
      ]}
      onChange={onChange}
      onClose={onClose}
      className="target-chip"
      hint={
        value === "new"
          ? `a message here starts a new worktree from ${title}; click to change`
          : `a message here goes to ${title}; click to change`
      }
      placeholder="where the message goes"
    />
  );
}
