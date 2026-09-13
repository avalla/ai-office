import {
  DisabledProjectMemoryProvider,
  type ProjectMemoryProvider,
} from "@ai-office/application/ports/project-memory-provider.port.ts";
import { resolveProjectMemoryConfiguration } from "./cairnkeep-configuration.ts";
import {
  CairnKeepMemoryProvider,
  MisconfiguredProjectMemoryProvider,
} from "./cairnkeep-memory-provider.ts";

/**
 * Composition-root factory. Reading the environment here keeps configuration
 * lookups out of application code. Creating a provider starts no process and
 * performs no installation or global client configuration.
 */
export function createProjectMemoryProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): ProjectMemoryProvider {
  const configuration = resolveProjectMemoryConfiguration(
    environment,
    platform,
  );
  if (configuration.kind === "disabled")
    return new DisabledProjectMemoryProvider();
  if (configuration.kind === "misconfigured")
    return new MisconfiguredProjectMemoryProvider(
      configuration.provider,
      configuration.reason,
    );
  return new CairnKeepMemoryProvider({
    command: configuration.command,
    timeoutMs: configuration.timeoutMs,
    baseDirectory: configuration.baseDirectory,
    environment,
  });
}
