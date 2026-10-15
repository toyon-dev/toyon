import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FullNav } from "../../ui/FullAttachment.tsx";
import { stepIndex } from "../../ui/fullNav.ts";

/**
 * The attachments of one message, as the set the full view walks: a sent message's rows, a queued
 * one's, the composer's or a card's draft chips. Opened from a chip, the view steps to the chip's
 * neighbours on the arrow keys and says where it stands in the list, and the set is the list the
 * eye sees above the text, never the whole transcript: what else went with this message is one
 * question, and a screenshot a call returned three turns up is another.
 *
 * The set holds which chip is open; each chip still draws its own full view, so what it shows is
 * whatever the chip shows now (a draft's progress, a paste the daemon has since served back). A
 * chip with nothing to open is not a stop, so the count is of what the keys can reach.
 */

type Slot = { id: string; el: () => HTMLElement | null };

/** the chip whose full view is up, and its place among the stops as they stood when it opened */
type Shown = { id: string; at: number; of: number };

type Api = {
  register(slot: Slot): () => void;
  open(id: string): void;
  step(dir: -1 | 1): void;
  close(): void;
};

const Ctx = createContext<{ api: Api; shown: Shown | null } | null>(null);

const FIELD = "input, textarea, [contenteditable]";

/** the stops in the order they stand on the page, which is the order the list shows them */
function ordered(slots: Map<string, Slot>): Slot[] {
  return [...slots.values()]
    .filter((s) => s.el()?.isConnected)
    .sort((a, b) => {
      const x = a.el();
      const y = b.el();
      if (!x || !y || x === y) return 0;
      return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
}

export function AttachmentSet({ children }: { children: ReactNode }) {
  const slots = useRef(new Map<string, Slot>());
  const [shown, setShown] = useState<Shown | null>(null);
  const current = useRef(shown);
  current.current = shown;

  // built once: the chips register against it, and a value that changed with every open would
  // re-register them all, taking the open one off the list as it went
  const api = useMemo<Api>(() => {
    const show = (id: string) => {
      const list = ordered(slots.current);
      const at = list.findIndex((s) => s.id === id);
      setShown(at < 0 ? null : { id, at, of: list.length });
    };
    return {
      register(slot) {
        slots.current.set(slot.id, slot);
        return () => {
          slots.current.delete(slot.id);
          // the row it was open from has gone (a queued message recorded, a draft sent), and its
          // view with it
          if (current.current?.id === slot.id) setShown(null);
        };
      },
      open: show,
      step(dir) {
        const was = current.current;
        if (!was) return;
        const list = ordered(slots.current);
        const at = list.findIndex((s) => s.id === was.id);
        const next = at < 0 ? null : stepIndex(at, list.length, dir);
        const slot = next === null ? undefined : list[next];
        if (slot) show(slot.id);
      },
      close() {
        const was = current.current;
        setShown(null);
        if (!was) return;
        // focus follows to the chip the view ended on, so the keyboard carries on from there and
        // the ring says which one it was. Not out of a field: a click on a chip in the composer
        // leaves the caret in the box in some browsers, and the box is where the typing goes on.
        const active = document.activeElement;
        if (active?.matches(FIELD)) return;
        slots.current.get(was.id)?.el()?.querySelector<HTMLElement>(".chip-link")?.focus({ preventScroll: true });
      },
    };
  }, []);

  const value = useMemo(() => ({ api, shown }), [api, shown]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * A chip's place in the set around it: whether its full view is up, how to put it up or take it
 * down, and the view's way along the list. Outside any set the chip is a set of one: its view
 * opens and closes on its own and the keys have nowhere to go.
 */
export function useAttachmentSlot(
  chip: RefObject<HTMLElement | null>,
  canOpen: boolean,
): { open: boolean; show: () => void; close: () => void; nav: FullNav | undefined } {
  const set = useContext(Ctx);
  const id = useId();
  const [alone, setAlone] = useState(false);
  const api = set?.api;

  useLayoutEffect(() => {
    if (!api || !canOpen) return;
    return api.register({ id, el: () => chip.current });
  }, [api, id, canOpen, chip]);

  if (!api) {
    return { open: alone, show: () => setAlone(true), close: () => setAlone(false), nav: undefined };
  }
  const shown = set?.shown ?? null;
  const open = shown?.id === id;
  return {
    open,
    show: () => api.open(id),
    close: api.close,
    nav: open && shown ? { at: shown.at, of: shown.of, step: api.step } : undefined,
  };
}
