import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  SkillPackageError,
  errorMessage,
  installManifestName,
  isRecord,
  listFiles,
  parseSkillFrontmatter,
} from "./shared.ts";

export const executorBlockStart = "<!-- executors:start -->";
export const executorBlockEnd = "<!-- executors:end -->";

const allowedTopLevelEntries = ["SKILL.md", "assets", "references", "scripts"];

// Frontmatter keys defined by the Agent Skills format. Anything else is a
// host-specific extension and would make the package less portable.
const allowedFrontmatterKeys = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
];

const maximumSkillLines = 500;
const maximumExecutorBlockLines = 40;

/**
 * Executor and product names that must not leak into the vendor-neutral core.
 * They are allowed only between the executor block markers of `SKILL.md`.
 * A denylist is a tripwire for the common slips, not proof of neutrality.
 */
const executorSpecificTerms: readonly { label: string; pattern: RegExp }[] = [
  { label: "Claude", pattern: /\bclaude\b/iu },
  { label: "Codex", pattern: /\bcodex\b/iu },
  { label: "Anthropic", pattern: /\banthropic\b/iu },
  { label: "OpenAI", pattern: /\bopenai\b/iu },
  { label: "Pi", pattern: /\bPi\b/u },
  { label: "Gemini", pattern: /\bgemini\b/iu },
  { label: "Copilot", pattern: /\bcopilot\b/iu },
  { label: "subagent", pattern: /\bsub-?agents?\b/iu },
  { label: ".claude path", pattern: /\.claude\b/u },
  { label: ".agents path", pattern: /\.agents\b/u },
  { label: "AI Office", pattern: /\bai[- ]office\b/iu },
];

interface ContentInvariant {
  readonly id: string;
  readonly pattern: RegExp;
  /** Skill-relative file that must state it; defaults to `SKILL.md`. */
  readonly file?: string;
}

interface SkillContract {
  readonly requiredFiles: readonly string[];
  /**
   * Titles of the numbered `### N. Title` lifecycle headings, in order. Each
   * heading must start with its title and be numbered consecutively from 1.
   */
  readonly stages: readonly string[];
  /**
   * Matched against the vendor-neutral core of `SKILL.md` (or the invariant's
   * own `file`) with whitespace collapsed to single spaces.
   */
  readonly invariants: readonly ContentInvariant[];
  /** Executors that need their own row in the executor block's table. */
  readonly executors: readonly string[];
}

/** Skill-specific contracts, keyed by skill name. */
export const skillContracts: Readonly<Record<string, SkillContract>> = {
  "task-delivery": {
    requiredFiles: [
      "references/lifecycle.md",
      "references/stop-conditions.md",
      "references/branch-policy.md",
      "references/review-checklist.md",
      "references/qa-checklist.md",
      "references/evidence.md",
      "references/configuration.md",
      "references/handoff.md",
      "references/multi-task.md",
      "references/checkpoints.md",
      "assets/pr-template.md",
    ],
    stages: [
      "Preflight",
      "Design",
      "Implementation",
      "Pull Request",
      "Independent Review",
      "Hardening",
      "Second Review",
      "Verification",
      "External Review",
      "Ready for Merge",
      "Post-merge verification",
    ],
    executors: ["Claude Code", "Codex", "Pi"],
    invariants: [
      {
        id: "policy:no-automatic-merge",
        pattern: /never merge without explicit authorization/iu,
      },
      {
        id: "policy:ready-for-merge-is-not-done",
        pattern: /READY FOR MERGE != DONE/u,
      },
      {
        id: "policy:task-dependency-is-not-branch-dependency",
        pattern: /task dependency != git branch dependency/iu,
      },
      {
        id: "policy:stop-on-unauthorized-architecture",
        pattern: /stop on any unauthorized architectural decision/iu,
      },
      {
        id: "policy:evidence-before-conclusion",
        pattern: /no stage and no task is concluded without evidence/iu,
      },
      {
        id: "policy:independent-contexts",
        pattern:
          /implementation, review, and verification must run in independent contexts/iu,
      },
      {
        id: "policy:required-external-review",
        pattern:
          /A required review must complete successfully: a timeout, a capacity or execution error, or an unavailable reviewer is a failed gate/u,
      },
      {
        id: "policy:installed-is-not-required",
        pattern: /Being installed does not make a reviewer required/u,
      },
      {
        id: "policy:ask-what-to-deliver",
        pattern:
          /When the request does not say what to deliver .* ask before doing anything else\. .*A whole milestone.*One or more tasks.*Some tasks of one milestone/u,
      },
      {
        id: "policy:check-dependencies-before-summary",
        pattern:
          /before showing anything for approval, check the dependencies of the selection\. The check always runs; when individual tasks were chosen it is done for every selected task/u,
      },
      {
        id: "policy:unresolved-dependency-proposals",
        pattern:
          /A dependency that is neither DONE nor selected is unresolved: name it, and propose adding it to the run or postponing the task that needs it\./u,
      },
      {
        id: "policy:stacking-does-not-satisfy-task-dependency",
        pattern:
          /Stacking neither satisfies nor cancels the logical task dependency: record the two dependencies separately, keep the task dependency listed as unresolved, and never treat the prerequisite as DONE until its own lifecycle has reached DONE\./u,
      },
      {
        id: "policy:clarify-before-development",
        file: "references/multi-task.md",
        pattern:
          /development starts only when no selected task has an open question\./u,
      },
      {
        id: "policy:run-stacking-needs-summary-approval",
        file: "references/multi-task.md",
        pattern:
          /An answer that accepts the stacking offer approves these Git branch dependencies for the run\./u,
      },
      {
        id: "policy:recompute-whole-selection",
        file: "references/multi-task.md",
        pattern:
          /run the dependency check again over the whole selection and recompute the order and the Git branch plan/u,
      },
      {
        id: "policy:unanswered-stacking-offer-declines",
        file: "references/multi-task.md",
        pattern:
          /A go-ahead that does not answer the stacking offer declines it/u,
      },
      {
        id: "policy:stacking-changes-only-where-branches-start",
        file: "references/multi-task.md",
        pattern:
          /Stacking the run changes where branches start and how a stop spreads along the stack, and nothing else/u,
      },
      {
        id: "policy:stacking-only-while-predecessor-unmerged",
        file: "references/multi-task.md",
        pattern:
          /while that task is unmerged, and from the updated integration branch once it is merged/u,
      },
      {
        id: "policy:any-difference-is-material",
        file: "references/multi-task.md",
        pattern:
          /Any difference in these items is material, except a base that changes only because a task was merged, as the approved plan anticipated\./u,
      },
      {
        id: "policy:git-tracked-clarification-must-be-in-effect",
        file: "references/multi-task.md",
        pattern:
          /counts as recorded only once it is in effect on the integration branch/u,
      },
      {
        id: "policy:run-stack-start-needs-prerequisite-beneath",
        file: "references/multi-task.md",
        pattern:
          /A task starts only on a base that contains the work of each of its prerequisites/u,
      },
      {
        id: "policy:review-heads-before-start",
        file: "references/multi-task.md",
        pattern:
          /If several prerequisites are under review, the starting head must contain every one of their current review heads\. Verify this before marking the task started/u,
      },
      {
        id: "policy:repeated-offer-spares-created-bases",
        file: "references/multi-task.md",
        pattern:
          /The repeated offer applies only to tasks not yet started: a base already created under an accepted stacking answer stays approved, and only an explicit decision of the authorizer changes it\./u,
      },
      {
        id: "policy:stopped-task-stops-stacked-tasks",
        file: "references/multi-task.md",
        pattern:
          /When a task in a stacked run stops or is postponed, the tasks whose branches are stacked on it, directly or through other tasks, stop too/u,
      },
      {
        id: "policy:stop-resume-needs-go-ahead",
        file: "references/multi-task.md",
        pattern:
          /If the stop is resolved without changing the plan, the authorizer's go-ahead is enough to resume them/u,
      },
      {
        id: "policy:declining-run-stacking-keeps-selective-dependencies",
        file: "references/multi-task.md",
        pattern:
          /Declining run-wide stacking leaves separately approved Git branch dependencies unchanged\. Every other task starts from the integration branch unless another separately approved Git branch dependency applies\./u,
      },
      {
        id: "policy:recompute-plan-after-clarification",
        file: "references/multi-task.md",
        pattern:
          /If the selection, the order, a task dependency, a Git branch dependency, the pipeline, or the exclusions changed materially, show a new summary and ask for a new approval, and start neither preflight nor development before it is given\./u,
      },
      {
        id: "policy:approve-summary-before-preflight",
        pattern:
          /Start preflight only after the authorizer approves that summary/u,
      },
      {
        id: "policy:settle-project-pipeline",
        pattern:
          /Settle which pipeline applies before preflight, and never choose one yourself:/u,
      },
      {
        id: "policy:project-pipeline-keeps-gates",
        pattern:
          /A project pipeline may group, rename, or add stages and gates; it never removes a gate of this skill, and the non-negotiable rules above still hold\./u,
      },
      {
        id: "policy:run-never-merges-to-unblock",
        file: "references/multi-task.md",
        pattern:
          /The run never merges a pull request merely to unblock a later selected task\./u,
      },
      {
        id: "policy:keep-task-state-true",
        pattern:
          /Mark the task started in preflight, before the first change\. Mark it in review when its pull request is open\. Mark it done only after stage 11\./u,
      },
      {
        id: "policy:refused-transition-stops",
        pattern: /A transition the tracker refuses is a stop condition/u,
      },
      {
        id: "policy:no-binding-run-you-cannot-finish",
        pattern:
          /Never start a binding run you cannot finish, and never override or cancel one on your own\./u,
      },
      {
        id: "policy:never-choose-the-target",
        pattern: /Never pick a milestone or a task yourself/u,
      },
      {
        id: "policy:preflight-dependencies-done",
        pattern:
          /logical dependencies are DONE or the authorizer has decided how to proceed/u,
      },
      {
        id: "policy:scope",
        pattern: /stay in scope/iu,
      },
      {
        id: "policy:handoff-is-offer-not-gate",
        pattern: /It is an offer, never a gate/iu,
      },
      {
        id: "policy:handoff-is-context-handoff",
        pattern:
          /A handoff is a context handoff: a map to recorded state for the context/iu,
      },
      {
        id: "policy:handoff-not-a-review-input",
        pattern:
          /It is never an input to independent review, second review, verification, or external review/iu,
      },
      {
        id: "policy:handoff-untrusted-input",
        pattern: /treats it as untrusted input/iu,
      },
      {
        id: "policy:checkpoint-location",
        pattern: /live at `\.task-delivery\/<task>\/checkpoints\/`/iu,
      },
      {
        id: "policy:checkpoint-written-at-every-gate",
        pattern: /written by the implementation context at every gate/iu,
      },
      {
        id: "policy:checkpoint-no-runtime",
        pattern: /work without a Runtime/iu,
      },
      {
        id: "policy:checkpoint-not-a-review-input",
        pattern:
          /it never reaches independent review, second review, verification, or external review/iu,
      },
      {
        id: "policy:checkpoint-immutable",
        pattern: /A published checkpoint is immutable/iu,
      },
      {
        id: "policy:checkpoint-untrusted-resume",
        pattern: /re-validates the recorded head commit and working tree/iu,
      },
      {
        id: "policy:checkpoint-never-validates-gate",
        pattern: /No checkpoint can validate a passed gate/iu,
      },
      {
        id: "policy:checkpoint-branch-name-encoding",
        pattern: /branch name encoded when it is not a safe path segment/iu,
      },
      {
        id: "policy:checkpoint-exclude-prerequisite",
        pattern:
          /the exclude is an operational prerequisite the executor verifies or configures before the first checkpoint/iu,
      },
    ],
  },
};

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * Splits `SKILL.md` into its vendor-neutral core and the executor block. The
 * block must be the last thing in the file and short, so it cannot swallow the
 * workflow it is meant to annotate.
 */
function splitExecutorBlock(
  source: string,
  errors: string[],
): { core: string; block: string | null } {
  const starts = source.split(executorBlockStart).length - 1;
  const ends = source.split(executorBlockEnd).length - 1;
  if (starts === 0 && ends === 0) return { core: source, block: null };
  const startIndex = source.indexOf(executorBlockStart);
  const endIndex = source.indexOf(executorBlockEnd);
  if (starts !== 1 || ends !== 1 || endIndex < startIndex) {
    errors.push(
      "SKILL.md must contain at most one well-formed executor block (executors:start ... executors:end)",
    );
    return { core: source, block: null };
  }
  const block = source.slice(startIndex + executorBlockStart.length, endIndex);
  if (source.slice(endIndex + executorBlockEnd.length).trim() !== "")
    errors.push("SKILL.md executor block must be the last section of the file");
  if (block.split("\n").length > maximumExecutorBlockLines)
    errors.push(
      `SKILL.md executor block exceeds ${maximumExecutorBlockLines} lines; it maps roles to executor primitives and nothing else`,
    );
  return { core: source.slice(0, startIndex), block };
}

function validateStages(
  core: string,
  stages: readonly string[],
  errors: string[],
): void {
  const headings = [...core.matchAll(/^### (\d+)\. (.+)$/gmu)];
  for (const [index, title] of stages.entries()) {
    const heading = headings[index];
    if (
      heading === undefined ||
      Number(heading[1]) !== index + 1 ||
      !heading[2]!.startsWith(title)
    ) {
      errors.push(
        `SKILL.md lifecycle stage ${index + 1} must be "### ${index + 1}. ${title}"`,
      );
      return;
    }
  }
  if (headings.length > stages.length)
    errors.push(
      `SKILL.md declares ${headings.length} lifecycle stages; the contract defines ${stages.length}`,
    );
}

function validateFrontmatter(
  source: string,
  skillRoot: string,
  errors: string[],
): void {
  let data: Record<string, unknown>;
  try {
    data = parseSkillFrontmatter(source).data;
  } catch (error) {
    errors.push(errorMessage(error));
    return;
  }
  for (const key of Object.keys(data))
    if (!allowedFrontmatterKeys.includes(key))
      errors.push(`SKILL.md frontmatter has a non-portable key: ${key}`);

  const { name, description, metadata } = data;
  if (typeof name !== "string" || name.trim() === "")
    errors.push("SKILL.md frontmatter requires a non-empty name");
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64)
      errors.push(
        "SKILL.md name must be lowercase kebab-case of at most 64 characters",
      );
    if (name !== basename(skillRoot))
      errors.push("SKILL.md name must match its directory name");
  }
  if (typeof description !== "string" || description.trim() === "")
    errors.push("SKILL.md frontmatter requires a non-empty description");
  else if (description.length > 1024)
    errors.push("SKILL.md description must not exceed 1024 characters");
  if (
    !isRecord(metadata) ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.version)
  )
    errors.push(
      "SKILL.md frontmatter requires metadata.version as a quoted MAJOR.MINOR.PATCH string",
    );
}

/**
 * Relative link targets of one Markdown document, fragments removed. Covers
 * inline links and reference definitions; fenced code blocks are examples,
 * not links.
 */
function relativeLinkTargets(markdown: string): string[] {
  const prose = markdown
    .replace(/^([ \t>]*)(```|~~~)[\s\S]*?^[ \t>]*\2.*$/gmu, "")
    .replace(/`[^`\n]*`/gu, "");
  const candidates = [
    ...[...prose.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)[^)]*\)/gu)].map(
      (match) => match[1]!,
    ),
    // Reference definitions with a path-like target. Footnotes ([^1]: ...)
    // and bracketed prose ([Note]: text) are not links.
    ...[
      ...prose.matchAll(
        /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]+<?([^\s>]*[./][^\s>]*)>?[ \t]*$/gmu,
      ),
    ].map((match) => match[1]!),
  ];
  const targets: string[] = [];
  for (const target of candidates) {
    if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target))
      continue;
    const withoutFragment = target.split("#", 1)[0]!;
    if (withoutFragment !== "") targets.push(withoutFragment);
  }
  return targets;
}

/**
 * Validates one canonical skill package. Returns human-readable problems; an
 * empty array means the package is valid.
 */
export function validateSkillPackage(skillRoot: string): string[] {
  const errors: string[] = [];
  const skillPath = join(skillRoot, "SKILL.md");
  if (!existsSync(skillPath) || !statSync(skillPath).isFile())
    return ["SKILL.md is missing"];

  let files: string[];
  try {
    files = listFiles(skillRoot);
  } catch (error) {
    if (error instanceof SkillPackageError) return [error.message];
    throw error;
  }

  const topLevelEntries = new Set(files.map((file) => file.split("/", 1)[0]!));
  for (const entry of readdirSync(skillRoot).sort())
    if (
      !allowedTopLevelEntries.includes(entry) &&
      // Ignored operating-system files are absent from `files`.
      (topLevelEntries.has(entry) ||
        statSync(join(skillRoot, entry)).isDirectory())
    )
      errors.push(
        `Unexpected top-level entry: ${entry} (allowed: ${allowedTopLevelEntries.join(", ")})`,
      );
  if (files.includes(installManifestName))
    errors.push(
      `${installManifestName} is reserved for installed copies and must not be in the canonical source`,
    );

  const source = readFileSync(skillPath, "utf8").replace(/\r\n/gu, "\n");
  validateFrontmatter(source, skillRoot, errors);
  if (source.split("\n").length > maximumSkillLines)
    errors.push(
      `SKILL.md exceeds ${maximumSkillLines} lines; move detail into references/`,
    );
  const { core, block } = splitExecutorBlock(source, errors);

  const skillName = basename(skillRoot);
  // An own-property lookup: a skill named "constructor" has no contract.
  const contract = Object.hasOwn(skillContracts, skillName)
    ? skillContracts[skillName]
    : undefined;
  if (contract !== undefined) {
    for (const requiredFile of contract.requiredFiles)
      if (!files.includes(requiredFile))
        errors.push(`Required file is missing: ${requiredFile}`);
    validateStages(core, contract.stages, errors);
    const normalized = core.replace(/\s+/gu, " ");
    for (const invariant of contract.invariants) {
      const file = invariant.file ?? "SKILL.md";
      const text =
        file === "SKILL.md"
          ? normalized
          : existsSync(join(skillRoot, file))
            ? readFileSync(join(skillRoot, file), "utf8").replace(/\s+/gu, " ")
            : "";
      if (!invariant.pattern.test(text))
        errors.push(`${file} is missing required content: ${invariant.id}`);
    }
    for (const executor of contract.executors)
      if (
        block === null ||
        // A row of the mapping table, not a passing mention in prose.
        !new RegExp(`^\\| ${executor} +\\|`, "mu").test(block)
      )
        errors.push(`SKILL.md executor block does not cover: ${executor}`);
  }

  const linked = new Set<string>();
  for (const file of files) {
    const text =
      file === "SKILL.md"
        ? core
        : readFileSync(join(skillRoot, file), "utf8").replace(/\r\n/gu, "\n");

    for (const term of executorSpecificTerms)
      if (term.pattern.test(text))
        errors.push(
          `${file} mentions an executor-specific term outside the executor block: ${term.label}`,
        );

    if (!file.endsWith(".md")) continue;
    // Links are read from the whole document, executor block included.
    const markdown = file === "SKILL.md" ? source : text;
    for (const target of relativeLinkTargets(markdown)) {
      const linkedPath = resolve(skillRoot, dirname(file), target);
      if (!isInside(skillRoot, linkedPath))
        errors.push(`${file} links outside the skill directory: ${target}`);
      else if (
        !statSync(linkedPath, { throwIfNoEntry: false })?.isFile() ||
        // Exact-case match, so a link that works on a case-insensitive
        // filesystem cannot break on a case-sensitive one.
        !files.includes(relative(skillRoot, linkedPath).split(sep).join("/"))
      )
        errors.push(`${file} links to a missing file: ${target}`);
      else if (relative(skillRoot, linkedPath).split(sep).join("/") !== file)
        linked.add(relative(skillRoot, linkedPath).split(sep).join("/"));
    }
  }
  for (const file of files)
    if (
      file !== "SKILL.md" &&
      file !== installManifestName &&
      !linked.has(file)
    )
      errors.push(`${file} is not linked from any document in the skill`);

  return errors;
}
