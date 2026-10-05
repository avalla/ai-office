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
  task_lifecycle: {
    enabled: "boolean",
    start: "string",
    review: "string",
    complete: "string",
  },
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
        errors.push(
          `${keyPath} must be a boolean: true or false, lowercase and unquoted`,
        );
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

/** Marks a section whose only lines were rejected: written, but unreadable. */
const unreadable = "\u0000unreadable";

const quoteHint =
  "wrap the whole value in quotes: double quotes, writing \\\" and \\\\ for a quote or backslash inside, or single quotes, writing '' for a single quote inside";

/** After a closed quote: nothing, or a comment. */
const afterClosedQuote = /^(?: +#.*)?$/u;

// Words some YAML readers turn into booleans or null even where a string is
// meant, so they are never accepted unquoted.
const typedWord = /^(?:y|n|yes|no|on|off|true|false|null|e[-+]?[0-9]+)$/iu;

/** Reads one value, or reports why it is outside the accepted layout. */
function readValue(raw: string): { value: Scalar } | { problem: string } {
  const text = raw.trim();
  if (text === "" || text.startsWith("#")) return { value: null };
  if (text.startsWith('"')) {
    // Closed on the same line; an open quote would swallow the next lines.
    const match = /^"((?:[^"\\]|\\.)*)"(.*)$/u.exec(text);
    if (match === null)
      return {
        problem: "has a double-quoted value that does not end on the same line",
      };
    if (!afterClosedQuote.test(match[2] ?? ""))
      return { problem: `has text after the closing quote; ${quoteHint}` };
    const body = match[1] ?? "";
    if (/\\[^"\\]/u.test(body))
      return {
        problem:
          'has a double-quoted value with an unsupported escape; only \\" and \\\\ are allowed',
      };
    return { value: body.replace(/\\(["\\])/gu, "$1") };
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(.*)$/u.exec(text);
    if (match === null)
      return {
        problem: "has a single-quoted value that does not end on the same line",
      };
    if (!afterClosedQuote.test(match[2] ?? ""))
      return { problem: `has text after the closing quote; ${quoteHint}` };
    return { value: (match[1] ?? "").replace(/''/gu, "'") };
  }
  // YAML ends an unquoted value at " #". After a boolean that is clearly a
  // comment; after anything else it may be part of a command, which would be
  // cut short without notice.
  const comment = text.indexOf(" #");
  const plain = (comment < 0 ? text : text.slice(0, comment)).trimEnd();
  if (plain === "true") return { value: true };
  if (plain === "false") return { value: false };
  if (comment >= 0)
    return {
      problem: `has an unquoted value followed by " #", which YAML reads as a comment; put the comment on its own line, or ${quoteHint}`,
    };
  // Unquoted text is accepted only where every YAML reader sees a string: it
  // starts with a letter, so it cannot be a number, a date, or YAML syntax.
  if (
    !/^[A-Za-z]/u.test(plain) ||
    typedWord.test(plain) ||
    plain.includes(": ") ||
    plain.endsWith(":")
  )
    return {
      problem: `has an unquoted value that a YAML reader may not take as plain text (it must start with a letter, must not be a word such as yes, no, on, off, null or e2, must not contain ": ", and must not end with ":"); ${quoteHint}`,
    };
  return { value: plain };
}

/**
 * The file is plain ASCII text. Anything else - a tab, a bare carriage
 * return, a control or invisible character, an unusual space, a look-alike
 * letter - can make a line read differently from what a parser sees, and no
 * branch name or command in a settings file needs it.
 */
function validateCharacters(source: string, errors: string[]): void {
  for (const [index, line] of source.split("\n").entries()) {
    const found = /[^\x20-\x7E]/u.exec(line);
    if (found === null) continue;
    const character = found[0];
    const codePoint = `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    errors.push(
      character === "\t"
        ? `line ${index + 1} contains a tab; use spaces`
        : `line ${index + 1} contains a character that is not printable ASCII (${codePoint}); remove it`,
    );
  }
}

/** The schema type of a dotted key path, when the schema knows it. */
function expectedType(path: string): FieldType | "section" | undefined {
  let node: FieldType | Schema = schema;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || !Object.hasOwn(node, part))
      return undefined;
    node = node[part] as FieldType | Schema;
  }
  return typeof node === "object" ? "section" : node;
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
    if (/^ *(?:#.*)?$/u.test(line)) continue;
    const at = `line ${index + 1}`;
    if (!started && /^---(?: +#.*| *)$/u.test(line)) {
      started = true;
      continue;
    }
    started = true;
    const match = /^( *)([A-Za-z_][A-Za-z0-9_]*):(?: (.*))?$/u.exec(line);
    if (match === null) {
      errors.push(
        `${at} is not a plain "key: value" line with a space after the colon (quoted keys, lists, a second document, and values continued from the previous line are not allowed)`,
      );
      continue;
    }
    const indent = match[1] ?? "";
    const key = match[2] ?? "";
    const name =
      indent === "" || section === null ? key : `${section.name}.${key}`;
    // A section with a rejected line is not an empty section.
    const owner = indent === "" || section === null ? null : section.name;
    const children = owner === null ? undefined : layout.get(owner);
    if (children instanceof Map && children.size === 0)
      children.set(unreadable, null);
    const read = readValue(match[3] ?? "");
    if (expectedType(name) === "boolean") {
      // Say what the field needs instead of how to quote a wrong value.
      if ("problem" in read || typeof read.value !== "boolean") {
        errors.push(
          `${at}: ${name} must be a boolean: true or false, lowercase and unquoted`,
        );
        continue;
      }
    }
    if ("problem" in read) {
      errors.push(`${at}: ${name} ${read.problem}`);
      continue;
    }
    if (expectedType(name) === "string" && typeof read.value === "boolean") {
      errors.push(
        `${at}: ${name} must be a string; to use the word as text, ${quoteHint}`,
      );
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
    if (!(children instanceof Map)) continue;
    children.delete(unreadable);
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
              Object.fromEntries(
                [...value].filter(([child]) => child !== unreadable),
              ),
            )
        : value;
  return object;
}

/**
 * True when a YAML parser reads exactly what the layout scan read: the same
 * keys, and the same string or boolean under each.
 */
function agrees(scanned: unknown, parsed: unknown): boolean {
  if (!isRecord(scanned)) return scanned === parsed;
  if (!isRecord(parsed)) return false;
  const keys = Object.keys(scanned);
  return (
    keys.length === Object.keys(parsed).length &&
    keys.every(
      (key) => Object.hasOwn(parsed, key) && agrees(scanned[key], parsed[key]),
    )
  );
}

/**
 * Validates the text of a `.task-delivery.yaml`. Returns human-readable
 * problems; an empty array means the configuration respects the contract.
 */
export function validateTaskDeliveryConfigSource(rawSource: string): string[] {
  // No byte-order mark and no CRLF: a tool reading the file line by line
  // would see a different first key and values ending in a carriage return.
  const source = rawSource;
  const errors: string[] = [];
  if (source.startsWith("\uFEFF"))
    return [
      "the file starts with a byte-order mark; save it as UTF-8 without BOM",
    ];
  if (source.includes("\r\n"))
    return ["the file uses CRLF line endings; save it with LF line endings"];
  validateCharacters(source, errors);
  // Nothing else can be read reliably until those characters are gone.
  if (errors.length > 0) return errors;
  const scanned = layoutToObject(readLayout(source, errors));
  // The scan decides what the file says, so the schema is checked against
  // it; keys whose line was rejected above are simply absent here.
  validateSection(scanned, schema, "", errors);
  if (errors.length > 0) return errors;
  if (Object.keys(scanned).length === 0)
    return [
      "the document root must be a mapping with at least one key; delete the file instead of leaving it empty",
    ];
  // A file accepted line by line must mean the same to a YAML parser.
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    return [`invalid YAML: ${errorMessage(error)}`];
  }
  return agrees(scanned, parsed)
    ? []
    : [
        `a YAML parser reads this file differently from its plain "key: value" lines; ${quoteHint} where it contains YAML syntax`,
      ];
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
