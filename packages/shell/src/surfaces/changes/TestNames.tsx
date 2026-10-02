import { memo } from "react";
import { rowState } from "../../ui/rowState.ts";
import type { ChangedTest } from "./testNames.ts";

const LETTER = { added: "A", changed: "M", removed: "D" } as const;
const XY = { added: "added", changed: "", removed: "deleted" } as const;

/** under the test file the editor has open: the tests its change added, changed and removed, each
 * one a row that shows the file at that test */
export const TestNames = memo(function TestNames({
  tests,
  id,
  cursor,
  onPick,
}: {
  tests: readonly ChangedTest[];
  /** the file row's id: each name's is made from it, for `aria-activedescendant` */
  id: string;
  /** the name the keyboard is on, or -1 */
  cursor: number;
  onPick: (at: number) => void;
}) {
  return tests.map((t, j) => (
    <button
      // biome-ignore lint/suspicious/noArrayIndexKey: a name can repeat, and the list is rebuilt whole on every read
      key={j}
      className="row row-sm changes-test row-rails row-edge"
      id={`${id}-t${j}`}
      data-state={rowState({ current: cursor === j, cursor: cursor === j })}
      // not one of the list's own rows: the list numbers those, and a name is counted under its file
      data-sub
      role="option"
      aria-selected={cursor === j}
      tabIndex={-1}
      onClick={() => onPick(j)}
      data-tip={[...t.group, t.name].join(" · ")}
      data-tip-placement="follow"
    >
      <span className={`xy ${XY[t.change]}`}>{LETTER[t.change]}</span>
      <span className="name">{t.name}</span>
    </button>
  ));
});
