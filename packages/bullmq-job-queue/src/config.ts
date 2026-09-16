export type QueueProvider = "none" | "bullmq";

export interface QueueConfiguration {
  provider: QueueProvider;
  redisUrl?: string;
  status: "disabled" | "configured" | "misconfigured";
  worker: "claude" | "gateway";
}

/** Reads host-local queue configuration without returning credential-bearing diagnostics. */
export function readQueueConfiguration(
  env: Record<string, string | undefined> = process.env,
): QueueConfiguration {
  const provider = env.AI_OFFICE_QUEUE_PROVIDER ?? "none";
  const workerValue = env.AI_OFFICE_QUEUE_WORKER ?? "claude";
  const worker = workerValue === "gateway" ? "gateway" : "claude";
  if (provider === "none")
    return { provider: "none", status: "disabled", worker };
  if (
    provider !== "bullmq" ||
    (workerValue !== "claude" && workerValue !== "gateway")
  )
    return { provider: "bullmq", status: "misconfigured", worker };
  const redisUrl = env.AI_OFFICE_REDIS_URL;
  if (redisUrl === undefined || redisUrl.trim() === "")
    return { provider: "bullmq", status: "misconfigured", worker };
  try {
    const parsed = new URL(redisUrl);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:")
      return { provider: "bullmq", status: "misconfigured", worker };
  } catch {
    return { provider: "bullmq", status: "misconfigured", worker };
  }
  return { provider: "bullmq", redisUrl, status: "configured", worker };
}
