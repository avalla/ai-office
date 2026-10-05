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

// One plain key, then nothing or a value that does not open a flow
// collection, anchor, alias, tag, block scalar, or explicit key.
const keyValueLine =
  /^( *)([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(?![{[&*!|>?]).*)?$/u;

/**
 * The YAML parser keeps the last of two identical keys without complaint, so
 * a repeated `git:` block would silently drop the first one, and YAML offers
 * many notations that could hide such a repeat. The file is therefore held to
 * a small layout: every line is one plain `key: value` or a section header,
 * at most one level deep. Within that layout a repeated key is visible line
 * by line, and nothing outside it is accepted.
 */
function validateLayout(source: string, errors: string[]): void {
  const seen = new Map<string, number>();
  let section: string | null = null;
  let started = false;
  for (const [index, line] of source.split("\n").entries()) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (!started && line === "---") {
      started = true;
      continue;
    }
    started = true;
    const match = keyValueLine.exec(line);
    if (match === null) {
      errors.push(
        `line ${index + 1} is not a plain "key: value" line (quoted keys, flow collections, anchors, aliases, tags, block scalars, and multi-line values are not allowed)`,
      );
      continue;
    }
    const nested = match[1] !== "";
    const key = match[2] ?? "";
    if (!nested) section = key;
    else if (section === null) {
      errors.push(`line ${index + 1} is indented but belongs to no section`);
      continue;
    }
    const keyPath = nested ? `${section}.${key}` : key;
    const firstLine = seen.get(keyPath);
    if (firstLine === undefined) seen.set(keyPath, index + 1);
    else
      errors.push(
        `${keyPath} is defined more than once (lines ${firstLine} and ${index + 1}); the parser would keep only the last one`,
      );
  }
}

/**
 * Validates the text of a `.task-delivery.yaml`. Returns human-readable
 * problems; an empty array means the configuration respects the contract.
 */
export function validateTaskDeliveryConfigSource(rawSource: string): string[] {
  const source = rawSource.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const errors: string[] = [];
  validateLayout(source, errors);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    return [...errors, `invalid YAML: ${errorMessage(error)}`];
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0)
    return [
      ...errors,
      "the document root must be a mapping with at least one key; delete the file instead of leaving it empty",
    ];
  validateSection(parsed, schema, "", errors);
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
