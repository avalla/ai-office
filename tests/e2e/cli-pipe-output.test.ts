import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { resolveTestSocketBase } from "../helpers/unix-socket.ts";

const entryPoint = resolve("bin/ai-office.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The runtime home holds the socket, so it lives under the short socket base. */
function runtimeHome(): string {
  const home = mkdtempSync(join(resolveTestSocketBase(), "ao-pipe-"));
  roots.push(home);
  return home;
}

/**
 * Runs the linked entry point with stdout connected to a real OS pipe whose
 * reader starts late, like a busy downstream consumer. Output larger than the
 * pipe buffer must still arrive in full, and the CLI must not report success
 * after dropping any of it. The delay is real on purpose: the defect is how
 * the CLI process treats a full kernel pipe, which no fake clock can produce,
 * and an eager reader can drain the pipe fast enough to hide it on some runs.
 */
async function pipedCli(home: string, args: string[], input = "") {
  const shell = Bun.spawn(
    [
      "sh",
      "-c",
      '{ "$@"; echo "cli-exit=$?" >&2; } | { sleep 0.5; cat; }',
      "sh",
      process.execPath,
      entryPoint,
      ...args,
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        AI_OFFICE_HOME: home,
        AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "1",
      },
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, shellExit] = await Promise.all([
    new Response(shell.stdout).text(),
    new Response(shell.stderr).text(),
    shell.exited,
  ]);
  expect(shellExit, stderr).toBe(0);
  expect(stderr).toContain("cli-exit=0");
  return stdout;
}

test("the linked CLI writes complete --json output larger than a pipe buffer into a pipe", async () => {
  const home = runtimeHome();
  const runtimePaths = resolveRuntimePaths({ mode: "user", runtimeHome: home });
  const host = await bootstrap({ runtimePaths });
  const controller = new AbortController();
  // A fresh home has no stale socket, so the listener is bound before the
  // first request below performs any I/O.
  const running = host.start(controller.signal);
  try {
    const command = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runRuntimeCli(args, {
        runtimePaths,
        workingDirectory: home,
        io: {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      });
      expect(exitCode, stderr.join("\n")).toBe(0);
      return stdout;
    };
    const created = await command(["project:create", "Pipe output"]);
    const projectId = created[0]!.replace("Project created: ", "");
    // 64 requirements x 4 KiB descriptions: one JSON line several times the
    // size of any pipe buffer.
    for (let index = 0; index < 64; index++)
      await command([
        "requirement:create",
        "--project",
        projectId,
        "--key",
        `REQ-${index}`,
        "--title",
        `Requirement ${index}`,
        "--description",
        `${index}:`.padEnd(4096, "d"),
      ]);

    const stdout = await pipedCli(home, [
      "requirement:list",
      "--project",
      projectId,
      "--json",
    ]);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(4 * 65_536);
    const listed = JSON.parse(stdout) as { requirements: unknown[] };
    expect(listed.requirements).toHaveLength(64);
  } finally {
    controller.abort();
    await running;
  }
}, 60_000);

test("the linked CLI writes complete output larger than a pipe buffer after answering a Runtime prompt", async () => {
  // No current command prompts, so a protocol-level Runtime asks one question
  // over the Unix socket and answers the reply with a large result.
  const home = runtimeHome();
  const large = JSON.stringify({ rows: "r".repeat(4 * 65_536) });
  const answers: (string | undefined)[] = [];
  const server = Bun.serve({
    unix: join(home, "daemon.sock"),
    fetch: async (request) => {
      const body = (await request.json()) as {
        requestId: string;
        promptAnswer?: string;
      };
      answers.push(body.promptAnswer);
      return Response.json(
        body.promptAnswer === undefined
          ? {
              protocolVersion: daemonProtocolVersion,
              requestId: body.requestId,
              exitCode: null,
              stdout: ["Question context"],
              stderr: [],
              prompt: { message: "Proceed? " },
            }
          : {
              protocolVersion: daemonProtocolVersion,
              requestId: body.requestId,
              exitCode: 0,
              stdout: [large],
              stderr: [],
            },
      );
    },
  });
  try {
    const stdout = await pipedCli(
      home,
      ["memory:search", "--query", "pipe", "--json"],
      "yes\n",
    );
    expect(answers).toEqual([undefined, "yes"]);
    expect(stdout).toBe(`Question context\nProceed? ${large}\n`);
  } finally {
    await server.stop(true);
  }
}, 60_000);
