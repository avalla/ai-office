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

type Scalar = string | boolean | null;
/** What the layout scan read: scalars, and sections of scalars. */
type Layout = Map<string, Scalar | Map<string, Scalar>>;

const quoteHint = "wrap the whole value in double quotes";

const afterQuote = "has text after the closing quote";

/** Reads one value, or reports why it is outside the accepted layout. */
function readValue(raw: string): { value: Scalar } | { problem: string } {
  const text = raw.trim();
  if (text === "" || text.startsWith("#")) return { value: null };
  if (text.startsWith('"')) {
    // Closed on the same line; an open quote would swallow the next lines.
    const match = /^("(?:[^"\\]|\\.)*")(.*)$/u.exec(text);
    if (match === null)
      return {
        problem: "has a double-quoted value that does not end on the same line",
      };
    if (!/^(?:[ \t]+#.*)?[ \t]*$/u.test(match[2] ?? ""))
      return { problem: `${afterQuote}; ${quoteHint}` };
    try {
      const decoded: unknown = JSON.parse(match[1] ?? "");
      if (typeof decoded === "string") return { value: decoded };
    } catch {
      // Reported below.
    }
    return {
      problem:
        'has a double-quoted value with an unsupported escape (use \\" \\\\ \\n \\t or \\uXXXX)',
    };
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(.*)$/u.exec(text);
    if (match === null)
      return {
        problem: "has a single-quoted value that does not end on the same line",
      };
    if (!/^(?:[ \t]+#.*)?[ \t]*$/u.test(match[2] ?? ""))
      return { problem: `${afterQuote}; ${quoteHint}` };
    return { value: (match[1] ?? "").replace(/''/gu, "'") };
  }
  if (/^[{[&*!|>?%@`,]/u.test(text) || /^[-?:](?:[ \t]|$)/u.test(text))
    return {
      problem: `has a value starting with YAML syntax (flow collections, anchors, aliases, tags, block scalars, and lists are not allowed); for a literal value, ${quoteHint}`,
    };
  // YAML ends a plain value at " #". After a boolean that is clearly a
  // comment; after anything else it may be part of a command, which would be
  // cut short without notice.
  const plain = text.replace(/[ \t]+#.*$/u, "");
  if (plain === "true") return { value: true };
  if (plain === "false") return { value: false };
  if (/^(?:true|false)$/iu.test(plain))
    return { problem: "must be written in lowercase: true or false" };
  if (plain !== text)
    return {
      problem: `has an unquoted value followed by " #", which YAML reads as a comment; put the comment on its own line, or ${quoteHint}`,
    };
  return { value: plain };
}

/**
 * Characters that make a line look different from what a parser reads: a
 * bare carriage return, other control and format characters, and spaces and
 * blanks that are not the ordinary space. None belongs in a settings file.
 */
const deceptiveCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u2800\u3164]/u;

function validateCharacters(source: string, errors: string[]): void {
  for (const [index, line] of source.split("\n").entries()) {
    const found = [...line].find(
      (character) =>
        character !== " " &&
        character !== "\t" &&
        deceptiveCharacter.test(character),
    );
    if (found !== undefined)
      errors.push(
        `line ${index + 1} contains an invisible or control character (U+${(found.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}); remove it`,
      );
  }
}

/**
 * Reads the file as the only layout that is accepted: plain `key: value`
 * lines and section headers, one level deep. YAML keeps the last of two
 * identical keys without complaint and offers many notations that can hide
 * one, so this scan - not the YAML parser - decides what the file says, and
 * `validateTaskDeliveryConfigSource` then requires the YAML parser to agree.
 */
function readLayout(source: string, errors: string[]): Layout {
  const layout: Layout = new Map();
  let section: { name: string; indent: string | null } | null = null;
  let started = false;
  for (const [index, line] of source.split("\n").entries()) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
    const at = `line ${index + 1}`;
    if (!started && /^---[ \t]*(?:#.*)?$/u.test(line)) {
      started = true;
      continue;
    }
    started = true;
    if (/^ *\t/u.test(line)) {
      errors.push(`${at} is indented with a tab; use spaces`);
      continue;
    }
    const match = /^( *)([A-Za-z_][A-Za-z0-9_]*):(?:[ \t](.*))?$/u.exec(line);
    if (match === null) {
      errors.push(
        `${at} is not a plain "key: value" line (quoted keys, lists, a second document, and values continued from the previous line are not allowed; if the previous value contains ": ", ${quoteHint})`,
      );
      continue;
    }
    const indent = match[1] ?? "";
    const key = match[2] ?? "";
    const read = readValue(match[3] ?? "");
    if ("problem" in read) {
      const name =
        indent === "" || section === null ? key : `${section.name}.${key}`;
      errors.push(`${at}: ${name} ${read.problem}`);
      continue;
    }
    if (indent === "") {
      section = read.value === null ? { name: key, indent: null } : null;
      if (layout.has(key))
        errors.push(
          `${at}: ${key} is defined more than once; the parser would keep only the last one`,
        );
      layout.set(key, read.value === null ? new Map() : read.value);
      continue;
    }
    if (section === null) {
      errors.push(`${at} is indented but does not follow a section header`);
      continue;
    }
    section.indent ??= indent;
    if (indent !== section.indent) {
      errors.push(
        `${at} is indented differently from the other keys of ${section.name}; sections are one level deep`,
      );
      continue;
    }
    const children = layout.get(section.name);
    if (!(children instanceof Map)) continue;
    if (children.has(key))
      errors.push(
        `${at}: ${section.name}.${key} is defined more than once; the parser would keep only the last one`,
      );
    children.set(key, read.value);
  }
  return layout;
}

/** The layout as the plain object a YAML parser must also produce. */
function layoutToObject(layout: Layout): Record<string, unknown> {
  const object: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of layout)
    object[key] =
      value instanceof Map
        ? value.size === 0
          ? null
          : Object.assign(
              Object.create(null) as Record<string, unknown>,
              Object.fromEntries(value),
            )
        : value;
  return object;
}

/**
 * True when a YAML parser reads the same keys, and the same strings and
 * booleans, as the layout scan. Values the parser types differently (numbers,
 * nulls) are left to the schema check, which reports them by name.
 */
function agrees(scanned: unknown, parsed: unknown): boolean {
  if (isRecord(scanned)) {
    if (!isRecord(parsed)) return false;
    const keys = Object.keys(scanned);
    return (
      keys.length === Object.keys(parsed).length &&
      keys.every(
        (key) =>
          Object.hasOwn(parsed, key) && agrees(scanned[key], parsed[key]),
      )
    );
  }
  if (typeof parsed === "string" || typeof parsed === "boolean")
    return scanned === parsed;
  return !isRecord(parsed);
}

/**
 * Validates the text of a `.task-delivery.yaml`. Returns human-readable
 * problems; an empty array means the configuration respects the contract.
 */
export function validateTaskDeliveryConfigSource(rawSource: string): string[] {
  // CRLF is an ordinary line ending. A bare CR is not: some readers treat it
  // as a line break and others do not, so it is rejected with the rest.
  const source = rawSource.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const errors: string[] = [];
  validateCharacters(source, errors);
  const scanned = layoutToObject(readLayout(source, errors));
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    return [
      ...errors,
      `invalid YAML: ${errorMessage(error)} (if a value contains ": " or starts with a special character, ${quoteHint})`,
    ];
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0)
    return [
      ...errors,
      "the document root must be a mapping with at least one key; delete the file instead of leaving it empty",
    ];
  // Only a file the scan accepted line by line can be compared; otherwise the
  // line errors above already say what to fix.
  if (errors.length === 0 && !agrees(scanned, parsed))
    errors.push(
      `a YAML parser reads this file differently from its plain "key: value" lines; write one unquoted key per line and ${quoteHint} where it contains YAML syntax`,
    );
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
