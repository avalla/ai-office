import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
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

// GP-25 over the Runtime's Unix socket: every command below is sent by the
// CLI client to one Runtime host. The packs exist only in a catalog this
// test supplies; the production catalog holds none.

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

const encoder = new TextEncoder();
const packId = "org.example.governed";

function packBytes(version: string, operations: string[]): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id: packId,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Governed", description: "Policy e2e fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(
        contributionKinds.map((kind) => [kind, [] as unknown[]]),
      ),
      roles: [{ id: "author" }, { id: "reviewer" }],
      taskTypes: [{ id: "change" }],
      workflows: [
        {
          id: "delivery",
          title: "Delivery",
          taskType: "change",
          stages: [
            { id: "implement", role: "author" },
            { id: "review", role: "reviewer" },
          ],
        },
      ],
      policies: [
        {
          id: "delivery-governance",
          title: "Delivery governance",
          workflow: "delivery",
          enforcement: "enforced",
          stages: [
            {
              stage: "review",
              requiresApproval: true,
              requiresIndependentApproval: true,
              requiresDifferentAgentFrom: ["implement"],
              operations,
            },
          ],
        },
      ],
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

function governedCatalog() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const register = (bytes: Uint8Array): PackIdentity =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "gp25" },
    });
  return {
    catalog,
    v1: register(packBytes("1.0.0", ["filesystem.read"])),
    v2: register(packBytes("2.0.0", ["filesystem.read", "git:commit"])),
  };
}

/** One Runtime host on its own socket; every command crosses that socket. */
async function start(
  runtimeRoot: string,
  installedPacks: InstalledDomainPackCatalog,
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
    installedPacks,
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

const policyOf = (operations: string[]) => ({
  policyId: `pack:${packId}/policies/delivery-governance`,
  workflowId: `pack:${packId}/workflows/delivery`,
  enforcement: "enforced",
  stages: [
    {
      stage: "review",
      requiresApproval: true,
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: ["implement"],
      operations,
    },
  ],
});

describe("GP-25 pack policy contributions over the Runtime socket", () => {
  test("project:configuration:show lists policies, project:definition:apply refuses a replacement that drops a governed stage, project:pack:apply refuses a policy change and project:pack:upgrade carries it out", async () => {
    const workspace = temporaryRoot("ai-office-gp25-e2e-");
    const root = join(workspace, "project");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"name":"gp25"}\n');
    const { catalog, v1, v2 } = governedCatalog();
    const host = await start(join(workspace, "runtime"), catalog);
    let projectId = "";
    const command = (name: string, ...options: string[]) =>
      host.run(root, [name, "--project", projectId, ...options, "--json"]);
    const count = (sql: string) => {
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return database.query<{ count: number }, []>(sql).get()!.count;
      } finally {
        database.close();
      }
    };
    const events = (eventType: string) =>
      count(
        `SELECT count(*) AS count FROM audit_event WHERE event_type='${eventType}'`,
      );
    const upgradePayload = () => {
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return JSON.parse(
          database
            .query<{ payload_json: string }, []>(
              "SELECT payload_json FROM audit_event WHERE event_type='project.pack_upgrade_applied'",
            )
            .get()!.payload_json,
        ) as Record<string, unknown>;
      } finally {
        database.close();
      }
    };
    const replace = (pack: PackIdentity, stages: object[]) =>
      JSON.stringify({
        action: "put_override",
        source: { ...pack, kind: "workflows", localId: "delivery" },
        operation: "replace",
        payload: { id: "delivery", taskType: "change", stages },
      });
    try {
      const installed = await host.run(root, ["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.exitCode);
      projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;

      // Selecting a governed pack is an explicit addition and is applied.
      const firstPreview = await command(
        "project:pack:preview",
        "--packs",
        JSON.stringify([v1]),
      );
      expect(firstPreview.exitCode).toBe(0);
      expect(JSON.parse(firstPreview.stdout[0]!)).toMatchObject({
        issues: [],
        policyChanges: {
          availability: "available",
          changes: [
            {
              workflowId: `pack:${packId}/workflows/delivery`,
              change: "added",
              after: policyOf(["filesystem.read"]),
            },
          ],
        },
      });
      expect(
        (
          await command(
            "project:pack:apply",
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
          )
        ).exitCode,
      ).toBe(0);

      // The derived view lists the policy with stable identities.
      const shown = await command("project:configuration:show");
      expect(shown.exitCode).toBe(0);
      const configuration = (
        JSON.parse(shown.stdout[0]!) as {
          ok: boolean;
          configuration: { policies: unknown[]; workflows: object[] };
        }
      ).configuration;
      expect(configuration.policies).toEqual([
        {
          ...policyOf(["filesystem.read"]),
          effectiveId: `pack:${v1.id}@${v1.version}#${v1.manifestDigest}/policies/delivery-governance`,
          origin: "pack_owned",
          title: "Delivery governance",
          state: "active",
        },
      ]);
      // The workflow view still declares no approval or guard.
      expect(JSON.stringify(configuration.workflows)).not.toMatch(
        /requiresApproval|enforcement|operations/,
      );

      // A replacement that drops the governed stage: reported, then refused.
      const dropped = replace(v1, [{ id: "implement", role: "author" }]);
      const message =
        "Workflow workflows/delivery must keep stage review, which policy policies/delivery-governance of exact source governs";
      const definitionPreview = await command(
        "project:definition:preview",
        "--mutation",
        dropped,
      );
      expect(definitionPreview.exitCode).toBe(1);
      expect(JSON.parse(definitionPreview.stdout[0]!)).toMatchObject({
        issues: [{ code: "policy_target_missing", message }],
      });
      const definitionApply = await command(
        "project:definition:apply",
        "--mutation",
        dropped,
        "--expected-revision",
        "0",
      );
      expect(definitionApply.exitCode).toBe(1);
      expect(definitionApply.stdout).toEqual([]);
      expect(definitionApply.stderr).toEqual([message]);
      expect(
        count("SELECT count(*) AS count FROM project_definition_override"),
      ).toBe(0);
      expect(events("project.definition_changed")).toBe(0);
      // A governance key in the payload is refused as well.
      const weakened = await command(
        "project:definition:apply",
        "--mutation",
        replace(v1, [
          { id: "implement", role: "author" },
          { id: "review", role: "reviewer", requiresApproval: false },
        ]),
        "--expected-revision",
        "0",
      );
      expect(weakened.exitCode).toBe(1);
      expect(weakened.stdout).toEqual([]);
      // The refusal is the governance one, not any other rejection.
      expect(weakened.stderr).toEqual([
        "Workflow stage cannot declare governance; a pack policy does",
      ]);
      expect(
        count("SELECT count(*) AS count FROM project_definition_override"),
      ).toBe(0);
      expect(events("project.definition_changed")).toBe(0);
      // One that keeps it and adds a stage is stored.
      expect(
        (
          await command(
            "project:definition:apply",
            "--mutation",
            replace(v1, [
              { id: "implement", role: "author" },
              { id: "document", role: "author" },
              { id: "review", role: "reviewer" },
            ]),
            "--expected-revision",
            "0",
          )
        ).exitCode,
      ).toBe(0);

      // A version that changes the policy is not a plain selection change.
      const refusal = `The selection changes the policy of workflow pack:${packId}/workflows/delivery; review and approve it with project:pack:upgrade`;
      const packPreview = await command(
        "project:pack:preview",
        "--packs",
        JSON.stringify([v2]),
      );
      expect(packPreview.exitCode).toBe(1);
      expect(JSON.parse(packPreview.stdout[0]!)).toMatchObject({
        issues: [{ code: "policy_change_requires_upgrade", message: refusal }],
        policyChanges: {
          availability: "available",
          changes: [
            {
              workflowId: `pack:${packId}/workflows/delivery`,
              change: "changed",
              before: policyOf(["filesystem.read"]),
              after: policyOf(["filesystem.read", "git:commit"]),
            },
          ],
        },
      });
      const packApply = await command(
        "project:pack:apply",
        "--packs",
        JSON.stringify([v2]),
        "--expected-revision",
        "1",
      );
      expect(packApply.exitCode).toBe(1);
      expect(packApply.stdout).toEqual([]);
      expect(packApply.stderr).toEqual([refusal]);
      expect(
        JSON.parse((await command("project:pack:show")).stdout[0]!),
      ).toMatchObject({ configurationRevision: 1, packs: [v1] });
      expect(events("project.pack_binding_applied")).toBe(1);

      // The reviewed upgrade reports the change and applies it once approved.
      const planned = await command(
        "project:pack:upgrade",
        "--packs",
        JSON.stringify([v2]),
      );
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout[0]!) as {
        planDigest: string;
        policyChanges: unknown;
        targetPolicies: unknown;
      };
      expect(plan).toMatchObject({
        issues: [],
        policyChanges: {
          availability: "available",
          changes: [
            {
              workflowId: `pack:${packId}/workflows/delivery`,
              change: "changed",
              before: policyOf(["filesystem.read"]),
              after: policyOf(["filesystem.read", "git:commit"]),
              customized: true,
            },
          ],
        },
        targetPolicies: [policyOf(["filesystem.read", "git:commit"])],
      });
      expect(events("project.pack_upgrade_applied")).toBe(0);
      const upgraded = await command(
        "project:pack:upgrade",
        "--packs",
        JSON.stringify([v2]),
        "--approve",
        plan.planDigest,
      );
      expect(upgraded.exitCode).toBe(0);
      expect(JSON.parse(upgraded.stdout[0]!)).toMatchObject({
        result: "applied",
        packs: [v2],
      });
      expect(upgradePayload()).toMatchObject({
        policyChanges: plan.policyChanges,
        targetPolicies: plan.targetPolicies,
      });
      expect(JSON.stringify(upgradePayload())).not.toContain(
        "Delivery governance",
      );

      const after = await command("project:configuration:show");
      expect(after.exitCode).toBe(0);
      expect(JSON.parse(after.stdout[0]!)).toMatchObject({
        ok: true,
        configuration: {
          policies: [
            {
              ...policyOf(["filesystem.read", "git:commit"]),
              state: "active",
            },
          ],
          workflows: [
            {
              customization: "replace",
              stages: [
                { id: "implement" },
                { id: "document" },
                { id: "review" },
              ],
            },
          ],
        },
      });
      // Nothing was started from the policy.
      for (const table of ["pipeline_run", "pipeline_stage_run", "approval"])
        expect([
          table,
          count(`SELECT count(*) AS count FROM ${table}`),
        ]).toEqual([table, 0]);
    } finally {
      await host.stop();
    }
  });
});
