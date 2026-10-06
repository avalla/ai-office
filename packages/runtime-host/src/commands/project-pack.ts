import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReconcileProjectPackUpgrade } from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
} from "./shared.ts";

function parsePacks(text: string): readonly PackIdentity[] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliUsageError(
      "--packs must be a JSON array of exact pack tuples",
    );
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        Object.keys(item).sort().join(",") !== "id,manifestDigest,version",
    )
  )
    throw new CliUsageError(
      "--packs must contain only id, version and manifestDigest for each pack",
    );
  return value as PackIdentity[];
}

export async function handleProjectPackCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (
    ![
      "project:pack:show",
      "project:pack:preview",
      "project:pack:apply",
      "project:pack:upgrade",
    ].includes(command)
  )
    return null;
  if (command === "project:pack:upgrade")
    return handleUpgrade(command, args, context);
  const options =
    command === "project:pack:show"
      ? new Set(["project"])
      : command === "project:pack:preview"
        ? new Set(["project", "packs"])
        : new Set(["project", "packs", "expected-revision"]);
  const parsed = parseArguments(args, options, new Set(["json"]));
  if (parsed.positionals.length > 0)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ManageProjectPackBinding({
    projects: context.projects,
    bindings: context.packBindings,
    definitions: context.definitions,
    catalog: context.installedPacks,
    providers: context.operationProviders,
    auditEvents: context.auditEvents,
    transactions: context.transactions,
    clock: context.clock,
    ids: context.ids,
  });
  const projectId = requiredOption(parsed, "project");
  if (command === "project:pack:show") {
    const binding = await service.read(projectId);
    context.io.stdout(
      parsed.flags.has("json")
        ? JSON.stringify(binding)
        : `Project pack binding revision ${binding.configurationRevision}: ${JSON.stringify(binding.packs)}`,
    );
    return 0;
  }
  const packs = parsePacks(requiredOption(parsed, "packs"));
  if (command === "project:pack:preview") {
    const preview = await service.preview(projectId, packs);
    context.io.stdout(
      parsed.flags.has("json")
        ? JSON.stringify(preview)
        : JSON.stringify(preview, null, 2),
    );
    return preview.issues.length === 0 ? 0 : 1;
  }
  const expectedRevision = Number(requiredOption(parsed, "expected-revision"));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new CliUsageError(
      "--expected-revision must be a nonnegative safe integer",
    );
  const binding = await service.apply({
    projectId,
    desired: packs,
    expectedRevision,
    actorId: context.principal.id,
  });
  context.io.stdout(
    parsed.flags.has("json")
      ? JSON.stringify(binding)
      : `Project pack binding revision ${binding.configurationRevision}: ${JSON.stringify(binding.packs)}`,
  );
  return 0;
}

/** Read-only reconciliation report without --approve; one audited change with it. */
async function handleUpgrade(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number> {
  const parsed = parseArguments(
    args,
    new Set(["project", "packs", "resolutions", "approve"]),
    new Set(["json"]),
  );
  if (parsed.positionals.length > 0)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ReconcileProjectPackUpgrade({
    projects: context.projects,
    bindings: context.packBindings,
    definitions: context.definitions,
    catalog: context.installedPacks,
    providers: context.operationProviders,
    auditEvents: context.auditEvents,
    transactions: context.transactions,
    clock: context.clock,
    ids: context.ids,
  });
  const projectId = requiredOption(parsed, "project");
  const desired = parsePacks(requiredOption(parsed, "packs"));
  let resolutions: unknown = [];
  const rawResolutions = parsed.options.get("resolutions");
  if (rawResolutions !== undefined)
    try {
      resolutions = JSON.parse(rawResolutions) as unknown;
    } catch {
      throw new CliUsageError(
        "--resolutions must be a JSON array of override resolutions",
      );
    }
  const indent = parsed.flags.has("json") ? 0 : 2;
  const approvedPlanDigest = parsed.options.get("approve");
  if (approvedPlanDigest === undefined) {
    const plan = await service.preview({ projectId, desired, resolutions });
    context.io.stdout(JSON.stringify(plan, null, indent));
    return plan.issues.length === 0 ? 0 : 1;
  }
  const result = await service.apply({
    projectId,
    desired,
    resolutions,
    approvedPlanDigest,
    actorId: context.principal.id,
  });
  context.io.stdout(JSON.stringify(result, null, indent));
  return 0;
}
