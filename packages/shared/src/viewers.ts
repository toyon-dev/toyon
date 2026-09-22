// Files the editor pane shows without the text editor: the daemon serves the bytes at /files and
// the browser draws them. Text is never a viewer, whatever it renders as: markdown, html and SVG
// open in the editor, and a rendered reading of them is a view of the text, not a viewer of the
// bytes. The route also serves what a rendered page reaches for beside itself.

/** what draws the file; a new kind is a row here and a component in the pane's viewer map */
export type FileViewer = "image";

const VIEWERS: [RegExp, FileViewer][] = [[/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i, "image"]];

/** the viewer for a path, or null for a file the text editor opens (or refuses) */
export function viewerOf(path: string): FileViewer | null {
  return VIEWERS.find(([re]) => re.test(path))?.[1] ?? null;
}

/** how the editor pane draws a text file rendered, beside its text and its diff: markdown through
 * the shell's own renderer, an html page as itself in a frame of its own */
export type Rendering = "markdown" | "html";

const RENDERINGS: [RegExp, Rendering][] = [
  [/\.(md|markdown)$/i, "markdown"],
  [/\.html?$/i, "html"],
];

/** the rendering a path has, or null for a file only read as text */
export function renderedAs(path: string): Rendering | null {
  return RENDERINGS.find(([re]) => re.test(path))?.[1] ?? null;
}

const PAGE_ASSETS = /\.(css|svg|woff2?|ttf|otf|mp4|webm|mp3|ogg|wav)$/i;

/** a file the daemon serves at /files for a rendered page beside it to draw: a stylesheet, a font, a
 * clip. An image is served already, for its own viewer; a script is not, since none runs in the
 * frame the page is read in. */
export function isPageAsset(path: string): boolean {
  return PAGE_ASSETS.test(path);
}
