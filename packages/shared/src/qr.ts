// A QR code as a grid of modules, for the CLI to print in block characters and the shell to draw as
// SVG. Its own subpath export, never through the package index, so nothing that only needs types or
// the protocol carries the encoder.

import qrcode from "qrcode-generator";

/** The modules for `text`, row by row, true where dark. No quiet zone: each caller adds the margin
 * its medium needs. Level M, and the smallest version that fits, since a phone camera reads a
 * coarse code from further away. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** The code in half blocks, one line of text per two rows of modules, with a quiet zone of `margin`
 * modules. Dark modules are spaces and light ones are blocks, so it reads on a dark terminal, the
 * common case; the quiet zone is light too, which is what a camera needs to find the corners. */
export function qrText(modules: boolean[][], margin = 2): string {
  const n = modules.length + margin * 2;
  const light = (r: number, c: number) => {
    const row = modules[r - margin];
    const v = row?.[c - margin];
    return v === undefined ? true : !v;
  };
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const top = light(r, c);
      const bottom = r + 1 < n ? light(r + 1, c) : true;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
