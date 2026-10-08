// One chip for what waits in a box, by kind: a picture, a file, or pasted text, drawn the same
// way wherever the box is (the composer's field, an ask card). An element pick is the composer's
// own, since it lights the preview up on hover and opens the source, so the composer draws that one.

import { useUrls } from "../../state/context.tsx";
import type { PendingAttachment } from "../../state/store.ts";
import { FileChip } from "./FileChip.tsx";
import { ImageChip } from "./ImageChip.tsx";
import { PasteChip } from "./PasteChip.tsx";

export type DraftItem = Exclude<PendingAttachment, { kind: "pick" }>;

export function DraftChip({ item, n, onRemove }: { item: DraftItem; n: number; onRemove: () => void }) {
  const urls = useUrls();
  if (item.kind === "image")
    return (
      <ImageChip
        src={item.local ?? urls.upload(item.upload)}
        n={n}
        name={item.name}
        width={item.width}
        height={item.height}
        bytes={item.bytes}
        uploading={item.uploading}
        onRemove={onRemove}
      />
    );
  if (item.kind === "file")
    return (
      <FileChip
        name={item.name}
        bytes={item.bytes}
        href={item.text && item.upload ? urls.upload(item.upload) : undefined}
        uploading={item.uploading}
        onRemove={onRemove}
      />
    );
  return (
    <PasteChip
      n={n}
      name={item.name}
      source={item.source}
      lines={item.lines}
      chars={item.chars}
      preview={item.preview}
      text={item.text}
      onRemove={onRemove}
    />
  );
}
