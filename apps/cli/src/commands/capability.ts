import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { DisableResource } from "@ai-office/application/capability/disable-resource.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { ListCapabilityRecords } from "@ai-office/application/capability/list-capability-records.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
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

export async function handleCapabilityCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const {
    projects,
    runtime,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
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
    const evaluator = new EvaluateActionPolicy(runtime, capabilities, clock);
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
  if (command === "action:show") {
    const parsed = parseArguments(args, new Set(["project", "action"]));
    const value = (
      await records.showAction(
        requiredOption(parsed, "action"),
        requiredOption(parsed, "project"),
      )
    ).snapshot();
    io.stdout(
      canonicalStringify({
        ...value,
        createdAt: value.createdAt.toISOString(),
        updatedAt: value.updatedAt.toISOString(),
      }),
    );
    return 0;
  }
  return null;
}
