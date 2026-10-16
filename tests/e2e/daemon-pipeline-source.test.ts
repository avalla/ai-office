import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
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
  throw new Error("Daemon did not become healthy");
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Pack source",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Pack source office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Pack source delivery",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    },
  ],
};

describe("daemon pipeline:start --source (M16.5 pack workflow selection)", () => {
  test("validates --source and keeps manifest-only projects on manifest pipelines over the socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pack-source-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot: root,
        workingDirectory: root,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, stdout: output.stdout, stderr: output.stderr };
    };

    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "source", "--json"]);
      expect(created.code).toBe(0);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      expect(
        (
          await invoke([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(manifest),
          ])
        ).code,
      ).toBe(0);
      const task = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Feature",
      ]);
      const taskId = task.stdout[0]!.slice("Task created: ".length);
      const start = (...extra: string[]) =>
        invoke([
          "pipeline:start",
          "--project",
          projectId,
          "--task",
          taskId,
          "--pipeline",
          "delivery",
          "--actor",
          "operator",
          ...extra,
        ]);

      const invalid = await start("--source", "elsewhere");
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toEqual([]);
      expect(invalid.stderr.join("\n")).toContain(
        "--source must be manifest or pack",
      );

      // A project with no selected pack has no pack workflows to select.
      const pack = await start("--source", "pack");
      expect(pack.code).toBe(1);
      expect(pack.stdout).toEqual([]);
      expect(pack.stderr.join("\n")).toContain("delivery");

      const manifestRun = await start("--source", "manifest");
      expect(manifestRun.code).toBe(0);
      const run = JSON.parse(manifestRun.stdout[0]!) as {
        definition: { id: string };
        configurationPin?: unknown;
      };
      expect(run.definition.id).toBe("delivery");
      expect(run.configurationPin).toBeUndefined();
    } finally {
      controller.abort();
      await running;
    }
  });
});

describe("daemon pipeline:start from a selected pack (M16.5)", () => {
  test("reports an ambiguous ID and a missing Runtime role with actionable messages over the socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pack-source-pack-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = installedPacks.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "legal" },
    });
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot: root,
        workingDirectory: root,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, stdout: output.stdout, stderr: output.stderr };
    };

    try {
      await waitForDaemon(socket.socketPath);
      const created = await invoke(["project:create", "selected", "--json"]);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      const withMatter: OfficeManifest = {
        ...manifest,
        pipelines: [
          ...manifest.pipelines,
          {
            ...manifest.pipelines[0]!,
            id: "matter-workflow",
            defaultFor: ["maintenance"],
          },
        ],
      };
      expect(
        (
          await invoke([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(withMatter),
          ])
        ).code,
      ).toBe(0);
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
      const task = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Matter",
      ]);
      const taskId = task.stdout[0]!.slice("Task created: ".length);
      const start = (...extra: string[]) =>
        invoke([
          "pipeline:start",
          "--project",
          projectId,
          "--task",
          taskId,
          "--pipeline",
          "matter-workflow",
          "--actor",
          "operator",
          ...extra,
        ]);

      const ambiguous = await start();
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stdout).toEqual([]);
      expect(ambiguous.stderr.join("\n")).toContain(
        "pass --source manifest or --source pack",
      );

      // The legal pack's stage roles do not exist in this Runtime project.
      const missing = await start("--source", "pack");
      expect(missing.code).toBe(1);
      expect(missing.stdout).toEqual([]);
      expect(missing.stderr.join("\n")).toContain(
        "needs Runtime roles that do not exist: intake-clerk, researcher, drafter, reviewer, approver",
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

function packBytes(draft: Record<string, unknown>): Uint8Array {
  const encoder = new TextEncoder();
  const full = {
    schemaVersion: 1,
    version: "1.0.0",
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    dependencies: [],
    ...draft,
  };
  return encoder.encode(
    JSON.stringify({
      ...full,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(encoder.encode(JSON.stringify(full))),
      ),
    }),
  );
}

const emptyContributions = Object.fromEntries(
  contributionKinds.map((kind) => [kind, []]),
);

describe("daemon pipeline:start pack guards over the socket (M16.5)", () => {
  test("refuses a guidance workflow before roles, a dependency workflow, and freezes the policy guards of a selected pack", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-pack-guards-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const installedPacks = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const register = (bytes: Uint8Array, reference: string) =>
      installedPacks.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: { installerId: "local-distribution", reference },
      });
    const legal = register(
      readFileSync(
        new URL(
          "../../packages/domain-pack-legal/manifest.json",
          import.meta.url,
        ),
      ),
      "legal",
    );
    const guidance = register(
      packBytes({
        id: "org.example.guidance",
        metadata: { name: "guidance", description: "No policy" },
        contributions: {
          ...emptyContributions,
          roles: [{ id: "clerk" }],
          taskTypes: [{ id: "case" }],
          workflows: [
            {
              id: "case-flow",
              taskType: "case",
              stages: [{ id: "open", role: "clerk" }],
            },
          ],
        },
      }),
      "guidance",
    );
    const empty = register(
      packBytes({
        id: "org.example.empty",
        metadata: { name: "empty", description: "Enforced without stages" },
        contributions: {
          ...emptyContributions,
          taskTypes: [{ id: "case" }],
          workflows: [{ id: "empty-flow", taskType: "case", stages: [] }],
          policies: [
            {
              id: "enforce",
              workflow: "empty-flow",
              enforcement: "enforced",
            },
          ],
        },
      }),
      "empty",
    );
    const dependent = register(
      packBytes({
        id: "org.example.dependent",
        metadata: { name: "dependent", description: "Depends on legal" },
        dependencies: [
          {
            id: legal.id,
            version: legal.version,
            manifestDigest: legal.manifestDigest,
          },
        ],
        contributions: emptyContributions,
      }),
      "dependent",
    );
    const daemon = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
      installedPacks,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const invoke = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot: root,
        workingDirectory: root,
        socketPath: socket.socketPath,
        io: output.io,
      });
      return { code, stdout: output.stdout, stderr: output.stderr };
    };
    const createProject = async (name: string, packs: unknown[]) => {
      const created = await invoke(["project:create", name, "--json"]);
      const { projectId } = JSON.parse(created.stdout[0]!) as {
        projectId: string;
      };
      expect(
        (
          await invoke([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(manifest),
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await invoke([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify(packs),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).code,
      ).toBe(0);
      const task = await invoke([
        "task:create",
        "--project",
        projectId,
        "--title",
        name,
      ]);
      return {
        projectId,
        taskId: task.stdout[0]!.slice("Task created: ".length),
      };
    };
    const start = (
      target: { projectId: string; taskId: string },
      pipeline: string,
    ) =>
      invoke([
        "pipeline:start",
        "--project",
        target.projectId,
        "--task",
        target.taskId,
        "--pipeline",
        pipeline,
        "--actor",
        "operator",
      ]);

    try {
      await waitForDaemon(socket.socketPath);

      // No Runtime role exists for this project: the guidance refusal must
      // come first, and must not suggest that adding roles would help.
      const guided = await createProject("guidance", [guidance]);
      const refusedGuidance = await start(guided, "case-flow");
      expect(refusedGuidance.code).toBe(1);
      expect(refusedGuidance.stdout).toEqual([]);
      const guidanceMessage = refusedGuidance.stderr.join("\n");
      expect(guidanceMessage).toContain("case-flow");
      expect(guidanceMessage).not.toContain("Runtime roles");

      const emptyProject = await createProject("empty", [empty]);
      const refusedEmpty = await start(emptyProject, "empty-flow");
      expect(refusedEmpty.code).toBe(1);
      expect(refusedEmpty.stdout).toEqual([]);
      expect(refusedEmpty.stderr.join("\n")).toContain(
        "cannot start a run: it has no stages",
      );

      // The legal pack is resolved only as a dependency of the selected pack.
      const dependency = await createProject("dependency", [dependent]);
      const refusedDependency = await start(dependency, "matter-workflow");
      expect(refusedDependency.code).toBe(1);
      expect(refusedDependency.stdout).toEqual([]);
      expect(refusedDependency.stderr.join("\n")).toContain("dependency pack");

      // The same workflow of a selected pack starts, with the policy guards
      // frozen into the run and the stage role enforced on assignment.
      const selected = await createProject("selected", [legal]);
      const database = openDatabase(join(root, ".ai-office", "project.sqlite"));
      const runtime = new SqliteAgentRuntimeRepository(database);
      const timestamp = new Date("2020-01-01T00:00:00.000Z");
      const keys = [
        "intake-clerk",
        "researcher",
        "drafter",
        "reviewer",
        "approver",
      ];
      for (const key of keys)
        await runtime.saveRole(
          Role.create({
            id: `role-${key}`,
            projectId: selected.projectId,
            key,
            name: key,
            version: 1,
            capabilities: [],
            tools: [],
            modelPolicy: "default",
            limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
            sourcePath: `${key}.yaml`,
            now: timestamp,
          }),
        );
      const agents: Agent[] = keys.map((key) => ({
        id: `${key}-agent`,
        projectId: selected.projectId,
        roleId: `role-${key}`,
        name: `${key} agent`,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      for (const agent of agents) await runtime.saveAgent(agent);
      database.close();

      const started = await start(selected, "matter-workflow");
      expect(started.code, started.stderr.join("\n")).toBe(0);
      const run = JSON.parse(started.stdout[0]!) as {
        id: string;
        configurationPin?: unknown;
        definition: {
          enforcement: string;
          stages: {
            id: string;
            requiresApproval: boolean;
            requiresIndependentApproval?: boolean;
            requiresDifferentAgentFrom?: string[];
          }[];
        };
      };
      expect(run.configurationPin).toBeDefined();
      expect(run.definition.enforcement).toBe("enforced");
      const stage = (id: string) =>
        run.definition.stages.find((value) => value.id === id);
      expect(stage("citation-review")).toMatchObject({
        requiresApproval: true,
        requiresDifferentAgentFrom: ["draft"],
      });
      expect(stage("human-approval")).toMatchObject({
        requiresApproval: true,
        requiresIndependentApproval: true,
        requiresDifferentAgentFrom: ["citation-review", "draft"],
      });

      const assign = (agent: string) =>
        invoke([
          "pipeline:assign",
          "--project",
          selected.projectId,
          "--run",
          run.id,
          "--agent",
          agent,
          "--actor",
          "operator",
        ]);
      const wrongRole = await assign("approver-agent");
      expect(wrongRole.code).toBe(1);
      expect(wrongRole.stderr.join("\n")).toContain(
        "requires role intake-clerk",
      );
      expect((await assign("intake-clerk-agent")).code).toBe(0);
    } finally {
      controller.abort();
      await running;
    }
  });
});
