// The editor formats nothing. The one formatter Monaco carries for the languages this pane opens
// is the TypeScript language service's, and it reads no config of the project's: on a file kept by
// biome or prettier it pulls every multi-line ternary branch two spaces left, and the save that
// follows leaves the file failing the project's own check. So nothing runs it. Typing and pasting
// do not, and Format Document and Format Selection are gone with it: Monaco offers those two, in
// its menu and on their keys, only for a language that has a formatter registered.

import type * as monaco from "monaco-editor";

/** editor options: a keystroke or a paste changes the text by what was typed or pasted, no more */
export const NO_FORMAT = {
  formatOnType: false,
  formatOnPaste: false,
  autoIndentOnPaste: false,
} as const satisfies monaco.editor.IEditorOptions;

/** the features a TypeScript mode registers, less its two formatters */
export function withoutFormatters(mode: monaco.typescript.ModeConfiguration): monaco.typescript.ModeConfiguration {
  return { ...mode, documentRangeFormattingEdits: false, onTypeFormattingEdits: false };
}
