import type { ModelChoice } from "@toyon/shared";
import { OptionChip } from "./OptionChip.tsx";

/** how hard the agent thinks here. The choices depend on the model: an agent that has none for
 * the model it is on advertises none, and the chip is not drawn. */
export function EffortChip({
  efforts,
  value,
  current,
  runs,
  onChange,
  onClose,
}: {
  efforts: ModelChoice[];
  value: string;
  current?: string;
  /** the agent's defaultEffort: what its default row stands for */
  runs?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <OptionChip
      choices={efforts}
      value={value}
      current={current}
      runs={runs}
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
