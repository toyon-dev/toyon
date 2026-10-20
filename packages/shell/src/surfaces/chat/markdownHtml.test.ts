import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { htmlAsText } from "./markdownHtml.ts";

const md = new Marked({ renderer: { html: htmlAsText } });

describe("a tag written in prose", () => {
  test("is drawn as text, and the reply goes on after it", () => {
    const html = md.parse('a chip that reads "the transcript of <title> is at <path>".\n\nnext paragraph\n', {
      async: false,
    });
    expect(html).not.toContain("<title>");
    expect(html).not.toContain("<path>");
    expect(html).toContain("the transcript of &lt;title&gt; is at &lt;path&gt;");
    expect(html).toContain("<p>next paragraph</p>");
  });

  test("on a line of its own is drawn as text too", () => {
    const html = md.parse("<style>\nnot a stylesheet\n", { async: false });
    expect(html).not.toContain("<style>");
    expect(html).toContain("&lt;style&gt;");
  });

  test("leaves a fenced block to the code renderer", () => {
    const html = md.parse("```html\n<title>x</title>\n```\n", { async: false });
    expect(html).toContain("<pre><code");
    expect(html).toContain("&lt;title&gt;x&lt;/title&gt;");
  });
});
