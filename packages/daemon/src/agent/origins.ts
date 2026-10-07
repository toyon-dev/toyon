// Which of an agent's slash commands the person wrote. The agent's list says name, description
// and hint and nothing of where each came from, while its own terminal leads with the person's
// skills and commands and keeps the built-ins for a letter typed. Toyon gets the same cut by
// reading the folders the agent reads them from and matching names: a skill is a folder with a
// SKILL.md, a command is a markdown file, and the slash name is the folder's or the file's. What
// a mod registers from its hook at runtime has no file and stays the agent's.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentCommand, CommandOrigin } from "@toyon/shared";
import { log } from "../core/log.ts";
import type { AgentSpec } from "./registry.ts";

/** one place an agent reads the person's commands from */
export interface CommandFolder {
  origin: CommandOrigin;
  /** `<skills>/<name>/SKILL.md`, the name the folder's unless the file's front matter renames it */
  skills?: string;
  /** `<commands>/**\/<name>.md`; a subfolder is a namespace the terminal shows, not part of the name */
  commands?: string;
}

/** the folders each builtin reads, for this checkout. Claude's plugin folders come from the
 * person's agents.json tuning (`claudeCode.options.plugins`, `type: "local"`): a plugin loaded
 * that way is theirs as much as a skill in the project is. A custom agent names none. */
export function commandFolders(spec: AgentSpec, cwd: string, home = homedir()): CommandFolder[] {
  if (spec.id === "claude") {
    return [
      { origin: "project", skills: join(cwd, ".claude", "skills"), commands: join(cwd, ".claude", "commands") },
      { origin: "user", skills: join(home, ".claude", "skills"), commands: join(home, ".claude", "commands") },
      ...pluginPaths(spec.meta).map(
        (p): CommandFolder => ({ origin: "plugin", skills: join(p, "skills"), commands: join(p, "commands") }),
      ),
    ];
  }
  if (spec.id === "codex") return [{ origin: "user", commands: join(home, ".codex", "prompts") }];
  return [];
}

/** the names found in the folders, each with where it was. Earlier folders win a name, the way
 * the project's skill shadows the user's of the same name in the terminal. */
export function readCommandOrigins(folders: CommandFolder[]): Map<string, CommandOrigin> {
  const out = new Map<string, CommandOrigin>();
  const claim = (name: string, origin: CommandOrigin) => {
    if (!out.has(name)) out.set(name, origin);
  };
  for (const f of folders) {
    if (f.skills) for (const name of skillNames(f.skills)) claim(name, f.origin);
    if (f.commands) for (const name of commandNames(f.commands)) claim(name, f.origin);
  }
  return out;
}

/** the list with each command the folders hold marked; the rest untouched */
export function markOrigins(cmds: AgentCommand[], origins: Map<string, CommandOrigin>): AgentCommand[] {
  if (origins.size === 0) return cmds;
  return cmds.map((c) => {
    const origin = origins.get(c.name);
    return origin ? { ...c, origin } : c;
  });
}

/** `plugins: [{ type: "local", path }]` under the Claude adapter's SDK options */
function pluginPaths(meta: Record<string, unknown> | undefined): string[] {
  const cc = meta?.claudeCode as Record<string, unknown> | undefined;
  const options = cc?.options as Record<string, unknown> | undefined;
  const plugins = options?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.flatMap((p) => {
    const rec = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    return rec.type === "local" && typeof rec.path === "string" ? [rec.path] : [];
  });
}

function skillNames(dir: string): string[] {
  return entries(dir).flatMap((e) => {
    const file = join(dir, e, "SKILL.md");
    if (!existsSync(file)) return [];
    return [frontMatterName(file) ?? e];
  });
}

function commandNames(dir: string): string[] {
  return entries(dir).flatMap((e) => {
    const path = join(dir, e);
    if (e.endsWith(".md")) return [basename(e, ".md")];
    return isDir(path) ? commandNames(path) : [];
  });
}

/** `name:` in the front matter, which the terminal takes over the folder's name when given */
function frontMatterName(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8");
    if (!text.startsWith("---")) return null;
    const end = text.indexOf("\n---", 3);
    const head = end === -1 ? text : text.slice(0, end);
    const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(head);
    return m?.[1] ?? null;
  } catch (e) {
    log.warn("origins", `${file} could not be read`, e);
    return null;
  }
}

function entries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((e) => !e.startsWith("."));
  } catch (e) {
    log.warn("origins", `${dir} could not be listed`, e);
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // a dangling symlink in a commands folder is nothing to list, and nothing to warn about
    return false;
  }
}
