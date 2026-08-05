import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function captured(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not start");
}

describe("M6A daemon-backed CLI", () => {
  test("round-trips registry, grants, decisions, revocation, and disable without resource I/O", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-m6a-daemon-"));
    roots.push(root);
    const agentDirectory = join(root, "agents", "developer");
    mkdirSync(agentDirectory, { recursive: true });
    writeFileSync(
      join(agentDirectory, "agent.yaml"),
      `id: developer
role_key: developer
role: Developer
version: 1
capabilities: []
tools: []
model_policy: mock
limits:
  max_iterations: 1
  max_cost_micros: "0"
  timeout_seconds: 60
`,
    );
    const untouched = join(root, "external-resource.txt");
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const run = async (args: string[]) => {
      const output = captured();
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        socketPath,
        io: output.io,
      });
      return { ...output, exitCode };
    };
    try {
      await waitForDaemon(socketPath);
      const project = await run(["project:create", "M6A"]);
      const projectId = project.stdout[0]!.replace("Project created: ", "");
      expect((await run(["agent:sync", "--project", projectId])).exitCode).toBe(
        0,
      );
      const agentRows = await run(["agent:list", "--project", projectId]);
      const agentId = agentRows.stdout[1]!.split("\t")[0]!;
      const missingProject = await run(["resource:list"]);
      expect(missingProject.exitCode).toBe(1);
      expect(missingProject.stderr).toEqual([
        "Missing required option --project",
      ]);
      const malformedConfiguration = await run([
        "resource:create",
        "--project",
        projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "fake",
        "--name",
        "Malformed",
        "--configuration",
        "{",
      ]);
      expect(malformedConfiguration.exitCode).toBe(1);
      expect(malformedConfiguration.stderr).toEqual([
        "Option --configuration must be a JSON object",
      ]);
      const credentialSecret = "cli-super-secret";
      const sensitiveConfiguration = await run([
        "resource:create",
        "--project",
        projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "fake",
        "--name",
        "Sensitive",
        "--configuration",
        JSON.stringify({ nested: { credentialRef: credentialSecret } }),
      ]);
      expect(sensitiveConfiguration.exitCode).toBe(1);
      expect(sensitiveConfiguration.stderr.join("\n")).toContain(
        "configuration.nested cannot contain sensitive field credentialRef",
      );
      expect(sensitiveConfiguration.stderr.join("\n")).not.toContain(
        credentialSecret,
      );
      const created = await run([
        "resource:create",
        "--project",
        projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "fake",
        "--name",
        "Fake only",
        "--external-ref",
        untouched,
      ]);
      const resourceId = created.stdout[0]!.replace("Resource created: ", "");
      expect(
        (await run(["resource:list", "--project", projectId])).stdout.join(
          "\n",
        ),
      ).toContain(resourceId);
      const invalidConstraints = await run([
        "capability:grant",
        "--project",
        projectId,
        "--principal-type",
        "agent",
        "--principal",
        agentId,
        "--resource",
        resourceId,
        "--actions",
        "fake.read",
        "--constraints",
        JSON.stringify({ maxPayloadBytes: -1 }),
        "--granted-by",
        "owner",
        "--reason",
        "invalid",
      ]);
      expect(invalidConstraints.exitCode).toBe(1);
      expect(invalidConstraints.stderr).toEqual([
        "maxPayloadBytes must be a non-negative safe integer",
      ]);
      const granted = await run([
        "capability:grant",
        "--project",
        projectId,
        "--principal-type",
        "agent",
        "--principal",
        agentId,
        "--resource",
        resourceId,
        "--actions",
        "fake.read",
        "--granted-by",
        "owner",
        "--reason",
        "daemon round trip",
      ]);
      const grantId = granted.stdout[0]!.replace("Capability granted: ", "");
      expect(
        (await run(["capability:list", "--project", projectId])).stdout.join(
          "\n",
        ),
      ).toContain(grantId);
      const unknownOperation = await run([
        "action:request",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "fake.unknown",
      ]);
      expect(unknownOperation.exitCode).toBe(2);
      expect(unknownOperation.stdout.at(-1)).toBe("Decision: denied");
      expect(unknownOperation.stderr).toEqual([]);
      const pollutedArguments = await run([
        "action:request",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "fake.read",
        "--arguments",
        '{"__proto__":{"polluted":true}}',
      ]);
      expect(pollutedArguments.exitCode).toBe(1);
      expect(pollutedArguments.stderr.join("\n")).toContain(
        "prototype-sensitive keys are forbidden",
      );
      const sensitiveArguments = await run([
        "action:request",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "fake.read",
        "--arguments",
        JSON.stringify({ credentialRef: credentialSecret }),
      ]);
      expect(sensitiveArguments.exitCode).toBe(1);
      expect(sensitiveArguments.stderr.join("\n")).toContain(
        "action arguments cannot contain sensitive field credentialRef",
      );
      expect(sensitiveArguments.stderr.join("\n")).not.toContain(
        credentialSecret,
      );
      const requested = await run([
        "action:request",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "fake.read",
        "--arguments",
        JSON.stringify({ target: untouched }),
      ]);
      expect(requested.stdout).toContain("Decision: allowed");
      const actionId = requested.stdout[0]!.replace("Action request: ", "");
      expect(
        (await run(["action:list", "--project", projectId])).stdout.join("\n"),
      ).toContain(actionId);
      expect(
        (
          await run([
            "action:show",
            "--project",
            projectId,
            "--action",
            actionId,
          ])
        ).stdout[0],
      ).toContain('"payloadHash"');
      expect(
        (
          await run([
            "capability:revoke",
            "--project",
            projectId,
            "--grant",
            grantId,
            "--revoked-by",
            "owner",
          ])
        ).exitCode,
      ).toBe(0);
      const repeatedRevocation = await run([
        "capability:revoke",
        "--project",
        projectId,
        "--grant",
        grantId,
        "--revoked-by",
        "owner",
      ]);
      expect(repeatedRevocation.exitCode).toBe(1);
      expect(repeatedRevocation.stderr).toEqual([
        `Capability grant is already revoked: ${grantId}`,
      ]);
      expect(
        (
          await run([
            "action:request",
            "--project",
            projectId,
            "--agent",
            agentId,
            "--resource",
            resourceId,
            "--operation",
            "fake.read",
          ])
        ).stdout,
      ).toContain("Decision: denied");
      expect(
        (
          await run([
            "resource:disable",
            "--project",
            projectId,
            "--resource",
            resourceId,
          ])
        ).exitCode,
      ).toBe(0);
      const repeatedDisable = await run([
        "resource:disable",
        "--project",
        projectId,
        "--resource",
        resourceId,
      ]);
      expect(repeatedDisable.exitCode).toBe(1);
      expect(repeatedDisable.stderr).toEqual([
        `Resource is already disabled: ${resourceId}`,
      ]);
      expect(existsSync(untouched)).toBe(false);
    } finally {
      controller.abort();
      await running;
    }
    const database = openDatabase(join(root, ".ai-office", "project.sqlite"));
    const auditPayloads = database
      .query<{ event_type: string; payload_json: string }, []>(
        "SELECT event_type, payload_json FROM audit_event",
      )
      .all();
    expect(auditPayloads.map((event) => event.event_type)).toContain(
      "action.requested",
    );
    expect(auditPayloads.map((event) => event.event_type)).toContain(
      "action.authorized",
    );
    expect(
      auditPayloads.some((event) =>
        event.payload_json.includes("cli-super-secret"),
      ),
    ).toBe(false);
    expect(
      auditPayloads.some((event) => event.payload_json.includes(untouched)),
    ).toBe(false);
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM resources
           WHERE configuration_json LIKE '%credential%'
              OR configuration_json LIKE '%secret%'`,
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });
});
