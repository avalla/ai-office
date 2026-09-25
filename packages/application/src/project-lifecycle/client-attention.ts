import type {
  LifecycleClientStatus,
  LifecycleIssue,
} from "./manage-project-lifecycle.ts";

/** Classify observed client problems; unverified is a knowledge gap, not a fault. */
export function clientIssues(
  clients: readonly LifecycleClientStatus[],
): LifecycleIssue[] {
  const issues: LifecycleIssue[] = [];
  for (const client of clients) {
    const requiresAttention =
      (client.detection === "detected" &&
        client.configuration !== "configured" &&
        client.configuration !== "unverified") ||
      (client.detection === "not_detected" &&
        (client.configuration === "drifted" ||
          client.configuration === "conflict"));
    if (requiresAttention)
      issues.push({
        severity: client.configuration === "conflict" ? "error" : "warning",
        code: `client_${client.clientId}_${client.configuration}`,
        message: `${client.displayName} integration is ${client.configuration}`,
        recovery:
          "Inspect the user-owned files, resolve conflicts, and rerun ai-office install .",
      });
  }
  return issues;
}
