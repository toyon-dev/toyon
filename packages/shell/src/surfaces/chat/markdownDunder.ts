import type { TokenizerAndRendererExtension } from "marked";

// a Python dunder name written bare, `__init__.py` or `"__main__"`, is valid strong emphasis to
// CommonMark: the underscores vanish and `init` comes out bold. `__bold__` is still emphasis, so
// this fires only on the shapes that are unmistakably a name: a lowercase identifier between the
// runs, closed by a file extension or attribute, a call, or a quote; a dotted chain of them is
// taken whole, since the tokenizer sees nothing behind it and the last link may end at a space.
const NAME = "__[a-z][a-z0-9_]*[a-z0-9]__";
const DUNDER = new RegExp(`^(?:${NAME}\\.)+${NAME}|^${NAME}(?=\\.\\w|\\(|["'])`);

export const dunder: TokenizerAndRendererExtension = {
  name: "dunder",
  level: "inline",
  start: (src) => src.indexOf("__"),
  tokenizer(src) {
    const m = DUNDER.exec(src);
    if (!m) return undefined;
    return { type: "dunder", raw: m[0], text: m[0] };
  },
  // nothing the pattern admits needs escaping
  renderer: (token) => token.text as string,
};
