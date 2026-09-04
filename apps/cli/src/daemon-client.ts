import type {
  DaemonCommandResponse,
  DaemonHealthResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import {
  daemonProtocolVersion,
  isDaemonErrorResponse,
  isDaemonCommandResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import type { RuntimeClient } from "@ai-office/application/runtime/runtime-client.port.ts";

export class RuntimeUnavailableError extends Error {
  constructor(socketPath: string) {
    super(
      `AI Office Runtime is not available at ${socketPath}. Start its persistent local host with "ai-office runtime start" or, in development mode, "bun run daemon".`,
    );
    this.name = "RuntimeUnavailableError";
  }
}

export class InvalidDaemonResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDaemonResponseError";
  }
}

function isHealthResponse(value: unknown): value is DaemonHealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === daemonProtocolVersion &&
    candidate.status === "ok" &&
    typeof candidate.startedAt === "string"
  );
}

export class IpcRuntimeClient implements RuntimeClient {
  constructor(private readonly socketPath: string) {}

  async health(): Promise<DaemonHealthResponse> {
    const value = await this.request("/health", { method: "GET" });
    if (!isHealthResponse(value)) {
      throw new InvalidDaemonResponseError(
        "Daemon returned an invalid health response",
      );
    }
    return value;
  }

  async execute(
    args: string[],
    promptAnswer?: string,
  ): Promise<DaemonCommandResponse> {
    const requestId = crypto.randomUUID();
    const value = await this.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: daemonProtocolVersion,
        requestId,
        args,
        ...(promptAnswer === undefined ? {} : { promptAnswer }),
      }),
    });

    if (!isDaemonCommandResponse(value) || value.requestId !== requestId) {
      throw new InvalidDaemonResponseError(
        "Daemon returned an invalid command response",
      );
    }
    return value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://localhost${path}`, {
        ...init,
        unix: this.socketPath,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RuntimeUnavailableError(this.socketPath);
    }

    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch {
      throw new InvalidDaemonResponseError("Daemon returned invalid JSON");
    }
    if (!response.ok) {
      const message = isDaemonErrorResponse(value)
        ? `${value.error.code}: ${value.error.message}`
        : typeof value === "object" &&
            value !== null &&
            typeof (value as Record<string, unknown>).error === "string"
          ? ((value as Record<string, unknown>).error as string)
          : `Daemon request failed with HTTP ${response.status}`;
      throw new InvalidDaemonResponseError(message);
    }
    return value;
  }
}

/**
 * Pre-Runtime names, kept so existing importers keep compiling and keep
 * behaving the same at the points that can be depended on.
 *
 * The compatibility contract is deliberately narrow and is asserted by
 * `tests/unit/deprecated-runtime-aliases.test.ts`:
 *
 * - the legacy export names resolve;
 * - each is the *same* class object as its Runtime-first name, so `instanceof`
 *   holds in both directions and a subclass never splits the hierarchy;
 * - version-1 daemon protocol behaviour is unchanged.
 *
 * It deliberately does not cover `error.name`, `constructor.name`, or message
 * text: those now read in Runtime terms, which is the point of the rename.
 */
export { IpcRuntimeClient as DaemonClient };
export { RuntimeUnavailableError as DaemonUnavailableError };
