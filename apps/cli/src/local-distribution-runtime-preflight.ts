import { createConnection } from "node:net";
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
    // Use Unix transport errors directly: Bun 1.3.6's HTTP client collapses
    // absence and other connection failures into generic FailedToOpenSocket.
    const socket = createConnection({ path: socketPath });
    let connected = false;
    let settled = false;
    const unverified = () =>
      new DistributionRuntimePreflightError(
        "runtime_not_verified",
        "AI Office update could not verify that a relevant Runtime host is stopped",
      );
    const deadline = setTimeout(() => finish(unverified()), 1_000);
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    }
    socket.once("connect", () => {
      connected = true;
      socket.write(
        "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
    });
    // Any reply proves presence; parsing or trusting a protocol version is
    // unnecessary for maintenance and would misclassify incompatible hosts.
    socket.once("data", () => finish());
    socket.once("end", () => finish(unverified()));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        !connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")
          ? new RuntimeUnavailableError(socketPath)
          : unverified(),
      ),
    );
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
