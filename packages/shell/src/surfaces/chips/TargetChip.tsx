import { ChipPicker } from "../../ui/ChipPicker.tsx";
import "./chips.css";

export type Target = "new" | "here";

/** Where a message from main goes: into a new worktree from it, or to main's own agent. A sentence
 * with the chip as its one variable word, so the line says what a send does and the chip is where
 * that changes. The same words lead the chip either way, so it does not move when it flips. It
 * defaults to a new worktree, which is what keeps the working copy out of an agent's hands unless
 * asked; a worktree's messages only ever go to that worktree, so only main has this line.
 *
 * Flow text, not a flex row: the words hug the chip, whose own padding is the space either side,
 * and a narrow dock wraps the sentence where a word ends. */
export function TargetLine({
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
    <>
      agent works in
      <ChipPicker<Target>
        value={value}
        options={[
          { id: "new", label: "new worktree", description: `starts an agent in a new worktree from ${title}` },
          { id: "here", label: title, description: `the agent edits ${title} directly` },
        ]}
        onChange={onChange}
        onClose={onClose}
        className="target-chip"
        hint="where the message goes; click to change"
        placeholder="where the message goes"
      />
      {value === "new" ? `from ${title}` : "directly"}
    </>
  );
}
