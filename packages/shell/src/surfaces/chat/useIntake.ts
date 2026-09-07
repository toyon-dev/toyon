import {
  IMAGES_PER_MESSAGE,
  isLongPaste,
  PASTE_MAX_CHARS,
  PASTES_PER_MESSAGE,
  pasteSummary,
  stripAnsi,
} from "@toyon/shared";
import { type DragEvent, useState } from "react";
import { useDispatch, useStore } from "../../state/context.tsx";
import { imageFiles, otherFiles, prepareImage, readText } from "./images.ts";

/** paste/drop handlers that turn what the OS hands over into pending chips on the active
 * worktree's composer. Shared by the composer (paste, drop) and the whole chat panel (drop):
 * dropping a screenshot or a log file anywhere on the chat should attach it. */
export function useIntake(worktreeId: string | null) {
  const dispatch = useDispatch();
  const pending = useStore((s) => (worktreeId ? (s.local[worktreeId]?.images.length ?? 0) : 0));
  const pendingPastes = useStore((s) => (worktreeId ? (s.local[worktreeId]?.pastes.length ?? 0) : 0));
  const [over, setOver] = useState(false);

  const addFiles = async (files: File[]) => {
    if (!worktreeId || files.length === 0) return;
    const room = IMAGES_PER_MESSAGE - pending;
    if (room <= 0)
      return dispatch({
        a: "toast",
        toast: { ok: false, message: `at most ${IMAGES_PER_MESSAGE} images per message` },
      });
    const results = await Promise.allSettled(files.slice(0, room).map(prepareImage));
    const images = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r) => r.status === "rejected");
    if (images.length) dispatch({ a: "add-images", id: worktreeId, images });
    if (failed)
      dispatch({
        a: "toast",
        toast: { ok: false, message: String((failed as PromiseRejectedResult).reason?.message ?? failed.reason) },
      });
    else if (files.length > room)
      dispatch({
        a: "toast",
        toast: {
          ok: false,
          message: `kept ${room} of ${files.length}: at most ${IMAGES_PER_MESSAGE} images per message`,
        },
      });
  };

  const toast = (message: string) => dispatch({ a: "toast", toast: { ok: false, message } });

  /** text long enough to bury the textarea becomes a chip instead. There is no file to point at,
   * so unlike an @path this has to travel with the message. */
  const addPaste = (raw: string, name?: string) => {
    if (!worktreeId) return;
    const text = stripAnsi(raw);
    if (pendingPastes >= PASTES_PER_MESSAGE) return toast(`at most ${PASTES_PER_MESSAGE} pastes per message`);
    if (text.length > PASTE_MAX_CHARS)
      // neither truncating nor dropping it silently: say what to do with something this big
      return toast(`that paste is too large; save it in the worktree and reference it with @path`);
    dispatch({
      a: "add-paste",
      id: worktreeId,
      paste: { key: crypto.randomUUID(), text, name, ...pasteSummary(text) },
    });
  };

  /** a dropped or pasted file that is not an image: attach it as text, or say why not */
  const addTextFiles = async (files: File[]) => {
    for (const f of files.slice(0, PASTES_PER_MESSAGE)) {
      const text = await readText(f);
      if (text === null) toast(`${f.name}: not a text file`);
      else addPaste(text, f.name);
    }
  };

  const hasImages = (e: DragEvent) =>
    Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file" && i.type.startsWith("image/"));

  return {
    over,
    addFiles,
    addPaste,
    /** In precedence order: an image wins (copying a spreadsheet cell offers both an image and a
     * text flavour), then a non-image file becomes a paste chip named after it, then text long
     * enough to bury the textarea. Anything shorter is typed in as usual. */
    onPaste: (e: React.ClipboardEvent) => {
      const files = imageFiles(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        return void addFiles(files);
      }
      const dropped = otherFiles(e.clipboardData);
      if (dropped.length > 0) {
        e.preventDefault();
        return void addTextFiles(dropped);
      }
      // text/plain, never text/html: an editor or a web page offers both, and the markup is style
      // noise the model does not want
      const text = e.clipboardData.getData("text/plain");
      if (!isLongPaste(text)) return;
      e.preventDefault();
      addPaste(text);
    },
    onDragOver: (e: DragEvent) => {
      if (!worktreeId || !hasImages(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      // leaving for a child element fires leave too; only the real exit clears the highlight
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      setOver(false);
      const files = imageFiles(e.dataTransfer);
      if (files.length > 0) {
        e.preventDefault();
        return void addFiles(files);
      }
      const rest = otherFiles(e.dataTransfer);
      if (rest.length === 0) return;
      e.preventDefault();
      void addTextFiles(rest);
    },
  };
}
