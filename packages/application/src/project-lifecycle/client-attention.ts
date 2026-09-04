import type {
  LifecycleClientStatus,
  LifecycleIssue,
} from "./manage-project-lifecycle.ts";

/** Classify observed client problems; unverified is a knowledge gap, not a fault. */
export function clientIssues(
  clients: readonly LifecycleClientStatus[],
): LifecycleIssue[] {
  const issues: LifecycleIssue[] = [];
  if (!clients.some((client) => client.detection === "detected"))
    issues.push({
      severity: "warning",
      code: "no_supported_client_detected",
      message: "No supported coding client was detected",
      recovery:
        "Install a supported client separately if desired, then rerun ai-office install .",
    });
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
