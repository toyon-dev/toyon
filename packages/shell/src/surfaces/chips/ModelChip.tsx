import type { ModelChoice } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { usePersisted } from "../../ui/hooks.ts";
import { DEFAULT_OPTION, OptionChip } from "./OptionChip.tsx";

/** the model a new worktree of this agent asks for: remembered per agent in this browser */
export function useNewWorktreeModel(agentId: string | undefined): [string, (m: string) => void] {
  const [stored, setStored] = usePersisted<string>(
    STORAGE.modelPrefix + (agentId ?? ""),
    DEFAULT_OPTION,
    (raw) => raw ?? "",
  );
  return [stored, setStored];
}

/** which of the agent's models answers here */
export function ModelChip({
  models,
  value,
  current,
  onChange,
  onClose,
}: {
  models: ModelChoice[];
  value: string;
  current?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <OptionChip
      choices={models}
      value={value}
      current={current}
      what="a model"
      defaultLabel="default model"
      defaultDescription="whatever the agent runs when nothing is asked for"
      placeholder="which model answers here"
      className="model-chip"
      onChange={onChange}
      onClose={onClose}
    />
  );
}
