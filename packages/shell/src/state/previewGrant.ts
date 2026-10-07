// A preview on another machine, opened from this page: its frame's first request carries a
// one-time code in the address, which that machine trades for the cookie its own shell would
// have set (core/remote.ts there). The machine that served this page needs none of this: its
// bootstrap set the cookie before the first frame painted. Nor does a machine with no public
// name (a second daemon on this box): its previews answer loopback with no gate at all.

import { PREVIEW_GRANT_PARAM } from "@toyon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { mintPreviewGrant } from "../ws.ts";
import type { Machine } from "./machine.ts";

/** `url` with a grant code in its query */
export const withGrant = (url: string, code: string) =>
  `${url}${url.includes("?") ? "&" : "?"}${PREVIEW_GRANT_PARAM}=${encodeURIComponent(code)}`;

/** whether a machine's previews take a code from this page: another machine's, reached by its
 * public name. Read where the machine's `remote` is already selected from its store. */
export const previewsGated = (machine: Machine, remote: unknown): boolean => !machine.serving && remote !== null;

/** how long after a machine did not answer an ask for a code before it is asked again */
const RETRY_MS = 3000;

/** The addresses a set of frames open at. Ungated, each is the address as given; gated, each
 * carries a fresh code, minted when the frame appears and again on `renew`, since a code is spent
 * by the first request that carries it. A frame whose code has not landed yet has no address, and
 * is not mounted until it does; a machine that did not answer the ask is asked again a few seconds
 * on, for as long as the frame is still wanted. */
export function useGrantedUrls(
  machine: Machine,
  wanted: readonly { id: string; url: string }[],
  gated: boolean,
): { urlOf(id: string): string | null; renew(id: string): void } {
  const [granted, setGranted] = useState<Map<string, { url: string; src: string }>>(() => new Map());
  // asks in flight, so a render between the ask and the answer does not ask again
  const asking = useRef(new Set<string>());
  // what is wanted now, for an answer or a retry that lands after the list moved on
  const wantedNow = useRef(wanted);
  wantedNow.current = wanted;
  const retries = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mint = useCallback(
    (id: string, url: string) => {
      if (asking.current.has(id)) return;
      asking.current.add(id);
      void mintPreviewGrant(machine.sock.urls).then((g) => {
        asking.current.delete(id);
        const still = wantedNow.current.some((w) => w.id === id && w.url === url);
        if (!still) return;
        if (!g) {
          retries.current.set(
            id,
            setTimeout(() => {
              retries.current.delete(id);
              if (wantedNow.current.some((w) => w.id === id && w.url === url)) mint(id, url);
            }, RETRY_MS),
          );
          return;
        }
        setGranted((m) => new Map(m).set(id, { url, src: withGrant(url, g.code) }));
      });
    },
    [machine],
  );
  // a retry pending when the frames go, or the page does, is dropped with them
  useEffect(() => {
    const pending = retries.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);
  useEffect(() => {
    if (!gated) return;
    for (const w of wanted) if (granted.get(w.id)?.url !== w.url) mint(w.id, w.url);
    // a frame that went takes its address with it, so a frame of the same id later starts fresh
    const ids = new Set(wanted.map((w) => w.id));
    if ([...granted.keys()].some((id) => !ids.has(id))) {
      setGranted((m) => new Map([...m].filter(([id]) => ids.has(id))));
    }
  }, [gated, wanted, granted, mint]);
  return {
    urlOf: (id) => (gated ? (granted.get(id)?.src ?? null) : (wanted.find((w) => w.id === id)?.url ?? null)),
    renew: (id) => {
      const w = wanted.find((x) => x.id === id);
      if (!w || !gated) return;
      setGranted((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
      mint(id, w.url);
    },
  };
}

/** one frame's address, by the same rule; null `url` wants no frame yet, and a code minted earlier
 * for this frame is let go, so the one asked for when it is wanted again is fresh */
export function useGrantedUrl(machine: Machine, url: string | null, gated: boolean): string | null {
  const wanted = useRef<{ id: string; url: string }[]>([]);
  if (url === null) {
    if (wanted.current.length > 0) wanted.current = [];
  } else if (wanted.current[0]?.url !== url) wanted.current = [{ id: "one", url }];
  return useGrantedUrls(machine, wanted.current, gated).urlOf("one");
}

/** Open a preview in the browser's own tab. The tab opens in the click, since a browser lets a
 * page open one only while a press is being handled, and its address is set once the code has
 * landed; an ungated address needs no code. */
export function openPreview(machine: Machine, url: string, gated: boolean) {
  if (!gated) {
    window.open(url, "_blank");
    return;
  }
  const tab = window.open("", "_blank");
  void mintPreviewGrant(machine.sock.urls).then((g) => {
    const target = g ? withGrant(url, g.code) : url;
    if (tab) tab.location.href = target;
    else window.open(target, "_blank");
  });
}
