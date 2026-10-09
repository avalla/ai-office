import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { errorMessage, isRecord } from "./shared.ts";

/**
 * Persistent checkpoints for the `task-delivery` skill (M19-T2).
 *
 * A checkpoint is a versioned, machine-readable snapshot of operational
 * delivery state, written by the implementation context at every gate and
 * read back when a fresh context resumes the work. Checkpoints are advisory:
 * resume re-validates live state and never treats a checkpoint as proof that
 * a gate was passed. Storage is the local filesystem only; a Runtime-backed
 * store is a later step, gated by ADR-0031.
 *
 * Layout, per task (so successive tasks sharing a worktree never share
 * state), all of it under the repository's shared Git exclude:
 *
 *   .task-delivery/<task>/handoff.md        context-handoff packet (T1)
 *   .task-delivery/<task>/checkpoints/<seq>.json   published, immutable
 *   .task-delivery/<task>/checkpoints/index.json    latest-valid pointer
 *   .task-delivery/<task>/checkpoints/.tmp-<uuid>   in flight, ignored
 *
 * The published file name is the zero-padded sequence alone, so the
 * exclusive-create reservation is per sequence, whatever the gate. A crash
 * can leave a zero-byte file behind (reserved, not yet renamed over); the
 * next publish removes such artifacts - once older than a grace period, so
 * a live publisher's in-flight reservation is never deleted - before
 * computing the sequence, and a colliding file that does not validate as a
 * checkpoint is removed on the retry path under the same age rule. Readers
 * cross-check the index against a scan of published files, so a crash
 * between the checkpoint rename and the index rename loses the update,
 * never the store.
 */

export const checkpointSchemaVersion = 1;

/**
 * How old a zero-byte or non-validating file at a sequence name must be
 * before cleanup treats it as a crash artifact. A younger file may be the
 * in-flight reservation of a live concurrent publisher: deleting it would
 * let that publisher's stalled rename overwrite a durable checkpoint.
 */
export const reservationGraceMs = 60_000;

/** Published checkpoints kept per task before automatic pruning starts. */
export const defaultCheckpointRetentionCap = 20;

/** Directory name holding a task's checkpoints, inside its task directory. */
export const checkpointsDirectoryName = "checkpoints";

export class CheckpointStoreError extends Error {
  // Widened to string so subclasses can narrow `name` to their own literal.
  override readonly name: string = "CheckpointStoreError";
}

/** A competing publisher reserved the same sequence number first. */
export class CheckpointExistsError extends CheckpointStoreError {
  override readonly name = "CheckpointExistsError";
  constructor(
    message: string,
    readonly seq: number,
  ) {
    super(message);
  }
}

/** The file exists but is not a checkpoint this reader can trust. */
export class CheckpointFormatError extends CheckpointStoreError {
  override readonly name = "CheckpointFormatError";
}

const checkpointFilePattern = /^(\d{6})\.json$/u;
const tempFilePattern = /^\.tmp-/u;
const idPattern = /^[0-9a-zA-Z][0-9a-zA-Z ._-]{0,63}$/u;
const shaPattern = /^[0-9a-f]{40,64}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const timestampMinimum = "2000-01-01T00:00:00.000Z";
const maximumPublishAttempts = 3;

export interface CheckpointEvidenceRef {
  readonly kind: "command" | "link" | "file";
  readonly value: string;
  /** Required for `file` references: content identity, not just a path. */
  readonly sha256?: string;
}

export interface CheckpointEvidence {
  readonly claim: string;
  readonly ref: CheckpointEvidenceRef;
}

// Type aliases rather than interfaces: object type literals get implicit
// index signatures, which keeps the parsed Record assignable without casts.
export type CheckpointFinding = {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
};

export type CheckpointDecision = {
  readonly what: string;
  readonly authorizedBy: string;
};

/** One immutable published checkpoint, schema version 1. */
export interface Checkpoint {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly run: {
    readonly task: string | null;
    readonly milestone: string | null;
    readonly branch: string;
    readonly base: string;
  };
  readonly head: {
    readonly sha: string;
    readonly dirty: boolean;
    readonly dirtyPaths: readonly string[];
    readonly capturedAt: string;
  };
  readonly stage: {
    readonly gate: string;
    readonly seq: number;
  };
  readonly profile: string;
  readonly evidence: readonly CheckpointEvidence[];
  readonly openFindings: readonly CheckpointFinding[];
  readonly decisions: readonly CheckpointDecision[];
  readonly unresolvedDependencies: readonly string[];
  readonly knownLimitations: readonly string[];
  readonly nextAction: string;
  readonly knowledgeReferences: readonly string[];
  readonly supersedes: string | null;
  readonly publishedAt: string;
}

/** What the caller supplies; head state comes from the Git provider. */
export interface PublishCheckpointInput {
  readonly task: string | null;
  readonly milestone?: string | null;
  readonly branch: string;
  readonly base: string;
  readonly profile: string;
  readonly gate: string;
  readonly evidence?: readonly CheckpointEvidence[];
  readonly openFindings?: readonly CheckpointFinding[];
  readonly decisions?: readonly CheckpointDecision[];
  readonly unresolvedDependencies?: readonly string[];
  readonly knownLimitations?: readonly string[];
  readonly nextAction: string;
  readonly knowledgeReferences?: readonly string[];
}

/**
 * Live repository state, injected so tests stay deterministic and never
 * shell out to Git. The implementation context supplies the real one.
 */
export interface GitStateProvider {
  readonly headSha: () => string;
  readonly dirtyPaths: () => readonly string[];
}

export interface PublishOptions {
  /** Test seam: deterministic clock. Defaults to the system time. */
  readonly now?: () => Date;
  /** Test seam: deterministic ids. Defaults to random UUIDs. */
  readonly idGen?: () => string;
  /** Retention cap applied after publishing. Defaults to 20. */
  readonly retentionCap?: number;
}

export interface PublishResult {
  readonly checkpoint: Checkpoint;
  readonly pruned: readonly string[];
  /** Retention is best-effort hygiene: its failure never fails the publish. */
  readonly pruneError: string | null;
}

export interface ResumeAssessment {
  /** Null when no checkpoint exists or the latest could not be trusted. */
  readonly checkpoint: Checkpoint | null;
  /** False when the latest checkpoint is missing, corrupt, or unsupported. */
  readonly usable: boolean;
  /** Why the checkpoint is not usable; null when it is. */
  readonly invalidReason: string | null;
  /** The live HEAD differs from the recorded one: evidence no longer binds. */
  readonly headChanged: boolean;
  readonly recordedHead: string | null;
  readonly liveHead: string;
  readonly dirty: boolean;
  readonly dirtyPaths: readonly string[];
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new CheckpointFormatError(`${path} must be an object`);
  return value;
}

function requireString(
  value: unknown,
  path: string,
  { pattern }: { pattern?: RegExp } = {},
): string {
  if (typeof value !== "string" || value === "")
    throw new CheckpointFormatError(`${path} must be a non-empty string`);
  if (pattern !== undefined && !pattern.test(value))
    throw new CheckpointFormatError(`${path} has an invalid value: ${value}`);
  return value;
}

function requireTimestamp(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!isoUtcPattern.test(text))
    throw new CheckpointFormatError(
      `${path} is not an ISO-8601 UTC timestamp: ${text}`,
    );
  const parsed = new Date(text);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== text ||
    text < timestampMinimum
  )
    throw new CheckpointFormatError(
      `${path} is not a valid ISO-8601 UTC timestamp: ${text}`,
    );
  return text;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value))
    throw new CheckpointFormatError(`${path} must be an array`);
  return value.map((entry, index) =>
    requireString(entry, `${path}[${index}]`, {
      pattern: /^[^\0].*$/u,
    }),
  );
}

function requireOptionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, path, { pattern: idPattern });
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      throw new CheckpointFormatError(
        `${path} has unknown key "${key}" (schema version ${checkpointSchemaVersion} accepts: ${allowed.join(", ")})`,
      );
}

function parseEvidence(value: unknown, path: string): CheckpointEvidence[] {
  if (!Array.isArray(value))
    throw new CheckpointFormatError(`${path} must be an array`);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = requireRecord(entry, itemPath);
    rejectUnknownFields(item, ["claim", "ref"], itemPath);
    const refPath = `${itemPath}.ref`;
    const ref = requireRecord(item.ref, refPath);
    rejectUnknownFields(ref, ["kind", "value", "sha256"], refPath);
    const kind = requireString(ref.kind, `${refPath}.kind`);
    if (kind !== "command" && kind !== "link" && kind !== "file")
      throw new CheckpointFormatError(
        `${refPath}.kind must be command, link, or file`,
      );
    const sha256 =
      ref.sha256 === undefined
        ? undefined
        : requireString(ref.sha256, `${refPath}.sha256`, {
            pattern: sha256Pattern,
          });
    if (kind === "file" && sha256 === undefined)
      throw new CheckpointFormatError(
        `${refPath}.sha256 is required for a file reference`,
      );
    return {
      claim: requireString(item.claim, `${itemPath}.claim`),
      ref: {
        kind,
        value: requireString(ref.value, `${refPath}.value`),
        ...(sha256 === undefined ? {} : { sha256 }),
      },
    };
  });
}

function parseTypedArray(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, string>[] {
  if (!Array.isArray(value))
    throw new CheckpointFormatError(`${path} must be an array`);
  return value.map((entry, index) => {
    const item = requireRecord(entry, `${path}[${index}]`);
    rejectUnknownFields(item, fields, `${path}[${index}]`);
    const parsed: Record<string, string> = {};
    for (const field of fields)
      parsed[field] = requireString(item[field], `${path}[${index}].${field}`);
    return parsed;
  });
}

/** Parses and strictly validates a checkpoint document. */
export function parseCheckpoint(raw: string): Checkpoint {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new CheckpointFormatError(
      `checkpoint is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const root = requireRecord(document, "checkpoint");
  rejectUnknownFields(
    root,
    [
      "schemaVersion",
      "id",
      "run",
      "head",
      "stage",
      "profile",
      "evidence",
      "openFindings",
      "decisions",
      "unresolvedDependencies",
      "knownLimitations",
      "nextAction",
      "knowledgeReferences",
      "supersedes",
      "publishedAt",
    ],
    "checkpoint",
  );
  if (root.schemaVersion !== checkpointSchemaVersion)
    throw new CheckpointFormatError(
      `checkpoint schemaVersion is ${String(root.schemaVersion)}; this reader supports exactly ${checkpointSchemaVersion}`,
    );
  const run = requireRecord(root.run, "checkpoint.run");
  rejectUnknownFields(
    run,
    ["task", "milestone", "branch", "base"],
    "checkpoint.run",
  );
  const head = requireRecord(root.head, "checkpoint.head");
  rejectUnknownFields(
    head,
    ["sha", "dirty", "dirtyPaths", "capturedAt"],
    "checkpoint.head",
  );
  const dirtyPaths = requireStringArray(
    head.dirtyPaths,
    "checkpoint.head.dirtyPaths",
  );
  for (const dirtyPath of dirtyPaths)
    if (isAbsolute(dirtyPath) || dirtyPath.split("/").includes(".."))
      throw new CheckpointFormatError(
        `checkpoint.head.dirtyPaths entry is not a relative in-repository path: ${dirtyPath}`,
      );
  const dirty = head.dirty;
  if (typeof dirty !== "boolean" || dirty !== dirtyPaths.length > 0)
    throw new CheckpointFormatError(
      "checkpoint.head.dirty must be a boolean consistent with dirtyPaths",
    );
  const stage = requireRecord(root.stage, "checkpoint.stage");
  rejectUnknownFields(stage, ["gate", "seq"], "checkpoint.stage");
  const seq = stage.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1)
    throw new CheckpointFormatError(
      "checkpoint.stage.seq must be an integer >= 1",
    );
  return {
    schemaVersion: checkpointSchemaVersion,
    id: requireString(root.id, "checkpoint.id", { pattern: idPattern }),
    run: {
      task: requireOptionalString(run.task, "checkpoint.run.task"),
      milestone: requireOptionalString(
        run.milestone,
        "checkpoint.run.milestone",
      ),
      branch: requireString(run.branch, "checkpoint.run.branch"),
      base: requireString(run.base, "checkpoint.run.base"),
    },
    head: {
      sha: requireString(head.sha, "checkpoint.head.sha", {
        pattern: shaPattern,
      }),
      dirty,
      dirtyPaths,
      capturedAt: requireTimestamp(
        head.capturedAt,
        "checkpoint.head.capturedAt",
      ),
    },
    stage: {
      gate: requireString(stage.gate, "checkpoint.stage.gate", {
        pattern: /^[a-z0-9][a-z0-9_-]*$/u,
      }),
      seq,
    },
    profile: requireString(root.profile, "checkpoint.profile"),
    evidence: parseEvidence(root.evidence, "checkpoint.evidence"),
    openFindings: parseTypedArray(
      root.openFindings,
      "checkpoint.openFindings",
      ["id", "severity", "status"],
    ) as CheckpointFinding[],
    decisions: parseTypedArray(root.decisions, "checkpoint.decisions", [
      "what",
      "authorizedBy",
    ]) as CheckpointDecision[],
    unresolvedDependencies: requireStringArray(
      root.unresolvedDependencies,
      "checkpoint.unresolvedDependencies",
    ),
    knownLimitations: requireStringArray(
      root.knownLimitations,
      "checkpoint.knownLimitations",
    ),
    nextAction: requireString(root.nextAction, "checkpoint.nextAction"),
    knowledgeReferences: requireStringArray(
      root.knowledgeReferences,
      "checkpoint.knowledgeReferences",
    ),
    supersedes: requireOptionalString(root.supersedes, "checkpoint.supersedes"),
    publishedAt: requireTimestamp(root.publishedAt, "checkpoint.publishedAt"),
  };
}

interface CheckpointIndexEntry {
  readonly seq: number;
  readonly file: string;
  readonly id: string;
  readonly sha256: string;
}

interface CheckpointIndex {
  readonly schemaVersion: 1;
  readonly latest: CheckpointIndexEntry | null;
  readonly updatedAt: string;
}

/**
 * Maps a task identifier or fallback name to its checkpoint directory name.
 * Names that already are safe single path segments (task identifiers) are
 * used unchanged. Any other name - typically a branch name such as
 * `feat/m19-t2-checkpoints` when there is no task identifier - is encoded
 * deterministically as `_` followed by the lowercase hex of its UTF-8
 * bytes. The leading underscore can never start a plain identifier
 * ({@link idPattern} requires an alphanumeric first character), so an
 * encoded name cannot collide with one, and hex holds no path separators,
 * so the result stays a single safe segment. For well-formed UTF-8 names
 * the mapping is reversible via {@link decodeCheckpointDirectoryName}.
 */
export function encodeCheckpointDirectoryName(name: string): string {
  if (name === "")
    throw new CheckpointStoreError(
      "checkpoint directory name must not be empty",
    );
  if (idPattern.test(name)) return name;
  const encoded = `_${Buffer.from(name, "utf8").toString("hex")}`;
  if (encoded.length > 255)
    throw new CheckpointStoreError(
      `checkpoint directory name is too long to encode safely: ${name.length} code units`,
    );
  return encoded;
}

/**
 * The inverse of {@link encodeCheckpointDirectoryName}: plain identifiers
 * come back unchanged, `_`-prefixed hex names decode to the original name.
 * Only the encoder's image is accepted: a name whose hex is malformed, has
 * an odd digit count, or does not re-encode to itself is rejected, so
 * decoding never returns mojibake for something encoding never produced.
 */
export function decodeCheckpointDirectoryName(encoded: string): string {
  if (!encoded.startsWith("_")) {
    if (!idPattern.test(encoded))
      throw new CheckpointFormatError(
        `not a checkpoint directory name: ${encoded}`,
      );
    return encoded;
  }
  if (!/^_[0-9a-f]+$/u.test(encoded) || encoded.length % 2 === 0)
    throw new CheckpointFormatError(
      `not an encoded checkpoint directory name: ${encoded}`,
    );
  const decoded = Buffer.from(encoded.slice(1), "hex").toString("utf8");
  if (encodeCheckpointDirectoryName(decoded) !== encoded)
    throw new CheckpointFormatError(
      `not an encoded checkpoint directory name: ${encoded}`,
    );
  return decoded;
}

/** The `.task-delivery/<task>` directory for `name` under `root`. */
export function taskCheckpointDirectory(root: string, name: string): string {
  if (!isAbsolute(root))
    throw new CheckpointStoreError(
      `repository root must be an absolute path, got: ${root}`,
    );
  return resolve(
    join(root, ".task-delivery", encodeCheckpointDirectoryName(name)),
  );
}

function checkpointsDirectory(taskDirectory: string): string {
  return join(taskDirectory, checkpointsDirectoryName);
}

function checkpointFileName(seq: number): string {
  return `${String(seq).padStart(6, "0")}.json`;
}

function seqFromFileName(file: string): number | null {
  const match = checkpointFilePattern.exec(file);
  return match === null ? null : Number.parseInt(match[1] ?? "0", 10);
}

function parseIndex(raw: string): CheckpointIndex {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new CheckpointFormatError(
      `checkpoint index is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const root = requireRecord(document, "index");
  rejectUnknownFields(root, ["schemaVersion", "latest", "updatedAt"], "index");
  if (root.schemaVersion !== 1)
    throw new CheckpointFormatError(
      `checkpoint index schemaVersion is ${String(root.schemaVersion)}; this reader supports exactly 1`,
    );
  let latest: CheckpointIndexEntry | null = null;
  if (root.latest !== null && root.latest !== undefined) {
    const entry = requireRecord(root.latest, "index.latest");
    rejectUnknownFields(entry, ["seq", "file", "id", "sha256"], "index.latest");
    const seq = entry.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1)
      throw new CheckpointFormatError(
        "index.latest.seq must be an integer >= 1",
      );
    const file = requireString(entry.file, "index.latest.file", {
      pattern: checkpointFilePattern,
    });
    if (seqFromFileName(file) !== seq)
      throw new CheckpointFormatError(
        `index.latest.seq ${String(seq)} does not match its file name ${file}`,
      );
    latest = {
      seq,
      file,
      id: requireString(entry.id, "index.latest.id", { pattern: idPattern }),
      sha256: requireString(entry.sha256, "index.latest.sha256", {
        pattern: sha256Pattern,
      }),
    };
  }
  return {
    schemaVersion: 1,
    latest,
    updatedAt: requireTimestamp(root.updatedAt, "index.updatedAt"),
  };
}

/**
 * Writes `content` to `fileName` inside `directory` so readers never see a
 * partial file: unique temp file, fsync, atomic rename, then a directory
 * fsync so the rename itself is durable. When `exclusive` is set, the final
 * name is reserved with `O_EXCL` first: a racing publisher fails with
 * {@link CheckpointExistsError} instead of overwriting, and the reservation
 * is the crash artifact the next publish cleans away.
 */
function writeAtomic(
  directory: string,
  fileName: string,
  content: string,
  exclusive: boolean,
): void {
  const tempPath = join(directory, `.tmp-${randomUUID()}`);
  const descriptor = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const finalPath = join(directory, fileName);
  if (exclusive) {
    let reservation: number;
    try {
      reservation = openSync(finalPath, "wx", 0o644);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temp file is dot-prefixed and ignored; cleanup is best effort.
      }
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new CheckpointExistsError(
          `checkpoint ${fileName} already exists; a concurrent publisher won the sequence`,
          seqFromFileName(fileName) ?? 0,
        );
      throw error;
    }
    closeSync(reservation);
  }
  renameSync(tempPath, finalPath);
  fsyncDirectory(directory);
}

/** Makes a rename durable; best effort is not enough for crash recovery. */
function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * A couple of milliseconds, spent synchronously: long enough for a
 * concurrent publisher to finish its rename between reservation attempts,
 * short enough to keep a contended publish cheap. Publish is a synchronous
 * API, so this spins rather than sleeping.
 */
function pauseBetweenPublishAttempts(): void {
  const until = Date.now() + 2;
  while (Date.now() < until) {
    // Spin: see the function comment.
  }
}

function readIndex(taskDirectory: string): CheckpointIndex | null {
  const path = join(checkpointsDirectory(taskDirectory), "index.json");
  if (!existsSync(path)) return null;
  return parseIndex(readFileSync(path, "utf8"));
}

function listPublishedFiles(taskDirectory: string): string[] {
  const directory = checkpointsDirectory(taskDirectory);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (tempFilePattern.test(entry)) continue;
    if (!lstatSync(join(directory, entry)).isFile()) continue;
    if (checkpointFilePattern.test(entry)) files.push(entry);
  }
  return files.sort();
}

function readPublishedCheckpoint(directory: string, file: string): Checkpoint {
  const checkpoint = parseCheckpoint(
    readFileSync(join(directory, file), "utf8"),
  );
  if (seqFromFileName(file) !== checkpoint.stage.seq)
    throw new CheckpointFormatError(
      `checkpoint file ${file} disagrees with its content sequence ${String(checkpoint.stage.seq)}`,
    );
  return checkpoint;
}

/**
 * Finds the highest-sequence valid checkpoint by scanning published files,
 * for recovery when the index is missing, stale, or its file failed the
 * recorded hash. Files that do not parse, or whose name disagrees with
 * their content, are skipped and left for inspection. Returns null when
 * none parse.
 */
function scanLatest(
  taskDirectory: string,
): { entry: CheckpointIndexEntry; bytes: Buffer } | null {
  const directory = checkpointsDirectory(taskDirectory);
  let best: { entry: CheckpointIndexEntry; bytes: Buffer } | null = null;
  for (const file of listPublishedFiles(taskDirectory)) {
    try {
      const bytes = readFileSync(join(directory, file));
      const checkpoint = parseCheckpoint(bytes.toString("utf8"));
      const seq = seqFromFileName(file);
      if (seq === null || seq !== checkpoint.stage.seq) continue;
      if (best === null || seq > best.entry.seq)
        best = {
          entry: { seq, file, id: checkpoint.id, sha256: sha256Hex(bytes) },
          bytes,
        };
    } catch {
      // Unreadable, unparseable, or inconsistent: not the latest valid one.
    }
  }
  return best;
}

/**
 * Removes zero-byte published files older than {@link reservationGraceMs}:
 * the reservation artifact of a crash between the exclusive create and the
 * rename. A younger file may be a live publisher's in-flight reservation
 * and is left alone. Runs at publish time only, so reads stay free of
 * write side effects.
 */
function removeCrashedReservationArtifacts(directory: string): string[] {
  const removed: string[] = [];
  const now = Date.now();
  for (const file of readdirSync(directory)) {
    if (!checkpointFilePattern.test(file)) continue;
    const path = join(directory, file);
    try {
      const stats = statSync(path);
      if (stats.size !== 0) continue;
      if (now - stats.mtimeMs < reservationGraceMs) continue;
      unlinkSync(path);
      removed.push(file);
    } catch {
      // A racing cleanup wins; the publish attempt reports what it saw.
    }
  }
  return removed;
}

/**
 * Handles an exclusive-create collision at `seq`. A file that validates as
 * a checkpoint is a lost race, left in place for the retry to re-read. A
 * file that does not validate and is older than {@link reservationGraceMs}
 * is a crashed or corrupt artifact and is removed so the retry can use the
 * sequence; a younger file is a live publisher's reservation and is never
 * deleted - the retry loop surfaces the contention instead.
 */
function handleSequenceCollision(directory: string, seq: number): void {
  const file = checkpointFileName(seq);
  const path = join(directory, file);
  let aged: boolean;
  try {
    aged = Date.now() - statSync(path).mtimeMs >= reservationGraceMs;
  } catch {
    return; // Gone between the collision and the inspection; the retry re-reads.
  }
  if (!aged) return;
  try {
    readPublishedCheckpoint(directory, file);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      // Best effort; the retry reports the collision again if it persists.
    }
  }
}

/**
 * Loads the latest published checkpoint and its bytes. Trusts the index
 * only after cross-checking it against the scan: a crash between the
 * checkpoint rename and the index rename leaves a stale-but-valid index,
 * and the scan is what reveals the newer checkpoint. Throws
 * {@link CheckpointFormatError} when an indexed file fails the recorded
 * hash (a tamper signal) or when nothing trustworthy reads.
 */
function loadLatestCheckpoint(
  taskDirectory: string,
): { entry: CheckpointIndexEntry; bytes: Buffer } | null {
  const directory = checkpointsDirectory(taskDirectory);
  let indexed: { entry: CheckpointIndexEntry; bytes: Buffer } | null = null;
  let indexEntry: CheckpointIndexEntry | null;
  try {
    indexEntry = readIndex(taskDirectory)?.latest ?? null;
  } catch (error) {
    if (!(error instanceof CheckpointFormatError)) throw error;
    // A corrupt index says nothing about any checkpoint; fall back to the
    // scan, and let the next publish rewrite the index.
    indexEntry = null;
  }
  if (indexEntry !== null) {
    const path = join(directory, indexEntry.file);
    if (!existsSync(path)) {
      const recovered = scanLatest(taskDirectory);
      if (recovered === null)
        throw new CheckpointFormatError(
          `checkpoint index points at ${indexEntry.file}, which is missing`,
        );
    } else {
      const bytes = readFileSync(path);
      if (sha256Hex(bytes) !== indexEntry.sha256)
        throw new CheckpointFormatError(
          `checkpoint ${indexEntry.file} does not match the hash recorded in index.json; resume from live state without it, or restore the file from a trusted copy`,
        );
      indexed = { entry: indexEntry, bytes };
    }
  }
  const scanned = scanLatest(taskDirectory);
  if (indexed !== null && scanned !== null)
    return scanned.entry.seq > indexed.entry.seq ? scanned : indexed;
  return indexed ?? scanned;
}

/**
 * Publishes the next checkpoint for a task. The sequence is one more than
 * the latest valid checkpoint known to a fresh read; losing the exclusive
 * reservation re-reads and retries, so a concurrent publisher can stall a
 * sequence but never fork it. Under real contention the reservation race
 * can be lost on every attempt: the typed {@link CheckpointExistsError}
 * then reaches the caller, which retries the call. Published checkpoints
 * are never modified; a newer one supersedes them by reference.
 */
export function publishCheckpoint(
  taskDirectory: string,
  input: PublishCheckpointInput,
  git: GitStateProvider,
  options: PublishOptions = {},
): PublishResult {
  const now = options.now ?? (() => new Date());
  const idGen = options.idGen ?? (() => randomUUID());
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(input.gate))
    throw new CheckpointStoreError(
      `gate must be lowercase letters, digits, _ or -, got: ${input.gate}`,
    );
  if (input.nextAction.trim() === "")
    throw new CheckpointStoreError("nextAction must not be empty");

  const directory = checkpointsDirectory(taskDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  removeCrashedReservationArtifacts(directory);

  const headSha = git.headSha();
  const dirtyPaths = [...git.dirtyPaths()];
  if (!shaPattern.test(headSha))
    throw new CheckpointStoreError(
      `git provider returned something that is not a full commit sha: ${headSha}`,
    );

  const timestamp = now().toISOString();
  const id = idGen();
  let lastCollision: CheckpointExistsError | null = null;
  for (let attempt = 0; attempt < maximumPublishAttempts; attempt += 1) {
    if (attempt > 0) pauseBetweenPublishAttempts();
    const current = loadLatestCheckpoint(taskDirectory);
    const previous =
      current === null ? null : parseCheckpoint(current.bytes.toString("utf8"));
    const seq = previous === null ? 1 : previous.stage.seq + 1;
    const checkpoint: Checkpoint = {
      schemaVersion: checkpointSchemaVersion,
      id,
      run: {
        task: input.task,
        milestone: input.milestone ?? null,
        branch: input.branch,
        base: input.base,
      },
      head: {
        sha: headSha,
        dirty: dirtyPaths.length > 0,
        dirtyPaths,
        capturedAt: timestamp,
      },
      stage: { gate: input.gate, seq },
      profile: input.profile,
      evidence: input.evidence ?? [],
      openFindings: input.openFindings ?? [],
      decisions: input.decisions ?? [],
      unresolvedDependencies: input.unresolvedDependencies ?? [],
      knownLimitations: input.knownLimitations ?? [],
      nextAction: input.nextAction,
      knowledgeReferences: input.knowledgeReferences ?? [],
      supersedes: previous === null ? null : previous.id,
      publishedAt: timestamp,
    };
    const body = `${JSON.stringify(checkpoint, null, 2)}\n`;
    // Write/read symmetry: refuse to publish a document the reader would
    // reject, whatever the provider or caller handed us.
    try {
      parseCheckpoint(body);
    } catch (error) {
      throw new CheckpointStoreError(
        `refusing to publish a checkpoint its own reader would reject: ${errorMessage(error)}`,
      );
    }
    try {
      writeAtomic(directory, checkpointFileName(seq), body, true);
      const bytes = Buffer.from(body, "utf8");
      // The index is made durable before retention pruning, so no index,
      // old or new, ever references a file pruning is about to delete; a
      // crash between the two renames is recovered by the scan.
      const index: CheckpointIndex = {
        schemaVersion: 1,
        latest: {
          seq,
          file: checkpointFileName(seq),
          id: checkpoint.id,
          sha256: sha256Hex(bytes),
        },
        updatedAt: timestamp,
      };
      writeAtomic(
        directory,
        "index.json",
        `${JSON.stringify(index, null, 2)}\n`,
        false,
      );
      let pruned: readonly string[] = [];
      let pruneError: string | null = null;
      try {
        pruned = pruneCheckpoints(
          taskDirectory,
          options.retentionCap ?? defaultCheckpointRetentionCap,
        );
      } catch (error) {
        pruneError = errorMessage(error);
      }
      return { checkpoint, pruned, pruneError };
    } catch (error) {
      if (error instanceof CheckpointExistsError) {
        lastCollision = error;
        handleSequenceCollision(directory, error.seq);
        continue;
      }
      throw error;
    }
  }
  throw (
    lastCollision ??
    new CheckpointStoreError("publish failed without a recorded cause")
  );
}

/**
 * All published checkpoints of a task, oldest first. Zero-byte files are
 * reservation artifacts (live or crashed) and are skipped; any other file
 * that does not validate throws, because a non-empty corrupt file is
 * evidence of tampering or media corruption, not of a transient state.
 */
export function listCheckpoints(taskDirectory: string): Checkpoint[] {
  const directory = checkpointsDirectory(taskDirectory);
  const checkpoints: Checkpoint[] = [];
  for (const file of listPublishedFiles(taskDirectory)) {
    if (statSync(join(directory, file)).size === 0) continue;
    checkpoints.push(readPublishedCheckpoint(directory, file));
  }
  return checkpoints;
}

function handoffCitedCheckpointIds(taskDirectory: string): Set<string> {
  const path = join(taskDirectory, "handoff.md");
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, "utf8");
  const directory = checkpointsDirectory(taskDirectory);
  const cited = new Set<string>();
  for (const file of listPublishedFiles(taskDirectory)) {
    try {
      const checkpoint = readPublishedCheckpoint(directory, file);
      if (text.includes(checkpoint.id)) cited.add(checkpoint.id);
    } catch {
      // Unparseable files have no id to cite.
    }
  }
  return cited;
}

/**
 * Deletes the oldest valid published checkpoints beyond `cap`, never the
 * latest and never one whose id a handoff packet cites. Files that do not
 * validate are not checkpoints: they are skipped, never deleted. Returns
 * deleted file names. Immutability means no mutation of what stays;
 * deletion under an explicit retention rule is the documented lifecycle of
 * what goes.
 */
export function pruneCheckpoints(taskDirectory: string, cap: number): string[] {
  if (!Number.isInteger(cap) || cap < 1)
    throw new CheckpointStoreError(
      `retention cap must be an integer >= 1, got: ${cap}`,
    );
  const directory = checkpointsDirectory(taskDirectory);
  const published: Checkpoint[] = [];
  for (const file of listPublishedFiles(taskDirectory)) {
    try {
      published.push(readPublishedCheckpoint(directory, file));
    } catch {
      // Not a valid checkpoint: outside retention's remit.
    }
  }
  if (published.length <= cap) return [];
  const cited = handoffCitedCheckpointIds(taskDirectory);
  const latestId =
    published.reduce((a, b) => (a.stage.seq > b.stage.seq ? a : b))?.id ?? null;
  const deletable = published
    .filter(
      (checkpoint) => checkpoint.id !== latestId && !cited.has(checkpoint.id),
    )
    .sort((a, b) => a.stage.seq - b.stage.seq);
  const excess = published.length - cap;
  const deleted: string[] = [];
  for (const checkpoint of deletable.slice(0, Math.max(0, excess))) {
    const fileName = checkpointFileName(checkpoint.stage.seq);
    try {
      unlinkSync(join(directory, fileName));
      deleted.push(fileName);
    } catch (error) {
      throw new CheckpointStoreError(
        `failed to prune ${fileName}: ${errorMessage(error)}`,
      );
    }
  }
  return deleted;
}

/**
 * Assesses whether a fresh context can resume from this task's latest
 * checkpoint. The assessment is advisory and never proves a gate passed:
 * `headChanged` means the recorded evidence no longer binds to the live
 * head, `dirty` means the working tree differs and must be handled
 * explicitly, and `usable: false` means the checkpoint itself cannot be
 * trusted, with the reason saying why.
 */
export function assessResume(
  taskDirectory: string,
  git: GitStateProvider,
): ResumeAssessment {
  const liveHead = git.headSha();
  const dirtyPaths = [...git.dirtyPaths()];
  const base = {
    headChanged: false,
    recordedHead: null as string | null,
    liveHead,
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
  let loaded: { bytes: Buffer } | null;
  try {
    loaded = loadLatestCheckpoint(taskDirectory);
  } catch (error) {
    if (error instanceof CheckpointStoreError)
      return {
        checkpoint: null,
        usable: false,
        invalidReason: error.message,
        ...base,
      };
    throw error;
  }
  if (loaded === null)
    return {
      checkpoint: null,
      usable: false,
      invalidReason: "no checkpoint has been published for this task",
      ...base,
    };
  let checkpoint: Checkpoint;
  try {
    checkpoint = parseCheckpoint(loaded.bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof CheckpointStoreError)
      return {
        checkpoint: null,
        usable: false,
        invalidReason: error.message,
        ...base,
      };
    throw error;
  }
  return {
    checkpoint,
    usable: true,
    invalidReason: null,
    headChanged: checkpoint.head.sha !== liveHead,
    recordedHead: checkpoint.head.sha,
    liveHead,
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
}
