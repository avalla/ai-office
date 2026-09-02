const networkProtocols = new Set(["git:", "http:", "https:", "ssh:"]);

function isLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:/u.test(value)
  );
}

function portableNetworkUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!networkProtocols.has(parsed.protocol) || parsed.hostname === "")
    return undefined;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function portableScpRemote(value: string): string | undefined {
  if (/\s/u.test(value) || value.includes("\\")) return undefined;
  const match = /^(?:[^/@:]+@)?([a-zA-Z0-9.-]+):(.+)$/u.exec(value);
  if (match === null) return undefined;
  const [, host, path] = match;
  if (
    host === undefined ||
    path === undefined ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === ".." || segment === "")
  )
    return undefined;
  return portableNetworkUrl(`ssh://${host}/${path}`);
}

/** Returns network-safe Git provenance or omits local/ambiguous remotes. */
export function portableGitRemote(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === "" || isLocalPath(candidate))
    return undefined;
  return portableNetworkUrl(candidate) ?? portableScpRemote(candidate);
}

export function comparablePortableGitRemote(
  value: string | undefined,
): string | undefined {
  return portableGitRemote(value)
    ?.replace(/\/?\.git$/u, "")
    .replace(/\/$/u, "");
}

export interface GitProvenanceCandidate {
  remoteUrl?: string;
  defaultBranch?: string;
}

export interface PortableGitProvenance {
  type: "git";
  remote: string;
  branch?: string;
}

/**
 * Selects provenance only when every portable network remote identifies the
 * same repository. Source-row ordering is deliberately irrelevant.
 */
export function selectPortableGitProvenance(
  candidates: readonly GitProvenanceCandidate[],
): PortableGitProvenance | undefined {
  const portable = candidates.flatMap((candidate) => {
    const remote = portableGitRemote(candidate.remoteUrl);
    const comparable = comparablePortableGitRemote(remote);
    return remote === undefined || comparable === undefined
      ? []
      : [{ remote, comparable, branch: candidate.defaultBranch?.trim() }];
  });
  const repositories = new Set(
    portable.map((candidate) => candidate.comparable),
  );
  if (repositories.size !== 1) return undefined;

  const remote = portable
    .map((candidate) => candidate.remote)
    .sort((left, right) => left.localeCompare(right))[0]!;
  const branches = new Set(
    portable.flatMap((candidate) =>
      candidate.branch === undefined || candidate.branch === ""
        ? []
        : [candidate.branch],
    ),
  );
  const branch = branches.size === 1 ? [...branches][0] : undefined;
  return {
    type: "git",
    remote,
    ...(branch === undefined ? {} : { branch }),
  };
}
