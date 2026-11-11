import { Button } from "../../ui/Button.tsx";
import { Icon, type IconName } from "../../ui/Icon.tsx";

/** A switch in the pane's head: one word that never changes, lit while it is on. The head then
 * reads as the state the pane is in, where a label naming the state a press leads to has to be
 * read backwards to learn the one it is in. */
export function HeadToggle({
  icon,
  label,
  on,
  onPress,
  tip,
}: {
  icon: IconName;
  label: string;
  on: boolean;
  onPress: (on: boolean) => void;
  tip: string;
}) {
  return (
    <Button
      variant="outline"
      tone="chrome"
      mono
      on={on}
      aria-pressed={on}
      className="deep-link"
      onClick={() => onPress(!on)}
      data-tip={tip}
    >
      <Icon name={icon} className="icon-inline" /> {label}
    </Button>
  );
}
