import { useEffect, useMemo, useState } from "react";
import { notesLead } from "../../app/releaseNotes.ts";
import { useDispatch, useStore, useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { View } from "../../ui/View.tsx";
import { releaseNotes } from "../../ws.ts";
import { renderMarkdown } from "../chat/markdown.ts";

/** The release notes, in the centre: every release this Toyon knows of, newest first, read off
 * the daemon rather than fetched from anywhere else, so they are there behind a company mirror
 * and in the installed app without a browser window opening. A view of Toyon's own, the machine's
 * parts: a line saying which version this browser last ran, since that is where the reading
 * starts, then the document. Escape and the button close it; so does choosing a row. */
export function ReleaseNotes() {
  const urls = useUrls();
  const dispatch = useDispatch();
  const version = useStore((s) => s.version);
  const ranBefore = useStore((s) => s.ranBefore);
  // undefined while the daemon is asked, null when nothing could be read
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void releaseNotes(urls).then((t) => {
      if (live) setText(t);
    });
    return () => {
      live = false;
    };
  }, [urls]);
  // from the first release heading: the file's own title and intro line repeat the lead above
  const html = useMemo(() => (text ? renderMarkdown(text.slice(Math.max(0, text.search(/^## /m)))) : ""), [text]);
  const state = text === undefined ? "reading" : text === null ? "missing" : "ready";
  return (
    <View wide>
      <p className="status-line">{notesLead(ranBefore, version, state)}</p>
      <div className="status-actions">
        <Button variant="outline" size="lg" onClick={() => dispatch({ a: "close-release-notes" })}>
          close
        </Button>
      </div>
      {html && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks
        <div
          className="md notes-md"
          onClick={(e) => {
            // a relative link in the notes must not navigate the shell; http links open a tab
            const link = (e.target as Element).closest("a");
            if (link && link.target !== "_blank") e.preventDefault();
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </View>
  );
}
