import { isAbsolute, relative, resolve, win32 } from "node:path";
import { InvalidRelativePathError, PathOutsideRootError } from "./errors.ts";

export interface FilesystemPathLimits {
  maxPathBytes: number;
  maxPathSegments: number;
}

const unsafeControl = /[\u0000-\u001f\u007f]/u;
const unsafeSurrogate = /[\ud800-\udfff]/u;
const encodedSeparatorOrDot = /%(?:2e|2f|5c)/iu;
const windowsReservedName =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function normalizeRelativePath(
  value: string,
  limits: FilesystemPathLimits,
  options: { allowRoot: boolean },
): string {
  if (options.allowRoot && value === "") return "";
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    unsafeControl.test(value) ||
    unsafeSurrogate.test(value) ||
    encodedSeparatorOrDot.test(value)
  )
    throw new InvalidRelativePathError();
  const segments = value.split("/");
  if (
    segments.length > limits.maxPathSegments ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        windowsReservedName.test(segment),
    ) ||
    new TextEncoder().encode(value).byteLength > limits.maxPathBytes
  )
    throw new InvalidRelativePathError();
  return Object.freeze(segments).join("/");
}

export function resolveContainedPath(root: string, path: string): string {
  const candidate = path === "" ? root : resolve(root, ...path.split("/"));
  const relation = relative(root, candidate);
  if (relation === "") return candidate;
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  )
    throw new PathOutsideRootError();
  return candidate;
}

export function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function pathCanContainPrefix(path: string, prefix: string): boolean {
  return path === "" || pathMatchesPrefix(prefix, path);
}

export type AllowedPathClassification =
  "inside_allowed" | "ancestor_of_allowed" | "denied";

export function classifyAllowedPath(
  path: string,
  allowedPrefixes: readonly string[] | undefined,
): AllowedPathClassification {
  if (allowedPrefixes === undefined) return "inside_allowed";
  if (allowedPrefixes.some((prefix) => pathMatchesPrefix(path, prefix)))
    return "inside_allowed";
  if (allowedPrefixes.some((prefix) => pathCanContainPrefix(path, prefix)))
    return "ancestor_of_allowed";
  return "denied";
}
