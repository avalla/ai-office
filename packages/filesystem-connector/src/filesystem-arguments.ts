import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";
import { CapabilityValidationError } from "@ai-office/domain/capability/errors.ts";
import { filesystemHardLimits } from "./filesystem-constraints.ts";
import { FilesystemBinaryFileError } from "./errors.ts";
import { normalizeRelativePath } from "./filesystem-path.ts";

const allowedFields: Readonly<Record<string, ReadonlySet<string>>> = {
  "filesystem.list": new Set(["path", "recursive"]),
  "filesystem.read": new Set(["path"]),
  "filesystem.search": new Set(["path", "query", "caseSensitive"]),
  "filesystem.create": new Set(["path", "content"]),
  "filesystem.write": new Set(["path", "content"]),
  "filesystem.move": new Set(["sourcePath", "destinationPath"]),
  "filesystem.delete": new Set(["path"]),
};

function assertFields(
  operation: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const allowed = allowedFields[operation];
  if (allowed === undefined)
    throw new CapabilityValidationError(`Unsupported operation: ${operation}`);
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0)
    throw new CapabilityValidationError(
      `Unsupported filesystem argument fields: ${unknown.join(", ")}`,
    );
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new CapabilityValidationError(`${field} must be a non-empty string`);
  return value;
}

function path(value: unknown, field: string): string {
  return normalizeRelativePath(text(value, field), filesystemHardLimits, {
    allowRoot: false,
  });
}

function content(value: unknown): string {
  if (typeof value !== "string")
    throw new CapabilityValidationError("content must be a string");
  if (/\u0000/u.test(value) || /[\ud800-\udfff]/u.test(value))
    throw new FilesystemBinaryFileError();
  if (
    new TextEncoder().encode(value).byteLength >
    filesystemHardLimits.maxInlineContentBytes
  )
    throw new CapabilityValidationError(
      "inline content exceeds the byte limit",
    );
  return value;
}

export function normalizeFilesystemArguments(
  operation: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  assertFields(operation, value);
  let result: Readonly<Record<string, unknown>>;
  if (operation === "filesystem.list") {
    if (value.recursive !== undefined && typeof value.recursive !== "boolean")
      throw new CapabilityValidationError("recursive must be boolean");
    result = {
      path:
        value.path === undefined || value.path === ""
          ? ""
          : normalizeRelativePath(
              text(value.path, "path"),
              filesystemHardLimits,
              {
                allowRoot: false,
              },
            ),
      recursive: value.recursive ?? false,
    };
  } else if (operation === "filesystem.search") {
    const query = text(value.query, "query");
    if (/\r|\n/u.test(query))
      throw new CapabilityValidationError("query must be a single line");
    if (new TextEncoder().encode(query).byteLength > 1024)
      throw new CapabilityValidationError("query exceeds the byte limit");
    if (
      value.caseSensitive !== undefined &&
      typeof value.caseSensitive !== "boolean"
    )
      throw new CapabilityValidationError("caseSensitive must be boolean");
    result = {
      path:
        value.path === undefined || value.path === ""
          ? ""
          : normalizeRelativePath(
              text(value.path, "path"),
              filesystemHardLimits,
              {
                allowRoot: false,
              },
            ),
      query,
      caseSensitive: value.caseSensitive ?? true,
    };
  } else if (operation === "filesystem.move") {
    result = {
      sourcePath: path(value.sourcePath, "sourcePath"),
      destinationPath: path(value.destinationPath, "destinationPath"),
    };
  } else if (
    operation === "filesystem.create" ||
    operation === "filesystem.write"
  ) {
    result = {
      path: path(value.path, "path"),
      content: content(value.content),
    };
  } else {
    result = { path: path(value.path, "path") };
  }
  return normalizeCanonicalJson(result) as Readonly<Record<string, unknown>>;
}
