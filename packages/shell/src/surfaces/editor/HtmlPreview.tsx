import type { FrameSource } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { useUrls } from "../../state/context.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { mintFrame } from "../../ws.ts";

/** where the preview would serve a page: its path under the worktree, taken as the served root,
 * which is the best guess the shell can make without reading the run command; `index.html` is its
 * directory. A server rooted elsewhere answers with its own not-found, in the preview, where it is
 * read for what it is. */
export function servedPath(path: string): string {
  const rel = path.replace(/(^|\/)index\.html?$/i, "$1");
  return `/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** how long before a ticket runs out the next one is asked for, and how long after a daemon that
 * did not answer before it is asked again */
const RENEW_MS = 60_000;
const RETRY_MS = 3000;

/** what one source is, as a string, so a render that rebuilds the object asks for nothing new */
const sourceKey = (s: FrameSource) =>
  s.kind === "worktree" ? `w:${s.worktreeId}:${s.path}` : s.kind === "loose" ? `g:${s.grantId}` : `t:${s.text}`;

/** An html file read rendered: the saved file, drawn in a frame on the daemon's frame origin, so
 * an agent writing it is seen as it writes. Its scripts run, since a scratch page often draws
 * itself with one, but on an origin that holds no token and no shell, under a policy the daemon
 * sends: the page can reach neither the shell around it nor anything a script could carry off. A
 * page that needs its own server is what the preview is for. `version` is the bytes on disk; a
 * new one asks for the page again. */
export function HtmlPreview({
  source,
  path,
  version,
  openSeq,
  focus,
}: {
  source: FrameSource;
  path: string;
  version: string | null | undefined;
  openSeq: number;
  focus: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // nothing in a sandboxed frame hands the keyboard back, so the seat takes it, as a picture's
  // does: Escape then finds the pane
  useOnChange([openSeq], () => {
    if (focus) ref.current?.focus();
  });
  const urls = useUrls();
  const [url, setUrl] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const latest = useRef(source);
  latest.current = source;
  const key = sourceKey(source);
  // the ticket lasts a fixed while and is never extended, so the next one is asked for before it
  // runs out, and a daemon that did not answer is asked again shortly
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the source and the bytes, which is when a new ticket is wanted
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void mintFrame(urls, latest.current).then((m) => {
        if (gone) return;
        if (m === null) {
          timer = setTimeout(ask, RETRY_MS);
          return;
        }
        if (typeof m === "string") {
          setRefused(m);
          setUrl(null);
          return;
        }
        setRefused(null);
        setUrl(m.url);
        timer = setTimeout(ask, Math.max(m.ms - RENEW_MS, RENEW_MS));
      });
    };
    ask();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [urls, key, version]);
  return (
    <div ref={ref} className="editor-viewer" tabIndex={-1}>
      {refused !== null ? (
        <p className="hint">{refused}</p>
      ) : (
        url !== null && (
          <iframe
            className="editor-frame"
            title={path}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={url}
          />
        )
      )}
    </div>
  );
}
