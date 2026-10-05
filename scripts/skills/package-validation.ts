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

/**
 * Executor and product names that must not leak into the vendor-neutral core.
 * They are allowed only between the executor block markers of `SKILL.md`.
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
}

interface SkillContract {
  readonly requiredFiles: readonly string[];
  /** Matched against `SKILL.md` with whitespace collapsed to single spaces. */
  readonly invariants: readonly ContentInvariant[];
}

function stage(id: string, title: string): ContentInvariant {
  return {
    id: `stage:${id}`,
    pattern: new RegExp(`#{2,3} \\d+\\. ${title}`, "u"),
  };
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
      "assets/pr-template.md",
    ],
    invariants: [
      stage("preflight", "Preflight"),
      stage("design", "Design"),
      stage("implementation", "Implementation"),
      stage("pull-request", "Pull Request"),
      stage("independent-review", "Independent Review"),
      stage("hardening", "Hardening"),
      stage("second-review", "Second Review"),
      stage("verification", "Verification"),
      stage("external-review", "External Review"),
      stage("ready-for-merge", "Ready for Merge"),
      stage("post-merge", "Post-merge verification"),
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
        id: "policy:scope",
        pattern: /stay in scope/iu,
      },
      {
        id: "executor-mapping",
        pattern:
          /<!-- executors:start -->.*Claude Code.*Codex.*<!-- executors:end -->/u,
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
 * Splits `SKILL.md` into its vendor-neutral core and the executor block.
 * Reports malformed or repeated markers.
 */
function splitExecutorBlock(
  source: string,
  errors: string[],
): { core: string } {
  const starts = source.split(executorBlockStart).length - 1;
  const ends = source.split(executorBlockEnd).length - 1;
  if (starts === 0 && ends === 0) return { core: source };
  const startIndex = source.indexOf(executorBlockStart);
  const endIndex = source.indexOf(executorBlockEnd);
  if (starts !== 1 || ends !== 1 || endIndex < startIndex) {
    errors.push(
      "SKILL.md must contain at most one well-formed executor block (executors:start ... executors:end)",
    );
    return { core: source };
  }
  return {
    core:
      source.slice(0, startIndex) +
      source.slice(endIndex + executorBlockEnd.length),
  };
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

/** Relative Markdown link targets of one document, fragments removed. */
function relativeLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/gu)) {
    const target = match[1]!;
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

  for (const entry of readdirSync(skillRoot).sort())
    if (!allowedTopLevelEntries.includes(entry))
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
  const { core } = splitExecutorBlock(source, errors);

  const contract = skillContracts[basename(skillRoot)];
  if (contract !== undefined) {
    for (const requiredFile of contract.requiredFiles)
      if (!files.includes(requiredFile))
        errors.push(`Required file is missing: ${requiredFile}`);
    const normalized = source.replace(/\s+/gu, " ");
    for (const invariant of contract.invariants)
      if (!invariant.pattern.test(normalized))
        errors.push(`SKILL.md is missing required content: ${invariant.id}`);
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
      else if (!existsSync(linkedPath))
        errors.push(`${file} links to a missing file: ${target}`);
      else linked.add(relative(skillRoot, linkedPath).split(sep).join("/"));
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
