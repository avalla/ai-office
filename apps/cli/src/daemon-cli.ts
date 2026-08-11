import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { cliHelp, type CliIo } from "./cli.ts";
import {
  DaemonClient,
  DaemonUnavailableError,
  InvalidDaemonResponseError,
} from "./daemon-client.ts";

export interface DaemonCliOptions {
  projectRoot: string;
  socketPath?: string;
  io?: CliIo;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

function promptContext(lines: string[]): string[] {
  let lastSaved = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith("Answer saved:") === true) {
      lastSaved = index;
      break;
    }
  }
  return lines.slice(lastSaved + 1);
}

function withoutRepeatedPrefix(lines: string[], prefix: string[]): string[] {
  const maximumOverlap = Math.min(lines.length, prefix.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const previousSuffix = prefix.slice(prefix.length - overlap);
    if (previousSuffix.every((line, index) => lines[index] === line)) {
      return lines.slice(overlap);
    }
  }
  return lines;
}

export async function runDaemonCli(
  args: string[],
  options: DaemonCliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  const socketPath =
    options.socketPath ??
    join(options.projectRoot, ".ai-office", "daemon.sock");
  const client = new DaemonClient(socketPath);

  try {
    if (
      args.length === 0 ||
      args[0] === "help" ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      io.stdout(cliHelp);
      return 0;
    }

    if (args[0] === "daemon:health") {
      const health = await client.health();
      io.stdout(`Daemon status: ${health.status}`);
      io.stdout(`Started at: ${health.startedAt}`);
      return 0;
    }

    const reader =
      io.prompt === undefined
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
    const prompt =
      io.prompt ?? ((message: string) => reader!.question(message));
    let answer: string | undefined;
    let previousPromptContext: string[] = [];

    try {
      while (true) {
        const response = await client.execute(args, answer);
        const stdout = withoutRepeatedPrefix(
          response.stdout,
          previousPromptContext,
        );
        for (const line of stdout) io.stdout(line);
        for (const line of response.stderr) io.stderr(line);

        if (response.prompt === undefined) return response.exitCode ?? 1;
        previousPromptContext = promptContext(response.stdout);
        answer = await prompt(response.prompt.message);
      }
    } finally {
      reader?.close();
    }
  } catch (error) {
    if (
      error instanceof DaemonUnavailableError ||
      error instanceof InvalidDaemonResponseError
    ) {
      io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}
