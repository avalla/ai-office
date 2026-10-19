/**
 * Exposure registry and mappers of the coordination API (CB-10, ADR-0036
 * Decision 7).
 *
 * Readable by the Runtime does not mean exposable. Every field an adapter can
 * receive is listed here with its data class; a field that is not listed is
 * never copied, and no source object is spread. Text fields pass through a
 * best-effort credential scrubber and are truncated at 256 characters, with
 * the truncated field names reported on the item.
 */

import type {
  PlanningDataClass,
  PlanningSnapshotCollection,
} from "./planning-snapshot.ts";

export const coordinationExposureLimits = {
  /** Characters (code points), not bytes or UTF-16 units. */
  maxStringLength: 256,
  /** Code points of stored text scanned by the scrubber before the cut. */
  maxScannedTextLength: 4096,
  /** Entries of one relationship list (ids or reasons) per item. */
  maxListLength: 100,
} as const;

export interface CoordinationFieldExposure {
  dataClass: PlanningDataClass;
  /** Free text: scrubbed and truncated before it leaves the Runtime. */
  text?: true;
}

/** The planning collections the coordination read operations expose. */
export type CoordinationExposedCollection = Extract<
  PlanningSnapshotCollection,
  | "milestones"
  | "tasks"
  | "requirements"
  | "dependencies"
  | "blockers"
  | "runnable"
>;

const p: CoordinationFieldExposure = { dataClass: "P" };
const t: CoordinationFieldExposure = { dataClass: "T", text: true };

/**
 * The closed field set of every exposed item. Adding a field here is the
 * only way to expose it; contract tests assert these sets exactly.
 */
export const coordinationExposureRegistry: Readonly<
  Record<
    CoordinationExposedCollection,
    Readonly<Record<string, CoordinationFieldExposure>>
  >
> = {
  milestones: { milestoneId: p, title: t, status: p },
  tasks: {
    taskId: p,
    title: t,
    status: p,
    priority: p,
    milestoneIds: p,
    requirementIds: p,
    prerequisiteIds: p,
  },
  requirements: {
    requirementId: p,
    // A key is a short operator-chosen label, so it is treated as text.
    key: { dataClass: "P", text: true },
    title: t,
    status: p,
    milestoneId: p,
    taskIds: p,
  },
  dependencies: { taskId: p, dependsOnTaskId: p },
  blockers: { taskId: p, status: p, reasons: p, unmetPrerequisiteIds: p },
  runnable: { taskId: p, status: p, priority: p },
};

/** Item marker naming the text fields that were truncated; class P. */
export const truncatedFieldsKey = "truncatedFields";

export const redactionMarker = "[redacted]";

/** The `: value` half of an assignment pattern: a quoted or a bare value. */
const assignedValue = String.raw`["']?\s*[:=]\s*(?:"(?:[^"\\]|\\[\s\S]){6,}"|'(?:[^'\\]|\\[\s\S]){6,}'|"(?:[^"\\\r\n]|\\.)*\\?(?=[\r\n]|$)|'(?:[^'\\\r\n]|\\.)*\\?(?=[\r\n]|$)|[^\s"']{8,})`;

/**
 * Best-effort only: it catches common credential shapes so an accidental
 * paste in a title does not leave the machine. It is not a guarantee, and
 * titles are owner-entered planning data, never agent output. Distinctive
 * prefixes are matched without a word boundary, so a token glued to other
 * text is still caught.
 */
const credentialPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[a-z]-[A-Za-z0-9-]{10,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // Credentials in URL userinfo: scheme://user:password@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  // Assignments such as password=..., api_key: ...
  // A quoted value (escapes included) is redacted up to its closing quote,
  // an unterminated one to the end of its line, all of its words and a
  // trailing backslash included; an escaped line break does not end a
  // closed quote. A JSON-style quoted key matches too, and so does a
  // prefixed name such as DB_PASSWORD or GITHUB_TOKEN, or a common compound
  // name such as SECRET_KEY or accessToken.
  new RegExp(
    String.raw`(?<![A-Za-z0-9])(?:password|passwd|pwd|(?:secret|private)[_-]?key|secret|(?:access|refresh|auth|id|session)[_-]?token|token|api[_-]?key|access[_-]?key|aws_secret_access_key|client[_-]?secret)` +
      assignedValue,
    "gi",
  ),
  // A camelCase name with a prefix, such as dbPassword or githubToken: the
  // keyword starts a word after a letter or digit (an acronym prefix such as DBPassword included). Case-sensitive,
  // so `mytoken=` (one lower-case word) stays untouched.
  new RegExp(
    String.raw`(?<=[A-Za-z0-9])(?:Password|Passwd|Pwd|SecretAccessKey|SecretKey|PrivateKey|Secret|AccessToken|RefreshToken|AuthToken|IdToken|SessionToken|Token|ApiKey|AccessKey|ClientSecret)` +
      assignedValue,
    "g",
  ),
];

/** Zero-width and format characters that could split a token past a pattern. */
const invisibleCharacters =
  // U+034F is a combining mark, so it stays outside the character class.
  /\u034F|[\u00AD\u180E\u200B-\u200F\u2028\u2029\u2060-\u2064\uFEFF]/g;

/**
 * Matching runs on a copy without invisible characters, so a token split by
 * one is still caught. Text with no credential is returned unchanged, so
 * joiners and direction marks of ordinary titles survive.
 */
export function scrubCredentials(value: string): string {
  const visible = value.replace(invisibleCharacters, "");
  let result = visible;
  for (const pattern of credentialPatterns)
    result = result.replace(pattern, redactionMarker);
  return result === visible ? value : result;
}

/**
 * Bounds text by code point so a surrogate pair is never split, and never
 * leaves a partial redaction marker at the cut.
 */
function truncate(value: string): { value: string; truncated: boolean } {
  const points = Array.from(value);
  const limit = coordinationExposureLimits.maxStringLength;
  if (points.length <= limit) return { value, truncated: false };
  let cut: number = limit;
  const marker = redactionMarker.length;
  for (let start = Math.max(0, cut - marker + 1); start < cut; start += 1)
    if (points.slice(start, start + marker).join("") === redactionMarker) {
      cut = start;
      break;
    }
  return { value: points.slice(0, cut).join(""), truncated: true };
}

export type CoordinationExposedItem = Record<string, unknown>;

/**
 * Builds one exposed item from a planning item: only registered fields of an
 * allowed class, in registry order. Text is bounded, scrubbed, then
 * truncated; relationship lists are cut at {@link coordinationExposureLimits}
 * so one item always fits a response. Every cut field is named in
 * `truncatedFields`.
 */
export function exposeItem(
  collection: CoordinationExposedCollection,
  source: object,
  classes: readonly PlanningDataClass[],
): CoordinationExposedItem {
  const values = source as Readonly<Record<string, unknown>>;
  const item: CoordinationExposedItem = {};
  const truncated: string[] = [];
  for (const [field, exposure] of Object.entries(
    coordinationExposureRegistry[collection],
  )) {
    if (!classes.includes(exposure.dataClass)) continue;
    if (!Object.hasOwn(values, field)) continue;
    const value = values[field];
    if (value === undefined) continue;
    if (exposure.text === true && typeof value === "string") {
      // The patterns only ever scan a bounded prefix of the stored text.
      // At most two UTF-16 units per code point, so this slice bounds the
      // conversion as well as the scan.
      const bound = coordinationExposureLimits.maxScannedTextLength;
      const scanned =
        value.length > bound
          ? Array.from(value.slice(0, bound * 2))
              .slice(0, bound)
              .join("")
          : value;
      const bounded = truncate(scrubCredentials(scanned));
      item[field] = bounded.value;
      if (bounded.truncated || scanned !== value) truncated.push(field);
    } else if (Array.isArray(value)) {
      const list = value as readonly unknown[];
      item[field] = list.slice(0, coordinationExposureLimits.maxListLength);
      if (list.length > coordinationExposureLimits.maxListLength)
        truncated.push(field);
    } else item[field] = value;
  }
  if (truncated.length > 0) item[truncatedFieldsKey] = truncated;
  return item;
}
