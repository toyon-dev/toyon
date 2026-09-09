// The bridge is injected into every preview page, so it runs inside someone else's app on every
// load. This is a tripwire, not a budget: it should stay in the small-script class, and a jump
// means something landed here that belongs in the shell.
//
// It does not guard against a wide @toyon/shared import. That threat is handled by
// `sideEffects: false` plus tree-shaking; importing the package root measures the same bytes as
// the chords subpath. Keep the narrow subpaths anyway, for intent.
//
// If this ever approaches the limit, the split to reach for is a second chunk behind a dynamic
// import: roughly two thirds of the bundle (picker, overlay, fiber mapping, the highlight modes)
// only ever runs after the shell posts a command.
const LIMIT = 16 * 1024;
const size = Bun.file(new URL("../dist/bridge.js", import.meta.url)).size;
if (size > LIMIT) {
  console.error(`bridge.js is ${size} bytes; limit ${LIMIT}. Move it to the shell, or split the bundle.`);
  process.exit(1);
}
console.log(`bridge.js ${(size / 1024).toFixed(2)} KB (limit ${LIMIT / 1024} KB)`);
