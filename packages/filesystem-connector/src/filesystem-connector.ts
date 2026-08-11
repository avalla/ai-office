import { isAbsolute } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type { ConnectorDefinition } from "@ai-office/connector-sdk/connector.ts";
import { UnsupportedConnectorError } from "@ai-office/connector-sdk/errors.ts";
import {
  CapabilityValidationError,
  UnsupportedConnectorResourceTypeError,
} from "@ai-office/domain/capability/errors.ts";
import { normalizeFilesystemArguments } from "./filesystem-arguments.ts";
import {
  FilesystemConstraintHandler,
  normalizeFilesystemConfiguration,
  normalizeFilesystemConstraints,
  parseEffectiveFilesystemConstraints,
} from "./filesystem-constraints.ts";
import { filesystemConnectorDescriptor } from "./filesystem-descriptor.ts";
import {
  FilesystemEntryNotFoundError,
  FilesystemNotDirectoryError,
  FilesystemSymlinkDeniedError,
  SensitiveFilesystemPathError,
  UnsupportedFilesystemPlatformError,
} from "./errors.ts";
import { FilesystemSandbox } from "./filesystem-sandbox.ts";
import { isBuiltInSensitiveFilesystemPath } from "./sensitive-paths.ts";

export function assertFilesystemPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin" && platform !== "linux")
    throw new UnsupportedFilesystemPlatformError();
}

export const filesystemConnectorDefinition: ConnectorDefinition = {
  descriptor: filesystemConnectorDescriptor,
  constraintHandler: new FilesystemConstraintHandler(),
  normalizeArguments: normalizeFilesystemArguments,
  normalizeConstraints: normalizeFilesystemConstraints,
  prepareResource: async (input) => {
    assertFilesystemPlatform();
    if (input.type !== "filesystem_scope")
      throw new UnsupportedConnectorResourceTypeError("filesystem", input.type);
    if (input.externalRef === undefined || !isAbsolute(input.externalRef))
      throw new CapabilityValidationError(
        "Filesystem resource root must be an absolute path",
      );
    let stats;
    try {
      stats = lstatSync(input.externalRef);
    } catch {
      throw new FilesystemEntryNotFoundError();
    }
    if (stats.isSymbolicLink()) throw new FilesystemSymlinkDeniedError();
    if (!stats.isDirectory()) throw new FilesystemNotDirectoryError();
    const canonicalRoot = realpathSync(input.externalRef);
    const canonicalStats = lstatSync(canonicalRoot);
    if (canonicalStats.isSymbolicLink())
      throw new FilesystemSymlinkDeniedError();
    if (!canonicalStats.isDirectory()) throw new FilesystemNotDirectoryError();
    if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino)
      throw new FilesystemSymlinkDeniedError();
    if (isBuiltInSensitiveFilesystemPath(canonicalRoot))
      throw new SensitiveFilesystemPathError();
    return {
      externalRef: canonicalRoot,
      configuration: normalizeFilesystemConfiguration(input.configuration),
    };
  },
  invoke: async (input) => {
    assertFilesystemPlatform();
    if (input.resource.provider !== "filesystem")
      throw new UnsupportedConnectorError(input.resource.provider);
    if (input.resource.type !== "filesystem_scope")
      throw new UnsupportedConnectorResourceTypeError(
        "filesystem",
        input.resource.type,
      );
    if (input.resource.externalRef === undefined)
      throw new CapabilityValidationError(
        "Filesystem resource has no canonical root",
      );
    const constraints = parseEffectiveFilesystemConstraints(
      input.effectiveConstraints,
    );
    return new FilesystemSandbox(
      input.resource.externalRef,
      constraints,
      {},
      input.signal,
    ).invoke(input.operation, input.arguments);
  },
  executeMutation: async (input) => {
    assertFilesystemPlatform();
    if (input.resource.provider !== "filesystem")
      throw new UnsupportedConnectorError(input.resource.provider);
    if (input.resource.type !== "filesystem_scope")
      throw new UnsupportedConnectorResourceTypeError(
        "filesystem",
        input.resource.type,
      );
    if (input.resource.externalRef === undefined)
      throw new CapabilityValidationError(
        "Filesystem resource has no canonical root",
      );
    const constraints = parseEffectiveFilesystemConstraints(
      input.effectiveConstraints,
    );
    return new FilesystemSandbox(
      input.resource.externalRef,
      constraints,
      {},
      input.signal,
    ).executeMutation(input.operation, input.arguments, input.preconditions);
  },
};
