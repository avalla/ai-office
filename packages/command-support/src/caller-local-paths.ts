import { isAbsolute, resolve } from "node:path";
import { CliUsageError } from "./arguments.ts";

/**
 * Where the meaning of a relative local filesystem path is decided.
 *
 * The Runtime host is persistent: it was started once, from some directory,
 * and keeps running while clients come and go from unrelated repositories. Its
 * process working directory therefore says nothing about what a client meant by
 * `.`, `agents`, or `draft.json`. Relative local filesystem semantics belong to
 * the invoking client context, so:
 *
 * - the client resolves every caller-local path argument against its own
 *   working directory before IPC (`resolveCallerLocalPaths`);
 * - the Runtime refuses any caller-local path that arrives omitted or relative rather than
 *   interpreting it against its own cwd (`assertAbsoluteCallerLocalPaths`).
 *
 * Two kinds of path deliberately stay outside this contract: a path resolved
 * inside a root the caller already supplied as an absolute argument (for
 * example `client:plan --contract`, read relative to `--root`), and a string
 * that only looks like a path (identifiers, titles, reasons, JSON payloads).
 */
export interface CallerLocalPathSpec {
  /** Options taking a value, so positional scanning skips those values. */
  valueOptions: readonly string[];
  /** Value-taking options whose value is a caller-local path. */
  pathOptions: readonly string[];
  /** The first positional is a caller-local path. */
  pathPositional?: boolean;
  /** Substitute the client working directory when no positional is given. */
  positionalDefaultsToWorkingDirectory?: boolean;
  /** Options defaulted from the client working directory when absent. */
  optionDefaults?: Readonly<
    Record<string, { segments: readonly string[]; whenOption?: string }>
  >;
}

export const callerLocalPathSpecs: Readonly<
  Record<string, CallerLocalPathSpec>
> = {
  install: {
    valueOptions: [],
    pathOptions: [],
    pathPositional: true,
    positionalDefaultsToWorkingDirectory: true,
  },
  status: {
    valueOptions: [],
    pathOptions: [],
    pathPositional: true,
    positionalDefaultsToWorkingDirectory: true,
  },
  next: {
    valueOptions: [],
    pathOptions: [],
    pathPositional: true,
    positionalDefaultsToWorkingDirectory: true,
  },
  uninstall: {
    valueOptions: ["approve"],
    pathOptions: [],
    pathPositional: true,
    positionalDefaultsToWorkingDirectory: true,
  },
  "project:import": {
    valueOptions: ["name"],
    pathOptions: [],
    pathPositional: true,
    positionalDefaultsToWorkingDirectory: true,
  },
  "project:backup": {
    valueOptions: ["project", "output"],
    pathOptions: ["output"],
  },
  "project:restore": {
    valueOptions: ["root"],
    pathOptions: ["root"],
    pathPositional: true,
    optionDefaults: { root: { segments: [] } },
  },
  "office:validate": {
    valueOptions: ["manifest", "file", "root"],
    pathOptions: ["file", "root"],
    optionDefaults: { root: { segments: [], whenOption: "file" } },
  },
  "office:apply": {
    valueOptions: ["project", "manifest", "file"],
    pathOptions: ["file"],
  },
  "agent:sync": {
    valueOptions: ["project", "directory"],
    pathOptions: ["directory"],
    optionDefaults: { directory: { segments: ["agents"] } },
  },
  "client:inspect": { valueOptions: ["client", "root"], pathOptions: ["root"] },
  "client:validate": {
    valueOptions: ["client", "root"],
    pathOptions: ["root"],
  },
  "client:plan": {
    valueOptions: ["client", "root", "contract"],
    pathOptions: ["root"],
  },
  "client:apply": {
    valueOptions: ["client", "root", "contract", "approve"],
    pathOptions: ["root"],
  },
  "client:uninstall": {
    valueOptions: ["client", "root", "approve"],
    pathOptions: ["root"],
  },
};

/** Index of the first positional argument, skipping option values. */
function firstPositionalIndex(
  args: readonly string[],
  spec: CallerLocalPathSpec,
): number {
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument.startsWith("--")) {
      if (spec.valueOptions.includes(argument.slice(2))) index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function optionValueIndex(
  args: readonly string[],
  spec: CallerLocalPathSpec,
  option: string,
): number {
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || !argument.startsWith("--")) continue;
    const name = argument.slice(2);
    if (name === option) {
      const value = args[index + 1];
      return value !== undefined && !value.startsWith("--") ? index + 1 : -1;
    }
    if (spec.valueOptions.includes(name)) index += 1;
  }
  return -1;
}

function optionDefault(
  spec: CallerLocalPathSpec,
  args: readonly string[],
  option: string,
): readonly string[] | undefined {
  const value = spec.optionDefaults?.[option];
  if (
    value?.whenOption !== undefined &&
    optionValueIndex(args, spec, value.whenOption) === -1
  )
    return undefined;
  return value?.segments;
}

/**
 * Rewrites caller-local path arguments into absolute paths in the client's
 * context. Every other argument is passed through untouched.
 */
export function resolveCallerLocalPaths(
  args: readonly string[],
  workingDirectory: string,
): string[] {
  const command = args[0];
  const spec =
    command === undefined ? undefined : callerLocalPathSpecs[command];
  if (spec === undefined) return [...args];
  const result = [...args];

  if (spec.pathPositional === true) {
    const index = firstPositionalIndex(result, spec);
    if (index === -1) {
      if (spec.positionalDefaultsToWorkingDirectory === true)
        result.splice(1, 0, resolve(workingDirectory));
    } else result[index] = resolve(workingDirectory, result[index]!);
  }

  for (const option of spec.pathOptions) {
    const index = optionValueIndex(result, spec, option);
    if (index !== -1) {
      const resolved = resolve(workingDirectory, result[index]!);
      result[index] = resolved;
      continue;
    }
    const segments = optionDefault(spec, result, option);
    if (segments !== undefined && !result.includes(`--${option}`))
      result.push(`--${option}`, resolve(workingDirectory, ...segments));
  }

  return result;
}

/**
 * Runtime-side guard. An omitted caller-cwd default or relative path here means the
 * client did not establish its own context; resolving it against the host's
 * process working directory would silently answer about the wrong directory.
 */
export function assertAbsoluteCallerLocalPaths(args: readonly string[]): void {
  const command = args[0];
  const spec =
    command === undefined ? undefined : callerLocalPathSpecs[command];
  if (spec === undefined) return;

  const reject = (description: string, value: string | undefined): never => {
    throw new CliUsageError(
      `${description} must be an absolute path resolved by the calling client, but received "${value ?? "omitted"}". The persistent AI Office Runtime never interprets a relative path against its own working directory.`,
    );
  };

  if (spec.pathPositional === true) {
    const index = firstPositionalIndex(args, spec);
    const value = index === -1 ? undefined : args[index];
    if (
      (value === undefined &&
        spec.positionalDefaultsToWorkingDirectory === true) ||
      (value !== undefined && !isAbsolute(value))
    )
      reject(`${command} path`, value);
  }

  for (const option of spec.pathOptions) {
    const index = optionValueIndex(args, spec, option);
    const value = index === -1 ? undefined : args[index];
    if (
      (value === undefined &&
        optionDefault(spec, args, option) !== undefined) ||
      (value !== undefined && !isAbsolute(value))
    )
      reject(`Option --${option}`, value);
  }
}
