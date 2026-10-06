import { Database } from "bun:sqlite";
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
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import {
  portableStateChecksum,
  serializePortableProjectArchive,
  sha256Canonical,
  type PortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import type { InstalledDomainPackCatalog } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import { computeArtifactDigest } from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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

/** legal.json contributes roles/counsel and taskTypes/matter. */
function legalCatalog() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const bytes = readFileSync(
    new URL("../fixtures/domain-pack/legal.json", import.meta.url),
  );
  const legal = catalog.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance: { installerId: "local-distribution", reference: "legal" },
  });
  return { catalog, legal };
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
  const stop = async () => {
    controller.abort();
    await running;
  };
  return { runtimePaths, run, stop };
}

function checkout(workspace: string, name: string): string {
  const root = join(workspace, name);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"name":"gp22"}\n');
  return root;
}

async function installProject(
  host: Awaited<ReturnType<typeof start>>,
  root: string,
): Promise<string> {
  const installed = await host.run(root, ["install", ".", "--json"]);
  expect([0, 2]).toContain(installed.exitCode);
  return (JSON.parse(installed.stdout[0]!) as { project: { id: string } })
    .project.id;
}

const ownCounsel = (projectId: string, revision: number) => [
  "project:definition:apply",
  "--project",
  projectId,
  "--mutation",
  JSON.stringify({
    action: "put_owned",
    kind: "roles",
    id: "counsel",
    enabled: true,
    payload: { id: "counsel" },
  }),
  "--expected-revision",
  String(revision),
  "--json",
];

describe("GP-22 binding composition preflight over the Runtime socket", () => {
  test("project:pack:preview and project:pack:apply reject a colliding selection without writing, and the unchanged selection stays a no-op", async () => {
    const workspace = temporaryRoot("ai-office-gp22-binding-e2e-");
    const root = checkout(workspace, "project");
    const { catalog, legal } = legalCatalog();
    const host = await start(join(workspace, "runtime"), catalog);
    const packs = JSON.stringify([legal]);
    const pack = (command: string, ...extra: string[]) =>
      host.run(root, [
        `project:pack:${command}`,
        "--project",
        projectId,
        ...(command === "show" ? [] : ["--packs", packs]),
        ...extra,
        "--json",
      ]);
    const auditCount = () => {
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_event WHERE event_type='project.pack_binding_applied'",
          )
          .get()!.count;
      } finally {
        database.close();
      }
    };
    let projectId = "";
    try {
      projectId = await installProject(host, root);
      expect((await host.run(root, ownCounsel(projectId, 0))).exitCode).toBe(0);
      const message =
        "Project definition roles/counsel collides with pack org.example.legal@1.0.0 in the proposed pack closure";

      const preview = await pack("preview");
      expect(preview.exitCode).toBe(1);
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        current: { configurationRevision: 0, packs: [] },
        added: [legal],
        issues: [{ code: "pack_definition_collision", message }],
      });
      const rejected = await pack("apply", "--expected-revision", "0");
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).toEqual([]);
      expect(rejected.stderr).toEqual([message]);
      expect(JSON.parse((await pack("show")).stdout[0]!)).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(auditCount()).toBe(0);

      // Removing the project definition makes the same selection applicable.
      expect(
        (
          await host.run(root, [
            "project:definition:apply",
            "--project",
            projectId,
            "--mutation",
            JSON.stringify({
              action: "remove_owned",
              kind: "roles",
              id: "counsel",
            }),
            "--expected-revision",
            "1",
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
      expect((await pack("preview")).exitCode).toBe(0);
      const applied = await pack("apply", "--expected-revision", "0");
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      // The unchanged active selection: no revision increment, no audit event.
      const repeated = await pack("apply", "--expected-revision", "1");
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout[0]!)).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      expect(auditCount()).toBe(1);
      // GP-07 keeps guarding the other direction with the same code.
      const definition = await host.run(root, ownCounsel(projectId, 2));
      expect(definition.exitCode).toBe(1);
      expect(definition.stderr).toEqual([
        "Project definition roles/counsel collides with pack org.example.legal@1.0.0 in the resolved pack closure",
      ]);
    } finally {
      await host.stop();
    }
  });

  test("project:restore rejects a checksummed archive whose composition collides when the closure is installed, and restores it when it is not", async () => {
    const workspace = temporaryRoot("ai-office-gp22-restore-e2e-");
    const sourceRoot = checkout(workspace, "source");
    const archivePath = join(workspace, "project.aioffice");
    const { catalog, legal } = legalCatalog();

    const source = await start(join(workspace, "source-runtime"));
    try {
      const projectId = await installProject(source, sourceRoot);
      expect(
        (await source.run(sourceRoot, ownCounsel(projectId, 0))).exitCode,
      ).toBe(0);
      expect(
        (
          await source.run(sourceRoot, [
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

    // No command produces a colliding composition any more, so the archive is
    // given the binding and fresh checksums, as a foreign producer would.
    const archive = JSON.parse(
      readFileSync(archivePath, "utf8"),
    ) as PortableProjectArchive;
    expect(archive.state.definitions?.owned).toHaveLength(1);
    const state = {
      ...archive.state,
      packBinding: { configurationRevision: 1, packs: [legal] },
    };
    const manifest = {
      ...archive.manifest,
      revision: {
        ...archive.manifest.revision,
        stateChecksum: portableStateChecksum(state),
      },
    };
    writeFileSync(
      archivePath,
      serializePortableProjectArchive({
        manifest,
        state,
        integrity: {
          algorithm: "sha256" as const,
          checksum: sha256Canonical({ manifest, state }),
        },
      }),
    );

    const counts = (host: Awaited<ReturnType<typeof start>>) => {
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return [
          "project",
          "project_pack_binding",
          "project_pack_binding_pack",
          "project_definition_head",
          "project_owned_definition",
        ].map(
          (table) =>
            database
              .query<{ count: number }, []>(
                `SELECT count(*) AS count FROM ${table}`,
              )
              .get()!.count,
        );
      } finally {
        database.close();
      }
    };

    // A host where the exact closure resolves: rejected before any commit.
    const installedRoot = checkout(workspace, "installed");
    const installed = await start(
      join(workspace, "installed-runtime"),
      catalog,
    );
    try {
      const before = counts(installed);
      expect(before).toEqual([0, 0, 0, 0, 0]);
      const rejected = await installed.run(installedRoot, [
        "project:restore",
        archivePath,
        "--json",
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).toEqual([]);
      expect(rejected.stderr).toEqual([
        "Portable restore rejected (pack_definition_collision): project definition roles/counsel collides with pack org.example.legal@1.0.0 in the archive's resolved pack closure; nothing was restored",
      ]);
      expect(counts(installed)).toEqual(before);
      expect(
        existsSync(join(installedRoot, ".ai-office", "project.json")),
      ).toBe(false);
    } finally {
      await installed.stop();
    }

    // A host without the artifacts: the same archive restores, and GP-06
    // reports its own closure failure.
    const emptyRoot = checkout(workspace, "empty");
    const empty = await start(join(workspace, "empty-runtime"));
    try {
      const restored = await empty.run(emptyRoot, [
        "project:restore",
        archivePath,
        "--json",
      ]);
      expect(restored.exitCode).toBe(0);
      const result = JSON.parse(restored.stdout[0]!) as {
        outcome: string;
        projectId: string;
      };
      expect(result.outcome).toBe("restored");
      const shown = await empty.run(emptyRoot, [
        "project:pack:show",
        "--project",
        result.projectId,
        "--json",
      ]);
      expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
        configurationRevision: 1,
        packs: [legal],
      });
      const configuration = await empty.run(emptyRoot, [
        "project:configuration:show",
        "--project",
        result.projectId,
        "--json",
      ]);
      expect(configuration.exitCode).toBe(1);
      expect(JSON.parse(configuration.stdout[0]!)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "pack_unavailable" }],
      });
      // Rerunning the same restore is not subject to the preflight.
      const rerun = await empty.run(emptyRoot, [
        "project:restore",
        archivePath,
        "--json",
      ]);
      expect(rerun.exitCode).toBe(0);
      expect(JSON.parse(rerun.stdout[0]!)).toMatchObject({
        outcome: "unchanged",
      });
    } finally {
      await empty.stop();
    }
  });
});
