import {
  workerLimits,
  type WorkerOutput,
} from "../ports/worker-runtime.port.ts";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Publish only the bounded artifact contract, never the raw worker envelope. */
export function projectWorkerOutput(result: unknown): WorkerOutput | null {
  const output = object(object(result)?.workerOutput);
  if (
    output?.schemaVersion !== 1 ||
    typeof output.summary !== "string" ||
    output.summary.trim() === "" ||
    output.summary.length > workerLimits.summaryLength ||
    typeof output.content !== "string" ||
    output.content.trim() === "" ||
    output.content.length > workerLimits.contentLength
  )
    return null;
  const usage = object(output.usage);
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value)
      ? value
      : null;
  return {
    schemaVersion: 1,
    summary: output.summary,
    content: output.content,
    sessionId: identifier(output.sessionId),
    model: identifier(output.model),
    usage:
      count(usage?.inputTokens) && count(usage?.outputTokens)
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : null,
    estimatedCostUsd:
      typeof output.estimatedCostUsd === "number" &&
      Number.isFinite(output.estimatedCostUsd) &&
      output.estimatedCostUsd >= 0
        ? output.estimatedCostUsd
        : null,
  };
}
