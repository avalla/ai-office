const networkProtocols = new Set(["git:", "http:", "https:", "ssh:"]);

function isLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/u.test(value)
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
  return `ssh://${host}/${path}`;
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
