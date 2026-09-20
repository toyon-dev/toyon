import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { table } from "./markdownTable.ts";

const md = new Marked({ renderer: { table } });

describe("a markdown table", () => {
  test("with nothing in its header row renders without a head", () => {
    const html = md.parse("| | |\n|---|---|\n| marked landed | 68 |\n| on disk | 39M |\n", { async: false });
    expect(html).not.toContain("<thead>");
    expect(html).not.toContain("<th>");
    expect(html).toContain("<tbody><tr>\n<td>marked landed</td>\n<td>68</td>\n</tr>");
    expect(html).toContain("<td>39M</td>");
  });

  test("with a header keeps it", () => {
    const html = md.parse("| what | count |\n|---|---|\n| landed | 68 |\n", { async: false });
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>what</th>");
    expect(html).toContain("<td>68</td>");
  });

  test("with one named header cell keeps the head", () => {
    const html = md.parse("| | count |\n|---|---|\n| landed | 68 |\n", { async: false });
    expect(html).toContain("<th>count</th>");
  });

  test("with an empty header and column alignment keeps the alignment on the cells", () => {
    const html = md.parse("| | |\n|:--|--:|\n| landed | 68 |\n", { async: false });
    expect(html).not.toContain("<thead>");
    expect(html).toContain('<td align="right">68</td>');
  });
});
