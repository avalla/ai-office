export class FilesystemConnectorError extends Error {}

export class UnsupportedFilesystemPlatformError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem connector is not supported on this platform");
    this.name = "UnsupportedFilesystemPlatformError";
  }
}

export class InvalidRelativePathError extends FilesystemConnectorError {
  constructor(message = "Invalid relative filesystem path") {
    super(message);
    this.name = "InvalidRelativePathError";
  }
}

export class PathOutsideRootError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem path is outside the registered root");
    this.name = "PathOutsideRootError";
  }
}

export class FilesystemSymlinkDeniedError extends FilesystemConnectorError {
  constructor() {
    super("Symbolic links are not permitted by the filesystem sandbox");
    this.name = "FilesystemSymlinkDeniedError";
  }
}

export class FilesystemHardLinkDeniedError extends FilesystemConnectorError {
  constructor() {
    super("Hard-linked files are not permitted by the filesystem sandbox");
    this.name = "FilesystemHardLinkDeniedError";
  }
}

export class SensitiveFilesystemPathError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem path is unavailable");
    this.name = "SensitiveFilesystemPathError";
  }
}

export class FilesystemEntryNotFoundError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem entry is unavailable");
    this.name = "FilesystemEntryNotFoundError";
  }
}

export class FilesystemDestinationExistsError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem destination already exists");
    this.name = "FilesystemDestinationExistsError";
  }
}

export class FilesystemNotRegularFileError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem entry is not a regular file");
    this.name = "FilesystemNotRegularFileError";
  }
}

export class FilesystemNotDirectoryError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem entry is not a directory");
    this.name = "FilesystemNotDirectoryError";
  }
}

export class FilesystemBinaryFileError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem content is not valid UTF-8 text");
    this.name = "FilesystemBinaryFileError";
  }
}

export class FilesystemFileTooLargeError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem file exceeds the permitted byte limit");
    this.name = "FilesystemFileTooLargeError";
  }
}

export class FilesystemOutputTooLargeError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem output exceeds the permitted byte limit");
    this.name = "FilesystemOutputTooLargeError";
  }
}

export class FilesystemDiffTooLargeError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem simulation diff exceeds the permitted byte limit");
    this.name = "FilesystemDiffTooLargeError";
  }
}

export class InvalidFilesystemConstraintsError extends FilesystemConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFilesystemConstraintsError";
  }
}

export class FilesystemSourceChangedError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem source changed during the operation");
    this.name = "FilesystemSourceChangedError";
  }
}

export class SourcePreconditionFailedError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem source precondition failed");
    this.name = "SourcePreconditionFailedError";
  }
}

export class FilesystemOperationAbortedError extends FilesystemConnectorError {
  constructor() {
    super("Filesystem operation was aborted");
    this.name = "FilesystemOperationAbortedError";
  }
}
