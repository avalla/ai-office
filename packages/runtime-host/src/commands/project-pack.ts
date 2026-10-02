import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
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
    ].includes(command)
  )
    return null;
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
    catalog: context.installedPacks,
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
