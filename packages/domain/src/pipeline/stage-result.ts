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

const invisibleCodePoints =
  // eslint-disable-next-line no-misleading-character-class -- explicit code points
  /[\p{Cf}\p{Co}\p{Cs}\u034f\u115f\u1160\u3164\uffa0\ufffc\u{e0100}-\u{e01ef}]/u;

/**
 * Code points that enable display or log-line spoofing in a later projection:
 * bidi marks, overrides and isolates, zero-width and byte-order marks, line and
 * paragraph separators, and lone surrogates (invalid UTF-16).
 */
function hasSpoofingCodePoint(text: string): boolean {
  // Format (Cf: bidi, zero-width, word joiner, soft hyphen, tag characters),
  // private-use and surrogate categories, plus invisible fillers and
  // ideographic variation selectors that no general category covers.
  if (invisibleCodePoints.test(text)) return true;
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
  /(?<![A-Za-z0-9])(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Z0-9])A[KS]IA[0-9A-Z]{16}(?![A-Z0-9])/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // URL userinfo carrying a password.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\bauthorization\s*[:=]\s*(?:bearer|basic|token|digest)\s+\S{8,}/i,
  // name=value (a quoted name is allowed) where the value has letters and
  // digits, at least 6 characters; lookaheads are capped to stay linear.
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|passphrase|credential)s?["']?\s*[:=]\s*["']?(?=[^\s"']{0,256}[0-9])(?=[^\s"']{0,256}[A-Za-z])[^\s"']{6,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
];

// Token-usage metering names are data, not secrets; the prefix is mandatory,
// so a bare `token` or `tokens` (with or without a suffix) is still sensitive.
const meteringKeyPattern =
  /^(?:(?:input|output|total|prompt|completion|cached|reasoning|max|cacheread|cachecreation)(?:input)?)tokens(?:used|count)?$/;

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

/**
 * Rejections raised by this parser. Membership is tested with a WeakSet, which
 * never runs a trap, so a hostile thrown value (a Proxy whose
 * `getPrototypeOf` throws, a revoked Proxy) cannot be mistaken for one of
 * ours or make the classification itself throw.
 */
const parserRejections = new WeakSet<object>();

function invalid(reason: string): never {
  // Messages name the failing field only; they never echo the rejected value.
  const rejection = new DomainValidationError(
    `Invalid stage result: ${reason}`,
  );
  parserRejections.add(rejection);
  throw rejection;
}

function assertSafeText(text: string, field: string): void {
  // CR is allowed only as part of CRLF: a lone CR can overwrite a rendered line.
  if (
    forbiddenControls.test(text) ||
    /\r(?!\n)/.test(text) ||
    hasSpoofingCodePoint(text)
  )
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
  // Limits and character checks apply to the raw input; trimming happens only
  // afterwards, so padding cannot hide an oversized value or a forbidden
  // boundary character (for example a trailing BOM).
  if (byteLength(value) > maxBytes)
    return invalid(`${field} exceeds ${maxBytes} bytes`);
  if (options.multiline !== true && /[\t\n\r]/.test(value))
    return invalid(`${field} must be a single line`);
  assertSafeText(value, field);
  const text = value.trim();
  if (text === "") return invalid(`${field} cannot be empty`);
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(`${field} must contain plain data properties`);
  const keys = Object.keys(value);
  if (keys.length > stageResultLimits.dataNodes)
    return invalid(`${field} has too many properties`);
  // Symbol and non-enumerable properties are refused, not silently dropped.
  if (Reflect.ownKeys(value).length !== keys.length)
    return invalid(`${field} must contain plain data properties`);
  const entries: [string, unknown][] = [];
  for (const key of keys) {
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
  assertSafeText(code, "error.code");
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
    if (Object.getPrototypeOf(value) !== Array.prototype)
      invalid("data is not canonical JSON");
    // Indices plus `length`: extra, symbol or hidden properties are refused
    // rather than silently dropped by the snapshot.
    if (Reflect.ownKeys(value).length !== value.length + 1)
      invalid("data is not canonical JSON");
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        invalid("data is not canonical JSON");
      items.push(guardData(descriptor.value, depth + 1, budget));
    }
    return items;
  }
  // Only plain objects: snapshotting a Map, Date, Set or class instance would
  // launder it into an object of its own fields and silently change evidence.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid("data is not canonical JSON");
  const keys = Object.keys(value);
  // Symbol and non-enumerable properties are refused, not silently dropped.
  if (Reflect.ownKeys(value).length !== keys.length)
    invalid("data is not canonical JSON");
  if (keys.length > stageResultLimits.dataNodes - budget.nodes)
    invalid("data has too many nodes");
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    // UTF-8 bytes never fewer than UTF-16 units: cheap check, then exact.
    if (
      key.length > stageResultLimits.dataKeyBytes ||
      byteLength(key) > stageResultLimits.dataKeyBytes
    )
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
  // fromEntries defines own properties; `__proto__`, `constructor` and
  // `prototype` keys are then refused by canonical JSON normalization.
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
    // Only this parser's own rejections pass through; any other error, even a
    // DomainValidationError thrown by a hostile trap, is replaced.
    if (
      typeof error === "object" &&
      error !== null &&
      parserRejections.has(error)
    )
      throw error;
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
