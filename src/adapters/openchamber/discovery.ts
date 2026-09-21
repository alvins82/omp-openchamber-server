import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { existsSync } from "node:fs";

export interface OpenCodeCommand {
  name: string;
  description: string;
  template?: string;
}

export interface OpenCodeSkill {
  name: string;
  description: string;
  path: string;
}

const BUILTIN_COMMANDS: OpenCodeCommand[] = [
  { name: "help", description: "Show available commands and usage hints", template: "/help" },
  { name: "compact", description: "Compact session history to reduce context window", template: "/compact" },
  { name: "clear", description: "Clear current session context and start fresh", template: "/clear" },
  { name: "undo", description: "Undo the last message or turn", template: "/undo" },
  { name: "redo", description: "Redo the previously undone turn", template: "/redo" },
  { name: "model", description: "Switch or configure the active model", template: "/model" },
  { name: "resume", description: "Resume an existing conversation session", template: "/resume" },
  { name: "git", description: "Interactive repository diff viewer and staging TUI", template: "/git" },
  { name: "extensions", description: "Extension and MCP server control center", template: "/extensions" },
  { name: "shake", description: "Strip reasoning and thinking blocks from context", template: "/shake" },
  { name: "pin", description: "Pin session to the top of session picker", template: "/pin" },
  { name: "task", description: "Spawn or manage subagent tasks", template: "/task" },
  { name: "goal", description: "Autonomous goal execution mode", template: "/goal" },
  { name: "cleanse", description: "Dispatch code repair subagents", template: "/cleanse" },
];

/**
 * Parses YAML-style frontmatter from a markdown file (between initial `---` lines).
 */
export function parseMarkdownFrontmatter(content: string): { name?: string; description?: string } {
  const result: { name?: string; description?: string } = {};
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return result;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return result;

  const header = trimmed.slice(3, endIdx);
  for (const line of header.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name" && val) result.name = val;
    if (key === "description" && val) result.description = val;
  }
  return result;
}

/**
 * Scan directory recursively for SKILL.md files up to maxDepth.
 */
async function scanSkillsInDir(rootDir: string, currentDepth = 0, maxDepth = 3): Promise<OpenCodeSkill[]> {
  const skills: OpenCodeSkill[] = [];
  if (currentDepth > maxDepth || !existsSync(rootDir)) return skills;

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const directSkill = join(fullPath, "SKILL.md");
        if (existsSync(directSkill)) {
          try {
            const content = await readFile(directSkill, "utf8");
            const fm = parseMarkdownFrontmatter(content);
            const name = fm.name || entry.name;
            const description = fm.description || `Skill: ${name}`;
            skills.push({ name, description, path: directSkill });
          } catch {
            /* ignore unreadable */
          }
        } else {
          skills.push(...(await scanSkillsInDir(fullPath, currentDepth + 1, maxDepth)));
        }
      }
    }
  } catch {
    /* ignore directory read error */
  }

  return skills;
}

/**
 * Discover available skills across project and global locations.
 */
export async function listAvailableSkills(directory?: string | null): Promise<OpenCodeSkill[]> {
  const home = Bun.env.HOME || process.env.HOME || "";
  const candidates: string[] = [];

  if (directory) {
    candidates.push(join(directory, ".agents", "skills"));
    candidates.push(join(directory, ".claude", "skills"));
    candidates.push(join(directory, ".opencode", "skills"));
    candidates.push(join(directory, ".omp", "skills"));
  }

  if (home) {
    candidates.push(join(home, ".omp", "agent", "skills"));
    candidates.push(join(home, ".config", "opencode", "skill"));
    candidates.push(join(home, ".config", "opencode", "skills"));
  }

  const skillMap = new Map<string, OpenCodeSkill>();
  for (const root of candidates) {
    const found = await scanSkillsInDir(root);
    for (const s of found) {
      if (!skillMap.has(s.name)) {
        skillMap.set(s.name, s);
      }
    }
  }

  return Array.from(skillMap.values());
}

/**
 * Discover available slash commands including custom markdown commands.
 */
export async function listAvailableCommands(directory?: string | null): Promise<OpenCodeCommand[]> {
  const commands = [...BUILTIN_COMMANDS];
  const seen = new Set(commands.map((c) => c.name));

  const commandDirs: string[] = [];
  if (directory) {
    commandDirs.push(join(directory, ".opencode", "commands"));
    commandDirs.push(join(directory, ".omp", "commands"));
  }
  const home = Bun.env.HOME || process.env.HOME || "";
  if (home) {
    commandDirs.push(join(home, ".config", "opencode", "commands"));
    commandDirs.push(join(home, ".omp", "agent", "commands"));
  }

  for (const dir of commandDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const name = basename(f, ".md");
        if (seen.has(name)) continue;
        try {
          const content = await readFile(join(dir, f), "utf8");
          const fm = parseMarkdownFrontmatter(content);
          const desc = fm.description || `Custom command /${name}`;
          commands.push({
            name,
            description: desc,
            template: `/${name}`,
          });
          seen.add(name);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return commands;
}
