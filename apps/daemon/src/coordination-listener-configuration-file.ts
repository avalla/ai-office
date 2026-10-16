import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  parseCoordinationListenerConfiguration,
  type CoordinationListenerConfiguration,
} from "@ai-office/application/coordination/coordination-listener-configuration.ts";

/** File name of the owner's listener configuration in the Runtime home. */
export const coordinationListenerConfigurationFile =
  "coordination-listener.json";

/** Bound on the configuration file; a larger file is misconfigured. */
const maxConfigurationBytes = 64 * 1024;

const misconfigured = (reason: string): CoordinationListenerConfiguration => ({
  state: "misconfigured",
  reason,
});

/**
 * Reads `<runtime home>/coordination-listener.json`. No file means disabled.
 * The file is opened without following a symbolic link, and every check runs
 * on that one open descriptor, so the file cannot be swapped between the
 * check and the read. It must be a regular file owned by the Runtime user and
 * writable by nobody else, since it decides what the listener exposes;
 * anything else is misconfigured and keeps the listener closed.
 */
export function loadCoordinationListenerConfiguration(
  runtimeHome: string,
): CoordinationListenerConfiguration {
  const path = join(runtimeHome, coordinationListenerConfigurationFile);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return parseCoordinationListenerConfiguration(undefined);
    if (code === "ELOOP")
      return misconfigured("the configuration is a symbolic link");
    return misconfigured("the configuration cannot be read");
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile())
      return misconfigured("the configuration is not a regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && status.uid !== uid)
      return misconfigured("the configuration is not owned by the Runtime user");
    if ((status.mode & 0o022) !== 0)
      return misconfigured(
        "the configuration is writable by other users; use mode 0600",
      );
    if (status.size > maxConfigurationBytes)
      return misconfigured("the configuration is too large");
    // Read at most one byte past the bound, so a file grown after the stat
    // is still refused rather than read without limit.
    const buffer = Buffer.alloc(maxConfigurationBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (read === 0) break;
      length += read;
      if (length > maxConfigurationBytes)
        return misconfigured("the configuration is too large");
    }
    return parseCoordinationListenerConfiguration(
      buffer.subarray(0, length).toString("utf8"),
    );
  } catch {
    return misconfigured("the configuration cannot be read");
  } finally {
    closeSync(descriptor);
  }
}
