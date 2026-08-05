import type {
  DaemonCommandResponse,
  DaemonHealthResponse
} from "@ai-office/application/protocol/daemon-protocol.ts";
import {
  daemonProtocolVersion,
  isDaemonCommandResponse
} from "@ai-office/application/protocol/daemon-protocol.ts";

export class DaemonUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`AI Office daemon is not available at ${socketPath}. Start it with "bun run daemon".`);
    this.name = "DaemonUnavailableError";
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
  return candidate.protocolVersion === daemonProtocolVersion &&
    candidate.status === "ok" &&
    typeof candidate.startedAt === "string";
}

export class DaemonClient {
  constructor(private readonly socketPath: string) {}

  async health(): Promise<DaemonHealthResponse> {
    const value = await this.request("/health", { method: "GET" });
    if (!isHealthResponse(value)) {
      throw new InvalidDaemonResponseError("Daemon returned an invalid health response");
    }
    return value;
  }

  async execute(args: string[], promptAnswer?: string): Promise<DaemonCommandResponse> {
    const requestId = crypto.randomUUID();
    const value = await this.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: daemonProtocolVersion,
        requestId,
        args,
        ...(promptAnswer === undefined ? {} : { promptAnswer })
      })
    });

    if (!isDaemonCommandResponse(value) || value.requestId !== requestId) {
      throw new InvalidDaemonResponseError("Daemon returned an invalid command response");
    }
    return value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://localhost${path}`, {
        ...init,
        unix: this.socketPath,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new DaemonUnavailableError(this.socketPath);
    }

    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      throw new InvalidDaemonResponseError("Daemon returned invalid JSON");
    }
    if (!response.ok) {
      const message = typeof value === "object" && value !== null &&
        typeof (value as Record<string, unknown>).error === "string"
        ? (value as Record<string, unknown>).error as string
        : `Daemon request failed with HTTP ${response.status}`;
      throw new InvalidDaemonResponseError(message);
    }
    return value;
  }
}
