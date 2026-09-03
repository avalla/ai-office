import {
  isSensitiveFieldKey,
  normalizeSensitiveFieldKey,
  sensitiveFieldNames,
} from "@ai-office/domain/capability/sensitive-fields.ts";
import type {
  ActivityDetailValue,
  ActivityEntry,
} from "./operational-read-models.ts";
import type { OperationalActivityRecord } from "../ports/operational-read.port.ts";

export const activitySanitizationLimits = {
  maxDetailKeys: 12,
  maxDetailStringLength: 240,
} as const;

/**
 * Publication-side sensitivity test.
 *
 * Authorization matches the canonical names exactly, because an argument named
 * `token` is a different thing from one named `tokenBudget`. Publishing to a
 * browser has no such precision requirement, so a key that merely *contains* a
 * sensitive name — `access-token`, `refresh_secret` — is dropped too. The
 * vocabulary still comes from the domain.
 */
function isPublishableKey(key: string): boolean {
  if (isSensitiveFieldKey(key)) return false;
  const normalized = normalizeSensitiveFieldKey(key);
  return !sensitiveFieldNames.some((name) => normalized.includes(name));
}

/**
 * Reduces an audit payload to safe scalars.
 *
 * Audit payloads already exclude command arguments and answers by design, but
 * this is a publication boundary: only scalars survive, sensitive key names are
 * dropped, strings are truncated, and nested structures are never flattened
 * into the response. Anything dropped is reported through `detailTruncated`
 * instead of being silently hidden.
 */
export function sanitizeActivityDetail(
  payload: Readonly<Record<string, unknown>>,
): { detail: Record<string, ActivityDetailValue>; truncated: boolean } {
  const detail: Record<string, ActivityDetailValue> = {};
  let truncated = false;

  for (const [key, value] of Object.entries(payload)) {
    if (
      Object.keys(detail).length >= activitySanitizationLimits.maxDetailKeys
    ) {
      truncated = true;
      break;
    }
    if (!isPublishableKey(key)) {
      truncated = true;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        truncated = true;
        continue;
      }
      detail[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.length > activitySanitizationLimits.maxDetailStringLength) {
        detail[key] =
          `${value.slice(0, activitySanitizationLimits.maxDetailStringLength)}…`;
        truncated = true;
        continue;
      }
      detail[key] = value;
      continue;
    }
    truncated = true;
  }

  return { detail, truncated };
}

export function projectActivityEntry(
  record: OperationalActivityRecord,
): ActivityEntry {
  const { detail, truncated } = sanitizeActivityDetail(record.payload);
  return {
    eventId: record.id,
    projectId: record.projectId,
    eventType: record.eventType,
    actorType: record.actorType,
    actorId: record.actorId,
    aggregateType: record.aggregateType,
    aggregateId: record.aggregateId,
    occurredAt: record.occurredAt.toISOString(),
    detail,
    detailTruncated: truncated,
  };
}
