import type {
  ConnectorConstraintHandler,
  ConnectorConstraintResult,
} from "@ai-office/domain/capability/capability.ts";
import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";
import {
  InvalidFilesystemConstraintsError,
  InvalidRelativePathError,
} from "./errors.ts";
import {
  classifyAllowedPath,
  normalizeRelativePath,
  pathMatchesPrefix,
} from "./filesystem-path.ts";

export interface FilesystemConstraints {
  allowedPathPrefixes?: readonly string[];
  deniedPathPrefixes?: readonly string[];
  allowedExtensions?: readonly string[];
  maxFileBytes?: number;
  maxOutputBytes?: number;
  maxResults?: number;
  maxVisitedEntries?: number;
  maxVisitedFiles?: number;
  maxVisitedDirectories?: number;
  maxDepth?: number;
  maxPathBytes?: number;
  maxPathSegments?: number;
  maxDiffBytes?: number;
  maxInlineContentBytes?: number;
  allowMutation?: boolean;
}

export interface EffectiveFilesystemConstraints {
  allowedPathPrefixes?: readonly string[];
  deniedPathPrefixes: readonly string[];
  allowedExtensions?: readonly string[];
  maxFileBytes: number;
  maxOutputBytes: number;
  maxResults: number;
  maxVisitedEntries: number;
  maxVisitedFiles: number;
  maxVisitedDirectories: number;
  maxDepth: number;
  maxPathBytes: number;
  maxPathSegments: number;
  maxDiffBytes: number;
  maxInlineContentBytes: number;
  allowMutation: boolean;
}

export const filesystemHardLimits = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxOutputBytes: 48 * 1024,
  maxResults: 1000,
  maxVisitedEntries: 10_000,
  maxVisitedFiles: 5000,
  maxVisitedDirectories: 1000,
  maxDepth: 8,
  maxPathBytes: 1024,
  maxPathSegments: 128,
  maxDiffBytes: 48 * 1024,
  maxInlineContentBytes: 16 * 1024,
});

const fields = new Set([
  "allowedPathPrefixes",
  "deniedPathPrefixes",
  "allowedExtensions",
  "maxFileBytes",
  "maxOutputBytes",
  "maxResults",
  "maxVisitedEntries",
  "maxVisitedFiles",
  "maxVisitedDirectories",
  "maxDepth",
  "maxPathBytes",
  "maxPathSegments",
  "maxDiffBytes",
  "maxInlineContentBytes",
  "allowMutation",
]);
const maximumFields = [
  "maxFileBytes",
  "maxOutputBytes",
  "maxResults",
  "maxVisitedEntries",
  "maxVisitedFiles",
  "maxVisitedDirectories",
  "maxDepth",
  "maxPathBytes",
  "maxPathSegments",
  "maxDiffBytes",
  "maxInlineContentBytes",
] as const;

function stringList(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new InvalidFilesystemConstraintsError(
      `${field} must be a string array`,
    );
  return value;
}

function normalizedPrefixes(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  const list = stringList(value, field);
  if (list === undefined) return undefined;
  try {
    return Object.freeze(
      [
        ...new Set(
          list.map((path) =>
            normalizeRelativePath(path, filesystemHardLimits, {
              allowRoot: false,
            }),
          ),
        ),
      ].sort(),
    );
  } catch (error) {
    if (error instanceof InvalidRelativePathError)
      throw new InvalidFilesystemConstraintsError(
        `${field} contains an invalid path`,
      );
    throw error;
  }
}

function normalizedExtensions(value: unknown): readonly string[] | undefined {
  const list = stringList(value, "allowedExtensions");
  if (list === undefined) return undefined;
  if (
    list.some(
      (extension) =>
        !/^\.[a-z0-9][a-z0-9._-]*$/iu.test(extension) ||
        extension.includes("/"),
    )
  )
    throw new InvalidFilesystemConstraintsError(
      "allowedExtensions contains an invalid extension",
    );
  return Object.freeze(
    [...new Set(list.map((value) => value.toLowerCase()))].sort(),
  );
}

function parse(
  value: Readonly<Record<string, unknown>>,
): FilesystemConstraints {
  const unknown = Object.keys(value)
    .filter((key) => !fields.has(key))
    .sort();
  if (unknown.length > 0)
    throw new InvalidFilesystemConstraintsError(
      `Unsupported filesystem constraint fields: ${unknown.join(", ")}`,
    );
  const parsed: FilesystemConstraints = {
    ...(value.allowedPathPrefixes === undefined
      ? {}
      : {
          allowedPathPrefixes: normalizedPrefixes(
            value.allowedPathPrefixes,
            "allowedPathPrefixes",
          )!,
        }),
    ...(value.deniedPathPrefixes === undefined
      ? {}
      : {
          deniedPathPrefixes: normalizedPrefixes(
            value.deniedPathPrefixes,
            "deniedPathPrefixes",
          )!,
        }),
    ...(value.allowedExtensions === undefined
      ? {}
      : { allowedExtensions: normalizedExtensions(value.allowedExtensions)! }),
  };
  for (const field of maximumFields) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0
    )
      throw new InvalidFilesystemConstraintsError(
        `${field} must be a non-negative safe integer`,
      );
    Object.assign(parsed, { [field]: candidate });
  }
  if (
    value.allowMutation !== undefined &&
    typeof value.allowMutation !== "boolean"
  )
    throw new InvalidFilesystemConstraintsError(
      "allowMutation must be boolean",
    );
  if (value.allowMutation !== undefined)
    Object.assign(parsed, { allowMutation: value.allowMutation });
  return parsed;
}

export function normalizeFilesystemConstraints(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return normalizeCanonicalJson(parse(value)) as Readonly<
    Record<string, unknown>
  >;
}

export const normalizeFilesystemConfiguration = normalizeFilesystemConstraints;

function intersectPrefixes(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const result: string[] = [];
  for (const first of left) {
    for (const second of right) {
      if (pathMatchesPrefix(first, second)) result.push(first);
      else if (pathMatchesPrefix(second, first)) result.push(second);
    }
  }
  return [...new Set(result)].sort();
}

function intersectExact(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return left.filter((value) => right.includes(value)).sort();
}

function combinedAllowed(
  values: readonly FilesystemConstraints[],
  field: "allowedPathPrefixes" | "allowedExtensions",
): readonly string[] | undefined {
  const lists = values
    .map((value) => value[field])
    .filter((value): value is readonly string[] => value !== undefined);
  if (lists.length === 0) return undefined;
  return lists
    .slice(1)
    .reduce(
      (current, next) =>
        field === "allowedPathPrefixes"
          ? intersectPrefixes(current, next)
          : intersectExact(current, next),
      [...lists[0]!],
    );
}

function operationPaths(
  operation: string,
  arguments_: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (operation === "filesystem.move")
    return [arguments_.sourcePath, arguments_.destinationPath].filter(
      (value): value is string => typeof value === "string",
    );
  return typeof arguments_.path === "string" ? [arguments_.path] : [];
}

function satisfiesEffectivePathLimits(
  path: string,
  effective: EffectiveFilesystemConstraints,
  allowRoot: boolean,
): boolean {
  try {
    return normalizeRelativePath(path, effective, { allowRoot }) === path;
  } catch {
    return false;
  }
}

function fileExtension(path: string): string {
  const basename = path.split("/").at(-1) ?? "";
  const index = basename.lastIndexOf(".");
  return index <= 0 ? "" : basename.slice(index).toLowerCase();
}

export function parseEffectiveFilesystemConstraints(
  value: Readonly<Record<string, unknown>>,
): EffectiveFilesystemConstraints {
  const parsed = parse(value);
  for (const field of maximumFields) {
    if (parsed[field] === undefined)
      throw new InvalidFilesystemConstraintsError(
        `Effective filesystem constraints are missing ${field}`,
      );
  }
  if (
    parsed.deniedPathPrefixes === undefined ||
    parsed.allowMutation === undefined
  )
    throw new InvalidFilesystemConstraintsError(
      "Effective filesystem constraints are incomplete",
    );
  return parsed as EffectiveFilesystemConstraints;
}

export class FilesystemConstraintHandler implements ConnectorConstraintHandler {
  readonly connector = "filesystem";

  readonly combineAndValidate: ConnectorConstraintHandler["combineAndValidate"] =
    (
      operation: string,
      arguments_: Readonly<Record<string, unknown>>,
      values: readonly Readonly<Record<string, unknown>>[],
      resourceConfiguration: Readonly<Record<string, unknown>>,
    ): ConnectorConstraintResult => {
      try {
        const resource = parse(resourceConfiguration);
        const grants = values.map(parse);
        const all = [resource, ...grants];
        const allowedPathPrefixes = combinedAllowed(all, "allowedPathPrefixes");
        const allowedExtensions = combinedAllowed(all, "allowedExtensions");
        const deniedPathPrefixes = [
          ...new Set(all.flatMap((value) => value.deniedPathPrefixes ?? [])),
        ].sort();
        const effective: EffectiveFilesystemConstraints = {
          ...(allowedPathPrefixes === undefined ? {} : { allowedPathPrefixes }),
          deniedPathPrefixes,
          ...(allowedExtensions === undefined ? {} : { allowedExtensions }),
          ...(Object.fromEntries(
            maximumFields.map((field) => [
              field,
              Math.min(
                filesystemHardLimits[field],
                ...all
                  .map((value) => value[field])
                  .filter(
                    (candidate): candidate is number => candidate !== undefined,
                  ),
              ),
            ]),
          ) as Pick<
            EffectiveFilesystemConstraints,
            (typeof maximumFields)[number]
          >),
          allowMutation:
            grants.every((value) => value.allowMutation === true) &&
            resource.allowMutation !== false,
        };

        const reasons: string[] = [];
        if (
          allowedPathPrefixes !== undefined &&
          allowedPathPrefixes.length === 0
        )
          reasons.push("filesystem allowed path intersection is empty");
        if (allowedExtensions !== undefined && allowedExtensions.length === 0)
          reasons.push("filesystem allowed extension intersection is empty");
        const paths = operationPaths(operation, arguments_);
        if (
          paths.length === 0 &&
          !["filesystem.list", "filesystem.search"].includes(operation)
        )
          reasons.push("filesystem operation requires a normalized path");
        for (const path of paths) {
          const directoryCapable =
            operation === "filesystem.list" ||
            operation === "filesystem.search";
          if (
            !satisfiesEffectivePathLimits(path, effective, directoryCapable)
          ) {
            reasons.push("filesystem path exceeds effective path limits");
            continue;
          }
          const classification = classifyAllowedPath(path, allowedPathPrefixes);
          if (
            classification === "denied" ||
            (!directoryCapable && classification !== "inside_allowed")
          )
            reasons.push("filesystem path is outside allowed prefixes");
          if (
            deniedPathPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))
          )
            reasons.push("filesystem path is denied");
        }
        if (
          allowedExtensions !== undefined &&
          !["filesystem.list", "filesystem.search"].includes(operation) &&
          paths.some((path) => !allowedExtensions.includes(fileExtension(path)))
        )
          reasons.push("filesystem extension is not allowed");
        if (
          operation.startsWith("filesystem.") &&
          operation !== "filesystem.list" &&
          operation !== "filesystem.read" &&
          operation !== "filesystem.search" &&
          !effective.allowMutation
        )
          reasons.push("filesystem mutation is not allowed");
        return {
          ok: reasons.length === 0,
          effectiveConstraints: normalizeCanonicalJson(effective) as Readonly<
            Record<string, unknown>
          >,
          reasons,
        };
      } catch (error) {
        return {
          ok: false,
          effectiveConstraints: {},
          reasons: [
            error instanceof Error
              ? error.message
              : "invalid filesystem constraints",
          ],
        };
      }
    };
}
