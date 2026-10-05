import { join, resolve } from "node:path";
import { installSkills } from "./install.ts";
import { validateSkillPackage } from "./package-validation.ts";
import { validateTaskDeliveryConfig } from "./task-delivery-config.ts";
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
  let skills: string[];
  try {
    skills = listCanonicalSkills(sourceRoot);
  } catch (error) {
    return [errorMessage(error)];
  }
  if (skills.length === 0)
    return [`No canonical skills found under ${canonicalSkillsDirectory}/`];

  const errors = [
    ...skills.flatMap((skill) =>
      validateSkillPackage(
        join(sourceRoot, canonicalSkillsDirectory, skill),
      ).map((problem) => `${canonicalSkillsDirectory}/${skill}: ${problem}`),
    ),
    ...validateTaskDeliveryConfig(sourceRoot),
  ];
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

if (import.meta.main) {
  const errors = validateSkills(process.argv[2] ?? repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    console.error(
      "Skill validation failed. Fix the canonical source, then run `bun run skills:install`.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Canonical skills and project configuration are valid; installed copies are in sync",
    );
  }
}
