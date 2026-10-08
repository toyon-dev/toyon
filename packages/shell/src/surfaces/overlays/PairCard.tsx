import { isTailnetName, type Knock, machineLink, tailnetLine } from "@toyon/shared";
import { qrModules } from "@toyon/shared/qr";
import { useMemo, useState } from "react";
import { useDispatch, useStore, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { usePolled } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { answerKnock, type DaemonUrls, tailnetPhones, turnOnRemote } from "../../ws.ts";
import { hostOf } from "./addMachine.ts";
import "./pair.css";

/** the light margin around the modules a camera looks for, in modules, as the standard asks */
const QUIET = 4;

/** a QR code as one path of unit squares; the card's CSS paints it, so the colours stay tokens */
function QrCode({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const m = qrModules(text);
    let path = "";
    m.forEach((row, r) => {
      row.forEach((dark, c) => {
        if (dark) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      });
    });
    return { size: m.length + QUIET * 2, d: path };
  }, [text]);
  return (
    <svg
      className="pair-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="This machine's address"
    >
      <path d={d} />
    </svg>
  );
}

/** how often the card asks again while it waits for a phone: turning Tailscale on at the phone is
 * the thing the person does next, and the line should follow it */
const PHONES_EVERY_MS = 3000;

/** what a knock is called on the card: the page it came from, when that is not this machine's own */
function knockFrom(k: Knock): string {
  return k.from === null ? "A device that opened this address" : `A Toyon page at ${hostOf(k.from)}`;
}

/** one device asking, with the two words it shows on its own screen, and the answer */
function KnockRow({
  knock,
  letIn,
  onAnswer,
}: {
  knock: Knock;
  /** the answer given here, or null while it waits */
  letIn: boolean | null;
  onAnswer: (letIn: boolean) => void;
}) {
  return (
    <div className={cx("pair-knock", letIn !== null && "pair-knock-done")}>
      <div className="pair-knock-line">
        <span className="knock-word">{knock.word}</span>
        <span className="pair-from">
          {letIn === null ? `${knockFrom(knock)} wants in.` : letIn ? "is in." : "was turned away."}
        </span>
      </div>
      {letIn === null && (
        <div className="pair-knock-actions">
          <Button tone="primary" onClick={() => onAnswer(true)}>
            let in
          </Button>
          <Button variant="outline" onClick={() => onAnswer(false)}>
            not now
          </Button>
        </div>
      )}
    </div>
  );
}

/** The address for a phone's camera, once the machine has a name; before that, what turning one
 * on means and the button that does it, or what Tailscale is missing. Only a desk shows this
 * half: a phone showing the address would be asking itself to scan. */
function Address({ urls, waitingOnPhone }: { urls: DaemonUrls; waitingOnPhone: boolean }) {
  const host = useStore((s) => s.remote?.host ?? null);
  const tailscale = useStore((s) => s.tailscale);
  const [turning, setTurning] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // the phones are asked after while the address is up and no device has knocked yet: once one
  // has, the phone is plainly connected
  const tailnet = host !== null && isTailnetName(host);
  const phones = usePolled(() => tailnetPhones(urls), PHONES_EVERY_MS, tailnet && waitingOnPhone);
  const note = tailnet && phones !== undefined ? tailnetLine(phones) : null;
  const turnOn = async () => {
    setTurning(true);
    setRefused(null);
    const why = await turnOnRemote(urls);
    setTurning(false);
    if (why) setRefused(why);
  };
  if (host !== null) {
    return (
      <>
        <div className="pair-frame">
          <QrCode text={machineLink(host)} />
        </div>
        <div className="hint pair-host">{host}</div>
        <p className="pair-line">
          Scan it with your phone's camera. The phone asks to be let in, and the ask shows here. Another machine finds
          this one under "add a machine".
        </p>
        {note && <p className={cx("pair-note", note.ok && "hint")}>{note.text}</p>}
      </>
    );
  }
  return (
    <>
      <p className="pair-line">
        Your phone opens this machine at its tailnet name. Anyone on your tailnet you let in gets a shell here.
      </p>
      {tailscale === null ? (
        <p className="pair-note">Asking Tailscale.</p>
      ) : tailscale.state === "ready" ? (
        <>
          <div className="pair-knock-actions">
            <Button tone="primary" busy={turning} onClick={() => void turnOn()}>
              turn on
            </Button>
          </div>
          {refused && <p className="pair-note">{refused}</p>}
        </>
      ) : (
        <p className="pair-note">{tailscale.line}</p>
      )}
    </>
  );
}

/** Pairing. On a desk the card leads with the machine's address, or with turning a name on, and
 * under it the devices asking to be let in; elsewhere it is the asking devices alone, since that
 * is what opened it. A device shows the same two words it is listed by here, so the person lets
 * in the one they meant. Answered knocks stay on the card, with their answer, until it closes;
 * the daemon's `knocks` frames keep the waiting ones true. */
export function PairCard() {
  const dispatch = useDispatch();
  const urls = useUrls();
  const desk = useStore((s) => s.frame === "desk");
  const knocks = useStore((s) => s.knocks);
  // what was answered here, with the answer, kept so the row says so after the daemon's list
  // drops it
  const [answered, setAnswered] = useState<{ knock: Knock; letIn: boolean }[]>([]);
  const close = () => dispatch({ a: "close" });

  const answer = (knock: Knock, letIn: boolean) => {
    setAnswered((list) => (list.some((a) => a.knock.id === knock.id) ? list : [...list, { knock, letIn }]));
    void answerKnock(urls, knock.id, letIn);
  };
  const waiting = knocks.filter((k) => !answered.some((a) => a.knock.id === k.id));
  const rows = [...answered, ...waiting.map((knock) => ({ knock, letIn: null }))];

  return (
    <Overlay boxClass="pair-card" onClose={close}>
      <div className="pair-title">{desk ? "Open on your phone" : "Pair a device"}</div>
      {desk && <Address urls={urls} waitingOnPhone={waiting.length === 0} />}
      {rows.length === 0 && !desk && <p className="pair-line">Nothing is asking to be let in right now.</p>}
      {waiting.length > 0 && <p className="pair-line">Let in the one whose words match the other screen.</p>}
      {rows.map((r) => (
        <KnockRow key={r.knock.id} knock={r.knock} letIn={r.letIn} onAnswer={(letIn) => answer(r.knock, letIn)} />
      ))}
      <div className="pair-actions">
        <Button tone="quiet" onClick={close}>
          done
        </Button>
      </div>
    </Overlay>
  );
}
