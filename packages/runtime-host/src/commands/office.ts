import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { OfficeManifestNotFoundError } from "@ai-office/application/errors.ts";
import { GetOfficeContext } from "@ai-office/application/queries/get-office-context.ts";
import {
  officeTaskKinds,
  type OfficeManifest,
  type OfficeTaskKind,
} from "@ai-office/domain/office/office-manifest.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

const maximumManifestBytes = 256 * 1024;

function parseBoundedManifest(source: string): OfficeManifest {
  if (Buffer.byteLength(source, "utf8") > maximumManifestBytes) {
    throw new CliUsageError(
      `Office manifest exceeds the ${maximumManifestBytes}-byte limit`,
    );
  }
  return parseOfficeManifestJson(source);
}

function isTaskKind(value: string): value is OfficeTaskKind {
  return officeTaskKinds.some((candidate) => candidate === value);
}

function manifestFromOptions(
  options: ReadonlyMap<string, string>,
  projectRoot: string,
): OfficeManifest {
  const inline = options.get("manifest");
  const file = options.get("file");
  if ((inline === undefined) === (file === undefined)) {
    throw new CliUsageError(
      "Provide exactly one of --manifest <json> or --file <path>",
    );
  }
  if (inline !== undefined) return parseBoundedManifest(inline);

  const canonicalRoot = realpathSync(projectRoot);
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync(resolve(projectRoot, file!));
  } catch {
    throw new CliUsageError(`Office manifest file was not found: ${file}`);
  }
  const relativePath = relative(canonicalRoot, canonicalFile);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new CliUsageError(
      "Office manifest file must be inside the project root",
    );
  }
  const fileStatus = statSync(canonicalFile);
  if (!fileStatus.isFile()) {
    throw new CliUsageError(
      "Office manifest path must identify a regular file",
    );
  }
  if (fileStatus.size > maximumManifestBytes) {
    throw new CliUsageError(
      `Office manifest exceeds the ${maximumManifestBytes}-byte limit`,
    );
  }
  return parseBoundedManifest(readFileSync(canonicalFile, "utf8"));
}

function revisionJson(value: {
  revision: number;
  appliedAt: Date;
  manifest: OfficeManifest;
}): string {
  return JSON.stringify({
    revision: value.revision,
    appliedAt: value.appliedAt.toISOString(),
    manifest: value.manifest,
  });
}

export async function handleOfficeCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command === "office:validate") {
    const parsed = parseArguments(args, new Set(["manifest", "file"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("office:validate only accepts named options");
    const manifest = manifestFromOptions(parsed.options, context.projectRoot);
    context.io.stdout(
      JSON.stringify({ valid: true, schemaVersion: manifest.schemaVersion }),
    );
    return 0;
  }

  if (command === "office:apply") {
    const parsed = parseArguments(
      args,
      new Set(["project", "manifest", "file"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("office:apply only accepts named options");
    const manifest = manifestFromOptions(parsed.options, context.projectRoot);
    const revision = await new ApplyOfficeManifest(
      context.projects,
      context.officeManifests,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
    ).execute(requiredOption(parsed, "project"), manifest);
    context.io.stdout(revisionJson(revision));
    return 0;
  }

  if (command === "office:context" || command === "office:show") {
    const parsed = parseArguments(args, new Set(["project"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError(`${command} only accepts named options`);
    const projectId = requiredOption(parsed, "project");
    const result = await new GetOfficeContext(
      context.projects,
      context.profiles,
      context.officeManifests,
    ).execute(projectId);
    if (command === "office:context") {
      context.io.stdout(
        JSON.stringify({
          contractVersion: 1,
          profileSemantics: result.profileSemantics,
          currentOfficeSemantics: result.currentOfficeSemantics,
          profile: result.profile,
          current:
            result.current === null
              ? null
              : {
                  revision: result.current.revision,
                  appliedAt: result.current.appliedAt.toISOString(),
                  manifest: result.current.manifest,
                },
        }),
      );
      return 0;
    }
    if (result.current === null) {
      throw new OfficeManifestNotFoundError(projectId);
    }
    context.io.stdout(revisionJson(result.current));
    return 0;
  }

  if (command === "office:pipeline") {
    const parsed = parseArguments(args, new Set(["project", "task-kind"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("office:pipeline only accepts named options");
    const projectId = requiredOption(parsed, "project");
    const taskKind = requiredOption(parsed, "task-kind");
    if (!isTaskKind(taskKind)) {
      throw new CliUsageError(
        `Task kind must be one of: ${officeTaskKinds.join(", ")}`,
      );
    }
    const pipeline = await new GetOfficeContext(
      context.projects,
      context.profiles,
      context.officeManifests,
    ).resolvePipeline(projectId, taskKind);
    context.io.stdout(JSON.stringify(pipeline));
    return 0;
  }

  return null;
}
