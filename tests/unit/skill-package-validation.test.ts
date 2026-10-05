import { afterEach, describe, expect, test } from "vitest";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../../scripts/skills/install.ts";
import {
  skillContracts,
  validateSkillPackage,
} from "../../scripts/skills/package-validation.ts";
import { validateSkills } from "../../scripts/skills/validate.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** An isolated repository holding a copy of the canonical skills. */
function repositoryCopy(): { root: string; skillRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "skill-validation-"));
  temporaryDirectories.push(root);
  cpSync(join(process.cwd(), "skills"), join(root, "skills"), {
    recursive: true,
  });
  return { root, skillRoot: join(root, "skills", "task-delivery") };
}

function rewrite(path: string, transform: (source: string) => string): void {
  const source = readFileSync(path, "utf8");
  const next = transform(source);
  if (next === source)
    throw new Error(`Test fixture edit did not change ${path}`);
  writeFileSync(path, next);
}

const canonicalSkillRoot = join(process.cwd(), "skills", "task-delivery");
const canonicalSkill = readFileSync(
  join(canonicalSkillRoot, "SKILL.md"),
  "utf8",
);

describe("skill package validation", () => {
  test("accepts the canonical skill and the repository's installed copies", () => {
    expect(validateSkillPackage(canonicalSkillRoot)).toEqual([]);
    expect(validateSkills()).toEqual([]);
  });

  test("rejects a missing SKILL.md", () => {
    const { skillRoot } = repositoryCopy();
    rmSync(join(skillRoot, "SKILL.md"));

    expect(validateSkillPackage(skillRoot)).toEqual(["SKILL.md is missing"]);
  });

  test.each([
    ["no frontmatter", "# Task Delivery\n", "must start with YAML frontmatter"],
    [
      "unclosed frontmatter",
      "---\nname: task-delivery\n",
      "frontmatter is not closed",
    ],
    [
      "invalid YAML",
      "---\nname: [unclosed\n---\n",
      "frontmatter is invalid YAML",
    ],
    ["non-object YAML", "---\n- a\n---\n", "must be a YAML object"],
  ])("rejects %s", (_label, source, expected) => {
    const { skillRoot } = repositoryCopy();
    writeFileSync(join(skillRoot, "SKILL.md"), source);

    expect(validateSkillPackage(skillRoot)).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });

  test.each([
    [
      "a missing name",
      /^name: task-delivery\n/mu,
      "",
      "requires a non-empty name",
    ],
    [
      "a name that differs from the directory",
      /^name: task-delivery$/mu,
      "name: other-skill",
      "name must match its directory name",
    ],
    [
      "a non-kebab-case name",
      /^name: task-delivery$/mu,
      "name: Task_Delivery",
      "lowercase kebab-case",
    ],
    [
      "a missing description",
      /^description: .*\n/mu,
      "",
      "requires a non-empty description",
    ],
    [
      "an over-long description",
      /^description: .*$/mu,
      `description: ${"x".repeat(1025)}`,
      "must not exceed 1024 characters",
    ],
    [
      "a missing version",
      /^ {2}version: .*\n/mu,
      "  note: none\n",
      "requires metadata.version",
    ],
    [
      "a host-specific frontmatter key",
      /^license: MIT$/mu,
      "license: MIT\nmodel: some-model",
      "non-portable key: model",
    ],
  ])("rejects %s", (_label, pattern, replacement, expected) => {
    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source.replace(pattern, replacement),
    );

    expect(validateSkillPackage(skillRoot)).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });

  test("rejects a missing required file and the broken link it leaves", () => {
    const { skillRoot } = repositoryCopy();
    rmSync(join(skillRoot, "references", "stop-conditions.md"));

    expect(validateSkillPackage(skillRoot)).toEqual(
      expect.arrayContaining([
        "Required file is missing: references/stop-conditions.md",
        "SKILL.md links to a missing file: references/stop-conditions.md",
      ]),
    );
  });

  test("rejects links that are broken or leave the skill directory", () => {
    const { skillRoot } = repositoryCopy();
    rewrite(
      join(skillRoot, "references", "lifecycle.md"),
      (source) =>
        `${source}\n[gone](missing.md) [out](../../../README.md) [web](https://example.com) [anchor](#top)\n`,
    );

    const errors = validateSkillPackage(skillRoot);
    expect(errors).toEqual(
      expect.arrayContaining([
        "references/lifecycle.md links to a missing file: missing.md",
        "references/lifecycle.md links outside the skill directory: ../../../README.md",
      ]),
    );
    expect(errors).toHaveLength(2);
  });

  test("rejects unreferenced files, unexpected entries, and symbolic links", () => {
    const { skillRoot } = repositoryCopy();
    writeFileSync(join(skillRoot, "references", "orphan.md"), "# Orphan\n");
    writeFileSync(join(skillRoot, "NOTES.md"), "# Notes\n");

    expect(validateSkillPackage(skillRoot)).toEqual(
      expect.arrayContaining([
        "references/orphan.md is not linked from any document in the skill",
        expect.stringContaining("Unexpected top-level entry: NOTES.md"),
      ]),
    );

    symlinkSync(
      join(skillRoot, "SKILL.md"),
      join(skillRoot, "references", "link.md"),
    );
    expect(validateSkillPackage(skillRoot)).toEqual([
      expect.stringContaining("symbolic link"),
    ]);
  });

  test.each([
    ["SKILL.md", "Launch a Claude subagent for the review."],
    ["SKILL.md", "Then call Codex to review."],
    ["references/lifecycle.md", "Read .claude/skills before starting."],
    ["references/qa-checklist.md", "Ask Pi to verify."],
    ["references/configuration.md", "Managed by AI Office."],
    ["assets/pr-template.md", "Reviewed with ai-office."],
  ])(
    "rejects executor-specific wording in the core of %s: %s",
    (file, sentence) => {
      const { skillRoot } = repositoryCopy();
      // Inserted before the executor block, i.e. inside the neutral core.
      rewrite(join(skillRoot, file), (source) =>
        file === "SKILL.md"
          ? source.replace("## Reporting", `${sentence}\n\n## Reporting`)
          : `${source}\n${sentence}\n`,
      );

      expect(validateSkillPackage(skillRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `${file} mentions an executor-specific term outside the executor block`,
          ),
        ]),
      );
    },
  );

  test("allows executor names only inside one well-formed executor block", () => {
    expect(canonicalSkill).toMatch(
      /<!-- executors:start -->[\s\S]*Claude Code[\s\S]*Codex[\s\S]*Pi[\s\S]*<!-- executors:end -->/u,
    );

    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source.replace("<!-- executors:end -->", ""),
    );
    expect(validateSkillPackage(skillRoot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("at most one well-formed executor block"),
      ]),
    );
  });

  test("rejects installed copies that are missing or diverge from the source", () => {
    const { root } = repositoryCopy();
    expect(validateSkills(root)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          ".claude/skills/task-delivery: out of sync with skills/task-delivery",
        ),
        expect.stringContaining(
          ".agents/skills/task-delivery: out of sync with skills/task-delivery",
        ),
      ]),
    );

    installSkills({ sourceRoot: root });
    expect(validateSkills(root)).toEqual([]);

    // A hand-edited copy is a second source of truth.
    writeFileSync(
      join(root, ".agents", "skills", "task-delivery", "SKILL.md"),
      canonicalSkill.replace("# Task Delivery", "# Task Delivery (forked)"),
    );
    expect(validateSkills(root)).toEqual([
      expect.stringContaining(
        ".agents/skills/task-delivery: SKILL.md was modified after installation",
      ),
    ]);
  });

  test("does not compare installed copies against an invalid source", () => {
    const { root, skillRoot } = repositoryCopy();
    rmSync(join(skillRoot, "assets", "pr-template.md"));

    const errors = validateSkills(root);
    expect(errors).toEqual(
      expect.arrayContaining([
        "skills/task-delivery: Required file is missing: assets/pr-template.md",
      ]),
    );
    expect(errors.join("\n")).not.toContain("out of sync");
  });
});

describe("task-delivery workflow invariants", () => {
  const contract = skillContracts["task-delivery"]!;

  // Each entry removes one gate or policy from the canonical text; the
  // validator must then name the invariant that disappeared.
  const removals: readonly [id: string, removed: string | RegExp][] = [
    ["stage:preflight", "### 1. Preflight"],
    ["stage:design", "### 2. Design"],
    ["stage:implementation", "### 3. Implementation"],
    ["stage:pull-request", "### 4. Pull Request"],
    ["stage:independent-review", "### 5. Independent Review"],
    ["stage:hardening", "### 6. Hardening"],
    ["stage:second-review", "### 7. Second Review"],
    ["stage:verification", "### 8. Verification / QA"],
    ["stage:external-review", "### 9. External Review (optional)"],
    ["stage:ready-for-merge", "### 10. Ready for Merge"],
    ["stage:post-merge", "### 11. Post-merge verification / completion"],
    [
      "policy:no-automatic-merge",
      "Never merge without explicit authorization.",
    ],
    ["policy:ready-for-merge-is-not-done", "READY FOR MERGE != DONE."],
    [
      "policy:task-dependency-is-not-branch-dependency",
      "Task dependency != Git branch dependency.",
    ],
    [
      "policy:stop-on-unauthorized-architecture",
      "Stop on any unauthorized architectural decision.",
    ],
    [
      "policy:evidence-before-conclusion",
      /No stage and no task is concluded without\s+evidence\./u,
    ],
    [
      "policy:independent-contexts",
      /Implementation, review, and verification must run in independent contexts/u,
    ],
    ["policy:scope", "Stay in scope."],
    ["executor-mapping", /\| Codex .*\n/u],
  ];

  test("every contract invariant has a removal case", () => {
    expect(removals.map(([id]) => id).sort()).toEqual(
      contract.invariants.map((invariant) => invariant.id).sort(),
    );
  });

  test.each(removals)("requires %s", (id, removed) => {
    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source.replace(removed, ""),
    );

    expect(validateSkillPackage(skillRoot)).toContain(
      `SKILL.md is missing required content: ${id}`,
    );
  });

  test("keeps the lifecycle stages in delivery order", () => {
    const stages = [...canonicalSkill.matchAll(/^### (\d+)\. (.+)$/gmu)].map(
      (match) => [Number(match[1]), match[2]],
    );

    expect(stages.map(([number]) => number)).toEqual(
      Array.from({ length: 11 }, (_unused, index) => index + 1),
    );
    const titles = stages.map(([, title]) => String(title));
    const position = (fragment: string): number =>
      titles.findIndex((title) => title.includes(fragment));
    expect(position("Preflight")).toBeLessThan(position("Implementation"));
    expect(position("Implementation")).toBeLessThan(
      position("Independent Review"),
    );
    expect(position("Independent Review")).toBeLessThan(position("Hardening"));
    expect(position("Hardening")).toBeLessThan(position("Verification"));
    expect(position("Verification")).toBeLessThan(position("Ready for Merge"));
    expect(position("Ready for Merge")).toBeLessThan(position("Post-merge"));
  });

  test("the detailed references restate the gates they own", () => {
    const reference = (name: string): string =>
      readFileSync(
        join(canonicalSkillRoot, "references", name),
        "utf8",
      ).replace(/\s+/gu, " ");

    expect(reference("lifecycle.md")).toMatch(/Do not merge\./u);
    expect(reference("lifecycle.md")).toMatch(/Only now report DONE/u);
    expect(reference("stop-conditions.md")).toMatch(
      /Unauthorized architectural decision/u,
    );
    expect(reference("stop-conditions.md")).toMatch(
      /Merge without authorization/u,
    );
    expect(reference("branch-policy.md")).toMatch(
      /satisfied Git dependency does not satisfy a task dependency/u,
    );
    expect(reference("evidence.md")).toMatch(/Bind evidence to a commit/u);
    expect(reference("qa-checklist.md")).toMatch(/PASS or FAIL/u);
    expect(reference("review-checklist.md")).toMatch(/blocking/u);
    expect(reference("configuration.md")).toMatch(
      /never grants authority: no key can authorize a merge/u,
    );
  });
});
