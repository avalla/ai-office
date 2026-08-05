export const daemonProtocolVersion = 1 as const;

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
}

export function isDaemonCommandRequest(value: unknown): value is DaemonCommandRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return candidate.protocolVersion === daemonProtocolVersion &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    Array.isArray(candidate.args) &&
    candidate.args.every((argument) => typeof argument === "string") &&
    (candidate.promptAnswer === undefined || typeof candidate.promptAnswer === "string");
}

export function isDaemonCommandResponse(value: unknown): value is DaemonCommandResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const prompt = candidate.prompt;

  return candidate.protocolVersion === daemonProtocolVersion &&
    typeof candidate.requestId === "string" &&
    (candidate.exitCode === null || typeof candidate.exitCode === "number") &&
    Array.isArray(candidate.stdout) &&
    candidate.stdout.every((line) => typeof line === "string") &&
    Array.isArray(candidate.stderr) &&
    candidate.stderr.every((line) => typeof line === "string") &&
    (prompt === undefined || (
      typeof prompt === "object" && prompt !== null &&
      typeof (prompt as Record<string, unknown>).message === "string"
    ));
}
