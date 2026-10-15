import { DomainValidationError } from "../errors.ts";
import {
  canonicalStringify,
  normalizeCanonicalJson,
  type CanonicalJsonValue,
} from "../capability/canonical-json.ts";
import { assertNoSensitiveFields } from "../capability/sensitive-fields.ts";

/**
 * Provisional, internal contract for the structured outcome of one pipeline
 * stage attempt (M11-1). It is run evidence only: it is not a persisted
 * Artifact, carries no review or approval meaning, and is not a stable public
 * schema. Future versions are added as new `version` values; an unknown
 * version is rejected, never coerced.
 */
export const stageResultEnvelopeVersion = 1;

export const stageResultLimits = Object.freeze({
  summaryBytes: 2_000,
  errorMessageBytes: 500,
  dataBytes: 16_384,
  identifierBytes: 128,
});

export type StageResultOutcome = "succeeded" | "failed";

/** Who produced the result. Provenance only; it never grants authority. */
export type StageResultProducer =
  | { readonly kind: "agent_run"; readonly agentRunId: string }
  | { readonly kind: "operator"; readonly actorLabel: string };

export interface StageResultError {
  /** Stable machine-readable code, e.g. `validation_failed`. */
  readonly code: string;
  readonly message: string;
}

export interface StageResultEnvelope {
  readonly version: typeof stageResultEnvelopeVersion;
  readonly outcome: StageResultOutcome;
  readonly summary: string;
  readonly producer: StageResultProducer;
  readonly data?: Readonly<Record<string, CanonicalJsonValue>>;
  readonly error?: StageResultError;
}

const envelopeKeys = new Set([
  "version",
  "outcome",
  "summary",
  "producer",
  "data",
  "error",
]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const errorCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
// Control characters (except tab/newline in summary) never belong in evidence.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): never {
  // Messages name the failing field only; they never echo the rejected value.
  throw new DomainValidationError(`Invalid stage result: ${reason}`);
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") return invalid(`${field} must be a string`);
  const text = value.trim();
  if (text === "") return invalid(`${field} cannot be empty`);
  if (controlCharacters.test(text))
    return invalid(`${field} contains control characters`);
  if (byteLength(text) > maxBytes)
    return invalid(`${field} exceeds ${maxBytes} bytes`);
  return text;
}

function parseProducer(value: unknown): StageResultProducer {
  if (!isRecord(value)) return invalid("producer must be an object");
  const keys = Object.keys(value);
  if (value.kind === "agent_run") {
    if (keys.some((key) => !["kind", "agentRunId"].includes(key)))
      return invalid("producer has unknown fields");
    const agentRunId = boundedText(
      value.agentRunId,
      "producer.agentRunId",
      stageResultLimits.identifierBytes,
    );
    if (!identifierPattern.test(agentRunId))
      return invalid("producer.agentRunId is malformed");
    return Object.freeze({ kind: "agent_run", agentRunId });
  }
  if (value.kind === "operator") {
    if (keys.some((key) => !["kind", "actorLabel"].includes(key)))
      return invalid("producer has unknown fields");
    const actorLabel = boundedText(
      value.actorLabel,
      "producer.actorLabel",
      stageResultLimits.identifierBytes,
    );
    return Object.freeze({ kind: "operator", actorLabel });
  }
  return invalid("producer.kind is not supported");
}

function parseError(value: unknown): StageResultError {
  if (!isRecord(value)) return invalid("error must be an object");
  if (Object.keys(value).some((key) => !["code", "message"].includes(key)))
    return invalid("error has unknown fields");
  if (typeof value.code !== "string" || !errorCodePattern.test(value.code))
    return invalid("error.code is malformed");
  const message = boundedText(
    value.message,
    "error.message",
    stageResultLimits.errorMessageBytes,
  );
  return Object.freeze({ code: value.code, message });
}

function parseData(
  value: unknown,
): Readonly<Record<string, CanonicalJsonValue>> {
  if (!isRecord(value)) return invalid("data must be an object");
  let normalized: CanonicalJsonValue;
  try {
    normalized = normalizeCanonicalJson(value);
    assertNoSensitiveFields(normalized, "data");
  } catch {
    // The underlying message may quote a field name or value; keep it out.
    return invalid("data is not canonical JSON or contains a sensitive field");
  }
  if (byteLength(canonicalStringify(normalized)) > stageResultLimits.dataBytes)
    return invalid(`data exceeds ${stageResultLimits.dataBytes} bytes`);
  return normalized as Readonly<Record<string, CanonicalJsonValue>>;
}

/**
 * Validates an untrusted value into a frozen, canonical envelope. Pure: it
 * performs no I/O, reads no clock and cannot widen a capability.
 */
export function parseStageResultEnvelope(value: unknown): StageResultEnvelope {
  if (!isRecord(value)) return invalid("envelope must be an object");
  if (Object.keys(value).some((key) => !envelopeKeys.has(key)))
    return invalid("envelope has unknown fields");
  if (value.version !== stageResultEnvelopeVersion)
    return invalid("version is not supported");
  if (value.outcome !== "succeeded" && value.outcome !== "failed")
    return invalid("outcome is not supported");
  const outcome: StageResultOutcome = value.outcome;
  const summary = boundedText(
    value.summary,
    "summary",
    stageResultLimits.summaryBytes,
  );
  const producer = parseProducer(value.producer);
  if (outcome === "failed" && value.error === undefined)
    return invalid("a failed result requires error");
  if (outcome === "succeeded" && value.error !== undefined)
    return invalid("a succeeded result cannot carry error");
  return Object.freeze({
    version: stageResultEnvelopeVersion,
    outcome,
    summary,
    producer,
    ...(value.data === undefined ? {} : { data: parseData(value.data) }),
    ...(value.error === undefined ? {} : { error: parseError(value.error) }),
  });
}

/** Canonical text form used to compare two deliveries of the same result. */
export function canonicalStageResult(envelope: StageResultEnvelope): string {
  return canonicalStringify(envelope);
}
