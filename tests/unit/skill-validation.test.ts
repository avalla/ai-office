import { afterEach, describe, expect, test } from "vitest";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAiOfficeSkill } from "../../scripts/validate-skills.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("AI Office skill validation", () => {
  test("accepts the repository skill contract", () => {
    expect(validateAiOfficeSkill()).toEqual([]);
  });

  test("rejects invalid frontmatter and missing required references", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-office-skill-check-"));
    temporaryDirectories.push(directory);
    const skillRoot = join(directory, "ai-office");
    cpSync(join(process.cwd(), ".agents", "skills", "ai-office"), skillRoot, {
      recursive: true,
    });
    writeFileSync(join(skillRoot, "SKILL.md"), "# Missing frontmatter\n");
    rmSync(join(skillRoot, "references", "manifest-contract.md"));

    expect(validateAiOfficeSkill(skillRoot)).toEqual(
      expect.arrayContaining([
        "SKILL.md must start with YAML frontmatter",
        "Required skill file is missing: references/manifest-contract.md",
      ]),
    );
  });

  test("requires lifecycle help and rejects removed provider onboarding", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-office-skill-flow-"));
    temporaryDirectories.push(directory);
    const skillRoot = join(directory, "ai-office");
    cpSync(join(process.cwd(), ".agents", "skills", "ai-office"), skillRoot, {
      recursive: true,
    });
    const skillPath = join(skillRoot, "SKILL.md");
    const source = readFileSync(skillPath, "utf8")
      .replace("## Help", "## Usage")
      .replace("## Update AI Office", "## Program maintenance")
      .concat("\nLegacy command: project:onboard\n");
    writeFileSync(skillPath, source);

    expect(validateAiOfficeSkill(skillRoot)).toEqual(
      expect.arrayContaining([
        "SKILL.md is missing required workflow content: ## Help",
        "SKILL.md is missing required workflow content: ## Update AI Office",
        "SKILL.md references removed provider onboarding: project:onboard",
      ]),
    );
  });
});
