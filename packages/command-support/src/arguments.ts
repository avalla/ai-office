export interface CommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
  prompt?(message: string): Promise<string>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliPromptRequiredError extends Error {
  constructor(readonly prompt: string) {
    super("CLI input is required");
    this.name = "CliPromptRequiredError";
  }
}

export interface ParsedArguments {
  positionals: string[];
  options: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}

export function parseArguments(
  args: string[],
  allowedOptions: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string> = new Set(),
): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (allowedFlags.has(name)) {
      if (flags.has(name))
        throw new CliUsageError(`Flag --${name} can only be provided once`);
      flags.add(name);
      continue;
    }
    if (!allowedOptions.has(name))
      throw new CliUsageError(`Unknown option --${name}`);
    if (options.has(name))
      throw new CliUsageError(`Option --${name} can only be provided once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliUsageError(`Option --${name} requires a value`);
    options.set(name, value);
    index += 1;
  }
  return { positionals, options, flags };
}

export function requiredOption(
  arguments_: ParsedArguments,
  name: string,
): string {
  const value = arguments_.options.get(name);
  if (value === undefined)
    throw new CliUsageError(`Missing required option --${name}`);
  return value;
}

export function jsonObject(
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

export function nonNegativeBigInt(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new CliUsageError(`Option --${name} must be a non-negative integer`);
  }
}

export function currency(value: string): "USD" | "EUR" {
  if (value !== "USD" && value !== "EUR")
    throw new CliUsageError("Currency must be USD or EUR");
  return value;
}

export function requiredPositional(
  arguments_: ParsedArguments,
  description: string,
): string {
  const value = arguments_.positionals[0];
  if (value === undefined)
    throw new CliUsageError(
      `Missing required ${description}; the calling client must supply an absolute path`,
    );
  return value;
}
