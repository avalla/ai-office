import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type {
  LifecycleClientStatus,
  LifecycleIssue,
  ProjectLifecycleStatus,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { repositoryIdFromLegacyProjectId } from "@ai-office/application/project-lifecycle/project-binding.ts";

function offlineConfiguration(input: {
  detected: boolean;
  canonicalStatus:
    "missing" | "integrated" | "drifted" | "unmanaged" | "conflict";
  clientStatus?:
    "missing" | "integrated" | "drifted" | "unmanaged" | "conflict";
  skillStatus?: "missing" | "integrated" | "drifted" | "unmanaged" | "conflict";
  sharedSkillStatus?:
    "missing" | "integrated" | "drifted" | "unmanaged" | "conflict";
  userOwnedClientInstructions: boolean;
  conflict: boolean;
}): LifecycleClientStatus["configuration"] {
  if (input.conflict) return "conflict";
  if (
    input.canonicalStatus === "unmanaged" ||
    input.userOwnedClientInstructions ||
    input.clientStatus === "unmanaged" ||
    input.sharedSkillStatus === "unmanaged" ||
    input.skillStatus === "unmanaged"
  )
    return "unmanaged";
  if (
    input.canonicalStatus === "drifted" ||
    input.clientStatus === "drifted" ||
    input.sharedSkillStatus === "drifted" ||
    input.skillStatus === "drifted"
  )
    return "drifted";
  if (
    input.canonicalStatus === "integrated" &&
    input.clientStatus === "integrated" &&
    (input.sharedSkillStatus === undefined ||
      input.sharedSkillStatus === "integrated") &&
    input.skillStatus === "integrated"
  )
    // AI-OFFICE.md depends on the authoritative office manifest, which is not
    // available offline. Deterministic host pointers and skills were attested,
    // but the complete integration cannot honestly be called configured.
    return "unverified";
  return input.detected ? "missing" : "not_configured";
}

/**
 * What this inspection knows about the persistent Runtime host.
 *
 * `unreachable` is only legitimate after a request to the host actually
 * failed. `not_checked` is the explicit `--offline` case: no request was made,
 * so the host may be running perfectly well.
 */
export type RuntimeHostEvidence = "unreachable" | "not_checked";

export async function getOfflineProjectStatus(
  rootPath: string,
  input: {
    runtimeHome: string;
    hostEvidence: RuntimeHostEvidence;
    bindings?: ProjectBindingAdapter;
    clients?: AgentClientCatalog;
  },
): Promise<ProjectLifecycleStatus> {
  const notChecked = input.hostEvidence === "not_checked";
  const bindings = input.bindings ?? new LocalProjectBindingAdapter();
  const clients = new ManageAgentClientIntegration(
    input.clients ?? new DefaultAgentClientCatalog(),
  );
  const resolvedRoot = await bindings.resolveProjectRoot(rootPath);
  const inspection = await bindings.inspect(resolvedRoot);
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
  else if (notChecked)
    // Requesting offline inspection is not evidence that the Runtime is down,
    // so this reports a gap in knowledge and never tells the operator to start
    // a host that may already be running.
    issues.push({
      severity: "warning",
      code: "runtime_not_checked",
      message:
        "Offline inspection was requested, so authoritative AI Office Runtime state was not checked",
      recovery: "Run: ai-office status to inspect authoritative Runtime state",
    });
  else
    issues.push({
      severity: "error",
      code: "daemon_unavailable",
      message:
        "The project binding exists, but the authoritative AI Office Runtime is currently unreachable",
      recovery: "Run: ai-office runtime start",
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
          ...(clientInspection.sharedSkillInstructions === undefined
            ? {}
            : {
                sharedSkillStatus:
                  clientInspection.sharedSkillInstructions.integrationStatus,
              }),
          conflict: clientInspection.issues.some(
            (issue) => issue.severity === "conflict",
          ),
          userOwnedClientInstructions:
            clientInspection.clientInstructions?.ownership === "user_owned",
        }),
        issues: clientInspection.issues.map((issue) => issue.message).sort(),
      });
    }
  }

  return {
    schemaVersion: 4,
    installed: bindingValid ? null : false,
    health: bindingValid
      ? notChecked
        ? "unverified"
        : "needs_attention"
      : inspection.status === "invalid"
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
      daemon: notChecked ? "not_checked" : "unreachable",
      home: input.runtimeHome,
      authoritativeState: notChecked ? "not_checked" : "unavailable",
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
