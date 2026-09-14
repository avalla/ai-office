import { join } from "node:path";

/**
 * The canonical, non-secret model routing file of a Runtime home. A managed
 * service discovers it from `AI_OFFICE_HOME` alone, so routing never depends on
 * an interactive shell environment being inherited at boot.
 */
export const runtimeHomeModelRoutingFileName = "model-routing.yaml";

/**
 * Written into generated Runtime service definitions. With this value the
 * Runtime reads model routing only from the Runtime home file and ignores
 * ambient routing variables of the service manager's environment.
 */
export const modelRoutingSourceEnvironmentVariable =
  "AI_OFFICE_MODEL_ROUTING_SOURCE";
export const runtimeHomeModelRoutingSource = "runtime_home";

export function runtimeHomeModelRoutingPath(runtimeHome: string): string {
  return join(runtimeHome, runtimeHomeModelRoutingFileName);
}
