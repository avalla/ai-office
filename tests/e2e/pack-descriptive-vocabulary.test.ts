import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  copyFileSync,
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
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

// GP-10B-2, PR 1: the descriptive vocabulary as a CLI client sends and
// receives it over the Runtime socket.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Every definition body carries one of these markers, so the test can show
// that none reaches an audit event, an upgrade plan or an error message.
const bodyMarkers = ["§pack", "§ours"];
const pack = (text: string) => `${text} §pack`;
const ours = (text: string) => `${text} §ours`;
const withoutBodies = (text: string): void => {
  for (const marker of bodyMarkers) expect(text).not.toContain(marker);
  expect(text).not.toContain("\\u00a7");
};

const template = parseDomainPackManifest(
  readFileSync(new URL("../fixtures/domain-pack/custom.json", import.meta.url)),
);

function packBytes(
  version: string,
  contributions: Record<string, unknown[]>,
): Uint8Array {
  const manifest = parseDomainPackManifest(
    new TextEncoder().encode(
      JSON.stringify({
        ...template,
        version,
        contributions: { ...template.contributions, ...contributions },
      }),
    ),
  );
  return new TextEncoder().encode(
    JSON.stringify({
      ...manifest,
      manifestDigest: computeManifestDigest(manifest),
    }),
  );
}

const shared = {
  capabilities: [{ id: "sign" }],
  taskTypes: [{ id: "matter" }, { id: "filing" }, { id: "appeal" }],
  roles: [
    {
      id: "counsel",
      title: "Counsel",
      capabilities: ["sign"],
      responsibilities: [pack("Advise"), pack("Sign filings")],
    },
    { id: "clerk" },
  ],
};
const review = {
  id: "review",
  title: "Review",
  taskType: "matter",
  additionalTaskTypes: ["appeal"],
  stages: [
    {
      id: "draft",
      role: "clerk",
      title: pack("Draft"),
      objective: pack("Produce a draft"),
      checks: [pack("Template used"), pack("Facts cited")],
    },
    { id: "check", role: "counsel" },
  ],
};
const v1Bytes = packBytes("1.0.0", {
  ...shared,
  prompts: [{ id: "brief", text: pack("Write the brief.") }, { id: "tone" }],
  workflows: [review],
});
// The prompt `tone` gains a title, which a project extension also sets, and a
// text.
const v2Bytes = packBytes("2.0.0", {
  ...shared,
  prompts: [
    { id: "brief", text: pack("Write the brief.") },
    { id: "tone", title: "Tone", text: pack("Calm.\nPrecise.") },
  ],
  workflows: [review],
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

describe("GP-10B-2 descriptive vocabulary over the Runtime socket", () => {
  test("definitions with the new keys are previewed, applied, shown, upgraded with a conversion, backed up and restored at format 10", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-office-gp10b2-e2e-"));
    roots.push(workspace);
    const projectA = join(workspace, "source");
    const projectB = join(workspace, "destination");
    for (const root of [projectA, projectB]) {
      mkdirSync(root);
      writeFileSync(join(root, "package.json"), '{"name":"gp10b2"}\n');
    }
    const catalog = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const [v1, v2] = [v1Bytes, v2Bytes].map((bytes, index) =>
      catalog.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: "local-distribution",
          reference: `gp10b2-${index}`,
        },
      }),
    ) as [
      ReturnType<typeof catalog.register>,
      ReturnType<typeof catalog.register>,
    ];
    const start = async (name: string, workingDirectory: string) => {
      const runtimeRoot = join(workspace, name);
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
        installedPacks: catalog,
      });
      const controller = new AbortController();
      const running = daemon.start(controller.signal);
      await waitForDaemon(socket.socketPath);
      const run = async (args: string[]) => {
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
    };
    type Runtime = Awaited<ReturnType<typeof start>>;
    const show = async (runtime: Runtime, projectId: string) => {
      const shown = await runtime.run([
        "project:configuration:show",
        "--project",
        projectId,
        "--json",
      ]);
      expect(shown.stderr).toEqual([]);
      expect(shown.exitCode).toBe(0);
      return (
        JSON.parse(shown.stdout[0]!) as {
          ok: boolean;
          configuration: {
            configurationDigest: string;
            roles: Record<string, unknown>[];
            workflows: Record<string, unknown>[];
            effectiveDefinitions: {
              prompts: { payload: Record<string, unknown> }[];
            };
          };
        }
      ).configuration;
    };
    const stable = (kind: string, localId: string) =>
      `pack:org.example.custom/${kind}/${localId}`;

    const a = await start("source-runtime", projectA);
    let stopped = false;
    let b: Runtime | undefined;
    try {
      const installed = await a.run(["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.exitCode);
      const projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;
      const project = ["--project", projectId];
      expect(
        (
          await a.run([
            "project:pack:apply",
            ...project,
            "--packs",
            JSON.stringify([v1]),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
      const source = (kind: string, localId: string, from = v1) => ({
        ...from,
        kind,
        localId,
      });
      const replace = (kind: string, localId: string, payload: object) => ({
        action: "put_override",
        source: source(kind, localId),
        operation: "replace",
        payload,
      });
      const define = (revision: number, mutation: object) =>
        a.run([
          "project:definition:apply",
          ...project,
          "--mutation",
          JSON.stringify(mutation),
          "--expected-revision",
          String(revision),
          "--json",
        ]);
      const stored = () => {
        const database = new Database(a.runtimePaths.projectDatabasePath, {
          readonly: true,
        });
        try {
          const rows = (table: string) =>
            database
              .query<{ payload_json: string | null }, []>(
                `SELECT payload_json FROM ${table} ORDER BY kind, local_id`,
              )
              .all()
              .map((row) => row.payload_json);
          return {
            owned: rows("project_owned_definition"),
            overrides: rows("project_definition_override"),
            audits: database
              .query<{ event_type: string; payload_json: string }, []>(
                "SELECT event_type, payload_json FROM audit_event WHERE event_type IN ('project.definition_changed', 'project.pack_upgrade_applied') ORDER BY rowid",
              )
              .all(),
          };
        } finally {
          database.close();
        }
      };

      // Preview reads; it stores nothing.
      const ourReview = {
        id: "review",
        title: "Our review",
        taskType: "matter",
        additionalTaskTypes: ["filing", "appeal"],
        stages: [
          {
            id: "check",
            role: "counsel",
            title: ours("Check"),
            objective: ours("Be sure"),
            checks: [ours("z last"), ours("a first")],
          },
        ],
      };
      const previewed = await a.run([
        "project:definition:preview",
        ...project,
        "--mutation",
        JSON.stringify(replace("workflows", "review", ourReview)),
        "--json",
      ]);
      expect(previewed.exitCode).toBe(0);
      expect(JSON.parse(previewed.stdout[0]!)).toMatchObject({
        issues: [],
        mutation: {
          payload: { additionalTaskTypes: ["appeal", "filing"] },
        },
      });
      // A route the pack does not declare is reported, with exit 1.
      const missing = await a.run([
        "project:definition:preview",
        ...project,
        "--mutation",
        JSON.stringify(
          replace("workflows", "review", {
            ...ourReview,
            additionalTaskTypes: ["ghost"],
          }),
        ),
        "--json",
      ]);
      expect(missing.exitCode).toBe(1);
      expect(JSON.parse(missing.stdout[0]!)).toMatchObject({
        issues: [{ code: "source_definition_missing" }],
      });
      expect(stored()).toEqual({ owned: [], overrides: [], audits: [] });

      // Rejected mutations exit 1 with the typed message and no payload text.
      for (const [mutation, message] of [
        [
          replace("prompts", "brief", { id: "brief", text: ours("a\u0000b") }),
          "text must be non-empty bounded text",
        ],
        [
          replace("roles", "counsel", {
            id: "counsel",
            text: ours("Not a role field"),
          }),
          "Definition payload may contain only its exact ID and descriptive fields",
        ],
        [
          {
            action: "put_override",
            source: source("prompts", "tone"),
            operation: "extend",
            payload: { text: ours("An extension stays descriptive") },
          },
          "Definition payload may contain only its exact ID and descriptive fields",
        ],
      ] as const) {
        const refused = await define(0, mutation);
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toEqual([]);
        expect(refused.stderr).toEqual([message]);
        withoutBodies(refused.stderr.join("\n"));
      }
      expect(stored()).toEqual({ owned: [], overrides: [], audits: [] });

      const ourRole = {
        id: "counsel",
        title: "Our counsel",
        responsibilities: [ours("Sign"), ours("Advise"), ours("Sign")],
      };
      const ourBrief = { id: "brief", text: ours("Write\nour brief.") };
      const house = { id: "house", text: ours("House rules.") };
      const mutations = [
        replace("workflows", "review", ourReview),
        replace("roles", "counsel", ourRole),
        replace("prompts", "brief", ourBrief),
        {
          action: "put_override",
          source: source("prompts", "tone"),
          operation: "extend",
          payload: { title: ours("Our tone") },
        },
        {
          action: "put_owned",
          kind: "prompts",
          id: "house",
          enabled: true,
          payload: house,
        },
      ];
      for (const [revision, mutation] of mutations.entries()) {
        const applied = await define(revision, mutation);
        expect(applied.stderr).toEqual([]);
        expect(applied.exitCode).toBe(0);
      }
      // Stored as given, with the route set ascending.
      expect(
        stored().overrides.map((row) => JSON.parse(row!) as unknown),
      ).toEqual([
        ourBrief,
        { title: ours("Our tone") },
        ourRole,
        { ...ourReview, additionalTaskTypes: ["appeal", "filing"] },
      ]);
      const definitionsShown = await a.run([
        "project:definition:show",
        ...project,
        "--json",
      ]);
      expect(definitionsShown.exitCode).toBe(0);
      expect(definitionsShown.stdout[0]).toContain(
        '"additionalTaskTypes":["appeal","filing"]',
      );
      expect(definitionsShown.stdout[0]).toContain(
        JSON.stringify({ responsibilities: ourRole.responsibilities }).slice(
          1,
          -1,
        ),
      );

      const reviewView = {
        workflowId: stable("workflows", "review"),
        origin: "pack_owned",
        title: "Our review",
        taskTypeId: stable("taskTypes", "matter"),
        additionalTaskTypeIds: [
          stable("taskTypes", "appeal"),
          stable("taskTypes", "filing"),
        ],
        stages: [
          {
            id: "check",
            roleId: stable("roles", "counsel"),
            title: ours("Check"),
            objective: ours("Be sure"),
            checks: [ours("z last"), ours("a first")],
          },
        ],
        customization: "replace",
      };
      const roleView = {
        roleId: stable("roles", "counsel"),
        origin: "pack_owned",
        title: "Our counsel",
        responsibilities: ourRole.responsibilities,
        // The capability set stays the pack's.
        capabilities: [stable("capabilities", "sign")],
        customization: "replace",
      };
      const before = await show(a, projectId);
      expect(before.workflows).toEqual([
        { ...reviewView, effectiveId: expect.any(String) as unknown },
      ]);
      expect(before.roles).toContainEqual({
        ...roleView,
        effectiveId: expect.any(String) as unknown,
      });
      expect(
        before.effectiveDefinitions.prompts.map((item) => item.payload),
      ).toEqual([ourBrief, { id: "tone", title: ours("Our tone") }, house]);

      // The new version sets the title the extension set: a conflict, which
      // a conversion resolves by copying the template's text.
      const tone = source("prompts", "tone");
      const upgrade = (...extra: string[]) =>
        a.run([
          "project:pack:upgrade",
          ...project,
          "--packs",
          JSON.stringify([v2]),
          ...extra,
          "--json",
        ]);
      const blocked = await upgrade();
      expect(blocked.exitCode).toBe(1);
      expect(JSON.parse(blocked.stdout[0]!)).toMatchObject({
        issues: [
          { code: "unresolved_override_conflict", detail: "extend_conflict" },
        ],
      });
      const resolutions = [
        "--resolutions",
        JSON.stringify([{ source: tone, action: "convert_to_replace" }]),
      ];
      const preview = await upgrade(...resolutions);
      expect(preview.exitCode).toBe(0);
      const plan = JSON.parse(preview.stdout[0]!) as {
        planDigest: string;
        prospectiveConfigurationDigest: string;
      };
      expect(plan).toMatchObject({
        issues: [],
        overrides: [
          { operation: "replace", outcome: "retargeted" },
          { operation: "extend", outcome: "converted_to_replace" },
          { operation: "replace", outcome: "retargeted" },
          { operation: "replace", outcome: "retargeted" },
        ],
      });
      // The plan carries identities only.
      withoutBodies(preview.stdout[0]!);
      const applied = await upgrade(
        ...resolutions,
        "--approve",
        plan.planDigest,
      );
      expect(applied.stderr).toEqual([]);
      expect(applied.exitCode).toBe(0);
      withoutBodies(applied.stdout.join("\n"));

      const after = await show(a, projectId);
      expect(after.configurationDigest).toBe(
        plan.prospectiveConfigurationDigest,
      );
      const converted = {
        id: "tone",
        title: ours("Our tone"),
        text: pack("Calm.\nPrecise."),
      };
      expect(
        after.effectiveDefinitions.prompts.map((item) => item.payload),
      ).toEqual([ourBrief, converted, house]);
      // The project's values were not dropped or rewritten.
      expect(after.workflows).toEqual([
        { ...reviewView, effectiveId: expect.any(String) as unknown },
      ]);
      expect(after.roles).toContainEqual({
        ...roleView,
        effectiveId: expect.any(String) as unknown,
      });

      // The audit log names identities and revisions, never a body.
      const { audits } = stored();
      expect(audits.map((event) => event.event_type)).toEqual([
        ...mutations.map(() => "project.definition_changed"),
        "project.pack_upgrade_applied",
      ]);
      for (const event of audits) withoutBodies(event.payload_json);

      const archivePath = join(workspace, "project.aioffice");
      const backedUp = await a.run([
        "project:backup",
        "--output",
        archivePath,
        "--json",
      ]);
      expect(backedUp.stderr).toEqual([]);
      expect(backedUp.exitCode).toBe(0);
      const archiveText = readFileSync(archivePath, "utf8");
      const archive = JSON.parse(archiveText) as {
        manifest: { formatVersion: number };
        state: {
          definitions: {
            owned: { payload: unknown }[];
            overrides: { payload: unknown }[];
          };
        };
      };
      expect(archive.manifest.formatVersion).toBe(10);
      expect(
        archive.state.definitions.overrides.map((item) => item.payload),
      ).toEqual([
        ourBrief,
        converted,
        ourRole,
        { ...ourReview, additionalTaskTypes: ["appeal", "filing"] },
      ]);
      expect(
        archive.state.definitions.owned.map((item) => item.payload),
      ).toEqual([house]);

      mkdirSync(join(projectB, ".ai-office"));
      copyFileSync(
        join(projectA, ".ai-office", "project.json"),
        join(projectB, ".ai-office", "project.json"),
      );
      await a.stop();
      stopped = true;

      b = await start("destination-runtime", projectB);
      const restored = await b.run(["project:restore", archivePath, "--json"]);
      expect(restored.stderr).toEqual([]);
      expect(restored.exitCode).toBe(0);
      const restoredId = (
        JSON.parse(restored.stdout[0]!) as { projectId: string }
      ).projectId;
      const restoredView = await show(b, restoredId);
      expect(restoredView.configurationDigest).toBe(after.configurationDigest);
      expect(restoredView.workflows).toEqual(after.workflows);
      expect(restoredView.roles).toEqual(after.roles);
      expect(restoredView.effectiveDefinitions.prompts).toEqual(
        after.effectiveDefinitions.prompts,
      );
      // The restored project is written at format 10 again.
      const again = join(workspace, "again.aioffice");
      expect(
        (await b.run(["project:backup", "--output", again, "--json"])).exitCode,
      ).toBe(0);
      const second = JSON.parse(readFileSync(again, "utf8")) as typeof archive;
      expect(second.manifest.formatVersion).toBe(10);
      expect(second.state.definitions).toEqual(archive.state.definitions);
    } finally {
      if (!stopped) await a.stop();
      if (b) await b.stop();
    }
  });
});
