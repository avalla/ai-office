import { createHash } from "node:crypto";
import type { ConnectorFilePrecondition } from "@ai-office/connector-sdk/connector.ts";

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function absentPrecondition(path: string): ConnectorFilePrecondition {
  return Object.freeze({ kind: "absent", path });
}

export function filePrecondition(
  path: string,
  bytes: Uint8Array,
): ConnectorFilePrecondition {
  return filePreconditionFromMetadata(path, sha256Bytes(bytes), bytes.byteLength);
}

export function filePreconditionFromMetadata(
  path: string,
  sha256: string,
  size: number,
): ConnectorFilePrecondition {
  return Object.freeze({
    kind: "file",
    path,
    sha256,
    size,
  });
}
