import {
  LegacyDevelopmentProfileError,
  type LegacyDevelopmentProfile,
  type LegacyRuntimeRole,
} from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { ReadLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/read-legacy-development-profile.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ProjectConfigurationResolutionError } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
} from "./shared.ts";

export async function handleProjectConfigurationCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command === "project:configuration:legacy")
    return handleLegacyProfile(command, args, context);
  if (command !== "project:configuration:show") return null;
  const parsed = parseArguments(args, new Set(["project"]), new Set(["json"]));
  if (parsed.positionals.length)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ReadProjectConfiguration({
    projects: context.projects,
    bindings: context.packBindings,
    definitions: context.definitions,
    transactions: context.transactions,
    catalog: context.installedPacks,
  });
  try {
    const result = await service.read(requiredOption(parsed, "project"));
    context.io.stdout(
      JSON.stringify(
        { ok: true, configuration: result },
        null,
        parsed.flags.has("json") ? 0 : 2,
      ),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ProjectConfigurationResolutionError)) throw error;
    context.io.stdout(
      JSON.stringify(
        {
          ok: false,
          diagnostics: [{ code: error.code, message: error.message }],
        },
        null,
        parsed.flags.has("json") ? 0 : 2,
      ),
    );
    return 1;
  }
}

function runtimeRoleText(role: LegacyRuntimeRole): string {
  return `Runtime role "${role.name}" version ${role.version}, model policy ${role.modelPolicy}, guidance ${
    role.guidance === null
      ? "none"
      : `version ${role.guidance.version} ${role.guidance.digest}`
  }`;
}

/** Operator summary. `--json` carries every field; this never prints more. */
function legacyProfileText(profile: LegacyDevelopmentProfile): string {
  const list = (title: string, lines: readonly string[]): string[] => [
    `${title}:`,
    ...(lines.length === 0 ? ["  (none)"] : lines.map((line) => `  ${line}`)),
  ];
  return [
    `Legacy development profile ${profile.profileId} version ${profile.profileVersion}`,
    `Source: ${profile.source}; executable: no`,
    profile.statement,
    `Profile digest: ${profile.profileDigest}`,
    profile.office === null
      ? "Office: none (this project has no office manifest)"
      : `Office: ${profile.office.name} (manifest revision ${profile.metadata.officeManifestRevision})`,
    `Pack binding present: ${profile.metadata.packBinding.present ? "yes" : "no"} (metadata; not part of the profile or its digest)`,
    ...list(
      "Roles",
      profile.roles.map(
        (role) =>
          `${role.id}: ${role.title}; ${role.runtime === null ? "no Runtime role" : runtimeRoleText(role.runtime)}`,
      ),
    ),
    ...list(
      "Agents",
      profile.agents.map(
        (agent) =>
          `${agent.name}: role ${agent.roleId}, ${agent.enabled ? "enabled" : "disabled"}`,
      ),
    ),
    ...list(
      "Task kinds",
      profile.taskKinds.map(
        (route) => `${route.kind} -> ${route.pipelineId ?? "(no pipeline)"}`,
      ),
    ),
    ...list(
      "Pipelines",
      profile.pipelines.flatMap((pipeline) => [
        `${pipeline.id}: ${pipeline.name} [${pipeline.enforcement ?? "enforcement not set"}], default for ${pipeline.defaultFor.join(", ")}`,
        ...pipeline.stages.map(
          (stage, index) =>
            `  ${index + 1}. ${stage.id}: role ${stage.roleId}, approval ${
              stage.requiresApproval
                ? stage.requiresIndependentApproval === true
                  ? "required (independent)"
                  : "required"
                : "not required"
            }, eligible agents: ${stage.eligibleAgents.join(", ") || "(none)"}`,
        ),
      ]),
    ),
    ...list("Runtime only (outside the office manifest; not pack content)", [
      ...profile.runtimeOnly.roles.map(
        (role) =>
          `role ${role.key}: ${runtimeRoleText(role)} [provenance: ${role.provenance}]`,
      ),
      ...profile.runtimeOnly.agents.map(
        (agent) =>
          `agent ${agent.name}: role ${agent.roleKey}, ${agent.enabled ? "enabled" : "disabled"} [provenance: ${agent.provenance}]`,
      ),
    ]),
    ...list(
      "Diagnostics",
      profile.diagnostics.map((item) => `${item.code}: ${item.subject}`),
    ),
    ...list(
      "Outside the schema-1 pack vocabulary",
      profile.vocabularyGaps.map(
        (item) => `${item.code}: ${item.subject} (${item.fields.join(", ")})`,
      ),
    ),
  ].join("\n");
}

/** GP-09: read-only; no write, no audit event, nothing scheduled. */
async function handleLegacyProfile(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number> {
  const parsed = parseArguments(args, new Set(["project"]), new Set(["json"]));
  if (parsed.positionals.length)
    throw new CliUsageError(`${command} only accepts named options`);
  const service = new ReadLegacyDevelopmentProfile({
    projects: context.projects,
    officeManifests: context.officeManifests,
    runtime: context.runtime,
    bindings: context.packBindings,
    transactions: context.transactions,
  });
  try {
    const profile = await service.read(requiredOption(parsed, "project"));
    context.io.stdout(
      parsed.flags.has("json")
        ? JSON.stringify({ ok: true, profile })
        : legacyProfileText(profile),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof LegacyDevelopmentProfileError)) throw error;
    context.io.stdout(
      parsed.flags.has("json")
        ? JSON.stringify({
            ok: false,
            diagnostics: [{ code: error.code, message: error.message }],
          })
        : `Legacy development profile unavailable: ${error.code}: ${error.message}`,
    );
    return 1;
  }
}
