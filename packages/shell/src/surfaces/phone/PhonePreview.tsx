import { type OwnedWorktree, parseBridgeMsg } from "@toyon/shared";
import { useEffect, useRef } from "react";
import { frameWalks } from "../../app/phoneHistory.ts";
import { useMachine } from "../../state/context.tsx";
import { useGrantedUrl } from "../../state/previewGrant.ts";
import { previewUp } from "../../state/store.ts";
import { View } from "../../ui/View.tsx";
import { stateLabel } from "../util.ts";

/**
 * The worktree's running app, in place, on a phone.
 *
 * One frame at the same proxied URL the desk's frames use. The app runs on the daemon's machine,
 * and Vite's HMR runs inside the page, so the agent's edits arrive live with nothing from this side:
 * no frame stack, no visits. Of what the bridge the daemon injects posts to its parent, one thing
 * is heard: a history traversal that moved the frame, which the phone's way back has to know about,
 * since the frame's entries are the tab's and a swipe can be spent on them while this frame is
 * hidden. The rest, the route bar's tracking, is what the phone gives up, for a bar it does not have.
 *
 * Kept mounted across the tabs of one worktree and hidden rather than unmounted (PhoneFrame), so
 * switching to the chat and back does not load the app again; unmounted with the worktree, so
 * leaving it does not keep its app running in the phone's tab.
 *
 * Until the app is up there is nothing to frame: the line names the state instead, and looking at
 * the worktree is what wakes it (App's `view` effect runs on the phone too), so the line resolves
 * into the frame on its own.
 */
export function PhonePreview({
  gated,
  active,
  url,
  hidden,
}: {
  /** the frame's first request carries a one-time code (previewGrant.ts) */
  gated: boolean;
  active: OwnedWorktree;
  url: string;
  hidden: boolean;
}) {
  // On another machine the frame's first request carries a one-time code; until it is minted
  // there is no address to open, and the line below stands a moment longer. The code is asked for
  // only once the app is up, since it is good for a minute and spent by the request that carries
  // it: minted while the dev server was still installing, it would be dead by the time the frame
  // first loaded, and the refusal page would reload that dead code forever.
  const up = previewUp(active);
  const src = useGrantedUrl(useMachine(), up ? url : null, gated);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!src) return;
    // only this frame, at the proxy origin it was given: the shell's own window hears every
    // frame's postMessage, and a page is not trusted to say which it is
    const origin = new URL(src, location.href).origin;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow || e.origin !== origin) return;
      if (!(e.data as { __toyon?: boolean } | null)?.__toyon) return;
      const d = parseBridgeMsg(e.data);
      if (d?.type === "traversed") frameWalks.tell({ dir: d.dir ?? null });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [src]);
  return (
    <div className="phone-preview" hidden={hidden}>
      {up && src ? (
        <iframe ref={frameRef} className="phone-preview-frame" src={src} title={active.worktree.title} />
      ) : (
        <View wide>
          <p className="status-line">{stateLabel(active)}</p>
        </View>
      )}
    </div>
  );
}
