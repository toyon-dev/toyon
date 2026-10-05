import { isTailnetName, type PairMint, type TailnetPhone, tailnetLine } from "@toyon/shared";
import { qrModules } from "@toyon/shared/qr";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { mintPair, pairPhones } from "../../ws.ts";
import "./pair.css";

/** the light margin around the modules a camera looks for, in modules, as the standard asks */
const QUIET = 4;

/** a QR code as one path of unit squares; the card's CSS paints it, so the colours stay tokens */
function QrCode({ text, spent }: { text: string; spent: boolean }) {
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
      className={cx("pair-qr", spent && "pair-qr-spent")}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing code"
    >
      <path d={d} />
    </svg>
  );
}

/** Seconds left on a code, ticking. The daemon gives a duration, so the clock here is this page's
 * own and may disagree with the daemon's by as long as the request took. */
function useSecondsLeft(mint: PairMint | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!mint) return;
    const until = performance.now() + mint.ms;
    const tick = () => setLeft(Math.max(0, Math.ceil((until - performance.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [mint]);
  return left;
}

/** how often the card asks again while it waits for a scan: turning Tailscale on at the phone is
 * the thing the person does next, and the line should follow it */
const PHONES_EVERY_MS = 3000;

/** For a tailnet name, the phones Tailscale lists and whether one is connected; undefined until
 * the first answer, and for any other name. */
function useTailnetPhones(host: string | null, waiting: boolean): TailnetPhone[] | null | undefined {
  const [phones, setPhones] = useState<TailnetPhone[] | null>();
  const tailnet = host !== null && isTailnetName(host);
  useEffect(() => {
    if (!tailnet || !waiting) return;
    let live = true;
    const ask = () => void pairPhones().then((p) => live && setPhones(p));
    ask();
    const id = setInterval(ask, PHONES_EVERY_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [tailnet, waiting]);
  return tailnet ? phones : undefined;
}

/** "open on your phone": a one-time code as a QR. The phone's camera opens this machine's public
 * name with the code, the page there trades it for the token, and the phone is sent on to add the
 * machine to toyon.cloud. A redeem anywhere shows here as the daemon's `paired` frame. */
export function PairCard() {
  const dispatch = useDispatch();
  const host = useStore((s) => s.remote?.host ?? null);
  const pairings = useStore((s) => s.pairings);
  const [mint, setMint] = useState<PairMint | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // a pairing counts only when it comes after the code on screen was made
  const pairingsAtMint = useRef(pairings);
  const left = useSecondsLeft(mint);

  useOnChange([round], () => {
    let live = true;
    setMint(null);
    setRefused(null);
    void mintPair().then((r) => {
      if (!live) return;
      pairingsAtMint.current = pairings;
      if (typeof r === "string") setRefused(r);
      else setMint(r);
    });
    return () => {
      live = false;
    };
  });

  const paired = mint !== null && pairings > pairingsAtMint.current;
  const spent = mint !== null && left === 0;
  const close = () => dispatch({ a: "close" });
  const phones = useTailnetPhones(host, !paired && !refused);
  const note = phones === undefined ? null : tailnetLine(phones);

  return (
    <Overlay bare boxClass="pair-stack" onClose={close}>
      <div className="pair-card">
        <div className="pair-title">Open on your phone</div>
        {paired ? (
          <p className="pair-line">Paired. Your phone lists this machine on toyon.cloud now.</p>
        ) : refused ? (
          <p className="pair-line">{refused}</p>
        ) : (
          <>
            <div className="pair-frame">{mint && <QrCode text={mint.url} spent={spent} />}</div>
            {host && <div className="hint pair-host">{host}</div>}
            <p className="pair-line">
              {!mint ? (
                "Making a code."
              ) : spent ? (
                "This code has expired."
              ) : (
                <>
                  Scan with your phone's camera. The code works once; <span className="pair-left">{left}</span> seconds
                  left.
                </>
              )}
            </p>
            {note && <p className={cx("pair-note", note.ok && "hint")}>{note.text}</p>}
          </>
        )}
        <div className="pair-actions">
          {(spent || refused) && !paired && (
            <Button variant="outline" onClick={() => setRound((n) => n + 1)}>
              new code
            </Button>
          )}
          <Button tone="quiet" onClick={close}>
            done
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
