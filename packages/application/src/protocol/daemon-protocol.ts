export const daemonProtocolVersion = 1 as const;
export const daemonProtocolLimits = {
  maxPayloadBytes: 64 * 1024,
  maxArguments: 64,
  maxArgumentLength: 16 * 1024,
  maxRequestIdLength: 128,
  maxPromptAnswerLength: 16 * 1024,
} as const;

export interface DaemonCommandRequest {
  protocolVersion: typeof daemonProtocolVersion;
  requestId: string;
  args: string[];
  promptAnswer?: string;
}

export interface DaemonPrompt {
  message: string;
}

export interface DaemonCommandResponse {
  protocolVersion: typeof daemonProtocolVersion;
  requestId: string;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  prompt?: DaemonPrompt;
}

export interface DaemonHealthResponse {
  protocolVersion: typeof daemonProtocolVersion;
  status: "ok";
  startedAt: string;
  /** Connection result observed at Runtime startup; this is not a live probe. */
  knowledge?: {
    provider: "none" | "surrealdb" | "unknown";
    startup: "disabled" | "misconfigured" | "connected" | "unavailable";
  };
  queue?: {
    provider: "disabled" | "configured" | "misconfigured";
    redis: "reachable" | "unreachable" | "not_checked";
    outboxPending: number;
    orchestrationWorker: boolean;
    agentRunWorker: boolean;
  };
}

/**
 * Read-only Runtime status behind `GET /api/status`. Subsystem state reuses
 * the exact shapes `/health` reports; identity fields are observed at request
 * time. `sourceRevision` is `null` when the checkout's HEAD is not
 * authoritatively known — never a guess.
 */
export interface RuntimeStatus {
  protocolVersion: typeof daemonProtocolVersion;
  status: "ok";
  productVersion: string;
  sourceRevision: string | null;
  startedAt: string;
  uptimeSeconds: number;
  knowledge: NonNullable<DaemonHealthResponse["knowledge"]>;
  queue: NonNullable<DaemonHealthResponse["queue"]>;
  storage: { project: "available" | "unavailable" };
}

export interface DaemonErrorResponse {
  protocolVersion: typeof daemonProtocolVersion;
  requestId: string;
  error: {
    code:
      | "INVALID_REQUEST"
      | "PAYLOAD_TOO_LARGE"
      | "COMMAND_TIMEOUT"
      | "INTERNAL_ERROR";
    message: string;
  };
}

export function isDaemonCommandRequest(
  value: unknown,
): value is DaemonCommandRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    candidate.protocolVersion === daemonProtocolVersion &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= daemonProtocolLimits.maxRequestIdLength &&
    Array.isArray(candidate.args) &&
    candidate.args.length <= daemonProtocolLimits.maxArguments &&
    candidate.args.every(
      (argument) =>
        typeof argument === "string" &&
        argument.length <= daemonProtocolLimits.maxArgumentLength,
    ) &&
    (candidate.promptAnswer === undefined ||
      (typeof candidate.promptAnswer === "string" &&
        candidate.promptAnswer.length <=
          daemonProtocolLimits.maxPromptAnswerLength)) &&
    !("operatorSurface" in candidate)
  );
}

export function isDaemonCommandResponse(
  value: unknown,
): value is DaemonCommandResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const prompt = candidate.prompt;

  return (
    candidate.protocolVersion === daemonProtocolVersion &&
    typeof candidate.requestId === "string" &&
    (candidate.exitCode === null || typeof candidate.exitCode === "number") &&
    Array.isArray(candidate.stdout) &&
    candidate.stdout.every((line) => typeof line === "string") &&
    Array.isArray(candidate.stderr) &&
    candidate.stderr.every((line) => typeof line === "string") &&
    (prompt === undefined ||
      (typeof prompt === "object" &&
        prompt !== null &&
        typeof (prompt as Record<string, unknown>).message === "string"))
  );
}

export function isDaemonErrorResponse(
  value: unknown,
): value is DaemonErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const error = candidate.error;
  return (
    candidate.protocolVersion === daemonProtocolVersion &&
    typeof candidate.requestId === "string" &&
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}
