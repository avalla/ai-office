/**
 * Owner-only provider credential files under `<AI_OFFICE_HOME>/credentials/`.
 *
 * One regular file per logical credential name holds exactly the credential
 * value (one trailing newline is tolerated). There is no shell or `.env`
 * syntax, so nothing is parsed, quoted or expanded.
 *
 * Reads fail closed on anything but an owner-only regular file in an
 * owner-only directory owned by the Runtime user, and never follow a symbolic
 * link. Errors carry sanitized codes only: never a value, a length or a path.
 *
 * This hardens against accidental exposure and other local users. It is not a
 * same-UID boundary: any process of the Runtime user can read these files, as
 * it can read the Runtime's environment (ADR-0014, ADR-0020).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { ProviderCredentialIssueCode } from "@ai-office/application/ports/provider-credential-source.port.ts";
import { runtimeHomeProviderCredentialsDirectory } from "@ai-office/runtime-paths/provider-credential-location.ts";

/** Upper bound for a credential value; provider API keys are far shorter. */
export const maximumProviderCredentialBytes = 4096;
/** A value plus one tolerated `\r\n`. */
const maximumFileBytes = maximumProviderCredentialBytes + 2;

const credentialNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** Visible ASCII only: no whitespace, NUL or control characters. */
const credentialValuePattern = /^[\x21-\x7E]+$/u;

export type RuntimeHomeCredentialRead =
  | { readonly state: "present"; readonly value: string }
  | { readonly state: "missing" }
  | { readonly state: "invalid"; readonly issue: ProviderCredentialIssueCode };

export class ProviderCredentialStoreError extends Error {
  constructor(
    readonly code: ProviderCredentialIssueCode | "CREDENTIAL_NAME_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialStoreError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownerOnly(status: Stats, uid: number): boolean {
  return status.uid === uid && (status.mode & 0o077) === 0;
}

function assertName(name: string): void {
  if (!credentialNamePattern.test(name))
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_NAME_INVALID",
      "Credential names are upper-case environment-style names.",
    );
}

/** Validates file content and returns the credential value, or null. */
export function parseProviderCredential(content: Buffer): string | null {
  if (content.length > maximumFileBytes) return null;
  let text = content.toString("latin1");
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  return text.length <= maximumProviderCredentialBytes &&
    credentialValuePattern.test(text)
    ? text
    : null;
}

type DirectoryState =
  | { readonly state: "missing" }
  | { readonly state: "invalid" }
  | { readonly state: "valid" };

function inspectDirectory(directory: string, uid: number): DirectoryState {
  let status: Stats;
  try {
    status = lstatSync(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  return status.isDirectory() &&
    !status.isSymbolicLink() &&
    ownerOnly(status, uid)
    ? { state: "valid" }
    : { state: "invalid" };
}

/** Reads one credential from a Runtime home without following symbolic links. */
export function readRuntimeHomeCredential(
  runtimeHome: string,
  name: string,
): RuntimeHomeCredentialRead {
  assertName(name);
  const uid = currentUid();
  if (uid === null) return { state: "invalid", issue: "CREDENTIAL_UNREADABLE" };
  const directory = runtimeHomeProviderCredentialsDirectory(runtimeHome);
  const directoryState = inspectDirectory(directory, uid);
  if (directoryState.state === "missing") return { state: "missing" };
  if (directoryState.state === "invalid")
    return { state: "invalid", issue: "CREDENTIAL_DIRECTORY_INSECURE" };

  let descriptor: number;
  try {
    // O_NONBLOCK keeps a FIFO planted at the name from blocking the Runtime.
    descriptor = openSync(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { state: "missing" };
    return {
      state: "invalid",
      issue:
        code === "ELOOP" || code === "EMLINK"
          ? "CREDENTIAL_SYMLINK"
          : "CREDENTIAL_UNREADABLE",
    };
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile())
      return { state: "invalid", issue: "CREDENTIAL_NOT_REGULAR_FILE" };
    if (status.uid !== uid)
      return { state: "invalid", issue: "CREDENTIAL_WRONG_OWNER" };
    if ((status.mode & 0o077) !== 0)
      return { state: "invalid", issue: "CREDENTIAL_INSECURE_PERMISSIONS" };
    if (status.size > maximumFileBytes)
      return { state: "invalid", issue: "CREDENTIAL_TOO_LARGE" };
    // Read one byte past the bound so growth after fstat is still refused.
    const buffer = Buffer.alloc(maximumFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > maximumFileBytes)
      return { state: "invalid", issue: "CREDENTIAL_TOO_LARGE" };
    const content = buffer.subarray(0, length);
    const value = parseProviderCredential(content);
    buffer.fill(0);
    return value === null
      ? { state: "invalid", issue: "CREDENTIAL_MALFORMED" }
      : { state: "present", value };
  } catch {
    return { state: "invalid", issue: "CREDENTIAL_UNREADABLE" };
  } finally {
    closeSync(descriptor);
  }
}

/** Creates the credential directory owner-only, or verifies an existing one. */
function ensureDirectory(runtimeHome: string, uid: number): string {
  const directory = runtimeHomeProviderCredentialsDirectory(runtimeHome);
  const state = inspectDirectory(directory, uid);
  if (state.state === "missing") {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw new ProviderCredentialStoreError(
          "CREDENTIAL_UNREADABLE",
          "The credential directory cannot be created.",
        );
    }
    if (inspectDirectory(directory, uid).state === "valid") return directory;
  } else if (state.state === "valid") return directory;
  throw new ProviderCredentialStoreError(
    "CREDENTIAL_DIRECTORY_INSECURE",
    "The credential directory must be a real directory owned by the Runtime user with no group or other access (chmod 700). Nothing was written.",
  );
}

/** Refuses to replace anything but a regular file at the credential name. */
function assertReplaceable(path: string): void {
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_UNREADABLE",
      "The existing credential cannot be inspected. Nothing was written.",
    );
  }
  if (status.isSymbolicLink())
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_SYMLINK",
      "The credential name is a symbolic link; remove it first. Nothing was written.",
    );
  if (!status.isFile())
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_NOT_REGULAR_FILE",
      "The credential name is not a regular file. Nothing was written.",
    );
}

/**
 * Atomically writes a credential: an exclusive owner-only temporary file in the
 * same directory, synced and renamed over the name.
 */
export function writeRuntimeHomeCredential(
  runtimeHome: string,
  name: string,
  content: Buffer,
): void {
  assertName(name);
  const value = parseProviderCredential(content);
  if (value === null)
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_MALFORMED",
      `A credential must be 1 to ${maximumProviderCredentialBytes} visible ASCII characters with no whitespace or control characters. Nothing was written.`,
    );
  const uid = currentUid();
  if (uid === null)
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_UNREADABLE",
      "Provider credential files are supported only on POSIX hosts.",
    );
  const directory = ensureDirectory(runtimeHome, uid);
  const target = join(directory, name);
  assertReplaceable(target);
  const temporary = join(
    directory,
    `.${name}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(value, "latin1");
    let written = 0;
    while (written < bytes.length)
      written += writeSync(descriptor, bytes, written, bytes.length - written);
    bytes.fill(0);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing was created, or it is already gone.
    }
    if (error instanceof ProviderCredentialStoreError) throw error;
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_UNREADABLE",
      "The credential could not be written. Nothing was replaced.",
    );
  }
  syncDirectory(directory);
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Directory fsync is best effort; the rename itself is atomic.
  }
}

/**
 * Removes a credential name. A symbolic link is removed as a link and never
 * followed. Returns false when nothing was configured.
 */
export function removeRuntimeHomeCredential(
  runtimeHome: string,
  name: string,
): boolean {
  assertName(name);
  const uid = currentUid();
  if (uid === null) return false;
  const directory = runtimeHomeProviderCredentialsDirectory(runtimeHome);
  const state = inspectDirectory(directory, uid);
  if (state.state === "missing") return false;
  if (state.state === "invalid")
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_DIRECTORY_INSECURE",
      "The credential directory must be a real directory owned by the Runtime user with no group or other access. Nothing was removed.",
    );
  const target = join(directory, name);
  let status: Stats;
  try {
    status = lstatSync(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_UNREADABLE",
      "The credential cannot be inspected. Nothing was removed.",
    );
  }
  if (!status.isFile() && !status.isSymbolicLink())
    throw new ProviderCredentialStoreError(
      "CREDENTIAL_NOT_REGULAR_FILE",
      "The credential name is not a regular file. Nothing was removed.",
    );
  unlinkSync(target);
  syncDirectory(directory);
  return true;
}
