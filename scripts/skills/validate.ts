import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  taskDeliverySetupKeys,
  setupKnowledgePolicies,
} from "@ai-office/application/task-delivery-setup/task-delivery-setup-schema.ts";
import { installSkills } from "./install.ts";
import { validateSkillPackage } from "./package-validation.ts";
import {
  taskDeliverySetupKeysInSchema,
  validateTaskDeliveryConfig,
} from "./task-delivery-config.ts";
import {
  readExecutorsBlock,
  renderExecutorsBlock,
} from "./executor-block.ts";
import { knowledgePolicies } from "./knowledge-policy.ts";
import {
  SkillPackageError,
  canonicalSkillsDirectory,
  errorMessage,
  listCanonicalSkills,
  repositoryRoot,
} from "./shared.ts";

/**
 * Validates every canonical skill under `root`, that the installed executor
 * copies in the same repository are present, managed, and in sync, and the
 * repository's optional task-delivery configuration. Returns human-readable
 * problems; an empty array means everything is valid.
 */
export function validateSkills(root: string = repositoryRoot): string[] {
  const sourceRoot = resolve(root);
  const configErrors = validateTaskDeliveryConfig(sourceRoot);
  let skills: string[];
  try {
    skills = listCanonicalSkills(sourceRoot);
  } catch (error) {
    return [errorMessage(error), ...configErrors];
  }
  if (skills.length === 0)
    return [
      `No canonical skills found under ${canonicalSkillsDirectory}/`,
      ...configErrors,
    ];

  const errors = [
    ...skills.flatMap((skill) =>
      validateSkillPackage(
        join(sourceRoot, canonicalSkillsDirectory, skill),
      ).map((problem) => `${canonicalSkillsDirectory}/${skill}: ${problem}`),
    ),
    ...configErrors,
  ];
  if (skills.includes("task-delivery"))
    errors.push(...validateSetupContract(sourceRoot));
  // Installed copies are only comparable against a valid source.
  if (errors.some((error) => error.startsWith(`${canonicalSkillsDirectory}/`)))
    return errors;

  try {
    const report = installSkills({ sourceRoot, check: true });
    for (const orphan of report.orphans)
      errors.push(
        `${orphan}: installed copy has no canonical skill under ${canonicalSkillsDirectory}/; remove it`,
      );
    for (const target of report.targets) {
      for (const conflict of target.conflicts)
        errors.push(`${target.directory}: ${conflict}`);
      for (const change of target.changes)
        errors.push(
          `${target.directory}: out of sync with ${canonicalSkillsDirectory}/${target.skill} (${change.kind} ${change.path})`,
        );
    }
  } catch (error) {
    if (!(error instanceof SkillPackageError)) throw error;
    errors.push(error.message);
  }
  return errors;
}

/**
 * The setup contract must name the same keys in three places: the Runtime
 * setup schema (application), the `.task-delivery.yaml` schema, and the
 * `### Setup keys` table of the skill's configuration reference. The
 * knowledgePolicy value vocabulary must also stay identical between the
 * Runtime schema and the mapping the retrieval policy consumes, and the
 * checked-in SKILL.md executor block must be the rendered contract.
 */
function validateSetupContract(sourceRoot: string): string[] {
  const problems: string[] = [];
  const label = `${canonicalSkillsDirectory}/task-delivery`;

  const runtimeKeys = [...taskDeliverySetupKeys].sort();
  const yamlKeys = taskDeliverySetupKeysInSchema();
  if (yamlKeys.join(",") !== runtimeKeys.join(","))
    problems.push(
      `${label}: the YAML schema setup keys (${yamlKeys.join(", ")}) differ from the Runtime setup keys (${runtimeKeys.join(", ")})`,
    );

  const configurationPath = join(
    sourceRoot,
    canonicalSkillsDirectory,
    "task-delivery",
    "references",
    "configuration.md",
  );
  if (existsSync(configurationPath)) {
    const documentationKeys = setupKeysFromConfiguration(
      readFileSync(configurationPath, "utf8"),
    );
    if (documentationKeys === null)
      problems.push(
        `${label}: references/configuration.md has no \`### Setup keys\` table to compare against the Runtime setup schema`,
      );
    else if (documentationKeys.join(",") !== runtimeKeys.join(","))
      problems.push(
        `${label}: references/configuration.md setup keys (${documentationKeys.join(", ")}) differ from the Runtime setup keys (${runtimeKeys.join(", ")})`,
      );
  }

  if (setupKnowledgePolicies.join(",") !== [...knowledgePolicies].join(","))
    problems.push(
      `${label}: the Runtime knowledgePolicy values (${setupKnowledgePolicies.join(", ")}) differ from the retrieval policy values (${knowledgePolicies.join(", ")})`,
    );

  const skillPath = join(
    sourceRoot,
    canonicalSkillsDirectory,
    "task-delivery",
    "SKILL.md",
  );
  if (existsSync(skillPath)) {
    const checkedIn = readExecutorsBlock(readFileSync(skillPath, "utf8"));
    if (checkedIn === null)
      problems.push(`${label}: SKILL.md executor block is not well-formed`);
    else if (checkedIn !== renderExecutorsBlock())
      problems.push(
        `${label}: SKILL.md executor block differs from the rendered transfer contract; run \`bun scripts/skills/executor-block.ts\` and \`bun run skills:install\``,
      );
  }
  return problems;
}

/**
 * The backticked keys of the `### Setup keys` table: every row between that
 * heading and the next heading, first cell in backticks. Returns null when
 * the heading or its table is absent.
 */
function setupKeysFromConfiguration(markdown: string): string[] | null {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const heading = lines.findIndex(
    (line) => line.trim() === "### Setup keys",
  );
  if (heading < 0) return null;
  const keys: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,3}\s/u.test(line)) break;
    const match = /^\| `([A-Za-z]+)`\s*\|/u.exec(line.trim());
    if (match !== null) keys.push(match[1]!);
  }
  return keys.length === 0 ? null : keys.sort();
}

if (import.meta.main) {
  const errors = validateSkills(process.argv[2] ?? repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    console.error(
      "Skill validation failed. Fix the files named above; after editing a canonical skill, run `bun run skills:install`.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Canonical skills and project configuration are valid; installed copies are in sync",
    );
  }
}
