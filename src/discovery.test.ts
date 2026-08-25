import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listAvailableCommands,
  listAvailableSkills,
  parseMarkdownFrontmatter,
} from "./discovery";

const TEST_DIR = mkdtempSync(join(tmpdir(), "oc-discovery-test-"));

describe("discovery (commands & skills)", () => {
  beforeAll(() => {
    // Create custom command
    const cmdDir = join(TEST_DIR, ".opencode", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      join(cmdDir, "review.md"),
      `---\ndescription: "Review current pull request diff"\n---\nReview prompt instructions`,
    );

    // Create custom skill in .agents/skills/deploy/SKILL.md
    const skillDir = join(TEST_DIR, ".agents", "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "deploy-service"\ndescription: "Deploy service to staging or production"\n---\n# Deploy Skill\nInstructions...`,
    );
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("parseMarkdownFrontmatter extracts name and description", () => {
    const raw = `---
name: my-skill
description: "My custom skill description"
---
# Skill body`;
    const res = parseMarkdownFrontmatter(raw);
    expect(res.name).toBe("my-skill");
    expect(res.description).toBe("My custom skill description");
  });

  test("listAvailableCommands returns builtin commands and discovered custom commands", async () => {
    const cmds = await listAvailableCommands(TEST_DIR);
    const names = cmds.map((c) => c.name);

    // Builtins
    expect(names).toContain("help");
    expect(names).toContain("compact");
    expect(names).toContain("clear");
    expect(names).toContain("git");
    expect(names).toContain("model");
    expect(names).toContain("shake");

    // Custom discovered command
    expect(names).toContain("review");
    const reviewCmd = cmds.find((c) => c.name === "review");
    expect(reviewCmd?.description).toBe("Review current pull request diff");
    expect(reviewCmd?.template).toBe("/review");
  });

  test("listAvailableSkills discovers project skills with parsed frontmatter", async () => {
    const skills = await listAvailableSkills(TEST_DIR);
    expect(skills.length).toBeGreaterThanOrEqual(1);

    const deploy = skills.find((s) => s.name === "deploy-service");
    expect(deploy).toBeDefined();
    expect(deploy?.description).toBe("Deploy service to staging or production");
    expect(deploy?.path).toBe(join(TEST_DIR, ".agents", "skills", "deploy", "SKILL.md"));
  });
});
