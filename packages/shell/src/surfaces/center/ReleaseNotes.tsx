import { useEffect, useState } from "react";
import { notesLead } from "../../app/releaseNotes.ts";
import { useStore, useUrls } from "../../state/context.tsx";
import { Document } from "../../ui/Document.tsx";
import { View } from "../../ui/View.tsx";
import { releaseNotes } from "../../ws.ts";
import { useMarkdown } from "../chat/markdown.ts";

/** The release notes, in the centre: every release this Toyon knows of, newest first, read off
 * the daemon rather than fetched from anywhere else, so they are there behind a company mirror
 * and in the installed app without a browser window opening. The changelog is a document read
 * for itself, so it reads the way a markdown file does in the editor pane: the file whole, from
 * its own title, with the outline down the left. Nothing of the shell's sits over it; Escape and
 * choosing a row leave it, as they leave a removed worktree's page. While the daemon is asked, or
 * when it has none, a view says so in the machine's voice. */
export function ReleaseNotes() {
  const urls = useUrls();
  const version = useStore((s) => s.version);
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
  const html = useMarkdown(text ?? "");
  if (!text) {
    return (
      <View wide>
        <p className="status-line">
          {text === undefined ? (
            <span className="live-text">{notesLead(version, "reading")}</span>
          ) : (
            notesLead(version, "missing")
          )}
        </p>
      </View>
    );
  }
  return (
    <div className="notes-page">
      <Document html={html} />
    </div>
  );
}
