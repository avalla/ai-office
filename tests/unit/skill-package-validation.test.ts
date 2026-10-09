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

  test("a skill named like an Object property has no inherited contract", () => {
    const { root, skillRoot } = repositoryCopy();
    const renamed = join(root, "skills", "constructor");
    cpSync(skillRoot, renamed, { recursive: true });
    rewrite(join(renamed, "SKILL.md"), (source) =>
      source.replace(/^name: task-delivery$/mu, "name: constructor"),
    );

    expect(validateSkillPackage(renamed)).toEqual([]);
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

  test.each(skillContracts["task-delivery"]!.requiredFiles)(
    "rejects a missing required file even without a dangling link: %s",
    (requiredFile) => {
      const { skillRoot } = repositoryCopy();
      rewrite(join(skillRoot, "SKILL.md"), (source) =>
        source.replaceAll(requiredFile, ""),
      );
      rmSync(join(skillRoot, ...requiredFile.split("/")));

      expect(validateSkillPackage(skillRoot)).toEqual(
        expect.arrayContaining([`Required file is missing: ${requiredFile}`]),
      );
    },
  );

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
      /Required: completed on the head\. Best effort: result or unavailability/u,
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
    ["policy:ask-what-to-deliver", "3. **Some tasks of one milestone**"],
    [
      "policy:check-dependencies-before-summary",
      /The\s+check always runs; when individual tasks were chosen/u,
    ],
    [
      "policy:unresolved-dependency-proposals",
      /propose adding it to the run or\s+postponing the task that needs it\./u,
    ],
    [
      "policy:stacking-does-not-satisfy-task-dependency",
      /Stacking neither\s+satisfies nor cancels the logical task dependency/u,
    ],
    [
      "policy:approve-summary-before-preflight",
      /Start\s+preflight\s+only after the authorizer\s+approves that summary\./u,
    ],
    [
      "policy:clarify-before-development",
      "development starts only when no selected",
    ],
    [
      "policy:run-stacking-needs-summary-approval",
      /An\s+answer\s+that\s+accepts\s+the\s+stacking\s+offer\s+approves\s+these\s+Git\s+branch\s+dependencies\s+for\s+the\s+run/u,
    ],
    [
      "policy:recompute-whole-selection",
      /run\s+the\s+dependency\s+check\s+again\s+over\s+the\s+whole\s+selection\s+and\s+recompute\s+the\s+order\s+and\s+the\s+Git\s+branch\s+plan/u,
    ],
    [
      "policy:unanswered-stacking-offer-declines",
      /A\s+go-ahead\s+that\s+does\s+not\s+answer\s+the\s+stacking\s+offer\s+declines\s+it/u,
    ],
    [
      "policy:stacking-changes-only-where-branches-start",
      /Stacking\s+the\s+run\s+changes\s+where\s+branches\s+start\s+and\s+how\s+a\s+stop\s+spreads\s+along\s+the\s+stack,\s+and\s+nothing\s+else/u,
    ],
    [
      "policy:stacking-only-while-predecessor-unmerged",
      /while\s+that\s+task\s+is\s+unmerged,\s+and\s+from\s+the\s+updated\s+integration\s+branch\s+once\s+it\s+is\s+merged/u,
    ],
    [
      "policy:any-difference-is-material",
      /Any\s+difference\s+in\s+these\s+items\s+is\s+material,\s+except\s+a\s+base\s+that\s+changes\s+only\s+because\s+a\s+task\s+was\s+merged,\s+as\s+the\s+approved\s+plan\s+anticipated\./u,
    ],
    [
      "policy:git-tracked-clarification-must-be-in-effect",
      /counts\s+as\s+recorded\s+only\s+once\s+it\s+is\s+in\s+effect\s+on\s+the\s+integration\s+branch/u,
    ],
    [
      "policy:run-stack-start-needs-prerequisite-beneath",
      /A\s+task\s+starts\s+only\s+on\s+a\s+base\s+that\s+contains\s+the\s+work\s+of\s+each\s+of\s+its\s+prerequisites/u,
    ],
    [
      "policy:review-heads-before-start",
      /If several prerequisites are under review, the starting head must\s+contain every one of their current review heads\. Verify this before marking the\s+task started/u,
    ],
    [
      "policy:repeated-offer-spares-created-bases",
      /The\s+repeated\s+offer\s+applies\s+only\s+to\s+tasks\s+not\s+yet\s+started/u,
    ],
    [
      "policy:stop-resume-needs-go-ahead",
      /If\s+the\s+stop\s+is\s+resolved\s+without\s+changing\s+the\s+plan,\s+the\s+authorizer's\s+go-ahead\s+is\s+enough\s+to\s+resume\s+them/u,
    ],
    [
      "policy:stopped-task-stops-stacked-tasks",
      /When\s+a\s+task\s+in\s+a\s+stacked\s+run\s+stops\s+or\s+is\s+postponed,\s+the\s+tasks\s+whose\s+branches\s+are\s+stacked\s+on\s+it,\s+directly\s+or\s+through\s+other\s+tasks,\s+stop\s+too/u,
    ],
    [
      "policy:declining-run-stacking-keeps-selective-dependencies",
      /Declining\s+run-wide\s+stacking\s+leaves\s+separately\s+approved\s+Git\s+branch\s+dependencies\s+unchanged/u,
    ],
    [
      "policy:recompute-plan-after-clarification",
      /start\s+neither\s+preflight\s+nor\s+development\s+before\s+it\s+is\s+given/u,
    ],
    ["policy:settle-project-pipeline", "Settle which pipeline applies before"],
    [
      "policy:run-never-merges-to-unblock",
      /The run never merges a\s+pull request merely to unblock a later selected task\./u,
    ],
    [
      "policy:project-pipeline-keeps-gates",
      /it never removes a gate of this skill,\s+and the non-negotiable rules above still hold\./u,
    ],
    [
      "policy:keep-task-state-true",
      /Mark the task\s+started in preflight, before the first change\./u,
    ],
    [
      "policy:refused-transition-stops",
      /A transition the\s+tracker\s+refuses\s+is\s+a\s+stop\s+condition/u,
    ],
    [
      "policy:no-binding-run-you-cannot-finish",
      /Never start a binding run\s+you\s+cannot finish/u,
    ],
    [
      "policy:never-choose-the-target",
      "Never pick a milestone or a task yourself.",
    ],
    [
      "policy:preflight-dependencies-done",
      /logical\s+dependencies are DONE or the authorizer has decided how to proceed/u,
    ],
    ["policy:scope", "Stay in scope."],
    ["policy:handoff-is-offer-not-gate", "It is an offer, never a gate"],
    [
      "policy:handoff-is-context-handoff",
      "A handoff is a context handoff: a map to recorded state for the context",
    ],
    [
      "policy:handoff-not-a-review-input",
      /It is never an input to independent review, second review, verification,\s+or external review/u,
    ],
    ["policy:handoff-untrusted-input", /treats it as untrusted\s+input/u],
    [
      "policy:checkpoint-location",
      "live at `.task-delivery/<task>/checkpoints/`",
    ],
    [
      "policy:checkpoint-written-at-every-gate",
      "written by the implementation context at every gate",
    ],
    ["policy:checkpoint-no-runtime", "work without a Runtime"],
    [
      "policy:checkpoint-not-a-review-input",
      /it never reaches independent\s+review, second review, verification, or external review/u,
    ],
    ["policy:checkpoint-immutable", /A published checkpoint\s+is immutable/u],
    [
      "policy:checkpoint-untrusted-resume",
      "re-validates the recorded head commit and working tree",
    ],
    [
      "policy:checkpoint-never-validates-gate",
      "No checkpoint can validate a passed gate",
    ],
    [
      "policy:checkpoint-branch-name-encoding",
      /branch name encoded when it is not a safe path\s+segment/u,
    ],
    [
      "policy:checkpoint-exclude-prerequisite",
      /the exclude is an operational\s+prerequisite the executor verifies or configures before the first\s+checkpoint/u,
    ],
  ];

  test("the contract pins the checkpoint and the multi-task rules together", () => {
    expect(contract.requiredFiles).toEqual(
      expect.arrayContaining([
        "references/checkpoints.md",
        "references/multi-task.md",
      ]),
    );
    const ids = contract.invariants.map((invariant) => invariant.id);
    expect(
      ids.filter((id) => id.startsWith("policy:checkpoint-")),
    ).toHaveLength(9);
    expect(
      contract.invariants.filter(
        (invariant) => invariant.file === "references/multi-task.md",
      ),
    ).toHaveLength(16);
  });

  test("every contract invariant has a removal case", () => {
    expect(removals.map(([id]) => id).sort()).toEqual(
      contract.invariants.map((invariant) => invariant.id).sort(),
    );
  });

  test.each(removals)("requires %s", (id, removed) => {
    const { skillRoot } = repositoryCopy();
    const file =
      contract.invariants.find((invariant) => invariant.id === id)?.file ??
      "SKILL.md";
    rewrite(join(skillRoot, file), (source) => source.replace(removed, ""));

    expect(validateSkillPackage(skillRoot)).toContain(
      `${file} is missing required content: ${id}`,
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

  test("task state is kept true: started, in review, done, and never forced", () => {
    const core = canonicalSkill
      .slice(0, canonicalSkill.indexOf("<!-- executors:start -->"))
      .replace(/\s+/gu, " ");
    const reference = (name: string): string =>
      readFileSync(
        join(canonicalSkillRoot, "references", name),
        "utf8",
      ).replace(/\s+/gu, " ");

    // The three transitions, in order, each tied to its moment.
    // One trigger, stated in the core: enabled, or a command, or a tracker
    // the project documents - and only an explicit switch turns it off.
    expect(core).toMatch(
      /## Task state The project tracks task state when its configuration enables that or configures a command for it, or when its own instructions describe a system that holds its tasks\. Only a configuration that switches it off explicitly says otherwise\. When you cannot tell, ask in preflight instead of skipping it\./u,
    );
    expect(core).toMatch(
      /Where task state is tracked, keep it true as the work moves\. Mark the task started in preflight, before the first change\. Mark it in review when its pull request is open\. Mark it done only after stage 11\./u,
    );
    // How: configured commands, else the project's documented way, else a
    // report - and a refusal stops the work.
    expect(core).toMatch(
      /Use the commands the project configures for this; without them, use the project's own documented way of changing task state, and only where there is none report each transition for someone else to apply\./u,
    );
    expect(core.indexOf("## Task state")).toBeLessThan(
      core.indexOf("## What to deliver"),
    );

    const lifecycle = reference("lifecycle.md");
    expect(lifecycle).toMatch(
      /Where the project tracks task state, mark the task started before the first change\. If the tracker refuses, stop\./u,
    );
    expect(lifecycle).toMatch(
      /Where the project tracks task state, mark the task as in review\. - Do not request merge\./u,
    );
    expect(lifecycle).toMatch(
      /After the post-merge verification passes, mark the task done where the project tracks task state\./u,
    );
    // Done is marked in the post-merge stage and nowhere earlier.
    expect(lifecycle.indexOf("mark the task done")).toBeGreaterThan(
      lifecycle.indexOf("## 11. Post-merge verification / completion"),
    );
    expect(reference("stop-conditions.md")).toMatch(
      /\*\*Refused task transition\.\*\* The system that tracks the project's tasks refuses to mark the task started, in review, or done\. Report what it said; never work around it or change the state another way\./u,
    );

    const configuration = reference("configuration.md");
    for (const key of ["start", "review", "complete"])
      expect(configuration).toContain(`\`task_lifecycle.${key}\``);
    expect(configuration).toMatch(
      /In the `task_lifecycle` commands, `\{task\}` stands for the identifier of the task in the system that tracks it\./u,
    );
    expect(configuration).toMatch(
      /When task state is tracked - `task_lifecycle\.enabled` is `true`, a command is configured, or the project's instructions describe a tracker and the key is not `false` - every transition is made: with the configured command; without one, in the project's own documented way of changing task state; and only where there is none, by reporting the transition so the tracker's owner can apply it\. A refused transition is a stop condition\./u,
    );
    expect(configuration).toMatch(
      /`task_lifecycle\.enabled: false` together with a `task_lifecycle` command is an error: the commands would never run\./u,
    );
    // The Keys table states the same default as the core: not "false".
    expect(configuration).toMatch(
      /\| `task_lifecycle\.enabled` \| `true`: task state is tracked outside Git\. `false`: it is not, and the skill never touches it \| Tracked when a command below is configured or the project's instructions describe a tracker \|/u,
    );
    expect(core).toMatch(
      /Check the task's current state first: a task already in the state you would set needs nothing; when you do not know how the tracker identifies the task, ask\./u,
    );
    expect(core).toMatch(
      /A transition the tracker refuses is a stop condition: report what it said, and never work around it\./u,
    );
    expect(core).toMatch(
      /A transition that would itself start a binding run falls under the rule on binding runs below\./u,
    );
  });

  describe("what to deliver", () => {
    const core = canonicalSkill
      .slice(0, canonicalSkill.indexOf("<!-- executors:start -->"))
      .replace(/\s+/gu, " ");
    const section = core.slice(
      core.indexOf("## What to deliver"),
      core.indexOf("## Lifecycle"),
    );
    const reference = (name: string): string =>
      readFileSync(
        join(canonicalSkillRoot, "references", name),
        "utf8",
      ).replace(/\s+/gu, " ");

    const multi = reference("multi-task.md");

    const documents: [string, string][] = [
      ["SKILL.md", core],
      ...[
        "branch-policy.md",
        "configuration.md",
        "evidence.md",
        "lifecycle.md",
        "qa-checklist.md",
        "review-checklist.md",
        "stop-conditions.md",
        "multi-task.md",
      ].map((name): [string, string] => [name, reference(name)]),
      [
        "pr-template.md",
        readFileSync(
          join(canonicalSkillRoot, "assets", "pr-template.md"),
          "utf8",
        ).replace(/\s+/gu, " "),
      ],
    ];

    test("a run without a target asks before preflight, with three choices", () => {
      expect(core.indexOf("## What to deliver")).toBeGreaterThan(-1);
      expect(core.indexOf("## What to deliver")).toBeLessThan(
        core.indexOf("### 1. Preflight"),
      );
      expect(section).toMatch(/ask before doing anything else/u);
      expect(section.match(/\b\d\. \*\*/gu)).toHaveLength(3);
      expect(section).toMatch(/1\. \*\*A whole milestone\*\*/u);
      expect(section).toMatch(/2\. \*\*One or more tasks\*\*/u);
      expect(section).toMatch(/3\. \*\*Some tasks of one milestone\*\*/u);
      expect(section).toMatch(/Offer these choices and wait:/u);
      expect(section).toMatch(/Never pick a milestone or a task yourself\./u);
      expect(section).toMatch(
        /When the request already names the target, do not ask for the target again; the pipeline is still settled, and the dependency check and the summary rule below still apply\./u,
      );
    });

    test("dependencies are checked, then summarized, then approved", () => {
      const check = section.indexOf("check the dependencies of the selection");
      const summary = section.indexOf(
        "Show one summary and ask for the go-ahead",
      );
      const approval = section.indexOf(
        "Start preflight only after the authorizer approves that summary",
      );
      expect(check).toBeGreaterThan(-1);
      expect(summary).toBeGreaterThan(check);
      expect(approval).toBeGreaterThan(summary);
      expect(section).toMatch(
        /A run over several tasks gives each task its own branch, pull request, and evidence; each ends at READY FOR MERGE\./u,
      );
      expect(section).toMatch(/\[multi-task\]\(references\/multi-task\.md\)/u);
    });

    // A logical task dependency and a Git branch dependency are independent.
    // The section is short, so every sentence of it is pinned: an edit or an
    // added sentence has to be made here too, in view of this distinction.
    // This is a tripwire for accidental drift, not a proof of meaning.
    test("the section is exactly these sentences", () => {
      const sentences = section
        .replace(/^## What to deliver /u, "")
        .split(/(?<=[.:]) (?=[A-Z0-9]|- )/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence !== "");

      expect(sentences).toEqual([
        "When the request does not say what to deliver - no task, milestone, or other target - ask before doing anything else.",
        "Offer these choices and wait:",
        "1. **A whole milestone**: every open task of one milestone.",
        "2. **One or more tasks**: the tasks the authorizer names.",
        "3. **Some tasks of one milestone**: a milestone, then a selection of its tasks.",
        "Never pick a milestone or a task yourself.",
        "When the request already names the target, do not ask for the target again; the pipeline is still settled, and the dependency check and the summary rule below still apply. ### Pipeline The project may define delivery pipelines of its own, in its instructions or in the system that tracks its tasks.",
        "Settle which pipeline applies before preflight, and never choose one yourself:",
        "- Enforced by the project: state it; there is no choice to offer.",
        "- Project default: ask whether to use it and wait for the answer; if declined, ask what to follow instead.",
        "- Several possible, none default or enforced: list them and ask which, if any.",
        "- None defined: do not ask.",
        "A project pipeline that is used decides the stages, assignments, and transitions of the work.",
        "A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold.",
        "A project stage may cover several gates of this skill; each gate still keeps its own criteria and its own evidence.",
        "Using a pipeline does not by itself mean starting anything in the project's systems.",
        "If it would start a run that binds the task (one whose stages only that system's assigned performers can complete), check first that you are such a performer for every stage.",
        "If you are not, do not start it: tell the authorizer what the run requires, let them decide how to proceed, and record their decision with the evidence.",
        "When you cannot tell whether a run would bind the task, or whether you are assigned to every stage, do not start it either: ask the authorizer.",
        "Never start a binding run you cannot finish, and never override or cancel one on your own. ### Dependencies and summary Once the target is known, and before showing anything for approval, check the dependencies of the selection.",
        "The check always runs; when individual tasks were chosen it is done for every selected task: find what each logically depends on and its state - DONE, selected, or neither.",
        "- A dependency that is neither DONE nor selected is unresolved: name it, and propose adding it to the run or postponing the task that needs it.",
        "- A selected prerequisite is planned, not resolved: it stays unresolved until it is DONE.",
        "- Never drop or reorder a task silently.",
        "- A selected prerequisite is worked on before the task that needs it, and that task starts only once the prerequisite is DONE or the authorizer has approved a Git branch dependency on it.",
        "- When the behavior a task needs already exists on a prerequisite branch that is not merged, and the project allows stacked work, you may also propose, explicitly, a Git branch dependency on that branch, as the [branch policy](references/branch-policy.md) describes.",
        "- Stacking neither satisfies nor cancels the logical task dependency: record the two dependencies separately, keep the task dependency listed as unresolved, and never treat the prerequisite as DONE until its own lifecycle has reached DONE.",
        "Show one summary and ask for the go-ahead, with these items:",
        "- the tasks in the proposed order, each with what it depends on; - every unresolved dependency, with its proposal; - any proposed Git branch dependency, kept apart from the task dependencies; - the pipeline that will be used, and anything excluded; - for a run over several tasks, the two questions of [multi-task](references/multi-task.md): clarify first, and stack.",
        "Start preflight only after the authorizer approves that summary.",
        "Only a request that itself names exactly one task skips the summary: make the same dependency check in preflight and stop on an unresolved dependency until the authorizer decides.",
        "Every other selection, including one task chosen from the choices above, needs the approved summary. ### Several tasks A run over several tasks gives each task its own branch, pull request, and evidence; each ends at READY FOR MERGE.",
        "Clarify-first, run-wide stacking, re-planning, and stop propagation are in [multi-task](references/multi-task.md); read it whenever the selection has more than one task.",
        "Branch bases are in [branch policy](references/branch-policy.md).",
      ]);
    });

    // Across the core, the references and the pull request template, no
    // statement about a task, a dependency, a prerequisite, a branch or a
    // pull request may count or treat it as DONE, satisfied, resolved,
    // merged, delivered or met - the usual shape of a sentence that lets an
    // open pull request, a READY FOR MERGE task or a stacked branch stand in
    // for a finished task. The one statement that matches is the rule
    // forbidding it. Other prose is none of this test's business.
    test("no task or dependency is counted or treated as done before it is", () => {
      const equivalence =
        /\b(?:counts?|counted|counting|treat(?:s|ed|ing)?|regard(?:s|ed|ing)?|consider(?:s|ed|ing)?|good|same)\b[^.]{0,80}?\bas (?:done|satisfied|resolved|merged|delivered|met|accepted|completed?)\b/iu;
      // Statements are read from the Markdown as written: a heading, a list
      // item, a table row and a paragraph are separate blocks, and a block is
      // split into sentences at ".", "?" and "!" only - never at a dash or a
      // colon inside a sentence. A statement's subject is named in the
      // statement itself; only when it speaks of "it" or "them" does the
      // statement before it count.
      const subject =
        /\btasks?\b|dependenc|prerequisite|branch|pull request|stack|READY FOR MERGE/iu;
      const pronoun =
        /\b(?:counts?|counted|counting|treat(?:s|ed|ing)?|regard(?:s|ed|ing)?|consider(?:s|ed|ing)?)\s+(?:it|them|this|that|these|those)\b/iu;
      const statementsOf = (markdown: string): string[] =>
        markdown
          // A heading line is a block of its own, with or without blank
          // lines around it.
          .replace(/^(#{1,6} .*)$/gmu, "\n\n$1\n\n")
          .split(/\n{2,}|\n(?=[ \t]*(?:[-*]|\d+\.) )|\n(?=\|)/u)
          .flatMap((block) => {
            const text = block.replace(/\s+/gu, " ").trim();
            return /^#{1,6} /u.test(text)
              ? [text]
              : text.split(/(?<=[.?!]) (?=\S)/u);
          })
          .map((statement) => statement.replace(/^(?:[-*]|\d+\.) /u, ""))
          .filter((statement) => statement !== "");
      const matchesIn = (markdown: string): string[] => {
        const statements = statementsOf(markdown);
        return statements.filter(
          (statement, index) =>
            equivalence.test(statement) &&
            (subject.test(statement) ||
              (pronoun.test(statement) &&
                subject.test(statements[index - 1] ?? ""))),
        );
      };
      const raw = (path: string[]): string =>
        readFileSync(join(canonicalSkillRoot, ...path), "utf8");
      const texts = [
        canonicalSkill.slice(
          0,
          canonicalSkill.indexOf("<!-- executors:start -->"),
        ),
        ...[
          "lifecycle.md",
          "stop-conditions.md",
          "branch-policy.md",
          "evidence.md",
          "configuration.md",
          "review-checklist.md",
          "qa-checklist.md",
          "multi-task.md",
        ].map((name) => raw(["references", name])),
        raw(["assets", "pr-template.md"]),
      ];

      expect(texts.flatMap(matchesIn)).toEqual([
        "Stacking neither satisfies nor cancels the logical task dependency: record the two dependencies separately, keep the task dependency listed as unresolved, and never treat the prerequisite as DONE until its own lifecycle has reached DONE.",
      ]);

      // The guard itself. Sentence-initial imperatives are caught whatever
      // their case, with the subject in the statement or just before "it" -
      // also when that earlier sentence has dashes or a colon in it, and when
      // it is the list item above.
      const caught = (markdown: string): string[] => matchesIn(markdown);
      expect(
        caught(
          "- A prerequisite whose pull request is READY FOR MERGE. Treat it as DONE and continue.",
        ),
      ).toEqual(["Treat it as DONE and continue."]);
      expect(
        caught(
          "- A prerequisite whose pull request is open - reviewed or not - is close enough. Treat it as DONE and continue.",
        ),
      ).toEqual(["Treat it as DONE and continue."]);
      expect(
        caught(
          "- A prerequisite waits on two checks: 1 review and 1 verification. Treat it as DONE and continue.",
        ),
      ).toEqual(["Treat it as DONE and continue."]);
      expect(
        caught(
          "- The pull request is approved - every check is green. Count it as merged.",
        ),
      ).toEqual(["Count it as merged."]);
      expect(
        caught(
          "- A prerequisite is still open.\n- Treat it as DONE and continue.",
        ),
      ).toEqual(["Treat it as DONE and continue."]);
      expect(
        caught("A stacked dependency Counts As Satisfied here."),
      ).toHaveLength(1);

      // Prose about something else is left alone wherever it is placed:
      // alone, after a sentence or a question that mentions a task, in a
      // list, directly under a heading that names a dependency or a pull
      // request, and before text that starts with a code span.
      const unrelated =
        "Always treat a finding as resolved only after its test fails without the fix.";
      for (const markdown of [
        unrelated,
        `Is every changed file needed for this task? ${unrelated}`,
        `Read the code of the pull request. ${unrelated} Report each finding.`,
        `## Tests\n\n- Do tests fail without the change and pass with it?\n- ${unrelated}\n- Are tests isolated from the branch under review?`,
        `## Two different dependencies\n\n${unrelated}\n\nA task dependency is logical.`,
        `## 4. Pull Request\n\n${unrelated}`,
        `## Dependencies\n${unrelated}`,
        `# Branch and dependency policy\n\n${unrelated}`,
        `${unrelated}\n\n\`integration_branch\` names the branch tasks start from.`,
        `| Task B depends on A | Base for B |\n| --- | --- |\n| No | ${unrelated} |`,
      ])
        expect(caught(markdown)).toEqual([]);
    });

    test("the pipeline is settled before preflight and never chosen by the executor", () => {
      const settle = section.indexOf(
        "Settle which pipeline applies before preflight, and never choose one yourself:",
      );
      expect(settle).toBeGreaterThan(
        section.indexOf("3. **Some tasks of one milestone**"),
      );
      expect(settle).toBeLessThan(
        section.indexOf("check the dependencies of the selection"),
      );
      // One rule per situation: enforced, default, several, none.
      expect(section).toMatch(
        /- Enforced by the project: state it; there is no choice to offer\. - Project default: ask whether to use it and wait for the answer; if declined, ask what to follow instead\. - Several possible, none default or enforced: list them and ask which, if any\. - None defined: do not ask\./u,
      );
      // A named target skips the target question, not the pipeline.
      expect(section).toMatch(
        /do not ask for the target again; the pipeline is still settled/u,
      );
      // The choice is part of what the authorizer approves.
      expect(section).toMatch(
        /- the pipeline that will be used, and anything excluded;/u,
      );
      // The neutral core names no product for it.
      expect(section).not.toMatch(/office|runtime|daemon/iu);
    });

    // An executor that started the project's enforced pipeline run could not
    // complete its first stage: only the project's own registered performers
    // could. The skill must check before starting, and never force its way
    // out afterwards.
    test("a binding pipeline run is never started by an executor who cannot finish it", () => {
      expect(section).toMatch(
        /Using a pipeline does not by itself mean starting anything in the project's systems\./u,
      );
      expect(section).toMatch(
        /If it would start a run that binds the task \(one whose stages only that system's assigned performers can complete\), check first that you are such a performer for every stage\. If you are not, do not start it: tell the authorizer what the run requires, let them decide how to proceed, and record their decision with the evidence\. When you cannot tell whether a run would bind the task, or whether you are assigned to every stage, do not start it either: ask the authorizer\./u,
      );
      expect(section).toMatch(
        /Never start a binding run you cannot finish, and never override or cancel one on your own\./u,
      );
      // The check comes with the pipeline, before dependencies and preflight.
      expect(
        section.indexOf("Never start a binding run you cannot finish"),
      ).toBeLessThan(
        section.indexOf("check the dependencies of the selection"),
      );
      expect(reference("stop-conditions.md")).toMatch(
        /\*\*Binding run you cannot complete\.\*\* Using the project's pipeline would start a run whose stages only the project's own assigned performers can complete, and you are not assigned to every stage needed to complete it - or such a run is already active for the task and you cannot complete it - or you cannot tell whether either is the case\. Do not start, override, or cancel it; report what it requires and wait\./u,
      );
    });

    test("a project pipeline maps onto the gates without removing any", () => {
      expect(section).toMatch(
        /A project pipeline that is used decides the stages, assignments, and transitions of the work\. A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold\. A project stage may cover several gates of this skill; each gate still keeps its own criteria and its own evidence\./u,
      );
      expect(section).toMatch(
        /A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold\./u,
      );
    });

    // The contract about project pipelines lives in these statements and
    // nowhere else. The list is closed across the core, the references and
    // the pull request template, so a statement about pipelines added to
    // another document - for example one letting a shorter pipeline drop a
    // gate - has to be added here deliberately. It checks where pipelines
    // are mentioned, not what any other prose means.
    test("the statements about pipelines are exactly these", () => {
      const statements = documents.flatMap(([name, text]) =>
        text
          .split(/(?<=[.:]) (?=[A-Z0-9*`[<-])| \| | (?=#{2,3} )/u)
          .map((part) => part.trim())
          .filter((part) => /pipeline/iu.test(part))
          .map((part) => `${name}: ${part}`),
      );

      expect(statements).toEqual([
        "SKILL.md: Use when asked to deliver, ship, or carry a task or ticket through to a reviewable pull request, to run a delivery pipeline over one or more tasks, or to review, harden, or verify a change before merge. license:",
        "SKILL.md: When the request already names the target, do not ask for the target again; the pipeline is still settled, and the dependency check and the summary rule below still apply.",
        "SKILL.md: ### Pipeline The project may define delivery pipelines of its own, in its instructions or in the system that tracks its tasks.",
        "SKILL.md: Settle which pipeline applies before preflight, and never choose one yourself:",
        "SKILL.md: A project pipeline that is used decides the stages, assignments, and transitions of the work.",
        "SKILL.md: A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold.",
        "SKILL.md: Using a pipeline does not by itself mean starting anything in the project's systems.",
        "SKILL.md: - the tasks in the proposed order, each with what it depends on; - every unresolved dependency, with its proposal; - any proposed Git branch dependency, kept apart from the task dependencies; - the pipeline that will be used, and anything excluded; - for a run over several tasks, the two questions of [multi-task](references/multi-task.md): clarify first, and stack.",
        "configuration.md: A project may bind them to its own role names and to any executor; the pipeline stays the same when the executor changes.",
        "stop-conditions.md: - **Binding run you cannot complete.** Using the project's pipeline would start a run whose stages only the project's own assigned performers can complete, and you are not assigned to every stage needed to complete it - or such a run is already active for the task and you cannot complete it - or you cannot tell whether either is the case.",
        "multi-task.md: - If the selection, the order, a task dependency, a Git branch dependency, the pipeline, or the exclusions changed materially, show a new summary and ask for a new approval, and start neither preflight nor development before it is given.",
      ]);
    });

    test("a run may clarify every task before development starts", () => {
      // The question is asked in the summary, before the go-ahead.
      expect(section).toMatch(
        /for a run over several tasks, the two questions of \[multi-task\]\(references\/multi-task\.md\): clarify first, and stack\./u,
      );
      expect(multi).toMatch(
        /Ask both in the same summary as the go-ahead: - Clarify every task before development starts\? - Where the project allows stacked work, stack each task on the one before it\? \(proposed by default; an unanswered offer declines it\)/u,
      );
      expect(multi).toMatch(
        /When the authorizer chooses it, take the selected tasks one at a time, in the approved order, before any development branch is created or any code is written\./u,
      );
      expect(multi).toMatch(
        /Ask together every question whose answer would change what is built\. - Record the answers where the project keeps its tasks and requirements, through its own way of changing them, and show what changed\. With no such place, report the clarified task instead\./u,
      );
      expect(multi).toMatch(
        /With clarify-first, development starts only when no selected task has an open question\. A question that only comes up later is still a stop condition\./u,
      );
    });

    test("the plan is recomputed after clarification and a materially changed plan is approved again", () => {
      const recompute = multi.indexOf(
        "Once every selected task is clarified and its answers are recorded, run the dependency check again over the whole selection",
      );
      // After the clarification rule, before the stacking rule.
      expect(recompute).toBeGreaterThan(
        multi.indexOf(
          "A question that only comes up later is still a stop condition.",
        ),
      );
      expect(recompute).toBeLessThan(multi.indexOf("## 4. Run-wide stacking"));
      expect(multi).toMatch(
        /recompute the order and the Git branch plan\. Compare the result with the approved summary\. - If the selection, the order, a task dependency, a Git branch dependency, the pipeline, or the exclusions changed materially, show a new summary and ask for a new approval, and start neither preflight nor development before it is given\. - Any difference in these items is material, except a base that changes only because a task was merged, as the approved plan anticipated\. - If nothing changed materially, say so and do not ask a second time\./u,
      );
      expect(multi).toMatch(
        /The repeated offer applies only to tasks not yet started: a base already created under an accepted stacking answer stays approved, and only an explicit decision of the authorizer changes it\./u,
      );
      // Task and Git branch dependencies stay two separate things.
      expect(multi).toMatch(/a task dependency, a Git branch dependency/u);
    });

    test("stacking a run is offered, approved in the summary, and changes only where branches start", () => {
      expect(multi).toMatch(
        /Proposed by default where the project allows stacked work: each task's branch starts from the branch of the task before it/u,
      );
      expect(multi).toMatch(
        /- An answer that accepts the stacking offer approves these Git branch dependencies for the run\. - A go-ahead that does not answer the stacking offer declines it; the plan then uses the bases without run-wide stacking\. - Declining run-wide stacking leaves separately approved Git branch dependencies unchanged\. Every other task starts from the integration branch unless another separately approved Git branch dependency applies\./u,
      );
      expect(multi).toMatch(
        /- A task starts only on a base that contains the work of each of its prerequisites: the branch of each unmerged prerequisite beneath it on the stack, and the merged work of each prerequisite that is DONE\. A prerequisite beneath the task in an approved stacked run counts as an approved Git branch dependency on it; otherwise the task waits, or needs a separately approved Git branch dependency on the prerequisite\./u,
      );
      // A declined run-wide stack never forces every task onto the
      // integration branch: it would drop a separately approved dependency.
      expect(multi).not.toMatch(/declining it keeps every task/u);
      expect(multi).toMatch(
        /Stacking the run changes where branches start and how a stop spreads along the stack, and nothing else: every task keeps its own pull request and gates, and its task dependencies stay as they were\./u,
      );
      expect(multi).toMatch(
        /When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it, directly or through other tasks, stop too, and so does every later task of the chain that is not yet started; the authorizer decides how their branches are rebuilt, and the changed plan is shown and approved before any of them starts\. If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them\./u,
      );
      const branchPolicy = reference("branch-policy.md");
      expect(branchPolicy).toMatch(
        /\| No \| - \| Integration branch, unless the authorizer approved stacking the run\. \|/u,
      );
      expect(branchPolicy).toMatch(
        /run-wide stacking is proposed by default and the authorizer may approve it once for the whole run; the reason stated in each pull request is then that the task is part of an approved stacked run\./u,
      );
      expect(branchPolicy).toMatch(
        /In a stacked run the first task starts from the integration branch and each later task's branch starts from the branch of the task before it while that task is unmerged; once it is merged, the next branch starts from the updated integration branch\. A separately approved Git branch dependency takes precedence over the run chain for its task\./u,
      );
      expect(branchPolicy).toMatch(
        /Declining run-wide stacking leaves separately approved Git branch dependencies unchanged; every other task starts from the integration branch unless another separately approved Git branch dependency applies\. A go-ahead that does not answer the stacking offer declines it\. A task starts only on a base that contains the work of each of its prerequisites: the branch of each unmerged prerequisite beneath it on the stack, and the merged work of each prerequisite that is DONE\. A prerequisite beneath the task in an approved stacked run counts as an approved Git branch dependency on it; otherwise the task waits, or needs a separately approved Git branch dependency on the prerequisite\./u,
      );
      expect(branchPolicy).toMatch(
        /When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it, directly or through other tasks, stop too, and so does every later task of the chain that is not yet started; the authorizer decides how their branches are rebuilt, and the changed plan is shown and approved before any of them starts\. If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them\. Never rewrite reviewed history to do so\./u,
      );
      expect(branchPolicy).toMatch(
        /An unrelated task must not inherit another task's unmerged commits, except in a run the authorizer approved as stacked\./u,
      );
    });

    test("a run over dependent tasks stops at READY FOR MERGE and never merges to unblock", () => {
      expect(section).toMatch(
        /A run over several tasks gives each task its own branch, pull request, and evidence; each ends at READY FOR MERGE\./u,
      );
      expect(multi).toMatch(
        /The run may continue with another selected task only if that task has no unresolved prerequisite that blocks execution, or if the authorizer has approved the required Git branch dependency, separately or by accepting run-wide stacking\. The run never merges a pull request merely to unblock a later selected task\. A stacked branch does not make the prerequisite task DONE and does not resolve the logical dependency\./u,
      );
      expect(multi).not.toMatch(
        /(?:delivers?|deliver)\s+(?:them|each task|the tasks)\s+one\s+at\s+a\s+time|whole lifecycle/iu,
      );
      // The tracker stays authoritative: an approved stack does not let a
      // task start when the tracker refuses it.
      expect(multi).toMatch(
        /Where task state is tracked, the tracker may refuse to start a task whose prerequisite is not DONE even on an approved Git branch dependency; that refusal stands, and the task waits\./u,
      );
      expect(core).toMatch(/READY FOR MERGE != DONE/u);
      expect(core).toMatch(/Never merge without explicit authorization/u);
    });

    // Every sentence, list item and table cell in the skill that speaks of
    // satisfying, resolving or settling something about a dependency, a
    // prerequisite, a base, a branch or stacking. The list is closed: a new
    // statement on the subject, anywhere in the package, has to be added
    // here deliberately. Like every wording check this is a tripwire for
    // accidental drift; it cannot stop a rewrite that avoids these words.
    test("the statements about satisfying a dependency are exactly these", () => {
      const statements = documents.flatMap(([name, text]) =>
        text
          .split(/(?<=[.:]) (?=[A-Z0-9*`[<-])| \| | (?=#{2,3} )/u)
          .map((part) => part.trim())
          .filter(
            (part) =>
              /satisf|resolv|settl/iu.test(part) &&
              /\bdepend|stack|prerequisite|\bbase\b|branch/iu.test(part),
          )
          .map((part) => `${name}: ${part}`),
      );

      expect(statements).toEqual([
        "SKILL.md: When the request already names the target, do not ask for the target again; the pipeline is still settled, and the dependency check and the summary rule below still apply.",
        "SKILL.md: - A dependency that is neither DONE nor selected is unresolved: name it, and propose adding it to the run or postponing the task that needs it.",
        "SKILL.md: - A selected prerequisite is planned, not resolved: it stays unresolved until it is DONE.",
        "SKILL.md: - Stacking neither satisfies nor cancels the logical task dependency: record the two dependencies separately, keep the task dependency listed as unresolved, and never treat the prerequisite as DONE until its own lifecycle has reached DONE.",
        "SKILL.md: - the tasks in the proposed order, each with what it depends on; - every unresolved dependency, with its proposal; - any proposed Git branch dependency, kept apart from the task dependencies; - the pipeline that will be used, and anything excluded; - for a run over several tasks, the two questions of [multi-task](references/multi-task.md): clarify first, and stack.",
        "SKILL.md: Only a request that itself names exactly one task skips the summary: make the same dependency check in preflight and stop on an unresolved dependency until the authorizer decides.",
        "branch-policy.md: - A satisfied Git dependency does not satisfy a task dependency: being stacked on A's branch does not mean A's task is accepted.",
        "lifecycle.md: A dependency that is not DONE is unresolved: stop until the authorizer decides.",
        "lifecycle.md: Decide the Git base separately, following the [branch policy](branch-policy.md); a stacked base never resolves a task dependency.",
        "stop-conditions.md: - **Unresolved task dependency.** The task logically depends on a task that is not DONE, and the authorizer has not decided how to proceed.",
        "stop-conditions.md: Behavior that is available on a stacked base lets work continue only under an approved Git branch dependency; it never satisfies the task dependency.",
        "multi-task.md: The run may continue with another selected task only if that task has no unresolved prerequisite that blocks execution, or if the authorizer has approved the required Git branch dependency, separately or by accepting run-wide stacking.",
        "multi-task.md: A stacked branch does not make the prerequisite task DONE and does not resolve the logical dependency.",
        "multi-task.md: - The logical dependencies remain unresolved until their tasks are DONE.",
      ]);
    });

    test("the rule and the table that define the two dependencies are intact", () => {
      expect(core).toMatch(
        /3\. \*\*Task dependency != Git branch dependency\.\*\* A task may logically depend on another without its branch being stacked on it, and the reverse\. Decide each one separately; see \[branch policy\]\(references\/branch-policy\.md\)\. 4\./u,
      );
      expect(reference("branch-policy.md")).toMatch(
        /\| Yes \| No \| Wait for A, or stack B on A's head if the project allows stacked work; in an approved stacked run, the run chain, whose base contains A\. \| ## Rules/u,
      );
    });

    test("no part of the section lets a branch settle a task dependency", () => {
      expect(section).not.toMatch(/branch policy (?:allows|permits)/iu);
      expect(section).not.toMatch(/\bunsatisfied\b|\bdelivered\b/iu);
      // The guard itself: it must be able to fail.
      expect("is delivered before").toMatch(/\bunsatisfied\b|\bdelivered\b/iu);
      expect("an unsatisfied dependency").toMatch(
        /\bunsatisfied\b|\bdelivered\b/iu,
      );
      expect(section).not.toMatch(
        /\b(?:counts? as|treat(?:ed)? (?:it|its dependency|the dependency) as|is then) (?:satisfied|resolved|DONE)\b/iu,
      );
    });

    test("the rest of the skill says the same about dependencies", () => {
      expect(core).toMatch(/Task dependency != Git branch dependency/u);
      expect(core).toMatch(
        /### 1\. Preflight Confirm the task is deliverable: acceptance criteria are explicit, logical dependencies are DONE or the authorizer has decided how to proceed, the working tree is clean, the base branch is chosen and current, and the full verification is green on the base commit before you change anything\. ### 2\. Design/u,
      );
      expect(core).not.toMatch(/satisfied or deliberately deferred/u);

      const stopConditions = reference("stop-conditions.md");
      expect(stopConditions).toMatch(
        /\*\*Unresolved task dependency\.\*\* The task logically depends on a task that is not DONE, and the authorizer has not decided how to proceed\. Behavior that is available on a stacked base lets work continue only under an approved Git branch dependency; it never satisfies the task dependency\./u,
      );
      expect(stopConditions).not.toMatch(
        /neither merged nor available on the chosen base/u,
      );

      expect(reference("lifecycle.md")).toMatch(
        /A dependency that is not DONE is unresolved: stop until the authorizer decides\. Decide the Git base separately, following the \[branch policy\]\(branch-policy\.md\); a stacked base never resolves a task dependency\./u,
      );
      expect(reference("branch-policy.md")).toMatch(
        /A satisfied Git dependency does not satisfy a task dependency: being stacked on A's branch does not mean A's task is accepted\./u,
      );
      expect(reference("branch-policy.md")).toMatch(
        /Stacking is the exception: it needs the authorizer's approval and a reason stated in the pull request\./u,
      );
      // The stop condition is one bullet with nothing appended to it.
      expect(stopConditions).toMatch(
        /it never satisfies the task dependency\. - \*\*Red baseline\.\*\*/u,
      );
      expect(reference("lifecycle.md")).toMatch(
        /a stacked base never resolves a task dependency\. - For each under-review prerequisite used as a base, verify that the proposed starting head contains its current review head\. With several such prerequisites, verify every head and record the commit IDs before marking the task started\. - Confirm the working tree is clean/u,
      );
    });
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
      /Its review covers only its own diff\. An external review command is run against that branch, not against the integration branch/u,
    );
    expect(reference("configuration.md")).toMatch(
      /`\{base\}` stands for the branch the task's pull request targets: the integration branch, or the branch the task is stacked on/u,
    );
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
