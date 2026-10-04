import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compileProjectKnowledgeSection,
  projectKnowledgeAdmissionSources,
  projectKnowledgeSourceBoundaries,
} from "@ai-office/application/agent-client/project-knowledge-policy.ts";
import { compileProjectSkill } from "@ai-office/application/agent-client/project-skill-compiler.ts";
import {
  validateAiOfficeSkill,
  validateHandoverKnowledgeBoundary,
  validateProjectedAiOfficeSkill,
} from "../../scripts/validate-skills.ts";

const skillRoot = join(process.cwd(), ".agents", "skills", "ai-office");
const distributionSkill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
const handoverReference = readFileSync(
  join(skillRoot, "references", "project-handover.md"),
  "utf8",
);
const projectedSkill = compileProjectSkill();
const policy = compileProjectKnowledgeSection();

function withSkillCopy(content: string, check: (copy: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ai-office-skill-policy-"));
  try {
    const copy = join(directory, "ai-office");
    cpSync(skillRoot, copy, { recursive: true });
    writeFileSync(join(copy, "SKILL.md"), content);
    check(copy);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("durable project knowledge policy", () => {
  test("both skill surfaces carry the one canonical policy exactly once", () => {
    for (const skill of [distributionSkill, projectedSkill]) {
      expect(skill.split(policy)).toHaveLength(2);
      expect(skill.split("## Durable project knowledge")).toHaveLength(2);
    }
    expect(validateAiOfficeSkill()).toEqual([]);
    expect(validateProjectedAiOfficeSkill(projectedSkill)).toEqual([]);
  });

  test("rejects a projected skill whose knowledge policy drifted", () => {
    expect(
      validateProjectedAiOfficeSkill(
        projectedSkill.replace(
          "Never write to the knowledge store directly",
          "Write to the knowledge store directly when convenient",
        ),
      ),
    ).toContain(
      "Projected SKILL.md does not embed the canonical durable project knowledge policy verbatim",
    );
  });

  test("rejects a checked-in distribution skill whose knowledge policy drifted", () => {
    const drifted = distributionSkill.replace(
      "Never write to the knowledge store directly",
      "Write to the knowledge store directly when convenient",
    );
    expect(drifted).not.toBe(distributionSkill);
    withSkillCopy(drifted, (copy) =>
      expect(validateAiOfficeSkill(copy)).toContain(
        "SKILL.md does not embed the canonical durable project knowledge policy verbatim",
      ),
    );
  });

  test("rejects a skill carrying a second copy of the policy section", () => {
    const duplicated = `${distributionSkill}\n${policy}\n`;
    withSkillCopy(duplicated, (copy) =>
      expect(validateAiOfficeSkill(copy)).toEqual(
        expect.arrayContaining([
          "SKILL.md embeds the durable project knowledge policy more than once",
          'SKILL.md must contain exactly one "## Durable project knowledge" heading',
        ]),
      ),
    );
    const editedCopy = `${projectedSkill}\n## Durable project knowledge\n\nEdited variant.\n`;
    expect(validateProjectedAiOfficeSkill(editedCopy)).toContain(
      'Projected SKILL.md must contain exactly one "## Durable project knowledge" heading',
    );
  });

  test("accepts a valid skill checked out with CRLF line endings", () => {
    const crlf = distributionSkill.replace(/\n/gu, "\r\n");
    withSkillCopy(crlf, (copy) => {
      writeFileSync(
        join(copy, "references", "project-handover.md"),
        handoverReference.replace(/\n/gu, "\r\n"),
      );
      expect(validateAiOfficeSkill(copy)).toEqual([]);
    });
    expect(
      validateProjectedAiOfficeSkill(projectedSkill.replace(/\n/gu, "\r\n")),
    ).toEqual([]);
  });

  test("rejects a handover reference that drops the knowledge boundary", () => {
    expect(validateHandoverKnowledgeBoundary(handoverReference)).toEqual([]);
    expect(
      validateHandoverKnowledgeBoundary(
        handoverReference.replace("agent interpretation", "bulk copy"),
      ),
    ).toEqual([
      "references/project-handover.md is missing the knowledge boundary: agent interpretation",
    ]);
  });

  test("offers exactly the three verified admission sources and no host-session source", () => {
    expect(projectKnowledgeAdmissionSources.map(([what]) => what)).toEqual([
      "AgentRun knowledge",
      "confirmed handover knowledge",
      "interactive/operator-reviewed knowledge",
    ]);
    // Every source reaches both clients with its selector, through the one policy.
    for (const selector of [
      "--run <runId>",
      "--source handover --handover <confirmationId>",
      "--source operator-confirmed --confirmed-by <operator> --evidence",
    ])
      expect(policy).toContain(selector);
    for (const boundary of projectKnowledgeSourceBoundaries)
      expect(policy).toContain(boundary);
    // No option, field, or evidence kind for a host session is ever suggested,
    // and the run-only restriction AK-11 removed does not survive.
    expect(policy).not.toMatch(/--(?:claude|codex)[-\w]*|SessionId|session:/u);
    expect(policy).not.toMatch(/bound to a completed worker run/u);
  });

  test("does not reintroduce removed commands or a second memory provider", () => {
    for (const skill of [distributionSkill, projectedSkill])
      expect(skill).not.toMatch(
        /project-memory:status|knowledge:legacy-plan|knowledge:legacy-import|memory_write/u,
      );
    expect(handoverReference).not.toMatch(/cairnkeep/iu);
  });
});
