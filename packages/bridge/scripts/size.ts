// The bridge is injected into every preview page: keep it small. A shared import that drags in
// zod or the theme data would show up here first.
const LIMIT = 8 * 1024;
const size = Bun.file(new URL("../dist/bridge.js", import.meta.url)).size;
if (size > LIMIT) {
  console.error(`bridge.js is ${size} bytes; limit ${LIMIT}. Import narrower subpaths from @toyon/shared.`);
  process.exit(1);
}
console.log(`bridge.js ${(size / 1024).toFixed(2)} KB (limit ${LIMIT / 1024} KB)`);
