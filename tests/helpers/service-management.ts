import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ServiceCommandResult,
  ServiceCommandRunner,
} from "@ai-office/service-management/service-command-runner.ts";
import type { OfficeServicePlan } from "@ai-office/service-management/service-plan.ts";

/**
 * Scripted process boundary for the service adapters.
 *
 * Tests must never depend on the host actually running systemd or launchd, so
 * every `systemctl`/`launchctl` call is answered from a matcher list and
 * recorded for ordering assertions.
 */
export class FakeServiceCommandRunner implements ServiceCommandRunner {
  readonly calls: string[][] = [];

  private readonly matchers: Array<{
    fragment: readonly string[];
    result: (command: readonly string[]) => ServiceCommandResult;
  }> = [];

  constructor(
    private readonly fallback: ServiceCommandResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      unavailable: false,
    },
  ) {}

  /** Later registrations win, so a test can override a default arrangement. */
  on(
    fragment: readonly string[],
    result:
      | Partial<ServiceCommandResult>
      | ((command: readonly string[]) => Partial<ServiceCommandResult>),
  ): this {
    this.matchers.unshift({
      fragment,
      result: (command) => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        unavailable: false,
        ...(typeof result === "function" ? result(command) : result),
      }),
    });
    return this;
  }

  async run(command: readonly string[]): Promise<ServiceCommandResult> {
    this.calls.push([...command]);
    const matched = this.matchers.find((matcher) =>
      matcher.fragment.every((part) => command.includes(part)),
    );
    return matched === undefined ? this.fallback : matched.result(command);
  }

  /** Every recorded invocation as one joined string, for ordering assertions. */
  get log(): string[] {
    return this.calls.map((command) => command.join(" "));
  }

  indexOf(fragment: readonly string[]): number {
    return this.calls.findIndex((command) =>
      fragment.every((part) => command.includes(part)),
    );
  }
}

export function systemctlShowOutput(properties: {
  LoadState: string;
  ActiveState: string;
  SubState: string;
  UnitFileState: string;
}): string {
  return `${Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

/** A `systemctl --user` arrangement in which everything succeeds and runs. */
export function healthySystemdRunner(): FakeServiceCommandRunner {
  return new FakeServiceCommandRunner()
    .on(["--version"], { stdout: "systemd 255\n" })
    .on(["is-system-running"], { stdout: "running\n" })
    .on(["show"], {
      stdout: systemctlShowOutput({
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        UnitFileState: "enabled",
      }),
    });
}

export function launchdPrintOutput(fields: {
  state?: string;
  pid?: number;
  lastExitCode?: number;
}): string {
  const lines = ["com.ai-office.runtime = {", "\tactive count = 1"];
  if (fields.state !== undefined) lines.push(`\tstate = ${fields.state}`);
  if (fields.pid !== undefined) lines.push(`\tpid = ${fields.pid}`);
  if (fields.lastExitCode !== undefined)
    lines.push(`\tlast exit code = ${fields.lastExitCode}`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function servicePlan(
  overrides: Partial<OfficeServicePlan> = {},
): OfficeServicePlan {
  return {
    program: {
      launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
      runtimeHome: "/home/operator/.ai-office",
      requiresSourceRuntimeOptIn: false,
      ...overrides.program,
    },
    dashboard: {
      host: "127.0.0.1",
      port: 4278,
      awaitRuntimeSeconds: 60,
      ...overrides.dashboard,
    },
  };
}

/** Isolated definition directory; never the invoking user's real one. */
export function temporaryDefinitionDirectory(
  registry: string[],
  prefix: string,
): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registry.push(directory);
  return join(directory, "definitions");
}

export function cleanTemporaryDirectories(registry: string[]): void {
  for (const directory of registry.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

/**
 * Minimal structural plist reader.
 *
 * It proves the generated document is well-formed and carries the expected
 * keys and nesting without adding an XML dependency to the repository.
 */
export type PlistValue =
  string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

export function parseMinimalPlist(source: string): Record<string, PlistValue> {
  const inner = /<plist[^>]*>([\s\S]*)<\/plist>/u.exec(source);
  if (inner === null) throw new Error("The document has no plist element");
  const tokens = [...inner[1]!.matchAll(/<(\/?)([a-z]+)\s*(\/?)>([^<]*)/gu)]
    .map((match) => ({
      closing: match[1] === "/",
      tag: match[2]!,
      selfClosing: match[3] === "/",
      text: match[4]!,
    }))
    // Scalar elements carry their whole value in one token; only the
    // containers need their closing tag to delimit membership.
    .filter(
      (token) =>
        !token.closing || token.tag === "dict" || token.tag === "array",
    );

  let index = 0;
  const parseValue = (): PlistValue => {
    const token = tokens[index];
    if (token === undefined) throw new Error("The plist ends mid-value");
    index += 1;
    if (token.selfClosing) {
      if (token.tag === "true" || token.tag === "false")
        return token.tag === "true";
      throw new Error(`Unsupported empty plist element ${token.tag}`);
    }
    if (token.tag === "dict") return parseDict();
    if (token.tag === "array") {
      const items: PlistValue[] = [];
      while (
        tokens[index] !== undefined &&
        !(tokens[index]!.closing && tokens[index]!.tag === "array")
      )
        items.push(parseValue());
      if (tokens[index] === undefined) throw new Error("Unclosed plist array");
      index += 1;
      return items;
    }
    if (token.tag === "string") return token.text;
    if (token.tag === "integer") return Number(token.text);
    throw new Error(`Unsupported plist element ${token.tag}`);
  };
  const parseDict = (): Record<string, PlistValue> => {
    const dict: Record<string, PlistValue> = {};
    while (
      tokens[index] !== undefined &&
      !(tokens[index]!.closing && tokens[index]!.tag === "dict")
    ) {
      const key = tokens[index]!;
      if (key.tag !== "key")
        throw new Error(`Expected a plist key, found ${key.tag}`);
      index += 1;
      dict[key.text] = parseValue();
    }
    if (tokens[index] === undefined) throw new Error("Unclosed plist dict");
    index += 1;
    return dict;
  };

  const root = parseValue();
  if (typeof root !== "object" || Array.isArray(root))
    throw new Error("The plist root is not a dictionary");
  return root;
}
