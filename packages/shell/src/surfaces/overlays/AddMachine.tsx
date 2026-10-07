import { parsePairLink } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useDispatch, useMachines } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { useFocusOnMount } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { reachable, redeemPair } from "../../ws.ts";
import { ADD_MACHINE, failureLine } from "./addMachine.ts";
import "./addMachine.css";

/** the browser's own barcode reader, where it has one (Chrome on Android and the desktop, not
 * Safari or Firefox); the DOM typings do not name it */
interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** how often the camera's frame is read for a code */
const SCAN_EVERY_MS = 250;

/** The camera over a code, reporting each new code it reads: a stray code (the Wi-Fi one on the
 * desk) is reported once and the camera keeps looking, so the right one is read when it comes into
 * view. Started with the rear camera, since the code is on another screen in front of the phone;
 * stopped with the card, since a camera left on is a light that says it is. Nothing when the
 * browser has no reader or no camera: the field beneath is the way in then, and the line says so. */
function Scanner({ onRead, onUnavailable }: { onRead: (text: string) => void; onUnavailable: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const read = useRef(onRead);
  read.current = onRead;
  const gone = useRef(onUnavailable);
  gone.current = onUnavailable;
  useEffect(() => {
    const Reader = window.BarcodeDetector;
    const el = video.current;
    if (!Reader || !el || !navigator.mediaDevices?.getUserMedia) {
      gone.current();
      return;
    }
    let live = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detector = new Reader({ formats: ["qr_code"] });
    // the code last reported, so one held in view is not submitted on every tick
    let lastRead: string | null = null;
    const scan = async () => {
      if (!live) return;
      try {
        const found = await detector.detect(el);
        const text = found[0]?.rawValue;
        if (text && live && text !== lastRead) {
          lastRead = text;
          read.current(text);
        }
      } catch {
        // a frame not ready yet, or the reader refusing it: the next tick tries again
      }
      timer = setTimeout(scan, SCAN_EVERY_MS);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (!live) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        el.srcObject = s;
        return el.play().then(scan);
      })
      .catch(() => {
        // no camera, or no permission: paste is the way in
        if (live) gone.current();
      });
    return () => {
      live = false;
      clearTimeout(timer);
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, []);
  return <video ref={video} className="add-machine-camera" muted playsInline />;
}

type Step =
  | { kind: "idle" }
  | { kind: "asking"; origin: string }
  | { kind: "added"; name: string }
  | { kind: "failed"; line: string };

/** Another machine, added from inside this one: its pairing code read by the camera or its link
 * pasted. A pair link is redeemed at that machine from here, which is also what makes that machine
 * answer this page across origins from then on; a token link is listed as it is, once the machine
 * answers at all. */
export function AddMachine() {
  const dispatch = useDispatch();
  const machines = useMachines();
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [camera, setCamera] = useState(true);
  const field = useFocusOnMount<HTMLInputElement>();
  const close = () => dispatch({ a: "close" });

  const submit = async (raw: string) => {
    if (step.kind === "asking") return;
    const link = parsePairLink(raw);
    if (!link) {
      setStep({ kind: "failed", line: ADD_MACHINE.notALink });
      return;
    }
    setStep({ kind: "asking", origin: link.origin });
    if ("token" in link) {
      if (!(await reachable(link.origin))) {
        setStep({ kind: "failed", line: failureLine("unreachable", link.origin) });
        return;
      }
      const m = machines.add({ origin: link.origin, token: link.token });
      setStep({ kind: "added", name: machines.displayName(m.origin) });
      return;
    }
    const got = await redeemPair(link.origin, link.code);
    if (typeof got === "string") {
      setStep({ kind: "failed", line: failureLine(got, link.origin) });
      return;
    }
    const m = machines.add({ origin: link.origin, token: got.token });
    setStep({ kind: "added", name: machines.displayName(m.origin) });
  };

  const line =
    step.kind === "asking"
      ? ADD_MACHINE.asking(step.origin)
      : step.kind === "added"
        ? ADD_MACHINE.added(step.name)
        : step.kind === "failed"
          ? step.line
          : camera
            ? ADD_MACHINE.lead
            : ADD_MACHINE.pasteOnly;

  return (
    <Overlay bare boxClass="add-machine-stack" onClose={close}>
      <div className="add-machine-card">
        <div className="add-machine-title">{ADD_MACHINE.title}</div>
        {camera && step.kind !== "added" && (
          <div className="add-machine-frame">
            <Scanner onRead={(t) => void submit(t)} onUnavailable={() => setCamera(false)} />
          </div>
        )}
        <p className={cx("add-machine-line", step.kind === "failed" && "add-machine-failed")}>{line}</p>
        {step.kind !== "added" && (
          <form
            className="add-machine-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(text);
            }}
          >
            <Field
              ref={field}
              size="md"
              font="ui"
              value={text}
              placeholder={ADD_MACHINE.placeholder}
              aria-label="Link to the other machine"
              onChange={(e) => setText(e.target.value)}
              className="add-machine-field"
            />
            <Button type="submit" variant="outline" busy={step.kind === "asking"} disabled={!text.trim()}>
              {ADD_MACHINE.add}
            </Button>
          </form>
        )}
        <div className="add-machine-actions">
          <Button tone="quiet" onClick={close}>
            {step.kind === "added" ? "done" : "cancel"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
