import { describe, expect, test } from "bun:test";
import { queryTerms } from "./query.ts";

describe("queryTerms", () => {
  test("lower-cased words, each once, whitespace ignored", () => {
    expect(queryTerms("  Footer\nlink footer ")).toEqual(["footer", "link"]);
    expect(queryTerms("")).toEqual([]);
  });
  test("a quoted run is one term with its spaces flattened, beside the bare words", () => {
    expect(queryTerms('tidy "the  Footer\nlink" now')).toEqual(["tidy", "the footer link", "now"]);
  });
  test("a quote left open runs to the end, and empty quotes say nothing", () => {
    expect(queryTerms('"footer link')).toEqual(["footer link"]);
    expect(queryTerms('"" footer')).toEqual(["footer"]);
    expect(queryTerms('"')).toEqual([]);
  });
  test("curly quotes count", () => {
    expect(queryTerms("“footer link” now")).toEqual(["footer link", "now"]);
  });
});
