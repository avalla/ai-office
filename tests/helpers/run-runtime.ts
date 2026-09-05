import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";

export async function runRuntime(agentExecutor?: AgentExecutor) {
  const root = mkdtempSync(join(tmpdir(), "ao-runs-"));
  const socketPath = join(root, "daemon.sock");
  let daemon = await bootstrap({
    projectRoot: root,
    socketPath,
    ...(agentExecutor === undefined ? {} : { agentExecutor }),
  });
  let controller = new AbortController();
  let running = daemon.start(controller.signal);
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.health();
      break;
    } catch {
      await Bun.sleep(5);
    }
  }
  const command = async (args: string[]) => {
    const stdout: string[] = [],
      stderr: string[] = [];
    const exitCode = await runDaemonCli(args, {
      projectRoot: root,
      socketPath,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    });
    return { exitCode, stdout, stderr };
  };
  const created = await command(["project:create", "Run tests"]);
  const projectId = created.stdout[0]!.replace("Project created: ", "");
  await command([
    "agent:sync",
    "--project",
    projectId,
    "--directory",
    resolve("agents"),
  ]);
  const agents = await command(["agent:list", "--project", projectId]);
  const agentId = agents.stdout[1]!.split("\t")[0]!;
  const task = async () =>
    (
      await command([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Test task",
      ])
    ).stdout[0]!.replace("Task created: ", "");
  const schedule = async (taskId: string, action = false) =>
    command([
      "run:schedule",
      "--project",
      projectId,
      "--task",
      taskId,
      "--agent",
      agentId,
      ...(action
        ? ["--resource", "missing", "--operation", "filesystem.read"]
        : []),
    ]);
  return {
    root,
    projectId,
    agentId,
    command,
    task,
    schedule,
    restart: async () => {
      controller.abort();
      await running;
      daemon = await bootstrap({
        projectRoot: root,
        socketPath,
        ...(agentExecutor === undefined ? {} : { agentExecutor }),
      });
      controller = new AbortController();
      running = daemon.start(controller.signal);
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await client.health();
          return;
        } catch {
          await Bun.sleep(5);
        }
      }
      throw new Error("Restart did not become healthy");
    },
    close: async () => {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
