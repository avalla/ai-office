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
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
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
  writeFileSync(join(root, "package.json"), '{"name":"gp16"}\n');
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

const encoder = new TextEncoder();

function packBytes(
  id: string,
  version: string,
  capabilities: unknown[],
  contributions: Record<string, unknown[]> = {
    roles: [{ id: "operator", capabilities: ["publish"] }],
  },
): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: id, description: "Capability contract fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
      capabilities,
    },
  };
  return encoder.encode(
    JSON.stringify({
      ...draft,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
      ),
    }),
  );
}

const read = { operation: "fake.read", mode: "read" };
const write = { operation: "fake.write", mode: "mutation" };
const merge = { operation: "github.merge_pr", mode: "mutation" };
const opsBytes = packBytes("org.example.ops", "1.0.0", [
  { id: "publish", operations: [read] },
  { id: "extras", requirement: "optional", operations: [write, merge] },
]);
const opsV2Bytes = packBytes("org.example.ops", "2.0.0", [
  { id: "publish", operations: [read, write] },
  { id: "extras", requirement: "optional", operations: [write, merge] },
]);
const needsBytes = packBytes("org.example.needs", "1.0.0", [
  { id: "publish", operations: [merge] },
]);
const modeBytes = packBytes("org.example.mode", "1.0.0", [
  { id: "publish", operations: [{ operation: "fake.write", mode: "read" }] },
]);
// A pack with a workflow, so that a project can hold a workflow override:
// the customization that makes an archive format 9.
const flowBytes = packBytes("org.example.flow", "1.0.0", [], {
  roles: [{ id: "author" }],
  taskTypes: [{ id: "note" }],
  workflows: [
    {
      id: "draft",
      taskType: "note",
      stages: [{ id: "write", role: "author" }],
    },
  ],
});

/** The test-supplied pack catalog; the providers are the host's own. */
function capabilityCatalog() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const install = (bytes: Uint8Array): PackIdentity =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "gp16" },
    });
  return {
    catalog,
    ops: install(opsBytes),
    opsV2: install(opsV2Bytes),
    needs: install(needsBytes),
    mode: install(modeBytes),
    flow: install(flowBytes),
  };
}

const fakeProvider = { id: "fake", version: "1" };
const missingMessage =
  "Pack org.example.needs@1.0.0 capability capabilities/publish requires operation github.merge_pr, which no registered provider offers";

function tableCounts(
  host: Awaited<ReturnType<typeof start>>,
  tables: readonly string[],
): number[] {
  const database = new Database(host.runtimePaths.projectDatabasePath, {
    readonly: true,
  });
  try {
    return tables.map(
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
}

const controlledTables = [
  "resources",
  "capability_grants",
  "action_requests",
  "action_approvals",
  "action_simulations",
  "action_executions",
];

describe("GP-16 pack capability contracts over the Runtime socket", () => {
  test("show reports bound and unbound optional operations; preview and apply refuse a missing or mismatched provider; an upgrade carries a contract change", async () => {
    const workspace = temporaryRoot("ai-office-gp16-e2e-");
    const root = checkout(workspace, "project");
    const { catalog, ops, opsV2, needs, mode } = capabilityCatalog();
    const host = await start(join(workspace, "runtime"), catalog);
    let projectId = "";
    const command = (name: string, ...options: string[]) =>
      host.run(root, [name, "--project", projectId, ...options, "--json"]);
    const packs = (selection: PackIdentity[]) => [
      "--packs",
      JSON.stringify(selection),
    ];
    const audits = (eventType: string) => {
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return database
          .query<{ payload_json: string }, [string]>(
            "SELECT payload_json FROM audit_event WHERE event_type = ? ORDER BY rowid",
          )
          .all(eventType)
          .map((row) => JSON.parse(row.payload_json) as unknown);
      } finally {
        database.close();
      }
    };
    try {
      projectId = await installProject(host, root);

      // Refusal: a required operation no provider of this host offers.
      const preview = await command("project:pack:preview", ...packs([needs]));
      expect(preview.exitCode).toBe(1);
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        added: [needs],
        issues: [
          {
            code: "missing_required_capability_provider",
            message: missingMessage,
          },
        ],
      });
      const rejected = await command(
        "project:pack:apply",
        ...packs([needs]),
        "--expected-revision",
        "0",
      );
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).toEqual([]);
      expect(rejected.stderr).toEqual([missingMessage]);
      // Refusal: the provider offers the operation in another mode.
      const mismatched = await command(
        "project:pack:preview",
        ...packs([mode]),
      );
      expect(mismatched.exitCode).toBe(1);
      expect(JSON.parse(mismatched.stdout[0]!)).toMatchObject({
        issues: [{ code: "capability_provider_mismatch" }],
      });
      expect(
        (
          await command(
            "project:pack:apply",
            ...packs([mode]),
            "--expected-revision",
            "0",
          )
        ).stderr,
      ).toEqual([
        "Pack org.example.mode@1.0.0 capability capabilities/publish declares operation fake.write in a mode that differs from its registered provider",
      ]);
      expect(
        JSON.parse((await command("project:pack:show")).stdout[0]!),
      ).toMatchObject({ configurationRevision: 0, packs: [] });
      expect(audits("project.pack_binding_applied")).toEqual([]);

      // Bound: the fake connector of the default registry provides it.
      expect(
        (await command("project:pack:preview", ...packs([ops]))).exitCode,
      ).toBe(0);
      const applied = await command(
        "project:pack:apply",
        ...packs([ops]),
        "--expected-revision",
        "0",
      );
      expect(applied.exitCode).toBe(0);
      const shown = await command("project:configuration:show");
      expect(shown.exitCode).toBe(0);
      const configuration = (
        JSON.parse(shown.stdout[0]!) as {
          configuration: {
            configurationDigest: string;
            pin: unknown;
            capabilities: unknown;
          };
        }
      ).configuration;
      expect(configuration.capabilities).toEqual([
        {
          capabilityId: "pack:org.example.ops/capabilities/extras",
          requirement: "optional",
          operations: [
            { ...write, binding: "bound", provider: fakeProvider },
            { ...merge, binding: "unbound_optional" },
          ],
        },
        {
          capabilityId: "pack:org.example.ops/capabilities/publish",
          requirement: "required",
          operations: [{ ...read, binding: "bound", provider: fakeProvider }],
        },
      ]);
      expect(JSON.stringify(configuration.pin)).not.toContain("provider");

      // A contract change is refused by apply and carried by upgrade.
      const refused = await command(
        "project:pack:apply",
        ...packs([opsV2]),
        "--expected-revision",
        "1",
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toEqual([
        "The selection changes the operation contract of capability pack:org.example.ops/capabilities/publish; review and approve it with project:pack:upgrade",
      ]);
      const planned = await command("project:pack:upgrade", ...packs([opsV2]));
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout[0]!) as {
        planDigest: string;
        capabilityContractChanges: unknown;
      };
      const contractChanges = {
        availability: "available",
        changes: [
          {
            capabilityId: "pack:org.example.ops/capabilities/publish",
            addedOperations: [write],
            removedOperations: [],
            requirement: { before: "required", after: "required" },
          },
        ],
      };
      expect(plan.capabilityContractChanges).toEqual(contractChanges);
      expect(audits("project.pack_upgrade_applied")).toEqual([]);
      const upgraded = await command(
        "project:pack:upgrade",
        ...packs([opsV2]),
        "--approve",
        plan.planDigest,
      );
      expect(upgraded.exitCode).toBe(0);
      expect(JSON.parse(upgraded.stdout[0]!)).toMatchObject({
        result: "applied",
        packs: [opsV2],
      });
      expect(audits("project.pack_upgrade_applied")).toMatchObject([
        {
          planDigest: plan.planDigest,
          capabilityContractChanges: contractChanges,
        },
      ]);
      const after = JSON.parse(
        (await command("project:configuration:show")).stdout[0]!,
      ) as { configuration: { capabilities: { operations: unknown[] }[] } };
      expect(after.configuration.capabilities[1]).toMatchObject({
        capabilityId: "pack:org.example.ops/capabilities/publish",
        operations: [
          { ...read, binding: "bound", provider: fakeProvider },
          { ...write, binding: "bound", provider: fakeProvider },
        ],
      });

      // An upgrade to a target whose provider is missing is blocked.
      const blocked = await command("project:pack:upgrade", ...packs([needs]));
      expect(blocked.exitCode).toBe(1);
      const blockedPlan = JSON.parse(blocked.stdout[0]!) as {
        planDigest: string;
        issues: unknown;
      };
      expect(blockedPlan.issues).toMatchObject([
        {
          code: "prospective_configuration_invalid",
          detail: "missing_required_capability_provider",
        },
      ]);
      const refusedUpgrade = await command(
        "project:pack:upgrade",
        ...packs([needs]),
        "--approve",
        blockedPlan.planDigest,
      );
      expect(refusedUpgrade.exitCode).toBe(1);
      expect(refusedUpgrade.stdout).toEqual([]);
      expect(refusedUpgrade.stderr[0]).toContain(missingMessage);
      expect(audits("project.pack_upgrade_applied")).toHaveLength(1);
      expect(audits("project.pack_binding_applied")).toHaveLength(1);
      // Nothing in this flow registered a resource, a grant or an action.
      expect(tableCounts(host, controlledTables)).toEqual(
        controlledTables.map(() => 0),
      );
    } finally {
      await host.stop();
    }
  });

  test("project:restore accepts a binding whose required provider is absent on the target, and resolution then fails closed", async () => {
    const workspace = temporaryRoot("ai-office-gp16-restore-e2e-");
    const sourceRoot = checkout(workspace, "source");
    const archivePath = join(workspace, "project.aioffice");
    const { catalog, needs, flow } = capabilityCatalog();

    // The source binds a pack it can resolve and disables its workflow, which
    // is what the exporter writes as format 9.
    const source = await start(join(workspace, "source-runtime"), catalog);
    try {
      const projectId = await installProject(source, sourceRoot);
      const run = async (args: string[]) => {
        const result = await source.run(sourceRoot, [...args, "--json"]);
        expect(result.stderr).toEqual([]);
        expect(result.exitCode).toBe(0);
      };
      await run([
        "project:pack:apply",
        "--project",
        projectId,
        "--packs",
        JSON.stringify([flow]),
        "--expected-revision",
        "0",
      ]);
      await run([
        "project:definition:apply",
        "--project",
        projectId,
        "--mutation",
        JSON.stringify({
          action: "put_override",
          source: { ...flow, kind: "workflows", localId: "draft" },
          operation: "disable",
        }),
        "--expected-revision",
        "0",
      ]);
      await run(["project:backup", "--output", archivePath]);
    } finally {
      await source.stop();
    }

    // No command on a host without the provider can bind `needs`, so the
    // archive is given the tuple and fresh checksums, as a host that has the
    // provider would have written it.
    const archive = JSON.parse(
      readFileSync(archivePath, "utf8"),
    ) as PortableProjectArchive;
    expect(archive.manifest.formatVersion).toBe(9);
    const selection = [flow, needs].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const state = {
      ...archive.state,
      packBinding: { configurationRevision: 2, packs: selection },
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

    // The pack is installed on the target; only its provider is not.
    const targetRoot = checkout(workspace, "target");
    const target = await start(join(workspace, "target-runtime"), catalog);
    try {
      const restored = await target.run(targetRoot, [
        "project:restore",
        archivePath,
        "--json",
      ]);
      expect(restored.stderr).toEqual([]);
      expect(restored.exitCode).toBe(0);
      const result = JSON.parse(restored.stdout[0]!) as {
        outcome: string;
        projectId: string;
      };
      expect(result.outcome).toBe("restored");
      expect(existsSync(join(targetRoot, ".ai-office", "project.json"))).toBe(
        true,
      );
      const shown = await target.run(targetRoot, [
        "project:pack:show",
        "--project",
        result.projectId,
        "--json",
      ]);
      expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
        configurationRevision: 2,
        packs: selection,
      });
      // Show failing required: a typed diagnostic and no view.
      const configuration = await target.run(targetRoot, [
        "project:configuration:show",
        "--project",
        result.projectId,
        "--json",
      ]);
      expect(configuration.exitCode).toBe(1);
      expect(JSON.parse(configuration.stdout[0]!)).toEqual({
        ok: false,
        diagnostics: [
          {
            code: "missing_required_capability_provider",
            message: missingMessage,
          },
        ],
      });
      expect(tableCounts(target, controlledTables)).toEqual(
        controlledTables.map(() => 0),
      );
    } finally {
      await target.stop();
    }
  });
});
