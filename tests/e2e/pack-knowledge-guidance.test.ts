import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import type { AgentKnowledgeStore } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import type { AgentKnowledgeConfiguration } from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";
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

// GP-15 over the Runtime's Unix socket: every command below is sent by the
// CLI client to one Runtime host whose agent knowledge store is a recording
// stub that fails every call. The packs exist only in a catalog this test
// supplies; the production catalog holds none.

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
const packId = "org.example.library";

const guidance = (maxResults: number) => ({
  category: "clauses",
  schema: [
    { field: "jurisdiction", description: "Where the clause applies" },
    { field: "clause", description: "The clause text" },
  ],
  seeds: ["seed:clauses/standard", "file:///etc/passwd"],
  retrieval: { maxResults, hint: "Prefer the matter's law" },
});

function packBytes(version: string, maxResults: number): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id: packId,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Library", description: "Knowledge e2e fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(
        contributionKinds.map((kind) => [kind, [] as unknown[]]),
      ),
      roles: [{ id: "curator" }],
      agents: [{ id: "librarian", role: "curator", knowledge: ["clauses"] }],
      knowledge: [
        {
          id: "clauses",
          title: "Clauses",
          ...guidance(maxResults),
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

function libraryCatalog() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const register = (bytes: Uint8Array): PackIdentity =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "gp15" },
    });
  return {
    catalog,
    v1: register(packBytes("1.0.0", 3)),
    v2: register(packBytes("2.0.0", 2)),
  };
}

/**
 * An agent knowledge store that records every property read and fails every
 * call: a Runtime that reaches the store through the pack flow is caught.
 */
function recordingStore() {
  const touched: string[] = [];
  const store = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(String(property));
        return () => {
          throw new Error("agent knowledge store must not be called");
        };
      },
    },
  ) as AgentKnowledgeStore;
  return { store, touched };
}

const knowledgeConfiguration: AgentKnowledgeConfiguration = {
  kind: "surrealdb",
  tenantId: "tenant-a",
  connection: {
    endpoint: "ws://127.0.0.1:8000",
    namespace: "ai_office",
    database: "knowledge",
    username: "operator",
    password: "secret",
  },
};

/** One Runtime host on its own socket; every command crosses that socket. */
async function start(
  runtimeRoot: string,
  installedPacks: InstalledDomainPackCatalog,
  store: AgentKnowledgeStore,
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
    agentKnowledgeConfiguration: knowledgeConfiguration,
    connectAgentKnowledge: async () => ({ store, close: async () => {} }),
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

const reported = (maxResults: number) => ({
  knowledgeId: `pack:${packId}/knowledge/clauses`,
  category: "clauses",
  schema: [
    { field: "clause", description: "The clause text" },
    { field: "jurisdiction", description: "Where the clause applies" },
  ],
  seeds: ["file:///etc/passwd", "seed:clauses/standard"],
  retrieval: { maxResults, hint: "Prefer the matter's law" },
});

function checkout(workspace: string, name: string): string {
  const root = join(workspace, name);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"name":"gp15"}\n');
  return root;
}

describe("GP-15 pack knowledge guidance over the Runtime socket", () => {
  test("show, definition, upgrade and restore carry the guidance and never reach the knowledge store", async () => {
    const workspace = temporaryRoot("ai-office-gp15-e2e-");
    const root = checkout(workspace, "project");
    const { catalog, v1, v2 } = libraryCatalog();
    const { store, touched } = recordingStore();
    const host = await start(join(workspace, "runtime"), catalog, store);
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
    const replace = (payload: object) =>
      JSON.stringify({
        action: "put_override",
        source: { ...v1, kind: "knowledge", localId: "clauses" },
        operation: "replace",
        payload,
      });
    try {
      const installed = await host.run(root, ["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.exitCode);
      projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;
      // Setup may talk to the store; the pack flow below must not.
      touched.length = 0;

      const applied = await command(
        "project:pack:apply",
        "--packs",
        JSON.stringify([v1]),
        "--expected-revision",
        "0",
      );
      expect(applied.exitCode).toBe(0);

      // The derived view lists the guidance, sets in one order.
      const shown = await command("project:configuration:show");
      expect(shown.exitCode).toBe(0);
      const configuration = (
        JSON.parse(shown.stdout[0]!) as {
          configuration: {
            knowledge: unknown[];
            agents: { knowledge: string[] }[];
          };
        }
      ).configuration;
      expect(configuration.knowledge).toEqual([
        {
          ...reported(3),
          effectiveId: `pack:${v1.id}@${v1.version}#${v1.manifestDigest}/knowledge/clauses`,
          origin: "pack_owned",
          title: "Clauses",
          customization: "none",
        },
      ]);
      expect(configuration.agents[0]!.knowledge).toEqual([
        `pack:${packId}/knowledge/clauses`,
      ]);

      // A guidance key in a project payload is refused; nothing is written.
      for (const [payload, message] of [
        [
          { id: "clauses", seeds: ["seed:injected"] },
          "Knowledge guidance is declared by the pack; a project cannot declare it",
        ],
        [
          { id: "clauses", category: "other" },
          "Knowledge guidance is declared by the pack; a project cannot declare it",
        ],
        [
          { id: "clauses", retrieval: { maxResults: 5 } },
          "Knowledge guidance is declared by the pack; a project cannot declare it",
        ],
        // A scope key is not guidance at all: the allowlist refuses it.
        [
          { id: "clauses", tenantId: "tenant-b" },
          "Definition payload may contain only its exact ID and descriptive fields",
        ],
      ] as const) {
        const refused = await command(
          "project:definition:apply",
          "--mutation",
          replace(payload),
          "--expected-revision",
          "0",
        );
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toEqual([]);
        expect(refused.stderr).toEqual([message]);
      }
      expect(
        count("SELECT count(*) AS count FROM project_definition_override"),
      ).toBe(0);
      expect(events("project.definition_changed")).toBe(0);
      // A descriptive replacement is stored, and the guidance stays the pack's.
      expect(
        (
          await command(
            "project:definition:apply",
            "--mutation",
            replace({ id: "clauses", title: "Project clauses" }),
            "--expected-revision",
            "0",
          )
        ).exitCode,
      ).toBe(0);

      // A version that changes the guidance is not a plain selection change.
      const refusal = `The selection changes the guidance of knowledge pack:${packId}/knowledge/clauses; review and approve it with project:pack:upgrade`;
      const preview = await command(
        "project:pack:preview",
        "--packs",
        JSON.stringify([v2]),
      );
      expect(preview.exitCode).toBe(1);
      expect(JSON.parse(preview.stdout[0]!)).toMatchObject({
        issues: [
          { code: "knowledge_change_requires_upgrade", message: refusal },
        ],
        knowledgeChanges: {
          availability: "available",
          changes: [
            {
              knowledgeId: `pack:${packId}/knowledge/clauses`,
              change: "changed",
              before: reported(3),
              after: reported(2),
            },
          ],
        },
      });
      const refused = await command(
        "project:pack:apply",
        "--packs",
        JSON.stringify([v2]),
        "--expected-revision",
        "1",
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toEqual([]);
      expect(refused.stderr).toEqual([refusal]);
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
        knowledgeChanges: unknown;
        targetKnowledge: unknown;
      };
      expect(plan).toMatchObject({
        issues: [],
        knowledgeChanges: {
          availability: "available",
          changes: [
            {
              knowledgeId: `pack:${packId}/knowledge/clauses`,
              change: "changed",
              before: reported(3),
              after: reported(2),
              customized: true,
            },
          ],
        },
        targetKnowledge: [reported(2)],
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
      expect(upgradePayload()).toMatchObject({
        knowledgeChanges: plan.knowledgeChanges,
        targetKnowledge: plan.targetKnowledge,
      });
      expect(JSON.stringify(upgradePayload())).not.toContain("Project clauses");
      const after = await command("project:configuration:show");
      expect(JSON.parse(after.stdout[0]!)).toMatchObject({
        configuration: {
          knowledge: [
            {
              ...reported(2),
              title: "Project clauses",
              customization: "replace",
            },
          ],
        },
      });

      // Backup and restore on another host with the same installed closure.
      const archive = join(workspace, "project.aioffice");
      const backedUp = await command("project:backup", "--output", archive);
      expect(backedUp.exitCode).toBe(0);
      const restoreRoot = checkout(workspace, "restored");
      const second = await start(join(workspace, "runtime-2"), catalog, store);
      try {
        const restored = await second.run(restoreRoot, [
          "project:restore",
          archive,
          "--json",
        ]);
        expect(restored.exitCode).toBe(0);
        const restoredId = (
          JSON.parse(restored.stdout[0]!) as { projectId: string }
        ).projectId;
        const view = await second.run(restoreRoot, [
          "project:configuration:show",
          "--project",
          restoredId,
          "--json",
        ]);
        expect(JSON.parse(view.stdout[0]!)).toMatchObject({
          configuration: { knowledge: [{ ...reported(2) }] },
        });
        expect(touched).toEqual([]);
      } finally {
        await second.stop();
      }

      // The whole flow never reached the knowledge store.
      expect(touched).toEqual([]);
      // Control: the stub is the store the Runtime would use.
      // (The recording stub fails the call, which the Runtime reports.)
      const searched = await host.run(root, [
        "knowledge:search",
        "--project",
        projectId,
        "--query",
        "clauses",
      ]);
      expect(searched.exitCode).toBe(1);
      expect(touched.length).toBeGreaterThan(0);
    } finally {
      await host.stop();
    }
  });
});
