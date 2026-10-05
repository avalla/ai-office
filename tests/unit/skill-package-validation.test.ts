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
import { repositoryRoot } from "../../scripts/skills/shared.ts";
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
  cpSync(join(repositoryRoot, "skills"), join(root, "skills"), {
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

const canonicalSkillRoot = join(repositoryRoot, "skills", "task-delivery");
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

  test("an external reviewer is required only when configured or requested", () => {
    const split = canonicalSkill.indexOf("<!-- executors:start -->");
    const core = canonicalSkill.slice(0, split).replace(/\s+/gu, " ");
    const block = canonicalSkill.slice(split).replace(/\s+/gu, " ");
    const reference = (name: string): string =>
      readFileSync(
        join(canonicalSkillRoot, "references", name),
        "utf8",
      ).replace(/\s+/gu, " ");

    // Required: configured by the project or requested by the authorizer.
    expect(core).toMatch(
      /\*\*required\*\* when the project configures one or the authorizer explicitly asks for one for this task/u,
    );
    expect(core).toMatch(/the task cannot become READY FOR MERGE/u);
    expect(core).toMatch(
      /\*\*External reviewer\*\*: a second, differently built reviewer - required when the project configures one or the authorizer asks for one, best effort otherwise/u,
    );
    expect(core).toMatch(
      /With no external reviewer at all, skip the stage and say so/u,
    );
    // Best effort: merely offered by the executor.
    expect(core).toMatch(
      /neither configured by the project nor requested by the authorizer - is \*\*best effort\*\*/u,
    );
    expect(core).toMatch(
      /When it cannot complete - a timeout, a capacity or execution error, or unavailability - record `external reviewer unavailable` with the error as evidence and continue/u,
    );
    expect(core).toMatch(
      /a best-effort reviewer never stands in for a required one/u,
    );
    expect(core).toMatch(
      /Declare READY FOR MERGE only when .* a required external review has completed successfully on the current head/u,
    );
    expect(core).toMatch(/an error is never a passed review/u);

    // The executor block offers a reviewer without making it a requirement.
    expect(block).toMatch(
      /Codex, when present in the session .* is an available external reviewer/u,
    );
    expect(block).toMatch(
      /Its presence alone does not make it required: it is best effort unless the project configures it or the authorizer requests it/u,
    );
    // Nothing in the block may turn presence into an obligation.
    expect(block).not.toMatch(
      /not optional|failed gate|mandatory|always|must|block(?:s|ing)\b/iu,
    );

    const lifecycle = reference("lifecycle.md");
    expect(lifecycle).toMatch(
      /\*\*Required\*\* when the project configures an external reviewer or the authorizer explicitly asks for one/u,
    );
    expect(lifecycle).toMatch(
      /unavailable reviewer is a failed gate: report it with the error and do not declare READY FOR MERGE/u,
    );
    expect(lifecycle).toMatch(/Never count the error as a review/u);
    expect(lifecycle).toMatch(
      /Run it again when the reviewer is available: a new run after an infrastructure error is not a retried check/u,
    );
    expect(lifecycle).toMatch(
      /a required external review is then run again on the resulting head/u,
    );
    expect(lifecycle).toMatch(
      /\*\*Best effort\*\* when the executor merely offers a reviewer that nobody configured or requested/u,
    );
    expect(lifecycle).toMatch(
      /record `external reviewer unavailable` with the error and continue\. It never stands in for a required reviewer/u,
    );
    expect(lifecycle).toMatch(
      /Findings handled; if best effort, recorded unavailability; or skip/u,
    );
    expect(lifecycle).toMatch(
      /required external review that has not completed successfully on the current head blocks READY FOR MERGE\. A best-effort one that was unavailable does not/u,
    );
    expect(reference("stop-conditions.md")).toMatch(
      /Required external review cannot complete\.\*\* A configured or requested external reviewer times out, errors, or is unavailable/u,
    );
    const stopConditions = reference("stop-conditions.md");
    expect(stopConditions).toMatch(
      /not READY FOR MERGE until that review completes successfully\./u,
    );
    expect(stopConditions).toMatch(
      /A best-effort external reviewer that cannot complete: record `external reviewer unavailable` with the error and continue/u,
    );
    expect(stopConditions).toMatch(
      /A best-effort external reviewer is not needed for a gate/u,
    );
    const evidence = reference("evidence.md");
    expect(evidence).toMatch(
      /external review that ended in a timeout, an error, or a capacity failure/u,
    );
    expect(evidence).toMatch(
      /External review: <required: result on hash \| best effort: result on hash \| best effort: external reviewer unavailable: error \| none - skipped>/u,
    );
    expect(evidence).toMatch(/the earlier error never does/u);
    const configuration = reference("configuration.md");
    expect(configuration).toMatch(/setting it makes stage 9 required/u);
    expect(configuration).toMatch(
      /None: required only if the authorizer asks; otherwise best effort/u,
    );
    expect(
      readFileSync(
        join(canonicalSkillRoot, "assets", "pr-template.md"),
        "utf8",
      ),
    ).toMatch(
      /"required: result on commit"; or "best effort: result on commit"; or "best effort: external reviewer unavailable" with the error; or "none - skipped"/u,
    );
    // A required review has exactly one way through; no document offers a
    // waiver, and none lets an installed reviewer become an obligation.
    for (const text of [core, block, lifecycle, stopConditions, evidence])
      expect(text).not.toMatch(/waive/iu);
    for (const text of [
      core,
      block,
      lifecycle,
      stopConditions,
      evidence,
      configuration,
    ]) {
      // Presence never creates the obligation.
      expect(text).not.toMatch(
        /\b(?:installed|exists?|present|available|found)\b[^.]*\b(?:is|are|becomes?) required\b/iu,
      );
    }
  });

  test("the executor block cannot swallow or precede the workflow", () => {
    const moved = repositoryCopy();
    rewrite(join(moved.skillRoot, "SKILL.md"), (source) =>
      source
        .replace("<!-- executors:start -->\n", "")
        .replace(
          "# Task Delivery",
          "<!-- executors:start -->\n\n# Task Delivery",
        ),
    );
    expect(validateSkillPackage(moved.skillRoot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("executor block exceeds"),
        expect.stringContaining("lifecycle stage 1 must be"),
      ]),
    );

    const trailing = repositoryCopy();
    rewrite(
      join(trailing.skillRoot, "SKILL.md"),
      (source) => `${source}\n## Afterword\n\nMore workflow text.\n`,
    );
    expect(validateSkillPackage(trailing.skillRoot)).toEqual([
      "SKILL.md executor block must be the last section of the file",
    ]);
  });

  test("checks reference-style links and ignores fenced examples and OS files", () => {
    const { skillRoot } = repositoryCopy();
    rewrite(
      join(skillRoot, "references", "lifecycle.md"),
      (source) =>
        `${source}\n\`\`\`md\n[example](path/to/file.md)\n\`\`\`\n\n[ref]: nope.md\n[dir]: ../assets\n[case]: QA-Checklist.md\n[angle]: <gone.md>\n[^1]: Footnote text here.\n[Note]: this is prose.\n\n- item\n\n  \`\`\`md\n  [nested](nested/example.md)\n  \`\`\`\n\nWrite \`[text](inline-code.md)\` and [ok](<qa-checklist.md>).\n`,
    );
    writeFileSync(join(skillRoot, ".DS_Store"), "junk");
    writeFileSync(join(skillRoot, "references", ".DS_Store"), "junk");

    expect(validateSkillPackage(skillRoot)).toEqual([
      "references/lifecycle.md links to a missing file: nope.md",
      "references/lifecycle.md links to a missing file: ../assets",
      "references/lifecycle.md links to a missing file: QA-Checklist.md",
      "references/lifecycle.md links to a missing file: gone.md",
    ]);
  });

  test("a file linked only from itself is still unreferenced", () => {
    const { skillRoot } = repositoryCopy();
    writeFileSync(
      join(skillRoot, "references", "loop.md"),
      "# Loop\n\nSee [this page](loop.md).\n",
    );

    expect(validateSkillPackage(skillRoot)).toEqual([
      "references/loop.md is not linked from any document in the skill",
    ]);
  });

  test("rejects an installed copy whose canonical skill no longer exists", () => {
    const { root } = repositoryCopy();
    installSkills({ sourceRoot: root });
    cpSync(
      join(root, ".claude", "skills", "task-delivery"),
      join(root, ".claude", "skills", "old-skill"),
      { recursive: true },
    );

    expect(validateSkills(root)).toEqual([
      expect.stringContaining(
        ".claude/skills/old-skill: installed copy has no canonical skill",
      ),
    ]);
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
    [
      "policy:required-external-review",
      /A required review must\s+complete successfully/u,
    ],
    [
      "policy:installed-is-not-required",
      /Being\s+installed does not make a reviewer required/u,
    ],
    ["policy:scope", "Stay in scope."],
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

  test.each(contract.stages.map((title, index) => [index + 1, title]))(
    "requires lifecycle stage %i: %s",
    (number, title) => {
      const { skillRoot } = repositoryCopy();
      rewrite(join(skillRoot, "SKILL.md"), (source) =>
        source.replace(new RegExp(`^### ${number}\\. .*$`, "mu"), ""),
      );

      const errors = validateSkillPackage(skillRoot);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^SKILL\.md lifecycle stage \d+ must be/u);
      expect(errors[0]).toContain(
        number === contract.stages.length
          ? `### ${number}. ${title}`
          : `### ${number}. `,
      );
    },
  );

  test("rejects lifecycle stages that are reordered or renumbered", () => {
    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source
        .replace("### 10. Ready for Merge", "### 3. Ready for Merge")
        .replace("### 3. Implementation", "### 10. Implementation"),
    );

    expect(validateSkillPackage(skillRoot)).toEqual([
      'SKILL.md lifecycle stage 3 must be "### 3. Implementation"',
    ]);
  });

  test.each(contract.executors)(
    "requires the executor block to cover %s",
    (executor) => {
      const { skillRoot } = repositoryCopy();
      rewrite(join(skillRoot, "SKILL.md"), (source) =>
        source.replace(new RegExp(`^\\| ${executor} .*\\n`, "mu"), ""),
      );

      expect(validateSkillPackage(skillRoot)).toEqual([
        `SKILL.md executor block does not cover: ${executor}`,
      ]);
    },
  );

  test("executor names are matched as whole words", () => {
    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source
        .replace(/^\| Pi .*\n/mu, "")
        .replace(
          "<!-- executors:end -->",
          "Pipeline note.\n\n<!-- executors:end -->",
        ),
    );

    expect(validateSkillPackage(skillRoot)).toEqual([
      "SKILL.md executor block does not cover: Pi",
    ]);
  });

  test("policies must be stated in the core, not only in the executor block", () => {
    const { skillRoot } = repositoryCopy();
    rewrite(join(skillRoot, "SKILL.md"), (source) =>
      source
        .replace("**Stay in scope.**", "**Mind the boundaries.**")
        .replace(
          "<!-- executors:end -->",
          "Stay in scope.\n\n<!-- executors:end -->",
        ),
    );

    expect(validateSkillPackage(skillRoot)).toContain(
      "SKILL.md is missing required content: policy:scope",
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

  test("stacked-branch handling never prescribes rewriting shared history", () => {
    const reference = (name: string): string =>
      readFileSync(
        join(canonicalSkillRoot, "references", name),
        "utf8",
      ).replace(/\s+/gu, " ");
    const lifecycle = reference("lifecycle.md");
    const branchPolicy = reference("branch-policy.md");
    const stopConditions = reference("stop-conditions.md");

    // Post-merge handling defers to the branch policy instead of restating a
    // looser rule, and no document tells the reader to rebase as a default.
    expect(lifecycle).toMatch(
      /stacked on this one, follow the \[branch policy\]\(branch-policy\.md\)/u,
    );
    expect(lifecycle).toMatch(/Never rewrite shared or reviewed history/u);
    for (const text of [lifecycle, branchPolicy, stopConditions])
      expect(text).not.toMatch(/\brebase or\b|\bor rebase\b/iu);
    expect(lifecycle).not.toMatch(/\brebase\b/iu);

    expect(branchPolicy).toMatch(
      /retarget the upper pull request to the integration branch/u,
    );
    expect(branchPolicy).toMatch(/merge the integration branch into it/u);
    expect(branchPolicy).toMatch(
      /A rebase is allowed only on a branch that has not been shared, whose review has not started, and that no other branch is stacked on/u,
    );
    expect(branchPolicy).toMatch(
      /Any change of base or merge-in invalidates earlier verification evidence: run verification again on the resulting head/u,
    );
    expect(lifecycle).toMatch(/verification again on the resulting head/u);
    expect(branchPolicy).toMatch(/\[stop condition\]\(stop-conditions\.md\)/u);
    expect(stopConditions).toMatch(/Rewriting shared or reviewed history/u);
    expect(stopConditions).toMatch(
      /Invalid configuration\.\*\* .* Never fall back to defaults/u,
    );
    expect(reference("configuration.md")).not.toMatch(/keys are ignored/iu);
    expect(reference("configuration.md")).toMatch(
      /stop and report it instead of continuing with defaults/u,
    );
  });
});
