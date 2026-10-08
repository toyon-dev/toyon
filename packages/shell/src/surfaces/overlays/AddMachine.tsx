import { machineAddress } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useDispatch, useMachines, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { useFocusOnMount, usePolled } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { daemonUrls, handMachine, requestAccess, tailnetMachines } from "../../ws.ts";
import { ADD_MACHINE, knockFailureLine } from "./addMachine.ts";
import "./addMachine.css";

/** how often the list is read again while the card is open: a machine whose phone button was just
 * pressed should appear while the person is still looking */
const LIST_EVERY_MS = 10_000;

type Step =
  | { kind: "idle" }
  | { kind: "asking"; origin: string }
  /** the knock is in; the person at the other machine sees `word` and decides */
  | { kind: "waiting"; origin: string; word: string }
  | { kind: "added"; name: string }
  | { kind: "failed"; line: string };

/** Another machine, added from inside this one: picked from the Toyons on the tailnet, or its
 * address typed. This page knocks there and waits; the person at that machine sees the knock,
 * with the same two words this card shows, and lets it in. The let-in carries that machine's
 * token here, which goes to the daemon that served this page: it keeps the one list, and every
 * browser it serves, this one included, lists the machine from its next frame. The let-in is also
 * what makes that machine answer this page across origins from then on. */
export function AddMachine() {
  const dispatch = useDispatch();
  const machines = useMachines();
  const urls = useUrls();
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const field = useFocusOnMount<HTMLInputElement>();
  const close = () => dispatch({ a: "close" });
  const busy = step.kind === "asking" || step.kind === "waiting";
  const idle = !busy && step.kind !== "added";
  const tailnet = usePolled(() => tailnetMachines(urls), LIST_EVERY_MS, idle);
  // a wait outlives nothing: closing the card ends it, and the knock expires there on its own
  const waits = useRef(new AbortController());
  useEffect(() => {
    const c = waits.current;
    return () => c.abort();
  }, []);

  const submit = async (origin: string) => {
    if (busy) return;
    setStep({ kind: "asking", origin });
    const got = await requestAccess(origin, waits.current.signal, (word) => setStep({ kind: "waiting", origin, word }));
    if (waits.current.signal.aborted) return;
    if (typeof got === "string") {
      setStep({ kind: "failed", line: knockFailureLine(got, origin, "this page") });
      return;
    }
    const serving = machines.serving();
    const refused = await handMachine(daemonUrls(serving.origin, serving.token), origin, got.token);
    if (refused) setStep({ kind: "failed", line: ADD_MACHINE.notKept(refused) });
    else setStep({ kind: "added", name: machines.displayName(origin) });
  };
  const submitTyped = () => {
    const origin = machineAddress(text);
    if (!origin) setStep({ kind: "failed", line: ADD_MACHINE.notAnAddress });
    else void submit(origin);
  };

  const toyons = (tailnet ?? []).filter((m) => m.toyon !== null);
  const others = (tailnet ?? []).filter((m) => m.toyon === null);
  const line = (() => {
    switch (step.kind) {
      case "asking":
        return ADD_MACHINE.asking(step.origin);
      case "waiting":
        return ADD_MACHINE.waiting(step.origin, step.word);
      case "added":
        return ADD_MACHINE.added(step.name);
      case "failed":
        return step.line;
      case "idle":
        return tailnet === null ? ADD_MACHINE.leadTyped : ADD_MACHINE.lead;
    }
  })();

  return (
    <Overlay boxClass="add-machine-card" onClose={close}>
      <div className="add-machine-title">{ADD_MACHINE.title}</div>
      {step.kind === "waiting" && <div className="knock-word add-machine-word">{step.word}</div>}
      <p className={cx("add-machine-line", step.kind === "failed" && "add-machine-failed")}>{line}</p>
      {idle && tailnet && (
        <div className="add-machine-list">
          {toyons.map((m) => {
            const origin = `https://${m.host}`;
            const listed = machines.get(origin) !== null;
            return (
              <div key={m.host} className="add-machine-row">
                <div className="add-machine-machine">
                  <span className="add-machine-name">{m.toyon?.machine ?? m.name}</span>
                  <span className="hint">{m.host}</span>
                </div>
                {listed ? (
                  <span className="hint">{ADD_MACHINE.listed}</span>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void submit(origin)}>
                    {ADD_MACHINE.request}
                  </Button>
                )}
              </div>
            );
          })}
          {toyons.length === 0 && <p className="add-machine-line">{ADD_MACHINE.noneOnTailnet}</p>}
          {others.length > 0 && <p className="hint add-machine-note">{ADD_MACHINE.missing}</p>}
        </div>
      )}
      {idle && (
        <form
          className="add-machine-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <Field
            ref={field}
            size="md"
            font="ui"
            value={text}
            placeholder={ADD_MACHINE.placeholder}
            aria-label="Address of the other machine"
            onChange={(e) => setText(e.target.value)}
            className="add-machine-field"
          />
          <Button type="submit" variant="outline" disabled={!text.trim()}>
            {ADD_MACHINE.add}
          </Button>
        </form>
      )}
      <div className="add-machine-actions">
        <Button tone="quiet" onClick={close}>
          {step.kind === "added" ? "done" : "cancel"}
        </Button>
      </div>
    </Overlay>
  );
}
