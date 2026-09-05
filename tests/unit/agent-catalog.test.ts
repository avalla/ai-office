import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = new YamlAgentDefinitionLoader();
const core = loader.load(join(root, "agents"));
const specialists = loader.load(join(root, "agent-catalog"));
const catalog = [...core, ...specialists];

describe("bundled agent catalog contract", () => {
  test("keeps stable core identities in the default synchronization directory", () => {
    expect(
      core.map(({ definition }) => [definition.id, definition.roleKey]),
    ).toEqual([
      ["architect", "software-architect"],
      ["developer", "software-developer"],
      ["qa", "quality-assurance"],
      ["reviewer", "code-reviewer"],
    ]);
  });

  test("keeps all fourteen stable specialist identities separate and globally unique", () => {
    expect(
      specialists.map(({ definition }) => [definition.id, definition.roleKey]),
    ).toEqual([
      ["alien-user", "usability-outsider"],
      ["chaos-gremlin", "resilience-tester"],
      ["code-archaeologist", "code-historian"],
      ["designer", "product-designer"],
      ["devil-advocate", "design-challenger"],
      ["forensic-detective", "incident-investigator"],
      ["future-keeper", "evolvability-reviewer"],
      ["hacker", "adversarial-tester"],
      ["mad-scientist", "experimental-scientist"],
      ["product", "product-analyst"],
      ["radical-minimalist", "simplification-analyst"],
      ["release", "release-engineer"],
      ["researcher", "technical-researcher"],
      ["security", "security-reviewer"],
    ]);
    expect(catalog).toHaveLength(18);
    expect(new Set(catalog.map(({ definition }) => definition.id)).size).toBe(
      18,
    );
    expect(
      new Set(catalog.map(({ definition }) => definition.roleKey)).size,
    ).toBe(18);
  });

  // This is an authored repository contract, not Runtime context assembly.
  test.each(
    catalog.map(
      ({ definition, sourcePath }) => [definition.id, sourcePath] as const,
    ),
  )(
    "%s has validated YAML and non-empty companion guidance with the common sections",
    (_id, sourcePath) => {
      expect(existsSync(sourcePath)).toBe(true);
      const guidancePath = join(dirname(sourcePath), "system.md");
      expect(existsSync(guidancePath)).toBe(true);
      const guidance = readFileSync(guidancePath, "utf8");
      expect(guidance.trim().length).toBeGreaterThan(0);
      for (const section of ["Method", "Handoff", "Boundaries"]) {
        expect(guidance).toMatch(new RegExp(`^## ${section}\\s*$`, "m"));
      }
    },
  );
});
