import {
  providerIdPattern,
  providerModelPattern,
  reasoningEffortPattern,
} from "@ai-office/domain/agent/agent-run-model.ts";
import {
  workerLimits,
  type WorkerGatewayMetering,
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
  const metering = projectGatewayMetering(output.metering);
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
    ...(metering === null ? {} : { metering }),
  };
}

const microsPattern = /^\d{1,20}$/u;

/** Gateway cost evidence is shown only when every field is well formed. */
function projectGatewayMetering(value: unknown): WorkerGatewayMetering | null {
  const metering = object(value);
  const usage = object(metering?.usage);
  const parameters = object(metering?.appliedParameters);
  const count = (item: unknown): item is number =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const micros = (item: unknown): item is string =>
    typeof item === "string" && microsPattern.test(item);
  if (
    metering === null ||
    usage === null ||
    parameters === null ||
    metering.kind !== "gateway" ||
    typeof metering.providerId !== "string" ||
    !providerIdPattern.test(metering.providerId) ||
    typeof metering.model !== "string" ||
    !providerModelPattern.test(metering.model) ||
    (metering.providerRequestId !== null &&
      (typeof metering.providerRequestId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,200}$/u.test(metering.providerRequestId))) ||
    !count(usage.inputTokens) ||
    !count(usage.cachedInputTokens) ||
    !count(usage.outputTokens) ||
    !count(usage.reasoningTokens) ||
    (parameters.reasoningEffort !== null &&
      (typeof parameters.reasoningEffort !== "string" ||
        !reasoningEffortPattern.test(parameters.reasoningEffort))) ||
    !count(parameters.maxOutputTokens) ||
    (metering.currency !== "USD" && metering.currency !== "EUR") ||
    typeof metering.pricingVersionId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(metering.pricingVersionId) ||
    metering.budgetScope !== "agent_run" ||
    !micros(metering.budgetLimitMicros) ||
    !micros(metering.reservedMicros) ||
    !micros(metering.estimatedMicros) ||
    !micros(metering.actualMicros)
  )
    return null;
  return {
    kind: "gateway",
    providerId: metering.providerId,
    model: metering.model,
    providerRequestId: metering.providerRequestId,
    usage: {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
    },
    appliedParameters: {
      reasoningEffort: parameters.reasoningEffort,
      maxOutputTokens: parameters.maxOutputTokens,
    },
    currency: metering.currency,
    pricingVersionId: metering.pricingVersionId,
    budgetScope: "agent_run",
    budgetLimitMicros: metering.budgetLimitMicros,
    reservedMicros: metering.reservedMicros,
    estimatedMicros: metering.estimatedMicros,
    actualMicros: metering.actualMicros,
  };
}
