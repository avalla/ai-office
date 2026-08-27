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
import { repositoryIdFromLegacyProjectId } from "@ai-office/application/project-lifecycle/project-binding.ts";

function offlineConfiguration(input: {
  detected: boolean;
  canonicalStatus: "missing" | "integrated" | "unmanaged" | "conflict";
  clientStatus?: "missing" | "integrated" | "unmanaged" | "conflict";
  skillStatus?: "missing" | "integrated" | "unmanaged" | "conflict";
  conflict: boolean;
}): LifecycleClientStatus["configuration"] {
  if (input.conflict) return "conflict";
  if (
    input.canonicalStatus === "unmanaged" ||
    input.clientStatus === "unmanaged" ||
    input.skillStatus === "unmanaged"
  )
    return "unmanaged";
  if (
    input.canonicalStatus === "integrated" &&
    input.clientStatus === "integrated" &&
    input.skillStatus === "integrated"
  )
    return "configured";
  return input.detected ? "missing" : "not_configured";
}

export async function getOfflineProjectStatus(
  rootPath: string,
  input: {
    runtimeHome: string;
    bindings?: ProjectBindingAdapter;
    clients?: AgentClientCatalog;
  },
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
          canonicalStatus:
            clientInspection.canonicalInstructions.integrationStatus,
          ...(clientInspection.clientInstructions === undefined
            ? {}
            : {
                clientStatus:
                  clientInspection.clientInstructions.integrationStatus,
              }),
          ...(clientInspection.skillInstructions === undefined
            ? {}
            : {
                skillStatus:
                  clientInspection.skillInstructions.integrationStatus,
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
    schemaVersion: 2,
    installed: bindingValid ? null : false,
    health:
      bindingValid || inspection.status === "invalid"
        ? "needs_attention"
        : "not_installed",
    project: {
      id: null,
      name: null,
      root: inspection.rootPath,
      repositoryIdentity: {
        id:
          inspection.binding?.schemaVersion === 2
            ? inspection.binding.repositoryId
            : inspection.binding?.schemaVersion === 1
              ? repositoryIdFromLegacyProjectId(inspection.binding.projectId)
              : null,
        path: inspection.bindingPath,
        state:
          inspection.status === "valid"
            ? inspection.binding?.schemaVersion === 1
              ? "legacy"
              : "valid"
            : inspection.status === "invalid"
              ? "invalid"
              : "missing",
      },
      runtimeAssociation: {
        projectId: null,
        state: bindingValid ? "unverified" : "missing",
      },
    },
    runtime: {
      daemon: "unreachable",
      home: input.runtimeHome,
      authoritativeState: "unavailable",
    },
    office: {
      state: "unavailable",
      onboarding: "unavailable",
      revision: null,
      name: null,
      roles: [],
    },
    clients: clientStatuses,
    tasks: null,
    issues,
  };
}
