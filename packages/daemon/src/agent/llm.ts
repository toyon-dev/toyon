// One-shot Haiku helpers: task naming and batch planning. No session, no tools.

import { query } from "@anthropic-ai/claude-agent-sdk";

/** One-shot Haiku call: name a task in 2-4 kebab-case words. Returns null on any failure. */
export async function quickName(taskPrompt: string, cwd: string): Promise<string | null> {
  try {
    const stream = query({
      prompt: `Name this coding task in 2 to 4 lowercase kebab-case words (like "sticky-header" or "dark-mode-toggle"). Reply with ONLY the name, nothing else.\n\nTask: ${taskPrompt.slice(0, 500)}`,
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        systemPrompt: "You are a naming assistant. Reply with only the requested name.",
      },
    });
    for await (const msg of stream) {
      const m = msg as Record<string, any>;
      if (m.type === "result" && m.subtype === "success") {
        const name = String(m.result ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30);
        if (name && name.length >= 3) return name;
      }
    }
  } catch {}
  return null;
}

/** One-shot planner: split a high-level request into independent tasks (1-5). Null on failure. */
export async function planTasks(request: string, cwd: string): Promise<string[] | null> {
  try {
    const stream = query({
      prompt: [
        "Split this request into independent coding tasks that could each be done in a separate git branch by a separate engineer.",
        "Reply with ONLY a JSON array of task description strings (1 to 5 items), nothing else.",
        "If the request is really one task, reply with a single-item array.",
        `Request: ${request.slice(0, 2000)}`,
      ].join("\n"),
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        systemPrompt: "You are a task-planning assistant. Reply with only the requested JSON.",
      },
    });
    for await (const msg of stream) {
      const m = msg as Record<string, any>;
      if (m.type === "result" && m.subtype === "success") {
        const text = String(m.result ?? "");
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start === -1 || end <= start) return null;
        const arr = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(arr)) return null;
        const tasks = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 5);
        return tasks.length > 0 ? tasks : null;
      }
    }
  } catch {}
  return null;
}
