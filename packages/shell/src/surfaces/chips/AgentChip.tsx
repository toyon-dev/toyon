import type { AgentInfo } from "@toyon/shared";
import { ChipPicker } from "../../ui/ChipPicker.tsx";

/** Which agent a new worktree runs. Only before the first message: a worktree's agent never
 * changes, since its session belongs to that agent. One that is not installed is listed with the
 * reason rather than hidden, so the way to get it is one line away. */
export function AgentChip({
  agents,
  value,
  onChange,
  onClose,
}: {
  agents: AgentInfo[];
  value: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  const shown = agents.find((a) => a.id === value);
  return (
    <ChipPicker
      value={value}
      options={agents.map((a) => ({
        id: a.id,
        label: a.name,
        description: !a.available
          ? `not installed: ${a.reason ?? ""}`
          : a.sandboxed
            ? "runs shell commands under an OS sandbox"
            : "runs without an OS sandbox",
        disabled: !a.available,
      }))}
      onChange={onChange}
      onClose={onClose}
      hint={`${shown?.name ?? value} works on the new worktree; click to change`}
      placeholder="which agent works on it"
    />
  );
}
