import { type Knock, machineAddress, machineLink, type TailnetDevice, type TailnetView } from "@toyon/shared";
import { qrModules } from "@toyon/shared/qr";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useMachines, useStore, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { usePolled } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import {
  answerKnock,
  daemonUrls,
  handMachine,
  requestAccess,
  tailnetView,
  tailscaleLogin,
  tailscaleUp,
  turnOffRemote,
  turnOnRemote,
} from "../../ws.ts";
import { DEVICES, hostOf, knockFailureLine, machineRank, machineState, selfState } from "./devices.ts";
import { deviceRow, type TailnetRow, TailnetRows } from "./TailnetRows.tsx";
import "./devices.css";

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
      className="devices-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="This machine's address"
    >
      <path d={d} />
    </svg>
  );
}

/** how often the list is read again while the card is open: turning Tailscale on at the phone,
 * or pressing the phone button on another machine, is the thing the person does next, and the
 * rows should follow it */
const TAILNET_EVERY_MS = 5000;

type Step =
  | { kind: "idle" }
  | { kind: "asking"; origin: string }
  /** the knock is in; the person at the other machine sees `word` and decides */
  | { kind: "waiting"; origin: string; word: string }
  | { kind: "added"; name: string }
  | { kind: "failed"; line: string };

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
    <div className={cx("devices-knock", letIn !== null && "devices-knock-done")}>
      <div className="devices-knock-line">
        <span className="knock-word">{knock.word}</span>
        <span className="devices-from">
          {letIn === null ? `${knockFrom(knock)} wants in.` : letIn ? "is in." : "was turned away."}
        </span>
      </div>
      {letIn === null && (
        <div className="devices-actions">
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

/** The address for a phone's camera beside what it is for. Only while it would work: a desk
 * with a name and this machine on the tailnet. Off the tailnet the code is a picture of nothing,
 * so it goes, and this machine's row says why. A phone never shows it: it would be asking
 * itself to scan. */
function Address({ host, noPhone }: { host: string; noPhone: boolean }) {
  return (
    <div className="devices-address">
      <div className="devices-frame">
        <QrCode text={machineLink(host)} />
      </div>
      <div className="devices-about">
        <p className="devices-line">{DEVICES.scan}</p>
        {noPhone && <p className="devices-note">{DEVICES.noPhone}</p>}
      </div>
    </div>
  );
}

/** the list's order: this machine, then the phones as Tailscale lists them, then the machines
 * with the Toyons that answer first */
function ordered(view: TailnetView): TailnetDevice[] {
  const phones = view.devices.filter((d) => d.kind === "phone");
  const machines = view.devices
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.kind === "machine")
    .sort((a, b) => machineRank(a.d) - machineRank(b.d) || a.i - b.i)
    .map(({ d }) => d);
  return [...phones, ...machines];
}

/** Every device that could see this machine, and this machine as they see it. On a desk the
 * card leads with the address a phone scans, or with turning a name on. Under it, the tailnet:
 * this machine first, then each device with a dot for whether it answers from here, so a grey
 * top row says the fault is here and a grey phone says it is the phone. A machine running Toyon
 * gets "request access": this page knocks there and waits, the person at that machine sees the
 * same two words this card shows and lets it in, and the let-in carries that machine's token to
 * the daemon that served this page, which keeps the one list every browser it serves gets. A
 * machine not on the tailnet goes in the field. The devices asking to be let in here sit at the
 * foot, each with the two words it shows on its own screen; answered ones stay, with their
 * answer, until the card closes. Nothing closes the card but Escape and a press outside it. */
export function DevicesCard() {
  const dispatch = useDispatch();
  const machines = useMachines();
  const urls = useUrls();
  const desk = useStore((s) => s.frame === "desk");
  const host = useStore((s) => s.remote?.host ?? null);
  const machine = useStore((s) => s.machine);
  const tailscale = useStore((s) => s.tailscale);
  const knocks = useStore((s) => s.knocks);
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  // what was answered here, with the answer, kept so the row says so after the daemon's list
  // drops it
  const [answered, setAnswered] = useState<{ knock: Knock; letIn: boolean }[]>([]);
  const close = () => dispatch({ a: "close" });
  const busy = step.kind === "asking" || step.kind === "waiting";
  const view = usePolled(() => tailnetView(urls), TAILNET_EVERY_MS, !busy);
  // a wait outlives nothing: cancelling or closing the card ends it, and the knock expires there
  // on its own
  const waits = useRef(new AbortController());
  useEffect(() => {
    return () => waits.current.abort();
  }, []);

  const submit = async (origin: string) => {
    if (busy) return;
    const signal = waits.current.signal;
    setStep({ kind: "asking", origin });
    const got = await requestAccess(origin, signal, (word) => setStep({ kind: "waiting", origin, word }));
    if (signal.aborted) return;
    if (typeof got === "string") {
      setStep({ kind: "failed", line: knockFailureLine(got, origin, "this page") });
      return;
    }
    const serving = machines.serving();
    const refused = await handMachine(daemonUrls(serving.origin, serving.token), origin, got.token);
    if (refused) setStep({ kind: "failed", line: DEVICES.notKept(refused) });
    else setStep({ kind: "added", name: machines.displayName(origin) });
  };
  const submitTyped = () => {
    const origin = machineAddress(text);
    if (!origin) setStep({ kind: "failed", line: DEVICES.notAnAddress });
    else void submit(origin);
  };
  const cancel = () => {
    waits.current.abort();
    waits.current = new AbortController();
    setStep({ kind: "idle" });
  };

  const answer = (knock: Knock, letIn: boolean) => {
    setAnswered((list) => (list.some((a) => a.knock.id === knock.id) ? list : [...list, { knock, letIn }]));
    void answerKnock(urls, knock.id, letIn);
  };
  const waiting = knocks.filter((k) => !answered.some((a) => a.knock.id === k.id));
  const knockRows = [...answered, ...waiting.map((knock) => ({ knock, letIn: null }))];

  // this machine's name on the tailnet, on or off: the one switch on the card, on its own row.
  // The daemon's `remote` frame moves `host`, so the row follows the fact and not the press.
  const [switching, setSwitching] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const switchName = async (on: boolean) => {
    setSwitching(true);
    setRefused(null);
    const why = await (on ? turnOnRemote(urls) : turnOffRemote(urls));
    setSwitching(false);
    if (why) setRefused(why);
  };

  // This machine, first and apart from the rest. Its row carries the switch for its name: a
  // toggle that reads the state, "on" or "off", so a press flips what it reads and the word can
  // never contradict the row (a verb would, with Tailscale down and the name still on). The dot
  // is its own link, the word beside the switch says what is wrong with it, and the address
  // sits after the name while the name is on, since that is what the switch gives and takes.
  // With no tailnet to list (Tailscale here off, or not asked) the row still draws, since the
  // word is then the whole message. The switch shows only while Tailscale here is up: the dot is
  // Tailscale's own connection, which the Tailscale app controls, and the switch is Toyon's name
  // on that connection; with the connection down there is nothing to switch, the address on the
  // row already says the name is on, and a switch beside a grey dot read as two answers to one
  // question. A phone never shows the switch: it would be cutting itself off.
  const here = view?.here === true;
  const self = selfState(view, tailscale, host);
  const named = host !== null;
  const toggle =
    desk && here ? (
      <Button
        variant="outline"
        size="sm"
        on={named}
        aria-pressed={named}
        busy={switching}
        disabled={!named && tailscale?.state !== "ready"}
        onClick={() => void switchName(!named)}
        {...tip(named ? "Take this machine's name off your tailnet" : "Give this machine a name on your tailnet")}
      >
        {named ? "on" : "off"}
      </Button>
    ) : null;
  // Where the switch would be, while Tailscale here is off in a way the CLI undoes: "connect"
  // runs `tailscale up`, "sign in" starts `tailscale login` and opens the link it is waiting
  // on. The link comes back after a round trip, so when the browser will not open it from
  // there (the press is too old by then to count), the row offers it as a second press instead.
  const [bringing, setBringing] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const openLogin = (url: string) => {
    if (window.open(url, "_blank", "noopener") === null) setLoginUrl(url);
    else setLoginUrl(null);
  };
  const bringBack = async (offer: "connect" | "sign-in") => {
    setBringing(true);
    setRefused(null);
    if (offer === "connect") {
      const why = await tailscaleUp(urls);
      if (why) setRefused(why);
    } else {
      const got = await tailscaleLogin(urls);
      if ("url" in got) openLogin(got.url);
      else setRefused(got.why);
    }
    setBringing(false);
  };
  const offer =
    desk && self.offer !== null ? (
      loginUrl !== null ? (
        <Button variant="outline" size="sm" onClick={() => openLogin(loginUrl)}>
          open the sign-in page
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          busy={bringing}
          onClick={() => void bringBack(self.offer ?? "connect")}
          {...(self.note ? tip(self.note) : {})}
        >
          {self.offer === "connect" ? "connect" : "sign in"}
        </Button>
      )
    ) : null;
  const selfRight =
    self.word === null && toggle === null && offer === null ? (
      "this machine"
    ) : (
      <>
        {self.word && <span className="hint">{self.word}</span>}
        {toggle ?? offer}
      </>
    );
  const selfRows: TailnetRow[] = [
    { key: "self", name: machine ?? "This machine", host: host ?? undefined, reached: here, right: selfRight },
  ];
  const rows: TailnetRow[] = view
    ? ordered(view).map((d) => {
        if (d.kind === "phone" || d.host === "") return deviceRow(d, d.reached ? undefined : "not answering");
        const origin = `https://${d.host}`;
        const state = machineState(d, machines.get(origin) !== null);
        return deviceRow(
          d,
          state ?? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void submit(origin)}>
              {DEVICES.request}
            </Button>
          ),
        );
      })
    : [];
  // the code only while a phone could scan it to any effect: a name, and this machine on the
  // tailnet (or not yet asked, so the card does not flash)
  const live = desk && host !== null && view !== null && (view === undefined || view.here);
  const noToyon = view?.devices.some((d) => d.kind === "machine" && d.host !== "" && d.reached && d.toyon === null);
  const noPhone = live && view !== undefined && !view.devices.some((d) => d.kind === "phone");
  const line = (() => {
    switch (step.kind) {
      case "asking":
        return DEVICES.asking(step.origin);
      case "waiting":
        return DEVICES.waiting(step.origin, step.word);
      case "added":
        return DEVICES.added(step.name);
      case "failed":
        return step.line;
      case "idle":
        return null;
    }
  })();

  return (
    <Overlay boxClass="devices-card" onClose={close}>
      <div className="devices-title">{DEVICES.title}</div>
      {view !== undefined && (
        <>
          <TailnetRows rows={selfRows} />
          {self.note && self.offer === null && <p className="devices-note">{self.note}</p>}
          {refused && <p className="devices-note">{refused}</p>}
          {desk && !named && tailscale?.state === "ready" && <p className="devices-note">{DEVICES.turnOn}</p>}
        </>
      )}
      {live && host !== null && <Address host={host} noPhone={noPhone} />}
      {step.kind === "waiting" && <div className="knock-word devices-word">{step.word}</div>}
      {line && <p className={cx("devices-line", step.kind === "failed" && "devices-failed")}>{line}</p>}
      {view !== undefined && (
        <>
          {rows.length > 0 && (
            <div className="devices-others">
              <TailnetRows rows={rows} />
            </div>
          )}
          {view?.devices.length === 0 && <p className="devices-note">{DEVICES.noneOnTailnet}</p>}
          {noToyon && <p className="devices-note">{DEVICES.missing}</p>}
        </>
      )}
      {!busy && (
        <form
          className="devices-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <Field
            size="md"
            font="ui"
            value={text}
            placeholder={DEVICES.placeholder}
            aria-label="Address of the other machine"
            onChange={(e) => setText(e.target.value)}
            className="devices-field"
          />
          <Button type="submit" variant="outline" disabled={!text.trim()}>
            {DEVICES.add}
          </Button>
        </form>
      )}
      {busy && (
        <div className="devices-actions">
          <Button tone="quiet" onClick={cancel}>
            cancel
          </Button>
        </div>
      )}
      {waiting.length > 0 && <p className="devices-line devices-centred">{DEVICES.knocking}</p>}
      {knockRows.map((r) => (
        <KnockRow key={r.knock.id} knock={r.knock} letIn={r.letIn} onAnswer={(letIn) => answer(r.knock, letIn)} />
      ))}
    </Overlay>
  );
}
