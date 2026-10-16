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
  dataKeyBytes: 128,
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
// the summary and data string values may contain them.
const forbiddenControls =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Code points that enable display or log-line spoofing in a later projection:
 * bidi marks, overrides and isolates, zero-width and byte-order marks, line and
 * paragraph separators, and lone surrogates (invalid UTF-16).
 */
function hasSpoofingCodePoint(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0x061c ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    )
      return true;
  }
  return false;
}

// Credential-looking content is rejected, not redacted: evidence stays exact
// or is refused. The patterns look for token-shaped material, not for words,
// so ordinary prose such as "basic validation" or "token: refresh logic" is
// accepted. Deliberately conservative; not a complete secret scanner.
const credentialPatterns: readonly RegExp[] = [
  // Bearer: a long token, or a shorter one that mixes in a digit.
  /\bbearer\s+(?:[A-Za-z0-9._~+/=-]{20,}|(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{12,})/i,
  // Basic: base64-shaped, with a digit, '+', '/', '=' or an interior capital.
  /\b[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/]*(?:[0-9+/]|[a-z][A-Z]))[A-Za-z0-9+/]{16,}={0,2}/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bauthorization\s*[:=]\s*(?:bearer|basic|token|digest)\s+\S{8,}/i,
  // name=value where the value has letters and digits, at least 6 characters.
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\s*[:=]\s*["']?(?=[^\s"']*[0-9])(?=[^\s"']*[A-Za-z])[^\s"']{6,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// Token-usage metering names are data, not secrets; a bare `token` is not.
const meteringKeyPattern =
  /^(?:input|output|total|prompt|completion|cached|max)?tokens(?:used|count)?$/;

function isSensitiveDataKey(key: string): boolean {
  const normalized = normalizeSensitiveFieldKey(key);
  if (meteringKeyPattern.test(normalized)) return false;
  return sensitiveFieldNames.some((name) => normalized.includes(name));
}

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
  if (forbiddenControls.test(text) || hasSpoofingCodePoint(text))
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

/**
 * Reads the own enumerable properties of an untrusted record exactly once and
 * returns a plain snapshot. An accessor is refused without being invoked, so
 * caller-controlled code never runs and a throwing getter cannot escape as an
 * arbitrary error. A Proxy trap that throws is translated by the boundary in
 * `parseStageResultEnvelope`.
 */
function snapshotRecord(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      return invalid(`${field} must contain plain data properties`);
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function parseProducer(input: unknown): StageResultProducer {
  if (!isRecord(input)) return invalid("producer must be an object");
  const value = snapshotRecord(input, "producer");
  const keys = Object.keys(value);
  const kind = value.kind;
  if (kind === "agent_run") {
    if (keys.some((key) => !["kind", "agentRunId"].includes(key)))
      return invalid("producer has unknown fields");
    const id = boundedText(
      value.agentRunId,
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
      value.actorLabel,
      "producer.actorLabel",
      stageResultLimits.identifierBytes,
    );
    if (!actorLabelPattern.test(label))
      return invalid("producer.actorLabel is malformed");
    return Object.freeze({ kind: "operator", actorLabel: label });
  }
  return invalid("producer.kind is not supported");
}

function parseError(input: unknown): StageResultError {
  if (!isRecord(input)) return invalid("error must be an object");
  const value = snapshotRecord(input, "error");
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

interface DataBudget {
  nodes: number;
  /** Cumulative characters of string values and keys. */
  chars: number;
}

function spend(budget: DataBudget, characters: number): void {
  budget.chars += characters;
  if (budget.chars > stageResultLimits.dataBytes)
    invalid(`data exceeds ${stageResultLimits.dataBytes} bytes`);
}

/**
 * Bounded pre-pass over untrusted `data`, run before any normalization so a
 * hostile shape (deep, wide or huge) is refused in work proportional to the
 * budget, not to the payload. It reads each own data property once and returns
 * a plain snapshot; every later step works on the snapshot, so a Proxy or an
 * object that changes between reads cannot get different content past the
 * checks. Accessors are refused without being invoked.
 */
function guardData(value: unknown, depth: number, budget: DataBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > stageResultLimits.dataNodes)
    invalid("data has too many nodes");
  if (depth > stageResultLimits.dataDepth) invalid("data is nested too deeply");
  if (typeof value === "string") {
    spend(budget, value.length);
    // Tab/LF/CR are legitimate inside data strings; other controls are not.
    assertSafeText(value, "data");
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > stageResultLimits.dataNodes)
      invalid("data has too many nodes");
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor))
        invalid("data is not canonical JSON");
      items.push(guardData(descriptor.value, depth + 1, budget));
    }
    return items;
  }
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    if (key.length > stageResultLimits.dataKeyBytes)
      invalid("data contains an oversized key");
    spend(budget, key.length);
    if (/[\t\n\r]/.test(key)) invalid("data contains forbidden characters");
    assertSafeText(key, "data");
    if (isSensitiveDataKey(key)) invalid("data contains a sensitive field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      invalid("data is not canonical JSON");
    entries.push([key, guardData(descriptor.value, depth + 1, budget)]);
  }
  // fromEntries defines own properties, so a `__proto__` key stays a key.
  return Object.fromEntries(entries);
}

function parseData(
  value: unknown,
): Readonly<Record<string, CanonicalJsonValue>> {
  if (!isRecord(value)) return invalid("data must be an object");
  const snapshot = guardData(value, 0, { nodes: 0, chars: 0 });
  let normalized: CanonicalJsonValue;
  try {
    normalized = normalizeCanonicalJson(snapshot);
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
  try {
    return parseEnvelope(value);
  } catch (error) {
    if (error instanceof DomainValidationError) throw error;
    // Exotic hostile input (for example a revoked Proxy) must still surface
    // as the typed, sanitized validation error, never as an arbitrary one.
    return invalid("envelope cannot be read");
  }
}

function parseEnvelope(input: unknown): StageResultEnvelope {
  if (!isRecord(input)) return invalid("envelope must be an object");
  const value = snapshotRecord(input, "envelope");
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
