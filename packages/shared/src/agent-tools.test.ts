import { describe, expect, test } from "bun:test";
import { mcpTool } from "./agent-tools.ts";

describe("mcpTool", () => {
  test("reads the server and the tool's words out of either spelling", () => {
    expect(mcpTool("mcp__Amplitude__search_amp_entities")).toEqual({
      server: "Amplitude",
      tool: "search amp entities",
    });
    expect(mcpTool("Amplitude/search-amp-entities")).toEqual({ server: "Amplitude", tool: "search amp entities" });
  });

  test("a server with one underscore of its own keeps it; the split is at the first double", () => {
    expect(mcpTool("mcp__my_crm__get__contact")).toEqual({ server: "my_crm", tool: "get contact" });
  });

  test("anything else is not an MCP tool", () => {
    for (const name of ["Bash", "", "mcp__", "mcp__x", "mcp__x__", "src/a.ts", "a/b/c"])
      expect(mcpTool(name)).toBeNull();
  });
});
