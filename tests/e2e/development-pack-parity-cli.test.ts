import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { LegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import type { ResolvedProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import type { InstalledDomainPackCatalog } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import {
  developmentPackBytes,
  developmentPackId,
  developmentPackManifestDigest,
  developmentPackVersion,
  legacyRoleIds,
  projectLegacyProfile,
  projectResolvedConfiguration,
  shippedAgentsDirectory,
  testCatalogWith,
} from "../helpers/development-pack-parity.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

// GP-10A over the Runtime socket. The development pack is resolvable only
// from a catalog a test supplies: the Runtime's own composition holds no pack
// and no command binds one. With such a catalog, a project installed with
// the shipped defaults and explicitly bound resolves the roles, agents and
// task types its legacy profile describes, and since GP-10B-1 the workflows
// its legacy pipelines describe. What the Runtime reads to run work stays the
// same.

/** `project:configuration:show` of a project with no selection and no definition. */
const emptyConfiguration = {
  formatVersion: 1,
  coreContractVersion: 1,
  bindingRevision: 0,
  definitionRevision: 0,
  selectedPacks: [],
  resolvedPacks: [],
  projectOwnedDefinitions: [],
  appliedOverrides: [],
  effectiveDefinitions: {
    roles: [],
    taskTypes: [],
    workflows: [],
    agents: [],
    artifactTypes: [],
    evidenceTypes: [],
    policies: [],
    knowledge: [],
    capabilities: [],
    prompts: [],
    validators: [],
  },
  origins: {},
  disabledDefinitions: [],
  resolvedWorkflowReferences: [],
  configurationDigest:
    "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
  roles: [],
  omittedRoles: [],
  agents: [],
  disabledAgents: [],
  workflows: [],
  disabledWorkflows: [],
  pin: {
    configurationDigest:
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    coreContractVersion: 1,
    bindingRevision: 0,
    definitionRevision: 0,
    selectedPacks: [],
    resolvedPacks: [],
  },
};

const developmentPack = {
  id: developmentPackId,
  version: developmentPackVersion,
  manifestDigest: developmentPackManifestDigest,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

/** One Runtime host on its own socket; every command crosses that socket. */
async function start(
  runtimeRoot: string,
  installedPacks?: InstalledDomainPackCatalog,
) {
  mkdirSync(runtimeRoot);
  const socket = createTestUnixSocket();
  roots.push(socket.root);
  const runtimePaths = resolveRuntimePaths({
    mode: "user",
    runtimeHome: runtimeRoot,
  });
  const daemon = await bootstrap({
    runtimePaths,
    socketPath: socket.socketPath,
    ...(installedPacks === undefined ? {} : { installedPacks }),
  });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);
  await waitForDaemon(socket.socketPath);
  const run = async (workingDirectory: string, args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    };
    const exitCode = await runDaemonCli(args, {
      runtimePaths,
      socketPath: socket.socketPath,
      workingDirectory,
      io,
    });
    return { exitCode, stdout, stderr };
  };
  const json = async <T>(workingDirectory: string, args: string[]) => {
    const result = await run(workingDirectory, [...args, "--json"]);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout[0]!) as T;
  };
  /** How many packs any project of this host selects. */
  const boundPacks = () => {
    const database = new Database(runtimePaths.projectDatabasePath, {
      readonly: true,
    });
    try {
      return database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM project_pack_binding_pack",
        )
        .get()!.count;
    } finally {
      database.close();
    }
  };
  const stop = async () => {
    controller.abort();
    await running;
  };
  return { run, json, boundPacks, stop };
}

type Host = Awaited<ReturnType<typeof start>>;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp10a-e2e-"));
  roots.push(root);
  return root;
}

function checkout(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"name":"gp10a"}\n');
  return root;
}

/**
 * `install` applies the shipped default office manifest; `agent:sync` reads
 * the shipped `agents/` directory. Together they are the default legacy state.
 */
async function installDefaults(host: Host, root: string): Promise<string> {
  const installed = await host.run(root, ["install", ".", "--json"]);
  expect([0, 2]).toContain(installed.exitCode);
  const result = JSON.parse(installed.stdout[0]!) as {
    project: { id: string };
    office: { roles: string[] };
  };
  expect(result.office.roles).toEqual([
    "Software Architect",
    "Developer",
    "Reviewer",
    "Quality Assurance",
  ]);
  const synced = await host.run(root, [
    "agent:sync",
    "--project",
    result.project.id,
    "--directory",
    shippedAgentsDirectory,
  ]);
  expect(synced.stdout).toEqual(["Agent definitions synchronized: 4"]);
  return result.project.id;
}

const selection = (host: Host, root: string, projectId: string) =>
  host.json<{ configurationRevision: number; packs: unknown[] }>(root, [
    "project:pack:show",
    "--project",
    projectId,
  ]);

const configuration = async (host: Host, root: string, projectId: string) =>
  (
    await host.json<{
      ok: boolean;
      configuration: ResolvedProjectConfiguration;
    }>(root, ["project:configuration:show", "--project", projectId])
  ).configuration;

const legacyProfile = async (host: Host, root: string, projectId: string) =>
  (
    await host.json<{ ok: boolean; profile: LegacyDevelopmentProfile }>(root, [
      "project:configuration:legacy",
      "--project",
      projectId,
    ])
  ).profile;

describe("GP-10A development pack over the Runtime socket", () => {
  test("the Runtime's own catalog holds no pack, and install, sync and restore bind none", async () => {
    const parent = workspace();
    const root = checkout(parent, "source");
    const archivePath = join(parent, "project.aioffice");
    const packs = JSON.stringify([developmentPack]);

    const source = await start(join(parent, "source-runtime"));
    try {
      const projectId = await installDefaults(source, root);
      expect(await selection(source, root, projectId)).toEqual({
        projectId,
        configurationRevision: 0,
        packs: [],
      });
      expect(source.boundPacks()).toBe(0);
      // Unbound: the empty configuration, key for key, at the pinned digest.
      const shown = await source.run(root, [
        "project:configuration:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toEqual([
        JSON.stringify({ ok: true, configuration: emptyConfiguration }),
      ]);

      // The pack cannot be selected here: nothing installed it.
      const preview = await source.run(root, [
        "project:pack:preview",
        "--project",
        projectId,
        "--packs",
        packs,
        "--json",
      ]);
      expect(preview.exitCode).toBe(1);
      expect(
        (
          JSON.parse(preview.stdout[0]!) as { issues: { code: string }[] }
        ).issues.map((issue) => issue.code),
      ).toEqual(["missing_pack"]);
      const applied = await source.run(root, [
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        packs,
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(applied.exitCode).toBe(1);
      expect(source.boundPacks()).toBe(0);
      expect(await selection(source, root, projectId)).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });

      expect(
        (
          await source.run(root, [
            "project:backup",
            "--output",
            archivePath,
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
    } finally {
      await source.stop();
    }

    const restoredRoot = checkout(parent, "restored");
    const target = await start(join(parent, "target-runtime"));
    try {
      const restored = await target.json<{
        outcome: string;
        projectId: string;
      }>(restoredRoot, ["project:restore", archivePath]);
      expect(restored.outcome).toBe("restored");
      expect(
        await selection(target, restoredRoot, restored.projectId),
      ).toMatchObject({ configurationRevision: 0, packs: [] });
      expect(target.boundPacks()).toBe(0);
      expect(
        await configuration(target, restoredRoot, restored.projectId),
      ).toEqual(emptyConfiguration);
      // The restored project still has its legacy office and roles.
      const profile = await legacyProfile(
        target,
        restoredRoot,
        restored.projectId,
      );
      expect(profile.roles.map((role) => role.id)).toEqual([...legacyRoleIds]);
      expect(profile.metadata.packBinding).toEqual({ present: false });
    } finally {
      await target.stop();
    }
  });

  test("with a test-supplied catalog, a project installed with the shipped defaults and bound to the pack is at expressible-subset parity, and its legacy state is untouched", async () => {
    const parent = workspace();
    const root = checkout(parent, "project");
    const { catalog, pack } = testCatalogWith(developmentPackBytes());
    expect(pack).toEqual(developmentPack);
    const host = await start(join(parent, "runtime"), catalog);
    try {
      const projectId = await installDefaults(host, root);
      const legacyReads = async () => ({
        office: (await host.run(root, ["office:show", "--project", projectId]))
          .stdout,
        agents: (await host.run(root, ["agent:list", "--project", projectId]))
          .stdout,
        pipelines: await Promise.all(
          ["feature", "bugfix", "maintenance", "research", "release"].map(
            async (kind) =>
              (
                await host.run(root, [
                  "office:pipeline",
                  "--project",
                  projectId,
                  "--task-kind",
                  kind,
                ])
              ).stdout,
          ),
        ),
      });

      // An installed pack that no project selects changes nothing.
      expect(await configuration(host, root, projectId)).toEqual(
        emptyConfiguration,
      );
      expect(host.boundPacks()).toBe(0);
      const unbound = await legacyProfile(host, root, projectId);
      expect(unbound.metadata.packBinding).toEqual({ present: false });
      const before = await legacyReads();
      expect(before.agents).toHaveLength(5);

      const applied = await host.run(root, [
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([pack]),
        "--expected-revision",
        "0",
        "--json",
      ]);
      expect(applied.exitCode).toBe(0);
      expect(await selection(host, root, projectId)).toMatchObject({
        configurationRevision: 1,
        packs: [developmentPack],
      });

      const resolved = await configuration(host, root, projectId);
      const bound = await legacyProfile(host, root, projectId);
      expect(resolved.selectedPacks).toEqual([developmentPack]);
      expect(projectResolvedConfiguration(resolved)).toEqual(
        projectLegacyProfile(bound),
      );
      expect(projectLegacyProfile(bound).roles).toHaveLength(4);
      // GP-10B-1: the four pack workflows are resolved as declarations, and
      // they are the legacy pipelines over the expressible subset.
      expect(
        projectResolvedConfiguration(resolved).workflows.map(
          (workflow) => workflow.id,
        ),
      ).toEqual(["bugfix", "delivery", "discovery", "release"]);
      expect(projectResolvedConfiguration(resolved).routes).toEqual(
        projectLegacyProfile(bound).routes,
      );
      expect(projectLegacyProfile(bound).routes).toHaveLength(4);

      // The binding is the only thing the legacy profile reports as changed.
      expect(bound.profileDigest).toBe(unbound.profileDigest);
      expect({
        ...bound,
        metadata: { ...bound.metadata, packBinding: { present: false } },
      }).toEqual(unbound);
      // What the Runtime reads to run work is what it read before.
      expect(await legacyReads()).toEqual(before);
    } finally {
      await host.stop();
    }
  });
});
