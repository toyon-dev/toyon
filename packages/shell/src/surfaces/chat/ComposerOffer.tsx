import type { ReactNode } from "react";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Icon, type IconName } from "../../ui/Icon.tsx";

/** One line at the top of the composer that offers something: a glyph, the word to press, and
 * what the word is about, a tier under it. The box's offers all wear it (the question set aside,
 * what is on the clipboard, a failure to hand to the agent), so they stack as one column. An
 * offer that can be turned down gets its way out at the row's end. `className` is how an offer
 * whose line holds more than words (the piece offer's title) says so to the stylesheet. */
export function ComposerOffer({
  icon,
  verb,
  tip,
  onPress,
  onDismiss,
  className,
  children,
}: {
  icon: IconName;
  verb: string;
  tip: string;
  onPress: () => void;
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("composer-offer", className)}>
      <Icon name={icon} className="icon-inline" />
      <span className="composer-offer-line">
        <Button variant="inline" tone="strong" data-tip={tip} onClick={onPress}>
          {verb}
        </Button>{" "}
        {children}
      </span>
      {onDismiss && (
        <IconButton
          icon="close"
          tone="quiet"
          className="composer-offer-close"
          label="Not this one"
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
