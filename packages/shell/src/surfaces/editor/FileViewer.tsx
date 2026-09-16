import type { FileViewer as Kind } from "@toyon/shared";

/** the editor body for a file the browser draws rather than the text editor: one component per
 * kind, and a new kind is a row in the shared table and an entry here */
const VIEWERS: Record<Kind, (p: { src: string; path: string }) => React.JSX.Element> = {
  image: ({ src, path }) => (
    <div className="editor-image">
      <img src={src} alt={path} />
    </div>
  ),
};

export function FileViewer({ kind, src, path }: { kind: Kind; src: string; path: string }) {
  const View = VIEWERS[kind];
  return <View src={src} path={path} />;
}
