import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultTaskDeliverySetupValues,
  isTaskDeliverySetupKey,
  validateTaskDeliverySetupValue,
  type TaskDeliverySetupValues,
} from "@ai-office/application/task-delivery-setup/task-delivery-setup-schema.ts";
import {
  taskDeliveryConfigName,
  validateTaskDeliveryConfigSource,
} from "./task-delivery-config.ts";
import { errorMessage } from "./shared.ts";

/**
 * Setup resolution for the `task-delivery` skill (M19-T4): Runtime first,
 * then `.task-delivery.yaml`, then the built-in defaults. The pure core is
 * {@link resolveSetupFromShow}; {@link resolveSetup} adds the Runtime and
 * YAML channels so the whole precedence chain is testable without a daemon.
 */

export type SetupResolutionSource = "runtime" | "yaml" | "defaults";

export interface ResolvedTaskDeliverySetup {
  readonly source: SetupResolutionSource;
  readonly values: TaskDeliverySetupValues;
}

export class SetupResolutionError extends Error {
  override readonly name = "SetupResolutionError";
}

export interface RuntimeSetupShow {
  readonly project: Record<string, unknown>;
  readonly overrides: readonly {
    readonly scope: string;
    readonly scopeRef: string;
    readonly key: string;
    readonly value: unknown;
  }[];
}

function overlay(
  base: TaskDeliverySetupValues,
  entries: readonly (readonly [string, unknown])[],
): TaskDeliverySetupValues {
  const values: Record<string, string | number> = { ...base };
  for (const [key, value] of entries) {
    if (!isTaskDeliverySetupKey(key)) continue;
    const valid = validateTaskDeliverySetupValue(key, value);
    if (valid !== null) values[key] = valid;
  }
  return values as unknown as TaskDeliverySetupValues;
}

/**
 * The deterministic merge: a parsed `delivery:setup:show` answer wins; with
 * no Runtime answer the YAML setup keys win; with neither, the defaults.
 * A present-but-malformed answer is an error in the caller, never silently
 * skipped here: this function only sees answers that already parsed.
 */
export function resolveSetupFromShow(
  show: RuntimeSetupShow | null,
  yamlSetup: Record<string, unknown> | null,
): ResolvedTaskDeliverySetup {
  if (show !== null)
    return {
      source: "runtime",
      values: overlay(defaultTaskDeliverySetupValues, [
        ...Object.entries(show.project),
        ...show.overrides.map((entry) => [entry.key, entry.value] as const),
      ]),
    };
  if (yamlSetup !== null)
    return {
      source: "yaml",
      values: overlay(defaultTaskDeliverySetupValues, Object.entries(yamlSetup)),
    };
  return { source: "defaults", values: defaultTaskDeliverySetupValues };
}

/** Spawns the office CLI; injectable in tests. */
export interface SetupCommandRunner {
  (args: string[]): { status: number | null; stdout: string };
}

export interface ResolveSetupOptions {
  readonly runId?: string;
  readonly taskId?: string;
  readonly runner?: SetupCommandRunner;
}

function parseShowOutput(stdout: string): RuntimeSetupShow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new SetupResolutionError(
      `the Runtime answered delivery:setup:show with output that is not JSON: ${errorMessage(error)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { project?: unknown }).project !== "object" ||
    !Array.isArray((parsed as { overrides?: unknown }).overrides)
  )
    throw new SetupResolutionError(
      "the Runtime answered delivery:setup:show with a payload outside the schemaVersion 1 contract",
    );
  const show = parsed as {
    project: Record<string, unknown>;
    overrides: unknown;
  };
  const overrides: {
    scope: string;
    scopeRef: string;
    key: string;
    value: unknown;
  }[] = [];
  for (const entry of show.overrides as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { scope?: unknown }).scope !== "string" ||
      typeof (entry as { scopeRef?: unknown }).scopeRef !== "string" ||
      typeof (entry as { key?: unknown }).key !== "string" ||
      !("value" in entry)
    )
      throw new SetupResolutionError(
        "the Runtime answered delivery:setup:show with an override row outside the schemaVersion 1 contract",
      );
    overrides.push(entry as RuntimeSetupShow["overrides"][number]);
  }
  return { project: show.project, overrides };
}

/**
 * Reads the setup keys from `.task-delivery.yaml`. A file that is present but
 * breaks its contract is a stop condition, exactly as the skill documents:
 * this throws instead of falling back to defaults around a typo.
 */
export function readYamlSetup(root: string): Record<string, unknown> | null {
  let source: string;
  try {
    source = readFileSync(join(root, taskDeliveryConfigName), "utf8");
  } catch {
    return null;
  }
  const problems = validateTaskDeliveryConfigSource(source);
  if (problems.length > 0)
    throw new SetupResolutionError(
      `${taskDeliveryConfigName} breaks its contract:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source);
  } catch (error) {
    throw new SetupResolutionError(
      `${taskDeliveryConfigName} cannot be parsed: ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const setup: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed))
    if (isTaskDeliverySetupKey(key)) setup[key] = value;
  return setup;
}

function defaultRunner(cwd: string): SetupCommandRunner {
  return (args) => {
    let result;
    try {
      result = Bun.spawnSync({
        cmd: ["ai-office", ...args],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      // The CLI is not installed or not reachable: the Runtime was not
      // contacted, which is a fallback, never an unreachable claim.
      return { status: null, stdout: "" };
    }
    return {
      status: result.exitCode,
      stdout: result.stdout.toString(),
    };
  };
}

/**
 * Resolves the effective setup for a repository root. A non-zero exit or an
 * absent CLI means the Runtime did not answer and the static fallback is
 * used; a zero exit with a malformed payload is an error, because the Runtime
 * did answer.
 */
export function resolveSetup(
  cwd: string,
  options: ResolveSetupOptions = {},
): ResolvedTaskDeliverySetup {
  const runner = options.runner ?? defaultRunner(cwd);
  const args = ["delivery:setup:show"];
  if (options.taskId !== undefined) args.push("--task", options.taskId);
  else if (options.runId !== undefined) args.push("--run", options.runId);
  const runtime = runner(args);
  const show =
    runtime.status === 0 ? parseShowOutput(runtime.stdout) : null;
  const yamlSetup = show === null ? readYamlSetup(cwd) : null;
  return resolveSetupFromShow(show, yamlSetup);
}

interface EntryArguments {
  readonly taskId?: string;
  readonly runId?: string;
}

function parseEntryArguments(argv: readonly string[]): EntryArguments {
  const parsed: { taskId?: string; runId?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new SetupResolutionError(`${argument} requires a value`);
    if (argument === "--task") parsed.taskId = value;
    else if (argument === "--run") parsed.runId = value;
    else throw new SetupResolutionError(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (parsed.taskId !== undefined && parsed.runId !== undefined)
    throw new SetupResolutionError("Pass at most one of --task and --run");
  return parsed;
}

/**
 * CLI entry point: resolves the setup for the current working directory and
 * prints `{schemaVersion: 1, source, values}`. A typed resolution failure
 * exits 1 with the message on stderr; an absent Runtime or file is not a
 * failure, it is the "defaults" answer.
 */
if (import.meta.main) {
  try {
    const { taskId, runId } = parseEntryArguments(process.argv.slice(2));
    const resolved = resolveSetup(process.cwd(), {
      ...(taskId === undefined ? {} : { taskId }),
      ...(runId === undefined ? {} : { runId }),
    });
    console.log(JSON.stringify({ schemaVersion: 1, ...resolved }));
  } catch (error) {
    if (!(error instanceof SetupResolutionError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
