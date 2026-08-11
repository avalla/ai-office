import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { DisableResource } from "@ai-office/application/capability/disable-resource.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { ListCapabilityRecords } from "@ai-office/application/capability/list-capability-records.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { DecideControlledAction } from "@ai-office/application/capability/decide-controlled-action.ts";
import { ExecuteControlledAction } from "@ai-office/application/capability/execute-controlled-action.ts";
import { RevokeCapabilityGrant } from "@ai-office/application/capability/revoke-capability-grant.ts";
import type {
  CapabilityPrincipalType,
  ResourceType,
} from "@ai-office/domain/capability/capability.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

const resourceTypes = [
  "filesystem_scope",
  "github_repository",
  "sqlite_database",
  "shell_environment",
] as const satisfies readonly ResourceType[];
const principalTypes = [
  "user",
  "agent",
  "role",
  "workflow",
  "application",
] as const satisfies readonly CapabilityPrincipalType[];

function isResourceType(value: string): value is ResourceType {
  return resourceTypes.some((candidate) => candidate === value);
}

function isPrincipalType(value: string): value is CapabilityPrincipalType {
  return principalTypes.some((candidate) => candidate === value);
}

function jsonObject(
  value: string | undefined,
  name: string,
): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new CliUsageError(`Option --${name} must be a JSON object`);
  }
}

function optionalDate(
  value: string | undefined,
  name: string,
): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new CliUsageError(`Option --${name} must be an ISO date`);
  return date;
}

function publicActionArguments(operation: string, value: unknown): unknown {
  if (
    (operation === "filesystem.create" || operation === "filesystem.write") &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const record = value as Readonly<Record<string, unknown>>;
    return { ...record, content: "[REDACTED]" };
  }
  return value;
}

export async function handleCapabilityCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const {
    projects,
    runtime,
    capabilities,
    controlled,
    audit,
    ids,
    clock,
    transactions,
    connectors,
    io,
  } = context;
  const records = new ListCapabilityRecords(capabilities);
  if (command === "resource:create") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "type",
        "provider",
        "name",
        "external-ref",
        "configuration",
      ]),
    );
    const type = requiredOption(parsed, "type");
    if (!isResourceType(type)) throw new CliUsageError("Invalid resource type");
    const resource = await new RegisterResource(
      projects,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
      connectors,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      type,
      provider: requiredOption(parsed, "provider"),
      displayName: requiredOption(parsed, "name"),
      configuration: jsonObject(
        parsed.options.get("configuration"),
        "configuration",
      ),
      ...(parsed.options.get("external-ref") === undefined
        ? {}
        : { externalRef: parsed.options.get("external-ref")! }),
    });
    io.stdout(`Resource created: ${resource.id}`);
    return 0;
  }
  if (command === "resource:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const resources = await records.listResources(
      requiredOption(parsed, "project"),
    );
    io.stdout("id\ttype\tprovider\tstatus\tdisplay_name");
    for (const resource of resources)
      io.stdout(
        `${resource.id}\t${resource.type}\t${resource.provider}\t${resource.status}\t${resource.displayName}`,
      );
    return 0;
  }
  if (command === "resource:disable") {
    const parsed = parseArguments(args, new Set(["project", "resource"]));
    await new DisableResource(capabilities, audit, clock, transactions).execute(
      {
        projectId: requiredOption(parsed, "project"),
        resourceId: requiredOption(parsed, "resource"),
      },
    );
    io.stdout(`Resource disabled: ${requiredOption(parsed, "resource")}`);
    return 0;
  }
  if (command === "capability:grant") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "principal-type",
        "principal",
        "resource",
        "actions",
        "constraints",
        "valid-from",
        "expires-at",
        "granted-by",
        "reason",
      ]),
    );
    const principalType = requiredOption(parsed, "principal-type");
    if (!isPrincipalType(principalType))
      throw new CliUsageError("Invalid capability principal type");
    const validFrom = optionalDate(
      parsed.options.get("valid-from"),
      "valid-from",
    );
    const expiresAt = optionalDate(
      parsed.options.get("expires-at"),
      "expires-at",
    );
    const grant = await new CreateCapabilityGrant(
      projects,
      runtime,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
      connectors,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      principalType,
      principalId: requiredOption(parsed, "principal"),
      resourceId: requiredOption(parsed, "resource"),
      actions: requiredOption(parsed, "actions").split(","),
      constraints: jsonObject(parsed.options.get("constraints"), "constraints"),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      grantedBy: requiredOption(parsed, "granted-by"),
      reason: requiredOption(parsed, "reason"),
    });
    io.stdout(`Capability granted: ${grant.id}`);
    return 0;
  }
  if (command === "capability:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const grants = await records.listGrants(requiredOption(parsed, "project"));
    io.stdout("id\tprincipal\tresource\tactions\tstate");
    for (const grant of grants)
      io.stdout(
        `${grant.id}\t${grant.principalType}:${grant.principalId}\t${grant.resourceId}\t${grant.actions.join(",")}\t${grant.revokedAt === undefined ? "active" : "revoked"}`,
      );
    return 0;
  }
  if (command === "capability:revoke") {
    const parsed = parseArguments(
      args,
      new Set(["project", "grant", "revoked-by"]),
    );
    await new RevokeCapabilityGrant(
      capabilities,
      audit,
      clock,
      transactions,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      grantId: requiredOption(parsed, "grant"),
      revokedBy: requiredOption(parsed, "revoked-by"),
    });
    io.stdout(`Capability revoked: ${requiredOption(parsed, "grant")}`);
    return 0;
  }
  if (command === "action:request") {
    const parsed = parseArguments(
      args,
      new Set(["project", "agent", "resource", "operation", "arguments"]),
    );
    const evaluator = new EvaluateActionPolicy(
      runtime,
      capabilities,
      clock,
      connectors,
    );
    const result = await new RequestControlledAction(
      evaluator,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      agentId: requiredOption(parsed, "agent"),
      resourceId: requiredOption(parsed, "resource"),
      operation: requiredOption(parsed, "operation"),
      arguments: jsonObject(parsed.options.get("arguments"), "arguments"),
    });
    io.stdout(`Action request: ${result.request.snapshot().id}`);
    io.stdout(`Decision: ${result.outcome}`);
    return result.outcome === "denied" ? 2 : 0;
  }
  if (command === "action:invoke") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "action",
        "agent",
        "resource",
        "operation",
        "arguments",
      ]),
    );
    const projectId = requiredOption(parsed, "project");
    const evaluator = new EvaluateActionPolicy(
      runtime,
      capabilities,
      clock,
      connectors,
    );
    const requestAction = new RequestControlledAction(
      evaluator,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
    );
    const service = new InvokeControlledConnectorAction(
      requestAction,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
      connectors,
      evaluator,
      controlled,
    );
    const actionRequestId = parsed.options.get("action");
    if (
      actionRequestId !== undefined &&
      ["agent", "resource", "operation", "arguments"].some((name) =>
        parsed.options.has(name),
      )
    )
      throw new CliUsageError(
        "Option --action cannot be combined with action request options",
      );
    const result =
      actionRequestId === undefined
        ? await service.execute({
            projectId,
            agentId: requiredOption(parsed, "agent"),
            resourceId: requiredOption(parsed, "resource"),
            operation: requiredOption(parsed, "operation"),
            arguments: jsonObject(parsed.options.get("arguments"), "arguments"),
          })
        : await service.invokeAuthorized({ projectId, actionRequestId });
    io.stdout(`Action request: ${result.requestId}`);
    io.stdout(`Status: ${result.status}`);
    if (result.result !== undefined)
      io.stdout(`Result: ${canonicalStringify(result.result)}`);
    if (result.simulation !== undefined) {
      const simulation = result.simulation.snapshot();
      io.stdout(
        `Simulation: ${canonicalStringify({
          id: simulation.id,
          preconditions: simulation.preconditions,
          diff: simulation.diff,
          diffSha256: simulation.diffSha256,
          artifactSha256: simulation.artifactSha256,
        })}`,
      );
    }
    return result.outcome === "denied" ? 2 : 0;
  }
  if (command === "action:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const actions = await records.listActions(
      requiredOption(parsed, "project"),
    );
    io.stdout("id\toperation\tdecision\trisk\tstatus");
    for (const action of actions) {
      const value = action.snapshot();
      io.stdout(
        `${value.id}\t${value.operation}\t${value.decision}\t${value.riskLevel}\t${value.status}`,
      );
    }
    return 0;
  }
  if (command === "action:approve" || command === "action:reject") {
    const parsed = parseArguments(
      args,
      new Set(["project", "action", "actor"]),
    );
    const input = {
      projectId: requiredOption(parsed, "project"),
      actionRequestId: requiredOption(parsed, "action"),
      actor: requiredOption(parsed, "actor"),
    };
    const service = new DecideControlledAction(
      capabilities,
      controlled,
      audit,
      clock,
      transactions,
    );
    const result =
      command === "action:approve"
        ? await service.approve(input)
        : await service.reject(input);
    io.stdout(`Action request: ${input.actionRequestId}`);
    io.stdout(`Approval: ${result.approval.snapshot().status}`);
    io.stdout(`Status: ${result.actionStatus}`);
    return 0;
  }
  if (command === "action:execute") {
    const parsed = parseArguments(args, new Set(["project", "action"]));
    const projectId = requiredOption(parsed, "project");
    const actionRequestId = requiredOption(parsed, "action");
    const evaluator = new EvaluateActionPolicy(
      runtime,
      capabilities,
      clock,
      connectors,
    );
    const result = await new ExecuteControlledAction(
      capabilities,
      controlled,
      audit,
      ids,
      clock,
      transactions,
      connectors,
      evaluator,
    ).execute({ projectId, actionRequestId });
    io.stdout(`Action request: ${result.actionRequestId}`);
    io.stdout(`Execution: ${result.executionId}`);
    io.stdout(`Status: ${result.status}`);
    if (result.resultHash !== undefined)
      io.stdout(`Result hash: ${result.resultHash}`);
    if (result.failureCode !== undefined)
      io.stdout(`Failure code: ${result.failureCode}`);
    return result.status === "completed" ? 0 : 2;
  }
  if (command === "action:show") {
    const parsed = parseArguments(args, new Set(["project", "action"]));
    const value = (
      await records.showAction(
        requiredOption(parsed, "action"),
        requiredOption(parsed, "project"),
      )
    ).snapshot();
    const approval = await controlled.findApprovalByAction(
      value.id,
      value.projectId,
    );
    const execution = await controlled.findExecutionByAction(
      value.id,
      value.projectId,
    );
    const approvalSnapshot = approval?.snapshot();
    const executionSnapshot = execution?.snapshot();
    io.stdout(
      canonicalStringify({
        ...value,
        normalizedArguments: publicActionArguments(
          value.operation,
          value.normalizedArguments,
        ),
        createdAt: value.createdAt.toISOString(),
        updatedAt: value.updatedAt.toISOString(),
        ...(approvalSnapshot === undefined
          ? {}
          : {
              approval: {
                id: approvalSnapshot.id,
                status: approvalSnapshot.status,
                requestedAt: approvalSnapshot.requestedAt.toISOString(),
                ...(approvalSnapshot.decidedAt === undefined
                  ? {}
                  : { decidedAt: approvalSnapshot.decidedAt.toISOString() }),
                ...(approvalSnapshot.actor === undefined
                  ? {}
                  : { actor: approvalSnapshot.actor }),
              },
            }),
        ...(executionSnapshot === undefined
          ? {}
          : {
              execution: {
                id: executionSnapshot.id,
                status: executionSnapshot.status,
                startedAt: executionSnapshot.startedAt.toISOString(),
                ...(executionSnapshot.completedAt === undefined
                  ? {}
                  : {
                      completedAt:
                        executionSnapshot.completedAt.toISOString(),
                    }),
                ...(executionSnapshot.failureCode === undefined
                  ? {}
                  : { failureCode: executionSnapshot.failureCode }),
                ...(executionSnapshot.resultHash === undefined
                  ? {}
                  : { resultHash: executionSnapshot.resultHash }),
              },
            }),
      }),
    );
    return 0;
  }
  return null;
}
