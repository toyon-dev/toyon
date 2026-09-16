// Files the editor pane shows without the text editor: the daemon serves the bytes at /files and
// the browser draws them. Text is never here, whatever it renders as: markdown and SVG open in the
// editor, and a rendered reading of them is a view of the text, not a viewer of the bytes.

/** what draws the file; a new kind is a row here and a component in the pane's viewer map */
export type FileViewer = "image";

const VIEWERS: [RegExp, FileViewer][] = [[/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i, "image"]];

/** the viewer for a path, or null for a file the text editor opens (or refuses) */
export function viewerOf(path: string): FileViewer | null {
  return VIEWERS.find(([re]) => re.test(path))?.[1] ?? null;
}

/** a file the editor pane can also show rendered, beside its text and its diff */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
