import { DomainValidationError } from "../errors.ts";
import {
  canonicalStringify,
  normalizeCanonicalJson,
  type CanonicalJsonValue,
} from "../capability/canonical-json.ts";
import {
  normalizeSensitiveFieldKey,
  sensitiveFieldNames,
} from "../capability/sensitive-fields.ts";

/**
 * Provisional, internal contract for the structured outcome of one pipeline
 * stage attempt (M11-1). It is run evidence only: it is not a persisted
 * Artifact, carries no review or approval meaning, and is not a stable public
 * schema. Future versions are added as new `version` values; an unknown
 * version is rejected, never coerced.
 *
 * The `producer` field is a claim made by the payload. The Runtime that
 * delivers it must compare it with the authenticated deliverer (see
 * `assessStageResultDelivery`); it is never trusted on its own.
 */
export const stageResultEnvelopeVersion = 1;

export const stageResultLimits = Object.freeze({
  summaryBytes: 2_000,
  errorMessageBytes: 500,
  dataBytes: 16_384,
  identifierBytes: 128,
  /** Structural bounds checked before any normalization of `data`. */
  dataDepth: 8,
  dataNodes: 512,
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
const actorLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._@: -]*$/;
const errorCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
// C0/C1 controls and DEL; tab, LF and CR are checked separately because only
// the summary may span lines.
const forbiddenControls =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// Bidi overrides/isolates and line/paragraph separators enable display and
// log-line spoofing in any later projection.
function isFormattingSpoof(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x2028 ||
      code === 0x2029
    )
      return true;
  }
  return false;
}
// Credential-looking content is rejected, not redacted: evidence stays exact
// or is refused. Deliberately conservative, not a complete secret scanner.
const credentialPatterns: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/,
  /\bauthorization\s*[:=]/i,
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\s*[:=]\s*\S/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

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

function assertSafeText(text: string, field: string): void {
  if (forbiddenControls.test(text) || isFormattingSpoof(text))
    invalid(`${field} contains forbidden characters`);
  if (credentialPatterns.some((pattern) => pattern.test(text)))
    invalid(`${field} contains credential-like content`);
}

function boundedText(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { readonly multiline?: boolean } = {},
): string {
  if (typeof value !== "string") return invalid(`${field} must be a string`);
  // UTF-16 code units never exceed UTF-8 bytes, so this cheap check runs
  // before any trimming, scanning or encoding of an oversized string.
  if (value.length > maxBytes)
    return invalid(`${field} exceeds ${maxBytes} bytes`);
  const text = value.trim();
  if (text === "") return invalid(`${field} cannot be empty`);
  if (byteLength(text) > maxBytes)
    return invalid(`${field} exceeds ${maxBytes} bytes`);
  if (options.multiline !== true && /[\t\n\r]/.test(text))
    return invalid(`${field} must be a single line`);
  assertSafeText(text, field);
  return text;
}

function parseProducer(value: unknown): StageResultProducer {
  if (!isRecord(value)) return invalid("producer must be an object");
  const keys = Object.keys(value);
  const { kind, agentRunId, actorLabel } = value;
  if (kind === "agent_run") {
    if (keys.some((key) => !["kind", "agentRunId"].includes(key)))
      return invalid("producer has unknown fields");
    const id = boundedText(
      agentRunId,
      "producer.agentRunId",
      stageResultLimits.identifierBytes,
    );
    if (!identifierPattern.test(id))
      return invalid("producer.agentRunId is malformed");
    return Object.freeze({ kind: "agent_run", agentRunId: id });
  }
  if (kind === "operator") {
    if (keys.some((key) => !["kind", "actorLabel"].includes(key)))
      return invalid("producer has unknown fields");
    const label = boundedText(
      actorLabel,
      "producer.actorLabel",
      stageResultLimits.identifierBytes,
    );
    if (!actorLabelPattern.test(label))
      return invalid("producer.actorLabel is malformed");
    return Object.freeze({ kind: "operator", actorLabel: label });
  }
  return invalid("producer.kind is not supported");
}

function parseError(value: unknown): StageResultError {
  if (!isRecord(value)) return invalid("error must be an object");
  if (Object.keys(value).some((key) => !["code", "message"].includes(key)))
    return invalid("error has unknown fields");
  const { code, message } = value;
  if (typeof code !== "string" || !errorCodePattern.test(code))
    return invalid("error.code is malformed");
  return Object.freeze({
    code,
    message: boundedText(
      message,
      "error.message",
      stageResultLimits.errorMessageBytes,
    ),
  });
}

/**
 * Bounded pre-pass over untrusted `data`, run before any normalization so a
 * hostile shape (deep, wide or huge) is refused in O(budget), not O(payload).
 * Reads own data properties only; an accessor is refused without being invoked.
 */
function guardData(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > stageResultLimits.dataNodes)
    invalid("data has too many nodes");
  if (depth > stageResultLimits.dataDepth) invalid("data is nested too deeply");
  if (typeof value === "string") {
    if (value.length > stageResultLimits.dataBytes)
      invalid(`data exceeds ${stageResultLimits.dataBytes} bytes`);
    // Tab/LF/CR are legitimate inside data strings; other controls are not.
    assertSafeText(value, "data");
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > stageResultLimits.dataNodes)
      invalid("data has too many nodes");
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor))
        invalid("data is not canonical JSON");
      guardData(descriptor.value, depth + 1, budget);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    const normalizedKey = normalizeSensitiveFieldKey(key);
    if (sensitiveFieldNames.some((name) => normalizedKey.includes(name)))
      invalid("data contains a sensitive field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      invalid("data is not canonical JSON");
    guardData(descriptor.value, depth + 1, budget);
  }
}

function parseData(
  value: unknown,
): Readonly<Record<string, CanonicalJsonValue>> {
  if (!isRecord(value)) return invalid("data must be an object");
  guardData(value, 0, { nodes: 0 });
  let normalized: CanonicalJsonValue;
  try {
    normalized = normalizeCanonicalJson(value);
  } catch {
    // The underlying message may quote a field name or value; keep it out.
    return invalid("data is not canonical JSON");
  }
  if (byteLength(canonicalStringify(normalized)) > stageResultLimits.dataBytes)
    return invalid(`data exceeds ${stageResultLimits.dataBytes} bytes`);
  return normalized as Readonly<Record<string, CanonicalJsonValue>>;
}

/**
 * Validates an untrusted value into a frozen, canonical envelope. Pure: it
 * performs no I/O, reads no clock and cannot widen a capability. Each
 * top-level field of the input is read exactly once.
 */
export function parseStageResultEnvelope(value: unknown): StageResultEnvelope {
  if (!isRecord(value)) return invalid("envelope must be an object");
  if (Object.keys(value).some((key) => !envelopeKeys.has(key)))
    return invalid("envelope has unknown fields");
  const { version, outcome, summary, producer, data, error } = value;
  if (version !== stageResultEnvelopeVersion)
    return invalid("version is not supported");
  if (outcome !== "succeeded" && outcome !== "failed")
    return invalid("outcome is not supported");
  const parsedSummary = boundedText(
    summary,
    "summary",
    stageResultLimits.summaryBytes,
    { multiline: true },
  );
  const parsedProducer = parseProducer(producer);
  if (outcome === "failed" && error === undefined)
    return invalid("a failed result requires error");
  if (outcome === "succeeded" && error !== undefined)
    return invalid("a succeeded result cannot carry error");
  return Object.freeze({
    version: stageResultEnvelopeVersion,
    outcome,
    summary: parsedSummary,
    producer: parsedProducer,
    ...(data === undefined ? {} : { data: parseData(data) }),
    ...(error === undefined ? {} : { error: parseError(error) }),
  });
}

/** Canonical text form used to compare two deliveries of the same result. */
export function canonicalStageResult(envelope: StageResultEnvelope): string {
  return canonicalStringify(envelope);
}

export function sameStageResultProducer(
  left: StageResultProducer,
  right: StageResultProducer,
): boolean {
  if (left.kind === "agent_run")
    return right.kind === "agent_run" && left.agentRunId === right.agentRunId;
  return right.kind === "operator" && left.actorLabel === right.actorLabel;
}
