import type { ModelChoice } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { DEFAULT_OPTION } from "./choiceRows.ts";
import { OptionChip } from "./OptionChip.tsx";

/** the effort level a new worktree of this agent asks for: remembered per agent in this browser */
export function useNewWorktreeEffort(agentId: string | undefined): [string, (e: string) => void] {
  const [stored, setStored] = usePersisted<string>(
    STORAGE.effortPrefix + (agentId ?? ""),
    DEFAULT_OPTION,
    (raw) => raw ?? "",
  );
  return [stored, setStored];
}

/** how hard the agent thinks here. The choices depend on the model: an agent that has none for
 * the model it is on advertises none, and the chip is not drawn. */
export function EffortChip({
  efforts,
  value,
  current,
  onChange,
  onClose,
}: {
  efforts: ModelChoice[];
  value: string;
  current?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <OptionChip
      choices={efforts}
      value={value}
      current={current}
      what="an effort level"
      defaultLabel="default effort"
      defaultDescription="the level the agent runs at when nothing is asked for"
      placeholder="how hard the agent thinks here"
      className="effort-chip"
      onChange={onChange}
      onClose={onClose}
    />
  );
}
