import type { GlobalInstall } from "@toyon/shared";
import { Fragment } from "react";
import { globalFailedText, PERMISSIONS_GUIDE } from "../../app/globalInstall.ts";
import { ComposerOffer } from "./ComposerOffer.tsx";

/** A short command as one piece: `toyon restart` split across lines reads as two things */
function Short({ children }: { children: string }) {
  return <code className="composer-offer-whole">{children}</code>;
}

/** A command that may be longer than the line: one piece while it is short, so it moves to the
 * next line whole rather than leaving its first word behind. One with a URL in it (a company
 * registry's long path) can be longer than the line on its own, so it is pieces: the plain words
 * together, then the URL word, which breaks only before the slashes of its path, never inside
 * `--registry` at its hyphens. */
function Cmd({ children }: { children: string }) {
  if (!children.includes("://")) return <Short>{children}</Short>;
  const pieces: string[] = [];
  for (const w of children.split(" ")) {
    const last = pieces.length - 1;
    if (w.includes("://") || last < 0 || pieces[last]?.includes("://")) pieces.push(w);
    else pieces[last] = `${pieces[last]} ${w}`;
  }
  return (
    <code>
      {pieces.map((piece, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces never reorder
        <Fragment key={i}>
          {i > 0 && " "}
          {piece.includes("://") ? (
            piece.split(/(?=\/)(?<![:/])/).map((part, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
              <Fragment key={j}>
                {j > 0 && <wbr />}
                <span className="composer-offer-whole">{part}</span>
              </Fragment>
            ))
          ) : (
            <span className="composer-offer-whole">{piece}</span>
          )}
        </Fragment>
      ))}
    </code>
  );
}

export function GlobalInstallOffer({
  offer,
  onInstall,
  onDismiss,
}: {
  offer: GlobalInstall;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (offer.state === "installing") {
    return (
      <ComposerOffer icon="download" busy>
        Installing Toyon with npm
      </ComposerOffer>
    );
  }
  if (offer.state === "installed") {
    return (
      <ComposerOffer icon="check" className="composer-offer-long" onDismiss={onDismiss}>
        Toyon is installed. In a new terminal, <Short>toyon restart</Short> moves onto it.
      </ComposerOffer>
    );
  }
  if (offer.state === "failed") {
    const f = globalFailedText(offer);
    return (
      <ComposerOffer
        icon="download"
        verb="try again"
        tip="Run the install again"
        className="composer-offer-long"
        onPress={onInstall}
        onDismiss={onDismiss}
      >
        {f.why}.{" "}
        {f.permissions && (
          <>
            <a href={PERMISSIONS_GUIDE} target="_blank" rel="noreferrer">
              npm's guide
            </a>{" "}
            covers this error.{" "}
          </>
        )}
        By hand: <Cmd>{f.command}</Cmd>
      </ComposerOffer>
    );
  }
  return (
    <ComposerOffer
      icon="download"
      verb="install"
      tip="Toyon started with npx does not update itself and leaves no toyon command. This runs npm install -g toyon."
      onPress={onInstall}
      onDismiss={onDismiss}
    >
      Toyon for good, so it updates itself
    </ComposerOffer>
  );
}
