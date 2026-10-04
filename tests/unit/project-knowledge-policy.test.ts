import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileProjectHandoverSection } from "@ai-office/application/agent-client/project-handover-workflow.ts";
import {
  compileProjectKnowledgeSection,
  projectKnowledgeAdmissionSteps,
  projectKnowledgeAuthoritativeSources,
  projectKnowledgeExclusions,
  projectKnowledgeWorkKinds,
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
const flat = (text: string) => text.replace(/\s+/gu, " ");

describe("durable project knowledge policy", () => {
  test("both skill surfaces carry the one canonical policy", () => {
    expect(distributionSkill).toContain(policy);
    expect(projectedSkill).toContain(policy);
    // Exactly one copy each: a second, hand-edited variant would be drift.
    for (const skill of [distributionSkill, projectedSkill])
      expect(skill.split("## Durable project knowledge")).toHaveLength(2);
  });

  test("names every kind of work that can produce knowledge and a promotion step", () => {
    for (const kind of [
      "project handover",
      "implementation",
      "debugging",
      "research",
      "code review",
      "QA and verification",
      "architectural investigation",
      "completed-task retrospection",
    ]) {
      expect(projectKnowledgeWorkKinds).toContain(kind);
      expect(policy).toContain(kind);
    }
    expect(policy).toContain("first-class possible output");
    expect(policy).toContain(
      "### Consider knowledge promotion before wrapping up",
    );
    // The step is also reachable from where task work ends.
    expect(flat(projectedSkill)).toMatch(
      /wrapped up, follow \*\*Durable project knowledge\*\* below and consider knowledge promotion/u,
    );
    expect(flat(distributionSkill)).toMatch(
      /wrapped up, follow \*\*Durable project knowledge\*\* and consider knowledge promotion/u,
    );
    expect(
      readFileSync(join(skillRoot, "references", "task-operation.md"), "utf8"),
    ).toContain("consider knowledge promotion");
  });

  test("identifies AgentKnowledgeStore as non-authoritative contextual knowledge", () => {
    expect(policy).toMatch(
      /`AgentKnowledgeStore` holds it as non-authoritative, advisory context/u,
    );
    expect(policy).toContain("never decides anything, grants anything");
    expect(policy).toContain(
      "Knowledge never overrides the authoritative decision that produced it",
    );
    expect(policy).toContain("the authoritative record wins");
  });

  test("keeps authoritative state in its source of truth, never in knowledge", () => {
    const sources = new Map(projectKnowledgeAuthoritativeSources);
    expect(
      sources.get("source code, configuration, and technical documentation"),
    ).toBe("the repository");
    expect(
      sources.get("goals, constraints, preferences, roles, and pipelines"),
    ).toBe("the approved office manifest");
    expect(sources.get("milestones and requirements")).toBe("governance state");
    expect(sources.get("architectural decisions")).toBe("ADRs");
    expect(sources.get("tasks and the execution lifecycle")).toBe(
      "task and run state",
    );
    expect(sources.get("deterministic repository structure and facts")).toBe(
      "the repository scan and handover evidence",
    );
    for (const [what, where] of projectKnowledgeAuthoritativeSources)
      expect(policy).toContain(`- ${what} stay in ${where}`);
    expect(policy).toContain(
      "Never admit it into `AgentKnowledgeStore` as a competing copy",
    );
    // No instruction moves an authoritative record into the store.
    expect(policy).not.toMatch(
      /(?:admit|record|store|move|copy)\s+(?:the\s+)?(?:ADRs?|requirements?|milestones?|manifest|tasks?)\s+(?:in|into|to)\s+`?AgentKnowledgeStore/iu,
    );
  });

  test("separates project knowledge from global reusable memory", () => {
    expect(policy).toContain(
      "Global reusable memory (`memory:*`) is only for knowledge meant to be reused across projects",
    );
    expect(policy).toContain(
      "Project-specific architecture or implementation facts must never leak into global memory",
    );
    expect(policy).toContain("Do not fall back to `memory:*`");
    expect(flat(distributionSkill)).toContain(
      "Global memory holds only knowledge reusable across projects",
    );
    expect(projectedSkill).toContain(
      "`memory:*` only for memory reusable across projects",
    );
  });

  test("requires search, verification, provenance and the governed admission path", () => {
    const steps = projectKnowledgeAdmissionSteps.join("\n");
    expect(projectKnowledgeAdmissionSteps[0]).toMatch(
      /^Search first\. Run `ai-office knowledge:search/u,
    );
    expect(steps).toContain("Admit only what you verified");
    expect(steps).toContain("State any remaining uncertainty explicitly");
    expect(steps).toContain("bound to a completed worker run");
    for (const evidence of [
      "ADR",
      "requirement",
      "review",
      "repository path",
      "explicit user confirmation",
    ])
      expect(steps).toContain(evidence);
    expect(steps).toContain("Do not create contradictory duplicates");
    expect(steps.indexOf("knowledge:plan")).toBeLessThan(
      steps.indexOf("knowledge:admit"),
    );
    expect(steps).toContain("review the exact returned plan");
    expect(steps).toContain("knowledge:trace");
    expect(steps).toContain("Use the governed workflow, and nothing else");
    expect(steps).toContain("Never write to the knowledge store directly");
    expect(steps).toContain("never admit on the user's behalf or in advance");
    expect(policy).toContain("Never admit every task result");
  });

  test("excludes secrets, transient state and raw repository content from promotion", () => {
    for (const excluded of [
      "credentials, secrets, tokens, or sensitive configuration",
      "raw copies of repository files",
      "large code excerpts",
      "transient command output",
      "temporary execution state",
      "speculative assumptions presented as facts",
      "information that is cheap and deterministic to regenerate from the repository, unless the interpretation or rationale itself is valuable",
      "stale knowledge known to be superseded",
    ]) {
      expect(projectKnowledgeExclusions).toContain(excluded);
      expect(policy).toContain(`- ${excluded}`);
    }
    expect(policy.indexOf("### Never persist")).toBeLessThan(
      policy.indexOf(`- ${projectKnowledgeExclusions[0]!}`),
    );
  });

  test("handover keeps the repository, scan, interpretation, knowledge boundary", () => {
    const handover = compileProjectHandoverSection();
    expect(handover).toContain("Scan facts stay repository-scan evidence");
    expect(handover).toContain("the confirmed review stays handover evidence");
    expect(handover).toContain(
      "Never copy repository structure or files into knowledge",
    );
    expect(handover).toContain(
      "Project knowledge complements handover evidence and authoritative state; it never replaces either",
    );
    expect(validateHandoverKnowledgeBoundary(handoverReference)).toEqual([]);
    const order = [
      "repository\n",
      "deterministic scan / handover evidence",
      "agent interpretation",
      "durable AgentKnowledgeStore entries when materially useful",
    ].map((stage) => handoverReference.indexOf(stage));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The blind-copy flow appears only as the rejected alternative.
    expect(handoverReference.indexOf("never:")).toBeLessThan(
      handoverReference.indexOf("copy everything into memory"),
    );
    expect(
      validateHandoverKnowledgeBoundary(
        handoverReference.replace("agent interpretation", "bulk copy"),
      ),
    ).toEqual([
      "references/project-handover.md is missing the knowledge boundary: agent interpretation",
    ]);
  });

  test("rejects a skill surface whose knowledge policy drifted", () => {
    expect(validateAiOfficeSkill()).toEqual([]);
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

  test("does not reintroduce CairnKeep or a second memory provider", () => {
    expect(policy).not.toMatch(/cairnkeep|memory_write|memory_search/iu);
    for (const skill of [distributionSkill, projectedSkill]) {
      expect(flat(skill)).toContain("CairnKeep integration has been removed");
      expect(skill).not.toMatch(
        /project-memory:status|knowledge:legacy-plan|knowledge:legacy-import|memory_write/u,
      );
    }
    expect(handoverReference).not.toMatch(/cairnkeep/iu);
  });
});
