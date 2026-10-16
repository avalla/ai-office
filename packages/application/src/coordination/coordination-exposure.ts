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

/**
 * Best-effort only: it catches common credential shapes so an accidental
 * paste in a title does not leave the machine. It is not a guarantee, and
 * titles are owner-entered planning data, never agent output.
 */
// Distinctive prefixes are matched without a word boundary, so a token glued
// to other text is still caught.
const credentialPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export function scrubCredentials(value: string): string {
  let result = value;
  for (const pattern of credentialPatterns)
    result = result.replace(pattern, redactionMarker);
  return result;
}

/** Truncates by code point so a surrogate pair is never split. */
function truncate(value: string): { value: string; truncated: boolean } {
  const points = Array.from(value);
  return points.length <= coordinationExposureLimits.maxStringLength
    ? { value, truncated: false }
    : {
        value: points
          .slice(0, coordinationExposureLimits.maxStringLength)
          .join(""),
        truncated: true,
      };
}

export type CoordinationExposedItem = Record<string, unknown>;

/**
 * Builds one exposed item from a planning item: only registered fields of an
 * allowed class, in registry order; text scrubbed, then truncated.
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
      const bounded = truncate(scrubCredentials(value));
      item[field] = bounded.value;
      if (bounded.truncated) truncated.push(field);
    } else item[field] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  if (truncated.length > 0) item[truncatedFieldsKey] = truncated;
  return item;
}
