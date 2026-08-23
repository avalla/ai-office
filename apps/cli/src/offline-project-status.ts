import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type {
  LifecycleClientStatus,
  LifecycleIssue,
  ProjectLifecycleStatus,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { LocalProjectBindingAdapter } from "./local-project-binding-adapter.ts";

function offlineConfiguration(input: {
  detected: boolean;
  clientId: "codex" | "claude";
  canonicalStatus: "missing" | "integrated" | "unmanaged" | "conflict";
  clientStatus?: "missing" | "integrated" | "unmanaged" | "conflict";
  conflict: boolean;
}): LifecycleClientStatus["configuration"] {
  if (input.conflict) return "conflict";
  if (input.canonicalStatus === "unmanaged") return "unmanaged";
  if (
    input.canonicalStatus === "integrated" &&
    (input.clientId === "codex" || input.clientStatus === "integrated")
  )
    return "configured";
  return input.detected ? "missing" : "not_configured";
}

export async function getOfflineProjectStatus(
  rootPath: string,
  input: {
    bindings?: ProjectBindingAdapter;
    clients?: AgentClientCatalog;
  } = {},
): Promise<ProjectLifecycleStatus> {
  const bindings = input.bindings ?? new LocalProjectBindingAdapter();
  const clients = new ManageAgentClientIntegration(
    input.clients ?? new DefaultAgentClientCatalog(),
  );
  const inspection = await bindings.inspect(rootPath, { ancestors: true });
  const bindingValid =
    inspection.status === "valid" && inspection.binding !== undefined;
  const issues: LifecycleIssue[] = [];
  if (inspection.status === "missing")
    issues.push({
      severity: "warning",
      code: "not_installed",
      message: "AI Office is not installed for this repository",
      recovery: "Run: ai-office install .",
    });
  else if (inspection.status === "invalid")
    issues.push({
      severity: "error",
      code: "binding_invalid",
      message: inspection.issue ?? "Project binding is invalid",
      recovery: "Repair or remove .ai-office/project.json explicitly",
    });
  else
    issues.push({
      severity: "error",
      code: "daemon_unavailable",
      message:
        "The project binding exists, but the AI Office runtime is currently unreachable",
      recovery: "Start the AI Office daemon and run status again",
    });

  const clientStatuses: LifecycleClientStatus[] = [];
  if (bindingValid) {
    const detections = await clients.detect();
    for (const detection of detections) {
      const clientInspection = await clients.inspect(
        detection.clientId,
        inspection.rootPath,
      );
      clientStatuses.push({
        clientId: detection.clientId,
        displayName: detection.displayName,
        detection: detection.status,
        configuration: offlineConfiguration({
          detected: detection.status === "detected",
          clientId: detection.clientId,
          canonicalStatus:
            clientInspection.canonicalInstructions.integrationStatus,
          ...(clientInspection.clientInstructions === undefined
            ? {}
            : {
                clientStatus:
                  clientInspection.clientInstructions.integrationStatus,
              }),
          conflict: clientInspection.issues.some(
            (issue) => issue.severity === "conflict",
          ),
        }),
        issues: clientInspection.issues.map((issue) => issue.message).sort(),
      });
    }
  }

  return {
    schemaVersion: 1,
    installed: bindingValid,
    health:
      bindingValid || inspection.status === "invalid"
        ? "needs_attention"
        : "not_installed",
    project: {
      id: inspection.binding?.projectId ?? null,
      name: null,
      root: inspection.rootPath,
      binding: {
        path: inspection.bindingPath,
        state:
          inspection.status === "valid"
            ? "unverified"
            : inspection.status === "invalid"
              ? "invalid"
              : "missing",
      },
    },
    runtime: {
      daemon: "unreachable",
      authoritativeState: "unavailable",
    },
    office: { state: "unavailable", revision: null, name: null, roles: [] },
    clients: clientStatuses,
    tasks: null,
    issues,
  };
}
