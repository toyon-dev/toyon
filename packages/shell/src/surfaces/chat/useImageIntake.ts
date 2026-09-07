import { IMAGES_PER_MESSAGE } from "@toyon/shared";
import { type DragEvent, useState } from "react";
import { useDispatch, useStore } from "../../state/context.tsx";
import { imageFiles, prepareImage } from "./images.ts";

/** paste/drop handlers that turn image files into pending chips on the active worktree's
 * composer. Shared by the composer (paste, drop) and the whole chat panel (drop): dropping a
 * screenshot anywhere on the chat should attach it. */
export function useImageIntake(worktreeId: string | null) {
  const dispatch = useDispatch();
  const pending = useStore((s) => (worktreeId ? (s.local[worktreeId]?.images.length ?? 0) : 0));
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

  const hasImages = (e: DragEvent) =>
    Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file" && i.type.startsWith("image/"));

  return {
    over,
    addFiles,
    /** the textarea's paste: images become chips, text pastes as usual */
    onPaste: (e: React.ClipboardEvent) => {
      const files = imageFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
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
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    },
  };
}
