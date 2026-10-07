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

// GP-14A over the Runtime's Unix socket: every command below is sent by the
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
const packId = "org.example.evidence";

const schema = {
  type: "object",
  properties: { verified: { type: "boolean" } },
};

function packBytes(version: string, adapterVersion: string): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id: packId,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: {
      name: "Evidence",
      description: "Evidence contract e2e fixture",
    },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(
        contributionKinds.map((kind) => [kind, [] as unknown[]]),
      ),
      artifactTypes: [
        {
          id: "filing",
          title: "Court filing",
          mediaTypes: ["application/pdf"],
          maximumBytes: 1_000_000,
          contentSchema: schema,
        },
      ],
      evidenceTypes: [
        { id: "citation-check", subject: "filing", payloadSchema: schema },
      ],
      validators: [
        {
          id: "cite-checker",
          title: "Citation checker",
          adapter: { id: "legal.citations", version: adapterVersion },
          accepts: [{ kind: "artifactTypes", id: "filing" }],
          inputSchema: schema,
          produces: "citation-check",
          outputSchema: schema,
          failurePolicy: "fail_closed",
          timeoutMs: 30_000,
          maxInputBytes: 1_000_000,
          maxOutputBytes: 65_536,
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

function evidenceCatalog() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const register = (bytes: Uint8Array): PackIdentity =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "gp14a" },
    });
  return {
    catalog,
    v1: register(packBytes("1.0.0", "1.0.0")),
    v2: register(packBytes("2.0.0", "1.1.0")),
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

const validatorId = `pack:${packId}/validators/cite-checker`;
const checker = (version: string) => ({
  contractId: validatorId,
  kind: "validators",
  adapter: { id: "legal.citations", version },
  accepts: [{ kind: "artifactTypes", id: "filing" }],
  inputSchema: schema,
  produces: "citation-check",
  outputSchema: schema,
  failurePolicy: "fail_closed",
  timeoutMs: 30_000,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 65_536,
});

describe("GP-14A evidence contracts over the Runtime socket", () => {
  test("an unavailable previous closure makes pure removal require an approved upgrade", async () => {
    const workspace = temporaryRoot("ai-office-gp130-e2e-");
    const root = join(workspace, "project");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"name":"gp130"}\n');
    const { catalog: installed, v1 } = evidenceCatalog();
    const unavailable = new InMemoryInstalledDomainPackCatalog(1, []);
    let active: InstalledDomainPackCatalog = installed;
    const catalog: InstalledDomainPackCatalog = {
      coreContractVersion: 1,
      read: (id, version) => active.read(id, version),
      list: () => active.list(),
      trusts: (provenance) => active.trusts(provenance),
    };
    const host = await start(join(workspace, "runtime"), catalog);
    try {
      const installedResult = await host.run(root, ["install", ".", "--json"]);
      expect([0, 2]).toContain(installedResult.exitCode);
      const projectId = (
        JSON.parse(installedResult.stdout[0]!) as {
          project: { id: string };
        }
      ).project.id;
      const command = (name: string, ...options: string[]) =>
        host.run(root, [name, "--project", projectId, ...options, "--json"]);
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
      active = unavailable;
      const preview = await command("project:pack:preview", "--packs", "[]");
      expect(preview.exitCode).toBe(1);
      const unavailableComparison = {
        availability: "unavailable",
        reason: "previous_closure_unresolved",
        detail: "missing_pack",
      };
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        issues: [{ code: "role_capability_change_requires_upgrade" }],
        policyChanges: unavailableComparison,
        evidenceContractChanges: unavailableComparison,
      });
      const refused = await command(
        "project:pack:apply",
        "--packs",
        "[]",
        "--expected-revision",
        "1",
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr[0]).toContain("project:pack:upgrade");
      expect(
        JSON.parse((await command("project:pack:show")).stdout[0]!),
      ).toMatchObject({ configurationRevision: 1, packs: [v1] });
      const planned = await command("project:pack:upgrade", "--packs", "[]");
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout[0]!) as { planDigest: string };
      expect(plan).toMatchObject({
        removed: [v1],
        issues: [],
        policyChanges: unavailableComparison,
        evidenceContractChanges: unavailableComparison,
      });
      expect(
        (
          await command(
            "project:pack:upgrade",
            "--packs",
            "[]",
            "--approve",
            "sha256:wrong",
          )
        ).exitCode,
      ).toBe(1);
      expect(
        JSON.parse((await command("project:pack:show")).stdout[0]!),
      ).toMatchObject({ configurationRevision: 1, packs: [v1] });
      const approved = await command(
        "project:pack:upgrade",
        "--packs",
        "[]",
        "--approve",
        plan.planDigest,
      );
      expect(approved.exitCode).toBe(0);
      expect(JSON.parse(approved.stdout[0]!)).toMatchObject({
        result: "applied",
        packs: [],
      });
      const database = new Database(host.runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        const row = database
          .query<{ payload_json: string }, []>(
            "SELECT payload_json FROM audit_event WHERE event_type='project.pack_upgrade_applied'",
          )
          .get();
        expect(JSON.parse(row!.payload_json)).toMatchObject({
          previousClosureUnavailableRemoval: {
            removedPacks: [v1],
            reason: "previous_closure_unresolved",
            detail: "missing_pack",
            approvedPlanDigest: plan.planDigest,
          },
        });
      } finally {
        database.close();
      }
    } finally {
      await host.stop();
    }
  });

  test("project:configuration:show lists the three views, project:definition:apply refuses a typed key, project:pack:apply refuses a contract change and project:pack:upgrade carries it out", async () => {
    const workspace = temporaryRoot("ai-office-gp14a-e2e-");
    const root = join(workspace, "project");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"name":"gp14a"}\n');
    const { catalog, v1, v2 } = evidenceCatalog();
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
    try {
      const installed = await host.run(root, ["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.exitCode);
      projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;

      // Selecting a pack with contracts is an explicit addition.
      const firstPreview = await command(
        "project:pack:preview",
        "--packs",
        JSON.stringify([v1]),
      );
      expect(firstPreview.exitCode).toBe(0);
      expect(JSON.parse(firstPreview.stdout[0]!)).toMatchObject({
        issues: [],
        evidenceContractChanges: {
          availability: "available",
          changes: [
            {
              contractId: `pack:${packId}/artifactTypes/filing`,
              change: "added",
            },
            {
              contractId: `pack:${packId}/evidenceTypes/citation-check`,
              change: "added",
            },
            { contractId: validatorId, change: "added" },
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

      // The derived views list the contracts with stable identities.
      const shown = await command("project:configuration:show");
      expect(shown.exitCode).toBe(0);
      const configuration = (
        JSON.parse(shown.stdout[0]!) as {
          configuration: {
            artifactTypes: unknown[];
            evidenceTypes: unknown[];
            validators: unknown[];
          };
        }
      ).configuration;
      expect(configuration.artifactTypes).toEqual([
        {
          kind: "artifactTypes",
          definitionId: `pack:${packId}/artifactTypes/filing`,
          effectiveId: `pack:${v1.id}@${v1.version}#${v1.manifestDigest}/artifactTypes/filing`,
          origin: "pack_owned",
          title: "Court filing",
          mediaTypes: ["application/pdf"],
          maximumBytes: 1_000_000,
          contentSchema: schema,
        },
      ]);
      expect(configuration.evidenceTypes).toEqual([
        {
          kind: "evidenceTypes",
          definitionId: `pack:${packId}/evidenceTypes/citation-check`,
          effectiveId: `pack:${v1.id}@${v1.version}#${v1.manifestDigest}/evidenceTypes/citation-check`,
          origin: "pack_owned",
          subject: "filing",
          payloadSchema: schema,
        },
      ]);
      expect(configuration.validators).toEqual([
        {
          kind: "validators",
          definitionId: validatorId,
          effectiveId: `pack:${v1.id}@${v1.version}#${v1.manifestDigest}/validators/cite-checker`,
          origin: "pack_owned",
          title: "Citation checker",
          registration: "unchecked",
          adapter: { id: "legal.citations", version: "1.0.0" },
          accepts: [{ kind: "artifactTypes", id: "filing" }],
          inputSchema: schema,
          produces: "citation-check",
          outputSchema: schema,
          failurePolicy: "fail_closed",
          timeoutMs: 30_000,
          maxInputBytes: 1_000_000,
          maxOutputBytes: 65_536,
        },
      ]);

      // A typed key in a project payload is refused, and nothing is written.
      const typedKey = await command(
        "project:definition:apply",
        "--mutation",
        JSON.stringify({
          action: "put_override",
          source: { ...v1, kind: "artifactTypes", localId: "filing" },
          operation: "replace",
          payload: { id: "filing", mediaTypes: ["text/plain"] },
        }),
        "--expected-revision",
        "0",
      );
      expect(typedKey.exitCode).toBe(1);
      expect(typedKey.stdout).toEqual([]);
      expect(typedKey.stderr).toEqual([
        "Definition payload may contain only its exact ID and descriptive fields",
      ]);
      expect(
        count("SELECT count(*) AS count FROM project_definition_override"),
      ).toBe(0);
      expect(events("project.definition_changed")).toBe(0);

      // A contract change is not a plain selection change.
      const refusal = `The selection changes the contract of ${validatorId}; review and approve it with project:pack:upgrade`;
      const packPreview = await command(
        "project:pack:preview",
        "--packs",
        JSON.stringify([v2]),
      );
      expect(packPreview.exitCode).toBe(1);
      expect(JSON.parse(packPreview.stdout[0]!)).toMatchObject({
        issues: [
          {
            code: "evidence_contract_change_requires_upgrade",
            message: refusal,
          },
        ],
        evidenceContractChanges: {
          availability: "available",
          changes: [
            {
              contractId: validatorId,
              change: "changed",
              before: checker("1.0.0"),
              after: checker("1.1.0"),
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
        evidenceContractChanges: unknown;
        targetEvidenceContracts: unknown[];
      };
      expect(plan).toMatchObject({
        issues: [],
        evidenceContractChanges: {
          availability: "available",
          changes: [
            {
              contractId: validatorId,
              change: "changed",
              before: checker("1.0.0"),
              after: checker("1.1.0"),
            },
          ],
        },
      });
      expect(plan.targetEvidenceContracts).toHaveLength(3);
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
      const recorded = JSON.stringify(upgradePayload());
      expect(recorded).toContain("1.1.0");
      for (const body of ["Court filing", "application/pdf", "verified"])
        expect(recorded).not.toContain(body);

      const after = await command("project:configuration:show");
      expect(after.exitCode).toBe(0);
      expect(JSON.parse(after.stdout[0]!)).toMatchObject({
        configuration: {
          validators: [
            {
              definitionId: validatorId,
              registration: "unchecked",
              adapter: { id: "legal.citations", version: "1.1.0" },
            },
          ],
        },
      });
      // Nothing was started, registered or run from a declaration.
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
