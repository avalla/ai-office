import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import { buildProjectInstructionContract } from "@ai-office/application/project-lifecycle/build-project-instructions.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  chmodSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli, runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import {
  DaemonClient,
  RuntimeUnavailableError,
} from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import type { RuntimeClient } from "@ai-office/application/runtime/runtime-client.port.ts";

const temporaryDirectories: string[] = [];

function captureIo(answers: string[] = []): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
  prompts: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async (message) => {
        prompts.push(message);
        return answers.shift() ?? "";
      },
    },
    stdout,
    stderr,
    prompts,
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
  throw new Error("Daemon did not become healthy");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installedRepository(prefix: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(projectRoot);
  mkdirSync(join(projectRoot, "runtime"));
  mkdirSync(join(projectRoot, ".ai-office"));
  writeFileSync(
    join(projectRoot, ".ai-office", "project.json"),
    JSON.stringify({
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: "repo_offline-status-test",
    }),
  );
  return projectRoot;
}

function offlineRuntimePaths(projectRoot: string) {
  const runtimeHome = join(projectRoot, "runtime");
  if (!existsSync(runtimeHome)) mkdirSync(runtimeHome);
  return resolveRuntimePaths({ mode: "user", runtimeHome });
}

async function cleanLocalIntegration(
  projectRoot: string,
): Promise<DefaultAgentClientCatalog> {
  const bin = join(projectRoot, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  const catalog = new DefaultAgentClientCatalog({ pathValue: bin });
  const service = new ManageAgentClientIntegration(catalog);
  const manifest = parseOfficeManifestJson(
    readFileSync(
      new URL(
        "../../.agents/skills/ai-office/assets/default-office-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const input = {
    clientId: "codex" as const,
    rootPath: projectRoot,
    contract: buildProjectInstructionContract({
      projectName: "Offline fixture",
      manifest,
    }),
  };
  const plan = await service.plan(input);
  await service.apply({ ...input, approvedPlanHash: plan.planHash });
  return catalog;
}

/**
 * A Runtime client that counts every crossing of the client boundary, so a
 * test can prove an offline path made no request at all rather than only
 * checking what the request returned.
 */
function rejectingRuntimeClient(failure?: () => Error): {
  client: RuntimeClient;
  readonly healthCalls: number;
  readonly executeCalls: number;
} {
  let healthCalls = 0;
  let executeCalls = 0;
  const fail = failure ?? (() => new Error("unexpected Runtime request"));
  return {
    client: {
      health: async () => {
        healthCalls += 1;
        throw fail();
      },
      execute: async () => {
        executeCalls += 1;
        throw fail();
      },
    },
    get healthCalls() {
      return healthCalls;
    },
    get executeCalls() {
      return executeCalls;
    },
  };
}

describe("CLI to daemon end-to-end", () => {
  test("runs persisted project commands through the socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-cli-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Existing project");
    writeFileSync(join(projectRoot, "index.ts"), "export const value = 1;");
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({
        name: "existing",
        devDependencies: { vitest: "latest" },
      }),
    );
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const socketPath = socket.socketPath;
    const daemon = await bootstrap({
      projectRoot,
      socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const healthOutput = captureIo();
      expect(
        await runDaemonCli(["daemon:health"], {
          projectRoot,
          socketPath,
          io: healthOutput.io,
        }),
      ).toBe(0);
      expect(healthOutput.stdout[0]).toBe("Daemon status: ok");

      const runtimeHealthOutput = captureIo();
      expect(
        await runRuntimeCli(["runtime", "status"], {
          projectRoot,
          socketPath,
          io: runtimeHealthOutput.io,
        }),
      ).toBe(0);
      expect(runtimeHealthOutput.stdout[0]).toBe("Runtime status: ok");

      const importOutput = captureIo();
      expect(
        await runDaemonCli(["project:import", "."], {
          projectRoot,
          socketPath,
          io: importOutput.io,
        }),
      ).toBe(0);
      const projectId =
        importOutput.stdout[0]?.replace("Project imported: ", "") ?? "";

      const profileOutput = captureIo();
      expect(
        await runDaemonCli(["project:profile", "--project", projectId], {
          projectRoot,
          socketPath,
          io: profileOutput.io,
        }),
      ).toBe(0);
      expect(profileOutput.stdout[0]).toContain("TypeScript");
      expect(profileOutput.stderr).toEqual([]);

      const invoke = async (args: string[]) => {
        const output = captureIo();
        const code = await runDaemonCli(args, {
          projectRoot,
          socketPath,
          io: output.io,
        });
        return { code, ...output };
      };
      const prerequisite = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Prerequisite",
      ]);
      const dependent = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Dependent",
      ]);
      expect(prerequisite.code).toBe(0);
      expect(dependent.code).toBe(0);
      const prerequisiteId = prerequisite.stdout[0]!.replace(
        "Task created: ",
        "",
      );
      const dependentId = dependent.stdout[0]!.replace("Task created: ", "");
      expect(
        (
          await invoke([
            "task:dependency:add",
            "--project",
            projectId,
            "--task",
            dependentId,
            "--depends-on",
            prerequisiteId,
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await invoke([
            "task:start",
            "--project",
            projectId,
            "--task",
            prerequisiteId,
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await invoke([
            "task:submit-review",
            "--project",
            projectId,
            "--task",
            prerequisiteId,
          ])
        ).code,
      ).toBe(0);
      const readiness = await invoke([
        "task:readiness",
        "--project",
        projectId,
        "--task",
        dependentId,
        "--json",
      ]);
      expect(readiness.code).toBe(0);
      expect(JSON.parse(readiness.stdout[0]!)).toMatchObject({
        runnable: true,
        blockedBy: [],
      });
      expect(
        (
          await invoke([
            "task:start",
            "--project",
            projectId,
            "--task",
            dependentId,
          ])
        ).stdout[0],
      ).toBe(`Task ${dependentId} is now running`);
    } finally {
      controller.abort();
      await running;
    }
  });

  test("uses model override scope for project autodiscovery", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-model-cli-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "model-routing-cli-fixture" }),
    );
    writeFileSync(join(projectRoot, "index.ts"), "export const value = 1;\n");
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const installed = await invoke(["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.code);
      const projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;
      const routingFile = join(projectRoot, ".ai-office", "model-routing.yaml");
      writeFileSync(
        routingFile,
        `schema_version: 1
default_profile: balanced
profiles:
  balanced: { model: "openai:test-model" }
`,
      );

      const host = await invoke([
        "model:override",
        "--scope",
        "host",
        "--agent",
        "architect",
        "--model",
        "openai:host-model",
        "--json",
      ]);
      expect(host.code).toBe(0);
      expect(JSON.parse(host.stdout[0]!)).toMatchObject({
        scope: "host",
        reloaded: true,
      });

      const discoveredProject = await invoke([
        "model:override",
        "--scope",
        "project",
        "--agent",
        "architect",
        "--model",
        "openai:project-model",
        "--json",
      ]);
      expect(discoveredProject.code).toBe(0);
      expect(JSON.parse(discoveredProject.stdout[0]!)).toMatchObject({
        scope: "project",
        projectId,
        reloaded: true,
      });

      const explicitProject = await invoke([
        "model:override",
        "--scope",
        "project",
        "--project",
        projectId,
        "--agent",
        "architect",
        "--model",
        "openai:explicit-model",
        "--json",
      ]);
      expect(explicitProject.code).toBe(0);
      expect(JSON.parse(explicitProject.stdout[0]!)).toMatchObject({
        scope: "project",
        projectId,
        reloaded: true,
      });

      const invalidHost = await invoke([
        "model:override",
        "--scope",
        "host",
        "--project",
        projectId,
        "--agent",
        "architect",
        "--model",
        "openai:invalid-host-project",
      ]);
      expect(invalidHost.code).toBe(1);
      expect(invalidHost.stderr.join("\n")).toContain(
        "--project is only valid with project scope",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("discovers the bound project for task dependency commands over the socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-task-deps-cli-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Dependencies\n");
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };

    try {
      await waitForDaemon(socket.socketPath);
      const installed = await invoke(["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.code);
      const projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;
      const created = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Dependent",
      ]);
      const prerequisite = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Prerequisite",
      ]);
      expect(created.code).toBe(0);
      expect(prerequisite.code).toBe(0);
      const taskId = created.stdout[0]!.replace("Task created: ", "");
      const prerequisiteId = prerequisite.stdout[0]!.replace(
        "Task created: ",
        "",
      );

      const added = await invoke([
        "task:dependency:add",
        "--task",
        taskId,
        "--depends-on",
        prerequisiteId,
        "--json",
      ]);
      expect(added.code).toBe(0);
      expect(JSON.parse(added.stdout[0]!)).toMatchObject({ created: true });

      const readiness = await invoke([
        "task:readiness",
        "--task",
        taskId,
        "--json",
      ]);
      expect(readiness.code).toBe(0);
      expect(JSON.parse(readiness.stdout[0]!)).toMatchObject({
        taskId,
        runnable: false,
        blockedBy: [{ taskId: prerequisiteId, status: "pending" }],
      });

      const removed = await invoke([
        "task:dependency:remove",
        "--task",
        taskId,
        "--depends-on",
        prerequisiteId,
        "--json",
      ]);
      expect(removed.code).toBe(0);
      expect(JSON.parse(removed.stdout[0]!)).toMatchObject({ removed: true });
    } finally {
      controller.abort();
      await running;
    }
  });

  test("persists and resolves task-delivery setup over the socket with project autodiscovery", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-delivery-setup-cli-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Setup\n");
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };

    try {
      await waitForDaemon(socket.socketPath);
      const installed = await invoke(["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.code);

      // Without --project the bound checkout supplies the project id.
      const set = await invoke([
        "delivery:setup:set",
        "--key",
        "checkpointFrequency",
        "--value",
        '"stage-boundaries"',
      ]);
      expect(set.code).toBe(0);
      expect(JSON.parse(set.stdout[0]!)).toMatchObject({
        schemaVersion: 1,
        key: "checkpointFrequency",
        value: "stage-boundaries",
        scope: "project",
      });
      expect(set.stderr).toEqual([]);

      const numberSet = await invoke([
        "delivery:setup:set",
        "--key",
        "contextThreshold",
        "--value",
        "0.5",
      ]);
      expect(numberSet.code).toBe(0);

      const taskSet = await invoke([
        "delivery:setup:set",
        "--task",
        "task-1",
        "--key",
        "resumeDetail",
        "--value",
        '"full"',
      ]);
      expect(taskSet.code).toBe(0);

      const show = await invoke(["delivery:setup:show"]);
      expect(show.code).toBe(0);
      expect(JSON.parse(show.stdout[0]!)).toEqual({
        schemaVersion: 1,
        source: "runtime",
        project: {
          checkpointFrequency: "stage-boundaries",
          contextThreshold: 0.5,
        },
        overrides: [],
      });

      const taskShow = await invoke([
        "delivery:setup:show",
        "--task",
        "task-1",
      ]);
      expect(taskShow.code).toBe(0);
      expect(JSON.parse(taskShow.stdout[0]!)).toMatchObject({
        overrides: [
          {
            scope: "task",
            scopeRef: "task-1",
            key: "resumeDetail",
            value: "full",
          },
        ],
      });

      const deleted = await invoke([
        "delivery:setup:set",
        "--key",
        "contextThreshold",
        "--value",
        "null",
      ]);
      expect(deleted.code).toBe(0);
      expect(JSON.parse(deleted.stdout[0]!)).toMatchObject({
        key: "contextThreshold",
        value: null,
      });
      const afterDelete = await invoke(["delivery:setup:show"]);
      expect(JSON.parse(afterDelete.stdout[0]!)).toMatchObject({
        project: { checkpointFrequency: "stage-boundaries" },
      });

      const invalid = await invoke([
        "delivery:setup:set",
        "--key",
        "checkpointFrequency",
        "--value",
        '"whenever"',
      ]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr.join("\n")).toContain(
        "Invalid value for setup key checkpointFrequency",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("delivery:setup commands never fall back to a local writer when the Runtime is unavailable", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-setup-offline-"));
    temporaryDirectories.push(projectRoot);
    const runtimeHome = join(projectRoot, "runtime");
    mkdirSync(runtimeHome);
    const runtimePaths = resolveRuntimePaths({
      mode: "user",
      runtimeHome,
    });
    let executeAttempts = 0;
    const unavailableRuntime: RuntimeClient = {
      health: async () => {
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
      execute: async () => {
        executeAttempts += 1;
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
    };
    const output = captureIo();

    expect(
      await runRuntimeCli(
        ["delivery:setup:set", "--project", "p", "--key", "handoffMode", "--value", '"gate"'],
        {
          projectRoot,
          runtimePaths,
          runtimeClient: unavailableRuntime,
          io: output.io,
        },
      ),
    ).toBe(1);
    expect(executeAttempts).toBe(1);
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
    expect(output.stderr).toEqual([
      expect.stringContaining("AI Office Runtime is not available"),
    ]);
  });

  test("definition preview and apply reject pack collisions and U+0000 over the socket without writing", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-definition-collision-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const bytes = readFileSync(
      new URL("../fixtures/domain-pack/legal.json", import.meta.url),
    );
    const pack = installedPacks.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: "bundled/legal",
      },
    });
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Collision fixture"]);
      expect(created.code).toBe(0);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([pack]),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).code,
      ).toBe(0);
      const definition = (
        command: "preview" | "apply",
        id: string,
        title?: string,
      ) =>
        invoke([
          `project:definition:${command}`,
          "--project",
          projectId,
          "--mutation",
          JSON.stringify({
            action: "put_owned",
            kind: "roles",
            id,
            enabled: true,
            payload: { id, ...(title === undefined ? {} : { title }) },
          }),
          ...(command === "apply" ? ["--expected-revision", "0"] : []),
          "--json",
        ]);
      const collision =
        "Project definition roles/counsel collides with pack org.example.legal@1.0.0 in the resolved pack closure";

      const preview = await definition("preview", "counsel");
      expect(preview.code).toBe(1);
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        current: { revision: 0 },
        issues: [{ code: "pack_definition_collision", message: collision }],
      });
      const applied = await definition("apply", "counsel");
      expect(applied.code).toBe(1);
      expect(applied.stdout).toEqual([]);
      expect(applied.stderr).toEqual([collision]);

      for (const command of ["preview", "apply"] as const) {
        const rejected = await definition(command, "custom", "a\u0000");
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toEqual([]);
        expect(rejected.stderr).toEqual(["title must be bounded text"]);
      }

      const shown = await invoke([
        "project:definition:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
        state: { revision: 0, owned: [], overrides: [] },
        issues: [],
      });
      // The same identity under different case is a distinct definition.
      expect((await definition("apply", "Counsel", "😀")).code).toBe(0);
      const resolved = await invoke([
        "project:configuration:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(resolved.code).toBe(0);
      expect(JSON.parse(resolved.stdout[0]!)).toMatchObject({
        ok: true,
        configuration: {
          projectOwnedDefinitions: [
            { effectiveId: "project:roles/Counsel", payload: { title: "😀" } },
          ],
        },
      });
    } finally {
      controller.abort();
      await running;
    }
  });

  test("previews, blocks and applies a pack upgrade over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-pack-upgrade-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const template = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/custom.json", import.meta.url),
      ),
    );
    const register = (version: string, roles: { id: string }[]) => {
      const manifest = {
        ...template,
        version,
        contributions: { ...template.contributions, roles },
      } as unknown as typeof template;
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...manifest,
          manifestDigest: computeManifestDigest(manifest),
        }),
      );
      return installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: "local-distribution",
          reference: `bundled/custom-${version}`,
        },
      });
    };
    const v1 = register("1.0.0", [{ id: "counsel" }, { id: "paralegal" }]);
    const v2 = register("2.0.0", [{ id: "counsel" }]);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Upgrade fixture"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
          ])
        ).code,
      ).toBe(0);
      for (const [revision, localId] of [
        [0, "counsel"],
        [1, "paralegal"],
      ] as const)
        expect(
          (
            await invoke([
              "project:definition:apply",
              "--project",
              projectId,
              "--mutation",
              JSON.stringify({
                action: "put_override",
                source: { ...v1, kind: "roles", localId },
                operation: "replace",
                payload: { id: localId, title: `Our ${localId}` },
              }),
              "--expected-revision",
              String(revision),
            ])
          ).code,
        ).toBe(0);
      const upgrade = (...extra: string[]) =>
        invoke([
          "project:pack:upgrade",
          "--project",
          projectId,
          "--packs",
          JSON.stringify([v2]),
          ...extra,
          "--json",
        ]);

      const blocked = await upgrade();
      expect(blocked.code).toBe(1);
      const blockedPlan = JSON.parse(blocked.stdout[0]!) as {
        planDigest: string;
      };
      expect(blockedPlan).toMatchObject({
        noop: false,
        issues: [
          {
            code: "unresolved_override_conflict",
            detail: "source_definition_removed",
          },
        ],
      });
      const refused = await upgrade("--approve", blockedPlan.planDigest);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toEqual([]);
      expect(refused.stderr).toEqual([
        `Pack upgrade is blocked: Override of org.example.custom@1.0.0 roles/paralegal needs an explicit resolution`,
      ]);

      const resolutions = JSON.stringify([
        {
          source: { ...v1, kind: "roles", localId: "paralegal" },
          action: "retain_as_project_owned",
        },
      ]);
      const preview = await upgrade("--resolutions", resolutions);
      expect(preview.code).toBe(0);
      const plan = JSON.parse(preview.stdout[0]!) as {
        planDigest: string;
        prospectiveConfigurationDigest: string;
      };
      expect(plan).toMatchObject({
        issues: [],
        overrides: [
          { outcome: "retargeted", target: { version: "2.0.0" } },
          { outcome: "retained_as_project_owned" },
        ],
      });
      expect(JSON.stringify(plan)).not.toContain("Our counsel");

      const unapproved = await upgrade(
        "--resolutions",
        resolutions,
        "--approve",
        blockedPlan.planDigest,
      );
      expect(unapproved.code).toBe(1);
      expect(unapproved.stderr).toEqual([
        "The approved digest does not match the current upgrade plan; preview it again",
      ]);
      expect((await upgrade("--resolutions", "not json")).stderr[0]).toContain(
        "--resolutions must be a JSON array",
      );

      const applied = await upgrade(
        "--resolutions",
        resolutions,
        "--approve",
        plan.planDigest,
      );
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toEqual({
        result: "applied",
        planDigest: plan.planDigest,
        bindingRevision: 2,
        definitionRevision: 3,
        packs: [v2],
      });
      const repeated = await upgrade(
        "--resolutions",
        resolutions,
        "--approve",
        plan.planDigest,
      );
      expect(repeated.code).toBe(0);
      expect(JSON.parse(repeated.stdout[0]!)).toMatchObject({
        result: "unchanged",
        bindingRevision: 2,
        definitionRevision: 3,
      });

      const resolved = await invoke([
        "project:configuration:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(resolved.code).toBe(0);
      expect(JSON.parse(resolved.stdout[0]!)).toMatchObject({
        ok: true,
        configuration: {
          configurationDigest: plan.prospectiveConfigurationDigest,
          selectedPacks: [v2],
          projectOwnedDefinitions: [
            {
              effectiveId: "project:roles/paralegal",
              payload: { title: "Our paralegal" },
            },
          ],
        },
      });
    } finally {
      controller.abort();
      await running;
    }
  });

  test("omits a role, approves a capability change and converts an extension over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-role-archetype-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const template = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/custom.json", import.meta.url),
      ),
    );
    const register = (version: string, roles: object[]) => {
      const manifest = {
        ...template,
        version,
        contributions: {
          ...template.contributions,
          roles,
          capabilities: [{ id: "draft" }, { id: "review" }, { id: "sign" }],
        },
      } as unknown as typeof template;
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...manifest,
          manifestDigest: computeManifestDigest(manifest),
        }),
      );
      return installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: "local-distribution",
          reference: `bundled/custom-${version}`,
        },
      });
    };
    const v1 = register("1.0.0", [
      { id: "counsel", title: "Counsel", capabilities: ["review", "draft"] },
      { id: "clerk", capabilities: ["draft"] },
      { id: "paralegal" },
    ]);
    // counsel gains `sign`, clerk changes, paralegal gains a title.
    const v2 = register("2.0.0", [
      {
        id: "counsel",
        title: "Counsel",
        capabilities: ["sign", "review", "draft"],
      },
      { id: "clerk", title: "Clerk", capabilities: ["draft"] },
      { id: "paralegal", title: "Paralegal", description: "Assists" },
    ]);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Role fixture"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
          ])
        ).code,
      ).toBe(0);
      const define = (revision: number, mutation: object) =>
        invoke([
          "project:definition:apply",
          "--project",
          projectId,
          "--mutation",
          JSON.stringify(mutation),
          "--expected-revision",
          String(revision),
        ]);
      const source = (pack: typeof v1, localId: string) => ({
        ...pack,
        kind: "roles",
        localId,
      });
      // A project payload cannot carry capabilities.
      const refused = await define(0, {
        action: "put_override",
        source: source(v1, "counsel"),
        operation: "replace",
        payload: { id: "counsel", capabilities: ["sign"] },
      });
      expect(refused.code).toBe(1);
      expect(
        (
          await define(0, {
            action: "put_override",
            source: source(v1, "clerk"),
            operation: "disable",
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(1, {
            action: "put_override",
            source: source(v1, "paralegal"),
            operation: "extend",
            payload: { title: "Our paralegal" },
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(2, {
            action: "put_owned",
            kind: "roles",
            id: "liaison",
            enabled: true,
            payload: { id: "liaison", title: "Liaison" },
          })
        ).code,
      ).toBe(0);
      const show = async () =>
        JSON.parse(
          (
            await invoke([
              "project:configuration:show",
              "--project",
              projectId,
              "--json",
            ])
          ).stdout[0]!,
        ) as {
          ok: boolean;
          configuration: {
            configurationDigest: string;
            roles: { roleId: string }[];
            omittedRoles: string[];
          };
        };
      const before = await show();
      expect(before.configuration.omittedRoles).toEqual([
        "pack:org.example.custom/roles/clerk",
      ]);

      // A capability change cannot slip through the plain selection command.
      const direct = await invoke([
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([v2]),
        "--expected-revision",
        "1",
      ]);
      expect(direct.code).toBe(1);
      expect(direct.stdout).toEqual([]);
      expect(direct.stderr).toEqual([
        "The selection changes the capabilities of role pack:org.example.custom/roles/counsel; review and approve it with project:pack:upgrade",
      ]);
      const directPreview = await invoke([
        "project:pack:preview",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([v2]),
        "--json",
      ]);
      expect(directPreview.code).toBe(1);
      expect(JSON.parse(directPreview.stdout[0]!)).toMatchObject({
        roleCapabilityChanges: {
          availability: "available",
          changes: [
            {
              roleId: "pack:org.example.custom/roles/counsel",
              added: ["sign"],
              removed: [],
            },
          ],
        },
        issues: [{ code: "role_capability_change_requires_upgrade" }],
      });
      expect((await show()).configuration).toEqual(before.configuration);

      const upgrade = (...extra: string[]) =>
        invoke([
          "project:pack:upgrade",
          "--project",
          projectId,
          "--packs",
          JSON.stringify([v2]),
          ...extra,
          "--json",
        ]);
      const blocked = await upgrade();
      expect(blocked.code).toBe(1);
      expect(JSON.parse(blocked.stdout[0]!)).toMatchObject({
        issues: [
          { code: "unresolved_override_conflict", detail: "extend_conflict" },
        ],
      });
      const resolutions = JSON.stringify([
        { source: source(v1, "paralegal"), action: "convert_to_replace" },
      ]);
      const preview = await upgrade("--resolutions", resolutions);
      expect(preview.code).toBe(0);
      const plan = JSON.parse(preview.stdout[0]!) as {
        planDigest: string;
        prospectiveConfigurationDigest: string;
      };
      expect(plan).toMatchObject({
        issues: [],
        overrides: [
          { operation: "disable", outcome: "retargeted", upstream: "changed" },
          { operation: "extend", outcome: "converted_to_replace" },
        ],
        roleCapabilityChanges: {
          availability: "available",
          changes: [
            {
              roleId: "pack:org.example.custom/roles/counsel",
              added: ["sign"],
              removed: [],
              customized: false,
            },
          ],
        },
        targetRoleCapabilities: [
          {
            roleId: "pack:org.example.custom/roles/clerk",
            capabilities: ["draft"],
          },
          {
            roleId: "pack:org.example.custom/roles/counsel",
            capabilities: ["draft", "review", "sign"],
          },
        ],
      });
      expect(JSON.stringify(plan)).not.toContain("Our paralegal");
      const applied = await upgrade(
        "--resolutions",
        resolutions,
        "--approve",
        plan.planDigest,
      );
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        result: "applied",
        bindingRevision: 2,
        definitionRevision: 4,
        packs: [v2],
      });

      const after = await show();
      expect(after).toEqual({
        ok: true,
        configuration: expect.objectContaining({
          configurationDigest: plan.prospectiveConfigurationDigest,
          selectedPacks: [v2],
          roles: [
            {
              roleId: "pack:org.example.custom/roles/counsel",
              effectiveId: `pack:org.example.custom@2.0.0#${v2.manifestDigest}/roles/counsel`,
              origin: "pack_owned",
              title: "Counsel",
              capabilities: [
                "pack:org.example.custom/capabilities/draft",
                "pack:org.example.custom/capabilities/review",
                "pack:org.example.custom/capabilities/sign",
              ],
              customization: "none",
            },
            {
              roleId: "pack:org.example.custom/roles/paralegal",
              effectiveId: `pack:org.example.custom@2.0.0#${v2.manifestDigest}/roles/paralegal`,
              origin: "pack_owned",
              title: "Our paralegal",
              description: "Assists",
              capabilities: [],
              customization: "replace",
            },
            {
              roleId: "project:roles/liaison",
              effectiveId: "project:roles/liaison",
              origin: "project_owned",
              title: "Liaison",
              capabilities: [],
              customization: "none",
            },
          ],
          omittedRoles: ["pack:org.example.custom/roles/clerk"],
        }) as unknown,
      });
      // Stable identities are the same before and after the upgrade.
      expect(after.configuration.roles.map((role) => role.roleId)).toEqual(
        before.configuration.roles.map((role) => role.roleId),
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("replaces and disables pack agents, upgrades and shows the agent view over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-agent-archetype-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const template = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/custom.json", import.meta.url),
      ),
    );
    const register = (version: string, roles: object[], agents: object[]) => {
      const manifest = {
        ...template,
        version,
        contributions: {
          ...template.contributions,
          roles,
          agents,
          prompts: [{ id: "brief" }, { id: "tone" }],
          knowledge: [{ id: "statutes" }],
          capabilities: [{ id: "draft" }, { id: "review" }, { id: "sign" }],
        },
      } as unknown as typeof template;
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...manifest,
          manifestDigest: computeManifestDigest(manifest),
        }),
      );
      return installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: "local-distribution",
          reference: `bundled/custom-${version}`,
        },
      });
    };
    const roles = [
      { id: "counsel", capabilities: ["draft", "review"] },
      { id: "clerk", capabilities: ["draft"] },
    ];
    const v1 = register("1.0.0", roles, [
      {
        id: "drafter",
        role: "counsel",
        prompts: ["brief"],
        capabilities: ["draft"],
      },
      { id: "filer", role: "clerk" },
      { id: "researcher", knowledge: ["statutes"] },
    ]);
    // Same role sets; the drafter and the filer change.
    const v2 = register("2.0.0", roles, [
      {
        id: "drafter",
        title: "Drafter",
        role: "counsel",
        prompts: ["brief", "tone"],
        capabilities: ["draft", "review"],
      },
      { id: "filer", title: "Filer", role: "clerk", capabilities: ["draft"] },
      { id: "researcher", knowledge: ["statutes"] },
    ]);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Agent fixture"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
          ])
        ).code,
      ).toBe(0);
      const define = (revision: number, mutation: object) =>
        invoke([
          "project:definition:apply",
          "--project",
          projectId,
          "--mutation",
          JSON.stringify(mutation),
          "--expected-revision",
          String(revision),
        ]);
      const source = (pack: typeof v1, localId: string) => ({
        ...pack,
        kind: "agents",
        localId,
      });
      // A request beyond the role's declared set is refused before storage.
      const exceeding = {
        action: "put_override",
        source: source(v1, "drafter"),
        operation: "replace",
        payload: { id: "drafter", role: "clerk", capabilities: ["review"] },
      };
      const previewed = await invoke([
        "project:definition:preview",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify(exceeding),
        "--json",
      ]);
      expect(previewed.code).toBe(1);
      expect(JSON.parse(previewed.stdout[0]!)).toMatchObject({
        issues: [{ code: "agent_capability_exceeds_role" }],
      });
      expect((await define(0, exceeding)).code).toBe(1);
      // Replace the drafter's name, role, prompts and requested capabilities.
      expect(
        (
          await define(0, {
            action: "put_override",
            source: source(v1, "drafter"),
            operation: "replace",
            payload: {
              id: "drafter",
              title: "Our drafter",
              role: "clerk",
              prompts: ["tone"],
              capabilities: ["draft"],
            },
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(1, {
            action: "put_override",
            source: source(v1, "filer"),
            operation: "disable",
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(2, {
            action: "put_owned",
            kind: "roles",
            id: "liaison",
            enabled: true,
            payload: { id: "liaison" },
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(3, {
            action: "put_owned",
            kind: "agents",
            id: "helper",
            enabled: true,
            payload: { id: "helper", title: "Helper", role: "liaison" },
          })
        ).code,
      ).toBe(0);
      const show = async () =>
        JSON.parse(
          (
            await invoke([
              "project:configuration:show",
              "--project",
              projectId,
              "--json",
            ])
          ).stdout[0]!,
        ) as {
          ok: boolean;
          configuration: {
            configurationDigest: string;
            agents: { agentId: string; effectiveId: string }[];
            disabledAgents: string[];
          };
        };
      const before = await show();
      const stable = (kind: string, localId: string) =>
        `pack:org.example.custom/${kind}/${localId}`;
      const drafter = {
        agentId: stable("agents", "drafter"),
        origin: "pack_owned",
        title: "Our drafter",
        roleId: stable("roles", "clerk"),
        prompts: [stable("prompts", "tone")],
        knowledge: [],
        capabilities: [stable("capabilities", "draft")],
        customization: "replace",
      };
      const researcher = {
        agentId: stable("agents", "researcher"),
        origin: "pack_owned",
        prompts: [],
        knowledge: [stable("knowledge", "statutes")],
        capabilities: [],
        customization: "none",
      };
      const helper = {
        agentId: "project:agents/helper",
        effectiveId: "project:agents/helper",
        origin: "project_owned",
        title: "Helper",
        roleId: "project:roles/liaison",
        prompts: [],
        knowledge: [],
        capabilities: [],
        customization: "none",
      };
      const effective = (pack: typeof v1, localId: string) =>
        `pack:org.example.custom@${pack.version}#${pack.manifestDigest}/agents/${localId}`;
      expect(before.configuration.agents).toEqual([
        { ...drafter, effectiveId: effective(v1, "drafter") },
        { ...researcher, effectiveId: effective(v1, "researcher") },
        helper,
      ]);
      expect(before.configuration.disabledAgents).toEqual([
        stable("agents", "filer"),
      ]);

      const upgrade = (...extra: string[]) =>
        invoke([
          "project:pack:upgrade",
          "--project",
          projectId,
          "--packs",
          JSON.stringify([v2]),
          ...extra,
          "--json",
        ]);
      const preview = await upgrade();
      expect(preview.code).toBe(0);
      const plan = JSON.parse(preview.stdout[0]!) as {
        planDigest: string;
        prospectiveConfigurationDigest: string;
      };
      expect(plan).toMatchObject({
        issues: [],
        overrides: [
          { operation: "replace", outcome: "retargeted", upstream: "changed" },
          { operation: "disable", outcome: "retargeted", upstream: "changed" },
        ],
        // Role sets are unchanged; the agent changes are template changes.
        roleCapabilityChanges: { availability: "available", changes: [] },
        templates: {
          availability: "available",
          changes: [
            { kind: "agents", localId: "drafter", customized: true },
            { kind: "agents", localId: "filer", customized: true },
          ],
        },
      });
      expect(JSON.stringify(plan)).not.toContain("Our drafter");
      const applied = await upgrade("--approve", plan.planDigest);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        result: "applied",
        bindingRevision: 2,
        definitionRevision: 5,
        packs: [v2],
      });

      const after = await show();
      expect(after).toEqual({
        ok: true,
        configuration: expect.objectContaining({
          configurationDigest: plan.prospectiveConfigurationDigest,
          selectedPacks: [v2],
          agents: [
            { ...drafter, effectiveId: effective(v2, "drafter") },
            { ...researcher, effectiveId: effective(v2, "researcher") },
            helper,
          ],
          // The disabled agent is not recreated by the upgrade.
          disabledAgents: [stable("agents", "filer")],
        }) as unknown,
      });
      // Stable identities are the same before and after the upgrade.
      expect(after.configuration.agents.map((agent) => agent.agentId)).toEqual(
        before.configuration.agents.map((agent) => agent.agentId),
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("replaces and disables pack workflows, omits the freed role, upgrades and shows the workflow view over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-workflow-template-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const template = parseDomainPackManifest(
      readFileSync(
        new URL("../fixtures/domain-pack/custom.json", import.meta.url),
      ),
    );
    const register = (version: string, workflows: object[]) => {
      const manifest = {
        ...template,
        version,
        contributions: {
          ...template.contributions,
          roles: [
            { id: "counsel" },
            { id: "clerk" },
            { id: "paralegal" },
            { id: "auditor" },
          ],
          taskTypes: [{ id: "matter" }, { id: "filing" }],
          workflows,
        },
      } as unknown as typeof template;
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...manifest,
          manifestDigest: computeManifestDigest(manifest),
        }),
      );
      return installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: "local-distribution",
          reference: `bundled/custom-${version}`,
        },
      });
    };
    // `clerk` is used by `intake` only.
    const intake = {
      id: "intake",
      taskType: "filing",
      stages: [{ id: "file", role: "clerk" }],
    };
    const audit = {
      id: "audit",
      taskType: "matter",
      stages: [{ id: "inspect", role: "auditor" }],
    };
    const v1 = register("1.0.0", [
      {
        id: "review",
        title: "Review",
        taskType: "matter",
        stages: [
          { id: "draft", role: "paralegal" },
          { id: "check", role: "counsel" },
        ],
      },
      intake,
      audit,
    ]);
    // The review is renamed and gains a stage; the intake gains a title.
    const v2 = register("2.0.0", [
      {
        id: "review",
        title: "Matter review",
        taskType: "matter",
        stages: [
          { id: "draft", role: "paralegal" },
          { id: "check", role: "counsel" },
          { id: "sign", role: "counsel" },
        ],
      },
      { ...intake, title: "Intake" },
      audit,
    ]);
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Workflow fixture"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
          ])
        ).code,
      ).toBe(0);
      const define = (revision: number, mutation: object) =>
        invoke([
          "project:definition:apply",
          "--project",
          projectId,
          "--mutation",
          JSON.stringify(mutation),
          "--expected-revision",
          String(revision),
        ]);
      const source = (
        pack: typeof v1,
        localId: string,
        kind = "workflows",
      ) => ({
        ...pack,
        kind,
        localId,
      });
      // A stage role the pack does not declare is refused before storage.
      const unknown = {
        action: "put_override",
        source: source(v1, "review"),
        operation: "replace",
        payload: {
          id: "review",
          taskType: "matter",
          stages: [{ id: "check", role: "partner" }],
        },
      };
      const previewed = await invoke([
        "project:definition:preview",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify(unknown),
        "--json",
      ]);
      expect(previewed.code).toBe(1);
      expect(JSON.parse(previewed.stdout[0]!)).toMatchObject({
        issues: [{ code: "source_definition_missing" }],
      });
      expect((await define(0, unknown)).code).toBe(1);
      // Replace the review: reorder its two stages and add one between them.
      expect(
        (
          await define(0, {
            action: "put_override",
            source: source(v1, "review"),
            operation: "replace",
            payload: {
              id: "review",
              title: "Our review",
              taskType: "matter",
              stages: [
                { id: "check", role: "counsel" },
                { id: "second-opinion", role: "auditor" },
                { id: "draft", role: "paralegal" },
              ],
            },
          })
        ).code,
      ).toBe(0);
      // Disable the intake, then omit the role only the intake used.
      expect(
        (
          await define(1, {
            action: "put_override",
            source: source(v1, "intake"),
            operation: "disable",
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await define(2, {
            action: "put_override",
            source: source(v1, "clerk", "roles"),
            operation: "disable",
          })
        ).code,
      ).toBe(0);
      const show = async () =>
        JSON.parse(
          (
            await invoke([
              "project:configuration:show",
              "--project",
              projectId,
              "--json",
            ])
          ).stdout[0]!,
        ) as {
          ok: boolean;
          configuration: {
            configurationDigest: string;
            workflows: { workflowId: string; effectiveId: string }[];
            disabledWorkflows: string[];
            omittedRoles: string[];
          };
        };
      const before = await show();
      const stable = (kind: string, localId: string) =>
        `pack:org.example.custom/${kind}/${localId}`;
      const effective = (pack: typeof v1, localId: string) =>
        `pack:org.example.custom@${pack.version}#${pack.manifestDigest}/workflows/${localId}`;
      const auditView = {
        workflowId: stable("workflows", "audit"),
        origin: "pack_owned",
        taskTypeId: stable("taskTypes", "matter"),
        stages: [{ id: "inspect", roleId: stable("roles", "auditor") }],
        customization: "none",
      };
      const reviewView = {
        workflowId: stable("workflows", "review"),
        origin: "pack_owned",
        title: "Our review",
        taskTypeId: stable("taskTypes", "matter"),
        stages: [
          { id: "check", roleId: stable("roles", "counsel") },
          { id: "second-opinion", roleId: stable("roles", "auditor") },
          { id: "draft", roleId: stable("roles", "paralegal") },
        ],
        customization: "replace",
      };
      expect(before.ok).toBe(true);
      expect(before.configuration.workflows).toEqual([
        { ...auditView, effectiveId: effective(v1, "audit") },
        { ...reviewView, effectiveId: effective(v1, "review") },
      ]);
      expect(before.configuration.disabledWorkflows).toEqual([
        stable("workflows", "intake"),
      ]);
      expect(before.configuration.omittedRoles).toEqual([
        stable("roles", "clerk"),
      ]);

      const upgrade = (...extra: string[]) =>
        invoke([
          "project:pack:upgrade",
          "--project",
          projectId,
          "--packs",
          JSON.stringify([v2]),
          ...extra,
          "--json",
        ]);
      const preview = await upgrade();
      expect(preview.code).toBe(0);
      const plan = JSON.parse(preview.stdout[0]!) as {
        planDigest: string;
        prospectiveConfigurationDigest: string;
      };
      expect(plan).toMatchObject({
        issues: [],
        overrides: [
          // The role omission: the role itself is unchanged.
          {
            operation: "disable",
            outcome: "retargeted",
            upstream: "unchanged",
          },
          { operation: "disable", outcome: "retargeted", upstream: "changed" },
          { operation: "replace", outcome: "retargeted", upstream: "changed" },
        ],
        templates: {
          availability: "available",
          changes: [
            { kind: "workflows", localId: "intake", customized: true },
            { kind: "workflows", localId: "review", customized: true },
          ],
        },
        activePins: { availability: "unavailable" },
      });
      expect(JSON.stringify(plan)).not.toContain("Our review");
      expect(JSON.stringify(plan)).not.toContain("second-opinion");
      const applied = await upgrade("--approve", plan.planDigest);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        result: "applied",
        bindingRevision: 2,
        definitionRevision: 4,
        packs: [v2],
      });

      const after = await show();
      expect(after).toEqual({
        ok: true,
        configuration: expect.objectContaining({
          configurationDigest: plan.prospectiveConfigurationDigest,
          selectedPacks: [v2],
          // The replacement is not reset and its stage order is kept.
          workflows: [
            { ...auditView, effectiveId: effective(v2, "audit") },
            { ...reviewView, effectiveId: effective(v2, "review") },
          ],
          // The disabled workflow is not recreated by the upgrade.
          disabledWorkflows: [stable("workflows", "intake")],
          omittedRoles: [stable("roles", "clerk")],
        }) as unknown,
      });
      // Stable identities are the same before and after the upgrade.
      expect(
        after.configuration.workflows.map((item) => item.workflowId),
      ).toEqual(before.configuration.workflows.map((item) => item.workflowId));
    } finally {
      controller.abort();
      await running;
    }
  });

  test("previews and applies an explicit project pack binding over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-pack-binding-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const bytes = readFileSync(
      new URL("../fixtures/domain-pack/custom.json", import.meta.url),
    );
    const pack = installedPacks.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: "bundled/custom",
      },
    });
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "Pack fixture"]);
      expect(created.code).toBe(0);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      const shown = await invoke([
        "project:pack:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      const preview = await invoke([
        "project:pack:preview",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([pack]),
        "--json",
      ]);
      expect(preview.code).toBe(0);
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        added: [pack],
        issues: [],
      });
      const applied = await invoke([
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([pack]),
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        configurationRevision: 1,
        packs: [pack],
      });
      const definitionMutation = {
        action: "put_owned",
        kind: "roles",
        id: "custom",
        enabled: true,
        payload: { id: "custom", title: "Custom" },
      };
      const definitionPreview = await invoke([
        "project:definition:preview",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify(definitionMutation),
        "--json",
      ]);
      expect(definitionPreview.code).toBe(0);
      expect(JSON.parse(definitionPreview.stdout[0]!)).toMatchObject({
        current: { revision: 0 },
        ownershipTransition: "absent -> project_owned",
        issues: [],
      });
      const definitionApplied = await invoke([
        "project:definition:apply",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify(definitionMutation),
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(definitionApplied.code).toBe(0);
      expect(JSON.parse(definitionApplied.stdout[0]!)).toMatchObject({
        revision: 1,
        owned: [{ id: "custom" }],
      });
      const definitionShown = await invoke([
        "project:definition:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(definitionShown.code).toBe(0);
      expect(JSON.parse(definitionShown.stdout[0]!)).toMatchObject({
        state: { revision: 1, owned: [{ id: "custom" }] },
        issues: [],
      });
      const resolved = await invoke([
        "project:configuration:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(resolved.code).toBe(0);
      expect(JSON.parse(resolved.stdout[0]!)).toMatchObject({
        ok: true,
        configuration: {
          bindingRevision: 1,
          definitionRevision: 1,
          selectedPacks: [pack],
          projectOwnedDefinitions: [{ kind: "roles", localId: "custom" }],
        },
      });
      expect(
        JSON.parse(resolved.stdout[0]!).configuration.configurationDigest,
      ).toMatch(/^sha256:[0-9a-f]{64}$/);
      const definitionStale = await invoke([
        "project:definition:apply",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify({ ...definitionMutation, expectedEntryRevision: 1 }),
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(definitionStale.code).toBe(1);
      expect(definitionStale.stderr.join("\n")).toContain("stale");
      const stale = await invoke([
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        "[]",
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(stale.code).toBe(1);
      expect(stale.stderr.join("\n")).toContain("stale");
      const removed = await invoke([
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        "[]",
        "--expected-revision",
        "1",
        "--json",
      ]);
      expect(removed.code).toBe(0);
      expect(JSON.parse(removed.stdout[0]!)).toMatchObject({
        configurationRevision: 2,
        packs: [],
      });
    } finally {
      controller.abort();
      await running;
    }
  });

  test("project:configuration:show stays read-only, project-scoped and sanitized over the socket", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-configuration-cli-"),
    );
    temporaryDirectories.push(projectRoot);
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const install = (bytes: Uint8Array, reference: string) =>
      installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: { installerId: "local-distribution", reference },
      });
    const legalBytes = readFileSync(
      new URL("../fixtures/domain-pack/legal.json", import.meta.url),
    );
    const legal = install(legalBytes, "/home/operator/secret-install/legal");
    const policyDraft = parseDomainPackManifest(legalBytes);
    const policyManifest = {
      ...policyDraft,
      id: "org.example.policy",
      contributions: {
        ...policyDraft.contributions,
        policies: [{ id: "deny-all" }],
      },
    } as unknown as typeof policyDraft;
    const policy = install(
      new TextEncoder().encode(
        JSON.stringify({
          ...policyManifest,
          manifestDigest: computeManifestDigest(policyManifest),
        }),
      ),
      "/home/operator/secret-install/policy",
    );
    const daemon = await bootstrap({
      projectRoot,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot,
        workingDirectory: projectRoot,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, ...output };
    };
    const create = async (name: string) =>
      (await invoke(["project:create", name])).stdout[0]!.replace(
        "Project created: ",
        "",
      );
    const show = (projectId: string) =>
      invoke(["project:configuration:show", "--project", projectId, "--json"]);
    const bind = async (
      projectId: string,
      packs: unknown[],
      revision: number,
    ) =>
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify(packs),
            "--expected-revision",
            String(revision),
            "--json",
          ])
        ).code,
      ).toBe(0);
    const authority = async (projectId: string) =>
      JSON.stringify([
        (await invoke(["project:pack:show", "--project", projectId, "--json"]))
          .stdout,
        (
          await invoke([
            "project:definition:show",
            "--project",
            projectId,
            "--json",
          ])
        ).stdout,
        (await invoke(["task:list", "--project", projectId])).stdout,
      ]);
    const expectSanitized = (output: { stdout: string[]; stderr: string[] }) =>
      expect([...output.stdout, ...output.stderr].join("\n")).not.toMatch(
        /secret-install|\/home\/|\bat .+:\d+:\d+|SQLITE|SELECT |ZodError|\.ts:/u,
      );
    try {
      await waitForDaemon(socket.socketPath);
      const projectId = await create("Configuration fixture");
      const otherId = await create("Other configuration fixture");

      const empty = await show(projectId);
      expect(empty.code).toBe(0);
      expect(Object.keys(JSON.parse(empty.stdout[0]!))).toEqual([
        "ok",
        "configuration",
      ]);
      expect(Object.keys(JSON.parse(empty.stdout[0]!).configuration)).toEqual([
        "formatVersion",
        "coreContractVersion",
        "bindingRevision",
        "definitionRevision",
        "selectedPacks",
        "resolvedPacks",
        "projectOwnedDefinitions",
        "appliedOverrides",
        "effectiveDefinitions",
        "origins",
        "disabledDefinitions",
        "resolvedWorkflowReferences",
        "configurationDigest",
        "roles",
        "omittedRoles",
        "agents",
        "disabledAgents",
        "workflows",
        "disabledWorkflows",
        "capabilities",
        "policies",
        "knowledge",
        "artifactTypes",
        "evidenceTypes",
        "validators",
        "pin",
      ]);
      expect(
        JSON.parse(empty.stdout[0]!).configuration.configurationDigest,
      ).toBe(
        "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
      );

      await bind(projectId, [legal], 0);
      const overrideApplied = await invoke([
        "project:definition:apply",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify({
          action: "put_override",
          source: { ...legal, kind: "roles", localId: "counsel" },
          operation: "replace",
          payload: { id: "counsel", title: "Lead counsel" },
        }),
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(overrideApplied.code).toBe(0);
      const resolved = await show(projectId);
      expect(resolved.code).toBe(0);
      expect(resolved.stdout).toEqual((await show(projectId)).stdout);
      expect(JSON.parse(resolved.stdout[0]!).configuration).toMatchObject({
        bindingRevision: 1,
        definitionRevision: 1,
        selectedPacks: [legal],
        appliedOverrides: [{ operation: "replace", revision: 1 }],
      });
      expectSanitized(resolved);

      // Another project never observes this project's binding or overrides.
      expect((await show(otherId)).stdout).toEqual(empty.stdout);

      // Removing the selected pack leaves a pinned override with no source.
      await bind(projectId, [], 1);
      const before = await authority(projectId);
      const stale = await show(projectId);
      expect(stale.code).toBe(1);
      expect(JSON.parse(stale.stdout[0]!)).toEqual({
        ok: false,
        diagnostics: [
          {
            code: "unresolved_override",
            message:
              "Override source pack org.example.legal@1.0.0 is not an exact selected pack",
          },
        ],
      });
      expectSanitized(stale);

      // A failed resolution changes no binding, definition or task state.
      expect(await authority(projectId)).toBe(before);

      await bind(otherId, [policy], 0);
      const beforePolicy = await authority(otherId);
      const unsupported = await show(otherId);
      expect(unsupported.code).toBe(1);
      expect(JSON.parse(unsupported.stdout[0]!)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "unsupported_security_composition" }],
      });
      expectSanitized(unsupported);
      expect(await authority(otherId)).toBe(beforePolicy);

      const missing = await show("no-such-project");
      expect(missing.code).toBe(1);
      expect(missing.stdout).toEqual([]);
      expect(missing.stderr.join("\n")).toBe(
        "Project no-such-project not found",
      );
      const unscoped = await invoke(["project:configuration:show", "--json"]);
      expect(unscoped.code).toBe(1);
      expectSanitized(unscoped);
      const positional = await invoke([
        "project:configuration:show",
        "--project",
        projectId,
        "extra",
      ]);
      expect(positional.code).toBe(1);
      expect(positional.stdout).toEqual([]);
    } finally {
      controller.abort();
      await running;
    }
  });

  test("records a historical task completion through the socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-task-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# Board");
    const socket = createTestUnixSocket();
    temporaryDirectories.push(socket.root);
    const socketPath = socket.socketPath;
    const daemon = await bootstrap({ projectRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    async function run(args: string[]): Promise<string[]> {
      const output = captureIo();
      const code = await runDaemonCli(args, {
        projectRoot,
        socketPath,
        io: output.io,
      });
      expect({ args, code, stderr: output.stderr }).toMatchObject({
        args,
        code: 0,
      });
      return output.stdout;
    }

    try {
      await waitForDaemon(socketPath);
      const projectId = (await run(["project:create", "Board"]))[0]!.replace(
        "Project created: ",
        "",
      );
      const taskId = (
        await run(["task:create", "--project", projectId, "--title", "AUC-03"])
      )[0]!.replace("Task created: ", "");

      // Preflight and correction both cross the Unix socket; the plan hash the
      // operator approves is the one the daemon produced.
      const preview = (
        await run([
          "task:record-completion",
          "--project",
          projectId,
          "--task",
          taskId,
          "--reason",
          "shipped before this board existed",
        ])
      ).join("\n");
      expect(preview).toContain(
        "operation: historical correction, not a lifecycle transition",
      );
      const planHash = preview.match(/--approve ([0-9a-f]{64})/u)?.[1];
      expect(planHash).toBeDefined();

      expect(
        (
          await run([
            "task:record-completion",
            "--project",
            projectId,
            "--task",
            taskId,
            "--reason",
            "shipped before this board existed",
            "--approve",
            planHash!,
          ])
        )[0],
      ).toBe(
        `Recorded completion of task ${taskId}: pending -> completed (historical correction)`,
      );
      expect((await run(["task:list", "--project", projectId]))[1]).toContain(
        "completed",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("returns a typed actionable error when the daemon is unavailable", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-no-daemon-"));
    temporaryDirectories.push(projectRoot);
    const output = captureIo();

    expect(
      await runDaemonCli(["project:create", "Demo"], {
        projectRoot,
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr[0]).toContain('"ai-office runtime start"');

    const helpOutput = captureIo();
    expect(
      await runDaemonCli(["--help"], { projectRoot, io: helpOutput.io }),
    ).toBe(0);
    expect(helpOutput.stdout[0]).toContain("daemon:health");
    expect(helpOutput.stdout[0]).toContain(
      "update [--approve <plan-hash>] [--json]",
    );
    expect(helpOutput.stderr).toEqual([]);

    const developmentUpdate = captureIo();
    expect(
      await runDaemonCli(["update"], {
        projectRoot,
        io: developmentUpdate.io,
      }),
    ).toBe(1);
    expect(developmentUpdate.stderr).toEqual([
      "AI Office program update is available only through the linkable ai-office entry point",
    ]);
  });

  test("never falls back to a local writer when the Runtime is unavailable", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-no-fallback-"));
    temporaryDirectories.push(projectRoot);
    const runtimeHome = join(projectRoot, "runtime");
    mkdirSync(runtimeHome);
    const runtimePaths = resolveRuntimePaths({
      mode: "user",
      runtimeHome,
    });
    let executeAttempts = 0;
    const unavailableRuntime: RuntimeClient = {
      health: async () => {
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
      execute: async () => {
        executeAttempts += 1;
        throw new RuntimeUnavailableError(runtimePaths.socketPath);
      },
    };
    const output = captureIo();

    expect(
      await runRuntimeCli(["project:create", "No local writer"], {
        projectRoot,
        runtimePaths,
        runtimeClient: unavailableRuntime,
        io: output.io,
      }),
    ).toBe(1);
    expect(executeAttempts).toBe(1);
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
    expect(output.stderr).toEqual([
      expect.stringContaining("AI Office Runtime is not available"),
    ]);
  });

  test("explicit offline status never contacts the Runtime and never claims it is unreachable", async () => {
    const projectRoot = installedRepository("ai-office-offline-status-");
    const agentClients = await cleanLocalIntegration(projectRoot);
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--offline", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        agentClients,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(0);

    expect(runtime.healthCalls).toBe(0);
    expect(runtime.executeCalls).toBe(0);
    const status = JSON.parse(output.stdout[0]!) as {
      schemaVersion: number;
      health: string;
      runtime: { daemon: string; authoritativeState: string };
      project: {
        repositoryIdentity: { state: string };
        runtimeAssociation: { state: string };
      };
      issues: { code: string; severity: string; recovery?: string }[];
    };

    expect(status.schemaVersion).toBe(4);
    expect(status.runtime.daemon).toBe("not_checked");
    expect(status.runtime.authoritativeState).toBe("not_checked");
    expect(status.health).toBe("unverified");
    expect(status.project).toMatchObject({
      repositoryIdentity: { state: "valid" },
      runtimeAssociation: { state: "unverified" },
    });
    expect(status.issues.map((issue) => issue.code)).not.toContain(
      "daemon_unavailable",
    );
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        code: "runtime_not_checked",
        severity: "warning",
      }),
    );
    expect(
      status.issues.some((issue) =>
        (issue.recovery ?? "").includes("runtime start"),
      ),
    ).toBe(false);
    expect(existsSync(runtimePaths.projectDatabasePath)).toBe(false);
  });

  test("explicit offline status renders host state as not checked", async () => {
    const projectRoot = installedRepository("ai-office-offline-render-");
    const agentClients = await cleanLocalIntegration(projectRoot);
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", "--offline"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        agentClients,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(0);

    expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
    expect(output.stdout).toContain("  persistent host: not_checked");
    expect(output.stdout).toContain("  state: not_checked");
    expect(output.stdout).toContain("Status: unverified");
    expect(output.stdout.join("\n")).not.toContain("ai-office runtime start");
  });

  test.each([
    "drifted",
    "conflict",
    "missing",
    "unmanaged",
    "binding_invalid",
  ] as const)(
    "explicit offline status fails for locally observed %s without a Runtime request",
    async (problem) => {
      const projectRoot = installedRepository("ai-office-offline-problem-");
      const agentClients = await cleanLocalIntegration(projectRoot);
      const skill = join(
        projectRoot,
        ".agents",
        "skills",
        "ai-office",
        "SKILL.md",
      );
      if (problem === "drifted")
        writeFileSync(skill, readFileSync(skill, "utf8") + "\nLocal drift\n");
      if (problem === "conflict") {
        writeFileSync(
          join(projectRoot, "CLAUDE.md"),
          "<!-- >>> ai-office managed: canonical-project-instructions -->\n@OTHER.md\n",
        );
        writeFileSync(
          join(projectRoot, "bin", "claude"),
          "#!/bin/sh\nexit 0\n",
        );
        chmodSync(join(projectRoot, "bin", "claude"), 0o755);
      }
      if (problem === "missing") rmSync(skill);
      if (problem === "unmanaged")
        writeFileSync(
          join(projectRoot, "AI-OFFICE.md"),
          "# User-owned instructions\n",
        );
      if (problem === "binding_invalid")
        writeFileSync(join(projectRoot, ".ai-office", "project.json"), "{}");
      const runtime = rejectingRuntimeClient();
      const output = captureIo();
      expect(
        await runRuntimeCli(["status", "--offline", "--json"], {
          projectRoot,
          workingDirectory: projectRoot,
          runtimePaths: offlineRuntimePaths(projectRoot),
          agentClients,
          runtimeClient: runtime.client,
          io: output.io,
        }),
      ).toBe(1);
      expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
      const status = JSON.parse(output.stdout[0]!) as {
        health: string;
        runtime: { daemon: string; authoritativeState: string };
        issues: { code: string }[];
      };
      expect(status.health).toBe("needs_attention");
      expect(status.runtime).toMatchObject({
        daemon: "not_checked",
        authoritativeState: "not_checked",
      });
      expect(status.issues.map((issue) => issue.code)).toContain(
        problem === "binding_invalid"
          ? problem
          : `client_${problem === "conflict" ? "claude" : "codex"}_${problem}`,
      );
    },
  );

  test("a failed Runtime connection still reports the host as unreachable", async () => {
    const projectRoot = installedRepository("ai-office-offline-degraded-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient(
      () => new RuntimeUnavailableError(runtimePaths.socketPath),
    );
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(1);

    expect(runtime.executeCalls).toBeGreaterThan(0);
    const status = JSON.parse(output.stdout[0]!) as {
      health: string;
      runtime: { daemon: string; authoritativeState: string };
      issues: { code: string; recovery?: string }[];
    };
    expect(status.runtime.daemon).toBe("unreachable");
    expect(status.runtime.authoritativeState).toBe("unavailable");
    expect(status.health).toBe("needs_attention");
    expect(status.issues.map((issue) => issue.code)).toContain(
      "daemon_unavailable",
    );
    expect(
      status.issues.some((issue) =>
        (issue.recovery ?? "").includes("runtime start"),
      ),
    ).toBe(true);
  });

  test("rejects malformed explicit offline invocations before contacting the Runtime", async () => {
    const projectRoot = installedRepository("ai-office-offline-usage-");
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const invocations: [string[], string][] = [
      [["status", "--offline", "--unknown"], "Unknown option --unknown"],
      [
        ["status", "--offline", "--offline"],
        "Flag --offline can only be provided once",
      ],
      [
        ["status", "--offline", "--json", "--json"],
        "Flag --json can only be provided once",
      ],
      [
        ["status", ".", "..", "--offline"],
        "status accepts at most one project path",
      ],
      [["status", "--offline", "--project"], "Unknown option --project"],
    ];

    for (const [args, message] of invocations) {
      const runtime = rejectingRuntimeClient();
      const output = captureIo();

      expect(
        await runRuntimeCli(args, {
          projectRoot,
          workingDirectory: projectRoot,
          runtimePaths,
          runtimeClient: runtime.client,
          io: output.io,
        }),
      ).toBe(1);
      expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
      expect(output.stdout).toEqual([]);
      expect(output.stderr).toEqual([message]);
    }
  });

  test("explicit offline status reports an uninstalled repository without blaming the Runtime", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-offline-none-"));
    temporaryDirectories.push(projectRoot);
    const runtimePaths = offlineRuntimePaths(projectRoot);
    const runtime = rejectingRuntimeClient();
    const output = captureIo();

    expect(
      await runRuntimeCli(["status", ".", "--offline", "--json"], {
        projectRoot,
        workingDirectory: projectRoot,
        runtimePaths,
        runtimeClient: runtime.client,
        io: output.io,
      }),
    ).toBe(1);

    expect(runtime.healthCalls + runtime.executeCalls).toBe(0);
    const status = JSON.parse(output.stdout[0]!) as {
      health: string;
      runtime: { daemon: string };
      issues: { code: string }[];
    };
    expect(status.health).toBe("not_installed");
    expect(status.runtime.daemon).toBe("not_checked");
    expect(status.issues.map((issue) => issue.code)).toEqual(["not_installed"]);
  });
});
