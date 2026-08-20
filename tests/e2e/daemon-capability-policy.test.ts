import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      for (const provider of ["github", "shell"]) {
        const unsupportedProvider = await run([
          "resource:create",
          "--project",
          projectId,
          "--type",
          "filesystem_scope",
          "--provider",
          provider,
          "--name",
          "Unsupported",
        ]);
        expect(unsupportedProvider.exitCode).toBe(1);
        expect(unsupportedProvider.stderr).toEqual([
          `Unsupported connector provider: ${provider}`,
        ]);
      }
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

  test("invokes reads and approved trusted-local mutations through the daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-m6b-daemon-"));
    roots.push(root);
    const agentDirectory = join(root, "agents", "developer");
    const workspace = join(root, "workspace");
    mkdirSync(agentDirectory, { recursive: true });
    mkdirSync(workspace);
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
    writeFileSync(join(workspace, "note.txt"), "literal needle\n");
    writeFileSync(join(workspace, ".env"), "TOKEN=must-not-leak\n");
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
      const project = await run(["project:create", "M6B"]);
      const projectId = project.stdout[0]!.replace("Project created: ", "");
      expect((await run(["agent:sync", "--project", projectId])).exitCode).toBe(
        0,
      );
      const agentId = (
        await run(["agent:list", "--project", projectId])
      ).stdout[1]!.split("\t")[0]!;
      const created = await run([
        "resource:create",
        "--project",
        projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "filesystem",
        "--name",
        "Workspace",
        "--external-ref",
        workspace,
      ]);
      expect(created.exitCode).toBe(0);
      expect(created.stdout.join("\n")).not.toContain(workspace);
      const resourceId = created.stdout[0]!.replace("Resource created: ", "");
      const malformed = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.read",
        "--arguments",
        "{",
      ]);
      expect(malformed).toMatchObject({
        exitCode: 1,
        stderr: ["Option --arguments must be a JSON object"],
      });
      const denied = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.read",
        "--arguments",
        JSON.stringify({ path: "note.txt" }),
      ]);
      expect(denied.exitCode).toBe(2);
      expect(denied.stdout).toContain("Status: denied");
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
        "filesystem.read,filesystem.search,filesystem.create,filesystem.write,filesystem.move,filesystem.delete",
        "--constraints",
        JSON.stringify({ allowMutation: true }),
        "--granted-by",
        "owner",
        "--reason",
        "M6B daemon test",
      ]);
      expect(granted.exitCode).toBe(0);

      const task = await run([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Create an agent artifact",
      ]);
      const taskId = task.stdout[0]!.replace("Task created: ", "");
      const databasePath = join(root, ".ai-office", "project.sqlite");
      const beforeInvalidIntents = openDatabase(databasePath);
      const actionCountBefore = beforeInvalidIntents
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM action_requests",
        )
        .get()!.count;
      const actionAuditCountBefore = beforeInvalidIntents
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM audit_event
           WHERE event_type LIKE 'agent.%' OR event_type LIKE 'action.%'`,
        )
        .get()!.count;
      beforeInvalidIntents.close();

      const sentinel = "SHOULD_NEVER_BE_PERSISTED_123";
      for (const [field, arguments_] of [
        ["token", { token: sentinel }],
        ["credentialRef", { request: { credentialRef: sentinel } }],
        ["api_key", { api_key: sentinel }],
      ] as const) {
        const rejected = await run([
          "run:schedule",
          "--project",
          projectId,
          "--task",
          taskId,
          "--agent",
          agentId,
          "--resource",
          resourceId,
          "--operation",
          "filesystem.create",
          "--arguments",
          JSON.stringify(arguments_),
        ]);
        expect(rejected.exitCode).toBe(1);
        expect(rejected.stderr.join("\n")).toContain(
          `cannot contain sensitive field ${field}`,
        );
        expect(rejected.stderr.join("\n")).not.toContain(sentinel);
      }

      const afterInvalidIntents = openDatabase(databasePath);
      for (const table of ["agent_run", "task_lock", "agent_run_event"])
        expect(
          afterInvalidIntents
            .query<{ count: number }, []>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            )
            .get()!.count,
        ).toBe(0);
      expect(
        afterInvalidIntents
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM action_requests",
          )
          .get()!.count,
      ).toBe(actionCountBefore);
      expect(
        afterInvalidIntents
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM audit_event
             WHERE event_type LIKE 'agent.%' OR event_type LIKE 'action.%'`,
          )
          .get()!.count,
      ).toBe(actionAuditCountBefore);
      expect(
        afterInvalidIntents
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM (
               SELECT action_intent_json AS value FROM agent_run
               UNION ALL SELECT payload_json FROM agent_run_event
               UNION ALL SELECT normalized_arguments_json FROM action_requests
               UNION ALL SELECT payload_json FROM audit_event
             ) WHERE instr(COALESCE(value, ''), ?) > 0`,
          )
          .get(sentinel)!.count,
      ).toBe(0);
      expect(
        afterInvalidIntents.query("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
      expect(
        afterInvalidIntents
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get(),
      ).toEqual({ integrity_check: "ok" });
      afterInvalidIntents.close();

      const scheduled = await run([
        "run:schedule",
        "--project",
        projectId,
        "--task",
        taskId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.create",
        "--arguments",
        JSON.stringify({
          path: "agent-created.txt",
          content: "created through controlled runtime\n",
        }),
      ]);
      expect(scheduled).toMatchObject({ exitCode: 0, stderr: [] });
      const runId = scheduled.stdout[0]!.replace("Agent run scheduled: ", "");
      const ticked = await run([
        "run:tick",
        "--project",
        projectId,
        "--capacity",
        "1",
      ]);
      expect(ticked).toMatchObject({ exitCode: 0, stderr: [] });
      const actionLine = ticked.stdout.find((line) =>
        line.startsWith(`Run ${runId} action: `),
      );
      expect(actionLine).toContain("(approval_pending)");
      const runActionId = actionLine!
        .replace(`Run ${runId} action: `, "")
        .replace(" (approval_pending)", "");
      const shownRun = await run([
        "run:show",
        "--project",
        projectId,
        "--run",
        runId,
      ]);
      expect(shownRun.stdout.join("\n")).toContain(runActionId);
      expect(shownRun.stdout.join("\n")).not.toContain(
        "created through controlled runtime",
      );
      expect(existsSync(join(workspace, "agent-created.txt"))).toBe(false);
      expect(
        (
          await run([
            "action:approve",
            "--project",
            projectId,
            "--action",
            runActionId,
            "--actor",
            "local-user",
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run([
            "action:execute",
            "--project",
            projectId,
            "--action",
            runActionId,
          ])
        ).exitCode,
      ).toBe(0);
      expect(readFileSync(join(workspace, "agent-created.txt"), "utf8")).toBe(
        "created through controlled runtime\n",
      );

      const authorizedRead = await run([
        "action:request",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.read",
        "--arguments",
        JSON.stringify({ path: "note.txt" }),
      ]);
      expect(authorizedRead.stdout).toContain("Decision: allowed");
      const authorizedReadId = authorizedRead.stdout[0]!.replace(
        "Action request: ",
        "",
      );
      const read = await run([
        "action:invoke",
        "--project",
        projectId,
        "--action",
        authorizedReadId,
      ]);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("Status: completed");
      expect(read.stdout.join("\n")).toContain("literal needle");
      expect(read.stdout.join("\n")).not.toContain(workspace);
      const repeatedRead = await run([
        "action:invoke",
        "--project",
        projectId,
        "--action",
        authorizedReadId,
      ]);
      expect(repeatedRead.exitCode).toBe(1);
      expect(repeatedRead.stderr).toEqual([
        "Action request must be authorized before invocation: completed",
      ]);
      const search = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.search",
        "--arguments",
        JSON.stringify({ query: "needle" }),
      ]);
      expect(search.stderr).toEqual([]);
      expect(search.exitCode).toBe(0);
      expect(search.stdout.join("\n")).toContain('"line":1');
      const secret = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.read",
        "--arguments",
        JSON.stringify({ path: ".env" }),
      ]);
      expect(secret.exitCode).toBe(1);
      expect(secret.stderr).toEqual(["Filesystem path is unavailable"]);
      expect(secret.stderr.join("\n")).not.toContain(".env");
      expect(secret.stderr.join("\n")).not.toContain("must-not-leak");
      const mutationSecret = "mutation-content-must-not-leak";
      const failedMutation = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.write",
        "--arguments",
        JSON.stringify({ path: "missing.txt", content: mutationSecret }),
      ]);
      expect(failedMutation.exitCode).toBe(1);
      expect(failedMutation.stderr).toEqual([
        "Filesystem entry is unavailable",
      ]);
      expect(failedMutation.stderr.join("\n")).not.toContain(mutationSecret);
      const simulation = await run([
        "action:invoke",
        "--project",
        projectId,
        "--agent",
        agentId,
        "--resource",
        resourceId,
        "--operation",
        "filesystem.write",
        "--arguments",
        JSON.stringify({ path: "note.txt", content: "changed\n" }),
      ]);
      expect(simulation.exitCode).toBe(0);
      expect(simulation.stdout).toContain("Status: approval_pending");
      expect(simulation.stdout.join("\n")).toContain("artifactSha256");
      expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe(
        "literal needle\n",
      );
      const actionId = simulation.stdout[0]!.replace("Action request: ", "");
      const shown = await run([
        "action:show",
        "--project",
        projectId,
        "--action",
        actionId,
      ]);
      expect(shown.stdout.join("\n")).toContain('"content":"[REDACTED]"');
      expect(shown.stdout.join("\n")).not.toContain('"content":"changed');
      expect(shown.stdout.join("\n")).toContain('"status":"pending"');
      const approved = await run([
        "action:approve",
        "--project",
        projectId,
        "--action",
        actionId,
        "--actor",
        "local-user",
      ]);
      expect(approved).toMatchObject({ exitCode: 0, stderr: [] });
      expect(approved.stdout).toContain("Approval: approved");
      const executed = await run([
        "action:execute",
        "--project",
        projectId,
        "--action",
        actionId,
      ]);
      expect(executed).toMatchObject({ exitCode: 0, stderr: [] });
      expect(executed.stdout).toContain("Status: completed");
      expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe(
        "changed\n",
      );
      const replay = await run([
        "action:execute",
        "--project",
        projectId,
        "--action",
        actionId,
      ]);
      expect(replay.exitCode).toBe(1);
      expect(replay.stderr).toEqual(["Action request is not executable"]);

      const invokeApproveExecute = async (
        operation: string,
        arguments_: Readonly<Record<string, unknown>>,
      ) => {
        const invoked = await run([
          "action:invoke",
          "--project",
          projectId,
          "--agent",
          agentId,
          "--resource",
          resourceId,
          "--operation",
          operation,
          "--arguments",
          JSON.stringify(arguments_),
        ]);
        expect(invoked.exitCode).toBe(0);
        expect(invoked.stdout).toContain("Status: approval_pending");
        const id = invoked.stdout[0]!.replace("Action request: ", "");
        expect(
          (
            await run([
              "action:approve",
              "--project",
              projectId,
              "--action",
              id,
              "--actor",
              "local-user",
            ])
          ).exitCode,
        ).toBe(0);
        const executedAction = await run([
          "action:execute",
          "--project",
          projectId,
          "--action",
          id,
        ]);
        expect(executedAction.exitCode).toBe(0);
        expect(executedAction.stdout).toContain("Status: completed");
      };

      await invokeApproveExecute("filesystem.create", {
        path: "created.txt",
        content: "created\n",
      });
      expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe(
        "created\n",
      );
      await invokeApproveExecute("filesystem.move", {
        sourcePath: "created.txt",
        destinationPath: "moved.txt",
      });
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(readFileSync(join(workspace, "moved.txt"), "utf8")).toBe(
        "created\n",
      );
      await invokeApproveExecute("filesystem.delete", { path: "moved.txt" });
      expect(existsSync(join(workspace, "moved.txt"))).toBe(false);
    } finally {
      controller.abort();
      await running;
    }
    const database = openDatabase(join(root, ".ai-office", "project.sqlite"));
    const audit = database
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM audit_event",
      )
      .all()
      .map((row) => row.payload_json)
      .join("\n");
    expect(audit).not.toContain("literal needle");
    expect(audit).not.toContain("must-not-leak");
    expect(audit).not.toContain("mutation-content-must-not-leak");
    expect(audit).not.toContain("changed\\n");
    expect(audit).not.toContain(workspace);
    const events = database
      .query<{ event_type: string }, []>(
        `SELECT event_type FROM audit_event
         WHERE event_type LIKE 'action_%'
         ORDER BY occurred_at, id`,
      )
      .all()
      .map((row) => row.event_type);
    expect(events).toEqual(
      expect.arrayContaining([
        "action_approval_requested",
        "action_approved",
        "action_execution_started",
        "action_execution_completed",
      ]),
    );
    database.close();
  });
});
