// A source file the CLI carries as text and compiles on the machine (`import x from "./y.m" with
// { type: "text" }`): bun reads it as a string in the source tree and inlines it into the bundle.
declare module "*.m" {
  const source: string;
  export default source;
}
