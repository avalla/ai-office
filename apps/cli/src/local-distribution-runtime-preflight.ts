import { request } from "node:http";
import type { DistributionUpdateRuntimeGuard } from "@ai-office/application/ports/distribution-update-adapter.port.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { RuntimeUnavailableError } from "./daemon-client.ts";

export class DistributionRuntimePreflightError extends Error {
  constructor(
    readonly code: "runtime_running" | "runtime_not_verified",
    message: string,
  ) {
    super(message);
    this.name = "DistributionRuntimePreflightError";
  }
}

/**
 * A presence probe, deliberately without a command method. Any HTTP response
 * proves a listener exists, even an incompatible or unhealthy Runtime host.
 * Only ENOENT/ECONNREFUSED prove absence; timeouts and access errors fail closed.
 */
export function probeDistributionRuntime(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = request({ socketPath, path: "/health", method: "GET" });
    const deadline = setTimeout(
      () => probe.destroy(new Error("timeout")),
      1_000,
    );
    probe.once("response", (response) => {
      clearTimeout(deadline);
      response.destroy();
      resolve();
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new RuntimeUnavailableError(socketPath)
          : new DistributionRuntimePreflightError(
              "runtime_not_verified",
              "AI Office update could not verify that a relevant Runtime host is stopped",
            ),
      );
    });
    probe.end();
  });
}

export class LocalDistributionRuntimePreflight implements DistributionUpdateRuntimeGuard {
  async assertStopped(distributionRoot: string): Promise<void> {
    // Resolution is read-only; never ensure/create a home, inspect a DB, or
    // infer a runtime from caller cwd/project bindings. No arbitrary home scan.
    const homes = [
      { label: "selected user", paths: resolveRuntimePaths({ mode: "user" }) },
      {
        label: "distribution development",
        paths: resolveRuntimePaths({
          mode: "development",
          developmentRoot: distributionRoot,
        }),
      },
    ];
    const checked = new Set<string>();
    for (const { label, paths } of homes) {
      if (checked.has(paths.socketPath)) continue;
      checked.add(paths.socketPath);
      try {
        await probeDistributionRuntime(paths.socketPath);
      } catch (error) {
        if (error instanceof RuntimeUnavailableError) continue;
        throw error;
      }
      throw new DistributionRuntimePreflightError(
        "runtime_running",
        `AI Office update requires the ${label} Runtime host to be stopped (${paths.runtimeHome})`,
      );
    }
  }
}
