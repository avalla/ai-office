/**
 * `ai-office credential set|status|remove`.
 *
 * Local Runtime host configuration, like `service`: it writes owner-only files
 * under `<AI_OFFICE_HOME>/credentials/` and never contacts the Runtime, so no
 * credential crosses IPC, an audit event or SQLite. A running Runtime keeps the
 * credentials it loaded at start until it restarts.
 *
 * A value is accepted only on non-terminal stdin, never as an argument, and is
 * never printed. Error text never echoes arguments, which could be a value
 * pasted in the wrong place.
 */
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "@ai-office/command-support/arguments.ts";
import { providerCredentialNames } from "@ai-office/llm-gateway/provider-credentials.ts";
import {
  inspectRuntimeHomeCredential,
  maximumProviderCredentialBytes,
  ProviderCredentialStoreError,
  removeRuntimeHomeCredential,
  writeRuntimeHomeCredential,
} from "@ai-office/llm-gateway/runtime-home-credential-store.ts";

export interface CredentialInput {
  readonly isTTY: boolean;
  /**
   * Reads stdin to its end, or stops once more than `limit` bytes arrived.
   * It returns and retains at most `limit + 1` bytes.
   */
  read(limit: number): Promise<Buffer>;
}

export interface CredentialCliOptions {
  runtimeHome: string;
  io: CommandIo;
  /** Called before a write so the Runtime home exists owner-only. */
  ensureRuntimeHome?: () => void;
  input?: CredentialInput;
}

export const credentialCommandHelp = `AI Office provider credentials

Stores provider credentials for the Runtime host as owner-only files in
<AI_OFFICE_HOME>/credentials/. They are never written to service definitions,
model-routing.yaml, SQLite, audit events or portable project state.

Commands:
  ai-office credential set <NAME>
    reads the value from stdin (never from arguments) and atomically replaces
    the file, mode 0600 in a 0700 directory (directory sync is best effort)
  ai-office credential status [--json]
    reports present, missing or invalid by name; never a value, length or path
  ai-office credential remove <NAME>

Names: ${providerCredentialNames().join(", ")}

Example (the value is not echoed and does not appear in the process list):
  read -rs KEY && printf '%s' "$KEY" | ai-office credential set OPENAI_API_KEY; unset KEY

Sources (never mixed):
  managed service  reads only this directory; ambient variables are ignored
  foreground       reads only its own environment variables, never this directory

Credentials are loaded when the Runtime starts; restart it after a change:
  systemctl --user restart ai-office-runtime.service          # Linux
  launchctl kickstart -k gui/$(id -u)/com.ai-office.runtime   # macOS`;

/**
 * Reads a byte stream into one preallocated buffer of `limit + 1` bytes and
 * stops at the first byte past `limit`, so an arbitrarily large chunk is never
 * retained or concatenated. Copied chunks are zeroed where they are mutable.
 * The caller owns the returned bytes and should zero them.
 */
export async function readBoundedInput(
  stream: AsyncIterable<Uint8Array | string>,
  limit: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const count = Math.min(bytes.length, buffer.length - length);
      buffer.set(bytes.subarray(0, count), length);
      length += count;
      bytes.fill(0);
      if (length > limit) break;
    }
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
  return buffer.subarray(0, length);
}

const processInput: CredentialInput = {
  isTTY: process.stdin.isTTY === true,
  read: (limit) => readBoundedInput(process.stdin, limit),
};

const restartHint =
  "Restart the Runtime to apply it (a running Runtime keeps the credentials it loaded at start).";

function credentialName(args: string[], subcommand: string): string {
  const names = providerCredentialNames();
  if (args.length !== 1)
    throw new CliUsageError(
      `credential ${subcommand} accepts exactly one credential name (${names.join(", ")}); a value is read from stdin, never from arguments`,
    );
  const name = args[0]!;
  if (!names.includes(name))
    throw new CliUsageError(
      `Unknown credential name; expected one of ${names.join(", ")}`,
    );
  return name;
}

export async function runCredentialCli(
  args: string[],
  options: CredentialCliOptions,
): Promise<number> {
  const { io, runtimeHome } = options;
  const subcommand = args[0];
  if (
    subcommand === undefined ||
    ["help", "--help", "-h"].includes(subcommand) ||
    args.slice(1).some((argument) => ["--help", "-h"].includes(argument))
  ) {
    io.stdout(credentialCommandHelp);
    return 0;
  }
  try {
    if (subcommand === "set") {
      const name = credentialName(args.slice(1), subcommand);
      const input = options.input ?? processInput;
      if (input.isTTY)
        throw new CliUsageError(
          "credential set reads the value from stdin and refuses a terminal, which would echo it. Pipe it in, for example: read -rs KEY && printf '%s' \"$KEY\" | ai-office credential set " +
            name,
        );
      options.ensureRuntimeHome?.();
      // One byte more than a value plus \r\n is enough to refuse oversize input.
      const content = await input.read(maximumProviderCredentialBytes + 3);
      try {
        writeRuntimeHomeCredential(runtimeHome, name, content);
      } finally {
        content.fill(0);
      }
      io.stdout(
        `Credential ${name} stored in the credentials directory of AI_OFFICE_HOME (owner-only).`,
      );
      io.stdout(restartHint);
      return 0;
    }
    if (subcommand === "remove") {
      const name = credentialName(args.slice(1), subcommand);
      const removed = removeRuntimeHomeCredential(runtimeHome, name);
      io.stdout(
        removed
          ? `Credential ${name} removed from the credentials directory of AI_OFFICE_HOME.`
          : `Credential ${name} is not configured in AI_OFFICE_HOME; nothing was removed.`,
      );
      if (removed) io.stdout(restartHint);
      return 0;
    }
    if (subcommand === "status") {
      let parsed;
      try {
        parsed = parseArguments(args.slice(1), new Set(), new Set(["json"]));
      } catch {
        parsed = null;
      }
      if (parsed === null || parsed.positionals.length > 0)
        throw new CliUsageError("credential status accepts only --json");
      // Metadata only: status never loads a credential value.
      const credentials = providerCredentialNames().map((name) => {
        const inspection = inspectRuntimeHomeCredential(runtimeHome, name);
        return {
          name,
          state: inspection.state,
          issue: inspection.state === "invalid" ? inspection.issue : null,
        };
      });
      if (parsed.flags.has("json")) {
        io.stdout(
          JSON.stringify({
            schemaVersion: 1,
            source: "runtime_home",
            credentials,
          }),
        );
        return credentials.some((value) => value.state === "invalid") ? 1 : 0;
      }
      io.stdout("Provider credentials in AI_OFFICE_HOME");
      for (const credential of credentials)
        io.stdout(
          `  ${credential.name}: ${credential.state}${credential.issue === null ? "" : ` ${credential.issue}`}`,
        );
      io.stdout(
        "A managed Runtime reads only these; a foreground Runtime reads only its own environment and never these. model:check reports what the running Runtime loaded.",
      );
      return credentials.some((value) => value.state === "invalid") ? 1 : 0;
    }
    throw new CliUsageError(
      "Unknown credential command; expected set, status or remove",
    );
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof ProviderCredentialStoreError
    ) {
      io.stderr(
        error instanceof ProviderCredentialStoreError
          ? `${error.code}: ${error.message}`
          : error.message,
      );
      return 1;
    }
    throw error;
  }
}
