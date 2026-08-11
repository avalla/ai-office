import { pathMatchesPrefix } from "./filesystem-path.ts";

const sensitiveSegments = new Set([
  ".ai-office",
  ".git",
  ".ssh",
  ".aws",
  ".kube",
]);
const sensitiveBasenames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  ".git-credentials",
  "git-credentials",
]);
const sensitiveExtensions = [".pem", ".key", ".p12", ".pfx"];

export function isSensitiveFilesystemSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    sensitiveSegments.has(lower) ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    sensitiveBasenames.has(lower) ||
    sensitiveExtensions.some((extension) => lower.endsWith(extension))
  );
}

export function isBuiltInSensitiveFilesystemPath(path: string): boolean {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (segments.some(isSensitiveFilesystemSegment)) return true;
  return segments.some(
    (segment, index) =>
      segment === ".config" && segments[index + 1] === "gcloud",
  );
}

export function isSensitiveFilesystemPath(
  path: string,
  additionalDeniedPrefixes: readonly string[] = [],
): boolean {
  const lower = path.toLowerCase();
  if (isBuiltInSensitiveFilesystemPath(lower)) return true;
  return additionalDeniedPrefixes.some((prefix) =>
    pathMatchesPrefix(lower, prefix.toLowerCase()),
  );
}
