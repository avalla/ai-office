import manifest from "../../../package.json";

/** Product version; protocol, schema, and profile versions remain independent. */
export const productVersion = manifest.version;

/**
 * The standalone flags and the `version` command are local. Role commands also
 * accept `--version`, so the flags are local only when they stand alone.
 */
export function isLocalVersionInvocation(args: readonly string[]): boolean {
  return (
    args[0] === "version" ||
    (args.length === 1 && (args[0] === "--version" || args[0] === "-V"))
  );
}

/** How the running code was obtained; new kinds extend this without CLI changes. */
export type DistributionKind = "source-linked";

/**
 * Locally observed identity of the running distribution. `null` means the
 * value is not authoritatively known, never "none" or "clean".
 */
export interface DistributionIdentity {
  revision: string | null;
  dirty: boolean | null;
  distribution: DistributionKind | null;
}

/** The single definition of a Git object name: a full SHA-1 or SHA-256 ID. */
export function isGitRevision(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/** Compact revision used in build metadata and human-readable messages. */
export function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

/**
 * SemVer build metadata identifies the code without changing precedence:
 * `0.1.0+git.6fe106c41945`. Without an authoritative revision the product
 * version is returned unchanged; no placeholder metadata is invented.
 */
export function displayVersion(
  version: string,
  revision: string | null,
): string {
  if (revision === null || !isGitRevision(revision)) return version;
  return `${version}${version.includes("+") ? "." : "+"}git.${shortRevision(revision)}`;
}

/** Stable machine-readable contract of `ai-office version --json`. */
export interface VersionReport {
  contractVersion: 1;
  version: string;
  displayVersion: string;
  revision: string | null;
  dirty: boolean | null;
  distribution: DistributionKind | null;
}

export function buildVersionReport(
  identity: DistributionIdentity,
  version: string = productVersion,
): VersionReport {
  const revision =
    identity.revision !== null && isGitRevision(identity.revision)
      ? identity.revision
      : null;
  return {
    contractVersion: 1,
    version,
    displayVersion: displayVersion(version, revision),
    revision,
    dirty: revision === null ? null : identity.dirty,
    distribution: revision === null ? null : identity.distribution,
  };
}

export function renderVersionReport(report: VersionReport): string[] {
  return [
    `AI Office ${report.version}`,
    `Revision: ${report.revision ?? "unavailable"}`,
    `Distribution: ${report.distribution ?? "unknown"}`,
    `Dirty: ${report.dirty === null ? "unavailable" : report.dirty ? "yes" : "no"}`,
  ];
}
