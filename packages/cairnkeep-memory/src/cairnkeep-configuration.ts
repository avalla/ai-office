import { isAbsolute, resolve } from "node:path";
import { projectMemoryLimits } from "@ai-office/application/ports/project-memory-provider.port.ts";

/**
 * Machine-local, environment-only configuration read once by the Runtime
 * composition root. Nothing here is written to `.ai-office/project.json`,
 * portable snapshots, office manifests, generated Markdown, or SQLite.
 */
export const projectMemoryEnvironment = {
  provider: "AI_OFFICE_PROJECT_MEMORY_PROVIDER",
  cairnKeepCommand: "AI_OFFICE_CAIRNKEEP_COMMAND",
  timeoutMs: "AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS",
  /** CairnKeep's own store root; normalized here, never forwarded raw. */
  cairnKeepBaseDirectory: "CAIRN_AGENTFS_BASE_DIR",
} as const;

export const defaultCairnKeepCommand = "cairn";
const minimumTimeoutMs = 100;

export type ProjectMemoryConfiguration =
  | { kind: "disabled" }
  | {
      kind: "cairnkeep";
      command: string;
      timeoutMs: number;
      /** Absolute, normalized `CAIRN_AGENTFS_BASE_DIR`; null leaves it unset. */
      baseDirectory: string | null;
    }
  | { kind: "misconfigured"; provider: string; reason: string };

/**
 * `AI_OFFICE_PROJECT_MEMORY_PROVIDER`: unset, empty or `none` disables project
 * memory (the default); `cairnkeep` enables the CairnKeep adapter.
 *
 * `AI_OFFICE_CAIRNKEEP_COMMAND`: a bare executable name resolved through the
 * Runtime host's `PATH` (default `cairn`) or an absolute path. Relative paths
 * are rejected because the persistent host must not depend on its own cwd.
 * The command never takes arguments from configuration; the adapter always
 * appends exactly `memory-server`.
 *
 * `AI_OFFICE_PROJECT_MEMORY_TIMEOUT_MS`: whole-retrieval deadline including
 * process start, integer 100..30000, default 5000.
 *
 * `CAIRN_AGENTFS_BASE_DIR`: see {@link resolveCairnKeepBaseDirectory}.
 */
export function resolveProjectMemoryConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
): ProjectMemoryConfiguration {
  const provider = (
    environment[projectMemoryEnvironment.provider] ?? ""
  ).trim();
  if (provider === "" || provider === "none") return { kind: "disabled" };
  if (provider !== "cairnkeep")
    return {
      kind: "misconfigured",
      provider: "unknown",
      reason: `${projectMemoryEnvironment.provider} must be none or cairnkeep.`,
    };
  if (platform === "win32")
    return {
      kind: "misconfigured",
      provider,
      reason:
        "The CairnKeep project memory adapter is supported on Linux and macOS only.",
    };

  const command =
    environment[projectMemoryEnvironment.cairnKeepCommand] ??
    defaultCairnKeepCommand;
  const bareName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command);
  const absolutePath =
    isAbsolute(command) &&
    command.length <= 4096 &&
    // Control characters, including NUL and newlines, are never valid here.
    !/\p{Cc}/u.test(command);
  if (!bareName && !absolutePath)
    return {
      kind: "misconfigured",
      provider,
      reason: `${projectMemoryEnvironment.cairnKeepCommand} must be an executable name or an absolute path without arguments.`,
    };

  const timeoutText = environment[projectMemoryEnvironment.timeoutMs];
  let timeoutMs: number = projectMemoryLimits.defaultTimeoutMs;
  if (timeoutText !== undefined && timeoutText.trim() !== "") {
    timeoutMs = /^\d{1,6}$/u.test(timeoutText.trim())
      ? Number(timeoutText.trim())
      : Number.NaN;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < minimumTimeoutMs ||
      timeoutMs > projectMemoryLimits.maxTimeoutMs
    )
      return {
        kind: "misconfigured",
        provider,
        reason: `${projectMemoryEnvironment.timeoutMs} must be an integer from ${minimumTimeoutMs} to ${projectMemoryLimits.maxTimeoutMs}.`,
      };
  }
  const baseDirectory = resolveCairnKeepBaseDirectory(
    environment[projectMemoryEnvironment.cairnKeepBaseDirectory],
    environment.HOME,
  );
  if (baseDirectory === "invalid")
    return {
      kind: "misconfigured",
      provider,
      // The configured value is never echoed: it is a machine-local path.
      reason: `${projectMemoryEnvironment.cairnKeepBaseDirectory} must be an absolute path or ~/path; relative paths are rejected.`,
    };
  return { kind: "cairnkeep", command, timeoutMs, baseDirectory };
}

/**
 * Normalizes CairnKeep's store root before any child is spawned.
 *
 * CairnKeep resolves a relative `CAIRN_AGENTFS_BASE_DIR` against its own cwd,
 * and every retrieval runs it in a fresh private temporary cwd, so a relative
 * value would name a different, empty store each time. Therefore:
 *
 * - unset: null, CairnKeep keeps its own default;
 * - absolute: lexically normalized (`.`/`..` segments, repeated and trailing
 *   separators) without consulting any cwd;
 * - `~/rest`: expanded against the Runtime host's absolute `HOME`, then
 *   normalized;
 * - anything else (empty, relative, `.`, `..`, bare `~`, `~user`, control
 *   characters, over 4096 characters, or `~/` without an absolute HOME):
 *   `invalid`.
 */
export function resolveCairnKeepBaseDirectory(
  value: string | undefined,
  home: string | undefined,
): string | null | "invalid" {
  if (value === undefined) return null;
  const valid = (path: string) =>
    path.length > 0 && path.length <= 4096 && !/\p{Cc}/u.test(path);
  if (!valid(value)) return "invalid";
  let absolute: string;
  if (value.startsWith("~/")) {
    if (home === undefined || !valid(home) || !isAbsolute(home))
      return "invalid";
    absolute = `${home}/${value.slice(2)}`;
  } else if (isAbsolute(value)) absolute = value;
  else return "invalid";
  // `resolve` of an absolute path is purely lexical and never reads the cwd.
  const normalized = resolve(absolute);
  return valid(normalized) ? normalized : "invalid";
}
