import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isRecord } from "./shared.ts";

/** Optional project configuration read by the `task-delivery` skill. */
export const taskDeliveryConfigName = ".task-delivery.yaml";

// A different spelling would never be read, which is the silent fallback this
// validation exists to prevent.
const misnamedConfigNames = [".task-delivery.yml", "task-delivery.yaml"];

type FieldType = "string" | "boolean";
type Schema = { readonly [key: string]: FieldType | Schema };

/**
 * The whole contract, mirrored by `references/configuration.md` in the skill.
 * Every key is optional; nothing outside this shape is accepted.
 */
const schema: Schema = {
  integration_branch: "string",
  verification: { full: "string", targeted: "string" },
  git: { worktree_required: "boolean", stacking_allowed: "boolean" },
  external_review: { command: "string" },
  task_lifecycle: { enabled: "boolean", start: "string", complete: "string" },
};

function validateSection(
  value: Record<string, unknown>,
  section: Schema,
  path: string,
  errors: string[],
): void {
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    const expected = Object.hasOwn(section, key) ? section[key] : undefined;
    if (expected === undefined) {
      errors.push(
        `unknown key ${keyPath} (allowed${path === "" ? "" : ` in ${path}`}: ${Object.keys(section).join(", ")})`,
      );
    } else if (typeof expected === "object") {
      if (isRecord(entry)) validateSection(entry, expected, keyPath, errors);
      else errors.push(`${keyPath} must be a mapping`);
    } else if (expected === "boolean") {
      if (typeof entry !== "boolean")
        errors.push(`${keyPath} must be a boolean (true or false, unquoted)`);
    } else if (typeof entry !== "string") {
      errors.push(`${keyPath} must be a string`);
    } else if (entry.trim() === "") {
      errors.push(`${keyPath} must not be empty`);
    }
  }
}

/**
 * Validates the text of a `.task-delivery.yaml`. Returns human-readable
 * problems; an empty array means the configuration respects the contract.
 */
export function validateTaskDeliveryConfigSource(source: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    return [`invalid YAML: ${errorMessage(error)}`];
  }
  if (!isRecord(parsed)) return ["the document root must be a mapping"];
  const errors: string[] = [];
  validateSection(parsed, schema, "", errors);
  return errors;
}

/**
 * Validates the optional configuration at a repository root. An absent file
 * is valid; a present one must respect the contract exactly.
 */
export function validateTaskDeliveryConfig(root: string): string[] {
  const errors: string[] = [];
  for (const name of misnamedConfigNames)
    if (lstatSync(join(root, name), { throwIfNoEntry: false }) !== undefined)
      errors.push(
        `${name}: not read by the skill; rename it to ${taskDeliveryConfigName}`,
      );

  const path = join(root, taskDeliveryConfigName);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return errors;
  if (!stats.isFile())
    return [...errors, `${taskDeliveryConfigName}: must be a regular file`];
  return [
    ...errors,
    ...validateTaskDeliveryConfigSource(readFileSync(path, "utf8")).map(
      (problem) => `${taskDeliveryConfigName}: ${problem}`,
    ),
  ];
}
