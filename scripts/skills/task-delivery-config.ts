import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isRecord } from "./shared.ts";

/** Optional project configuration read by the `task-delivery` skill. */
export const taskDeliveryConfigName = ".task-delivery.yaml";

// A near-miss spelling would never be read, which is the silent fallback this
// validation exists to prevent. Best effort: it catches the likely slips, not
// every possible name.
const misnamedConfigPattern = /^\.?task[-_]?delivery\.(?:ya?ml|json)$/iu;

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
 * The YAML parser keeps the last of two identical keys without complaint, so
 * a repeated `git:` block would silently drop the first one. Every key name in
 * the schema is unique across levels, which makes a line scan sufficient: each
 * key the parser reports must start exactly one line. Zero means a notation
 * this scan cannot vouch for (flow mappings), which is rejected rather than
 * trusted; `validateKeyNotation` rejects the notations that could spell a key
 * the scan would not recognize.
 */
function validateKeyLines(
  source: string,
  value: Record<string, unknown>,
  section: Schema,
  path: string,
  errors: string[],
): void {
  for (const [key, entry] of Object.entries(value)) {
    const expected = Object.hasOwn(section, key) ? section[key] : undefined;
    if (expected === undefined) continue;
    const keyPath = path === "" ? key : `${path}.${key}`;
    const lines = source.match(
      new RegExp(`^[ \\t]*(["']?)${key}\\1[ \\t]*:(?=[ \\t]|$)`, "gmu"),
    );
    const count = lines?.length ?? 0;
    if (count > 1)
      errors.push(
        `${keyPath} is defined ${count} times; the parser would keep only the last one`,
      );
    else if (count === 0)
      errors.push(
        `${keyPath} must be written on its own line in block style (no flow mappings, merge keys, or aliases for keys)`,
      );
    if (typeof expected === "object" && isRecord(entry))
      validateKeyLines(source, entry, expected, keyPath, errors);
  }
}

/**
 * Explicit, tagged, anchored, aliased, merged, and escaped keys can all spell
 * a second `git` that the line scan would not count. None is needed for a
 * flat settings file, so they are refused outright.
 */
function validateKeyNotation(source: string, errors: string[]): void {
  for (const [index, line] of source.split("\n").entries())
    if (/^[ \t]*(?:[?&*!]|<<|"[^"\n]*\\)/u.test(line))
      errors.push(
        `line ${index + 1} uses YAML notation that is not allowed here (explicit, tagged, anchored, aliased, merged, or escaped keys); write plain keys`,
      );
}

/**
 * Validates the text of a `.task-delivery.yaml`. Returns human-readable
 * problems; an empty array means the configuration respects the contract.
 */
export function validateTaskDeliveryConfigSource(rawSource: string): string[] {
  const source = rawSource.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    return [`invalid YAML: ${errorMessage(error)}`];
  }
  if (!isRecord(parsed))
    return [
      "the document root must be a mapping with at least one key; delete the file instead of leaving it empty",
    ];
  const errors: string[] = [];
  validateSection(parsed, schema, "", errors);
  validateKeyLines(source, parsed, schema, "", errors);
  validateKeyNotation(source, errors);
  return errors;
}

/**
 * Validates the optional configuration at a repository root. An absent file
 * is valid; a present one must respect the contract exactly.
 */
export function validateTaskDeliveryConfig(root: string): string[] {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // A root that cannot be listed is reported by the skill checks.
    return errors;
  }
  for (const name of entries.sort())
    if (name !== taskDeliveryConfigName && misnamedConfigPattern.test(name))
      errors.push(
        `${name}: not read by the skill; rename it to ${taskDeliveryConfigName}`,
      );

  const path = join(root, taskDeliveryConfigName);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return errors;
  if (!stats.isFile())
    return [...errors, `${taskDeliveryConfigName}: must be a regular file`];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return [
      ...errors,
      `${taskDeliveryConfigName}: cannot be read (${errorMessage(error)})`,
    ];
  }
  return [
    ...errors,
    ...validateTaskDeliveryConfigSource(source).map(
      (problem) => `${taskDeliveryConfigName}: ${problem}`,
    ),
  ];
}
