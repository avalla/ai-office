import { lstatSync, readFileSync } from "node:fs";
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

/**
 * Reads `<runtime home>/coordination-listener.json`. No file means disabled;
 * anything else that cannot be read as a regular file is misconfigured, so
 * the listener stays closed.
 */
export function loadCoordinationListenerConfiguration(
  runtimeHome: string,
): CoordinationListenerConfiguration {
  const path = join(runtimeHome, coordinationListenerConfigurationFile);
  let size: number;
  try {
    const status = lstatSync(path);
    if (!status.isFile())
      return {
        state: "misconfigured",
        reason: "the configuration is not a regular file",
      };
    size = status.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parseCoordinationListenerConfiguration(undefined);
    return {
      state: "misconfigured",
      reason: "the configuration cannot be read",
    };
  }
  if (size > maxConfigurationBytes)
    return { state: "misconfigured", reason: "the configuration is too large" };
  try {
    return parseCoordinationListenerConfiguration(readFileSync(path, "utf8"));
  } catch {
    return {
      state: "misconfigured",
      reason: "the configuration cannot be read",
    };
  }
}
