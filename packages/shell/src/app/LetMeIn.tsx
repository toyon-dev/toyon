import { useState } from "react";
import { knockFailureLine } from "../surfaces/overlays/addMachine.ts";
import { Button } from "../ui/Button.tsx";
import { useOnChange } from "../ui/hooks.ts";
import { View } from "../ui/View.tsx";
import { type KnockFailure, requestAccess } from "../ws.ts";

type Step =
  | { kind: "asking" }
  | { kind: "waiting"; word: string }
  | { kind: "in" }
  | { kind: "failed"; failure: KnockFailure };

/**
 * The page a device sees when it opened this machine's address with no token: the whole shell
 * is behind the token, so there is nothing else to show. It knocks at once, shows the two words
 * the knock is listed by on every screen that holds the token, and waits. A yes there lands the
 * token here, and the page loads again as the shell. The person is looking at the other screen
 * for most of this, so the words are the biggest thing on the page.
 */
export function LetMeIn({
  origin,
  machine,
  onToken,
}: {
  origin: string;
  machine: string;
  onToken: (token: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "asking" });
  const [round, setRound] = useState(0);
  // keyed on the round: "ask again" is the one thing that starts the knock over
  useOnChange([round], () => {
    const stop = new AbortController();
    setStep({ kind: "asking" });
    void requestAccess(origin, stop.signal, (word) => setStep({ kind: "waiting", word })).then((got) => {
      if (stop.signal.aborted) return;
      if (typeof got === "string") {
        setStep({ kind: "failed", failure: got });
        return;
      }
      setStep({ kind: "in" });
      onToken(got.token);
    });
    return () => stop.abort();
  });

  return (
    <View>
      {step.kind === "waiting" && <div className="knock-word">{step.word}</div>}
      <p className="status-line">
        {step.kind === "asking"
          ? `Asking Toyon on ${machine} to let this device in.`
          : step.kind === "waiting"
            ? `Toyon on ${machine} is asking whether to let these two words in. Say yes there.`
            : step.kind === "in"
              ? "Let in. Opening."
              : knockFailureLine(step.failure, origin, "this device")}
      </p>
      {step.kind === "failed" && (
        <div className="status-actions">
          <Button variant="outline" onClick={() => setRound((n) => n + 1)}>
            ask again
          </Button>
        </div>
      )}
    </View>
  );
}
