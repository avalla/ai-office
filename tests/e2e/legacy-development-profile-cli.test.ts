import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { officeTaskKinds } from "@ai-office/domain/office/office-manifest.ts";
import { computeArtifactDigest } from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { tableRows } from "../helpers/legacy-development-fixture.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

// GP-09 over the Runtime socket: what a CLI client sends and receives.

const emptyConfigurationDigest =
  "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19";
const emptyProfileDigest =
  "sha256:5f040cf62cdf54e2cacf480c04166469a56f75c473b5d6623da8b7a716c114ab";
const statement =
  "Legacy-state profile: it describes the office, role, agent and pipeline state the Runtime reads today. It is not an executable resolved configuration, and nothing is bound or scheduled from it.";

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

describe("GP-09 project:configuration:legacy over the Runtime socket", () => {
  test("describes a legacy project read-only, in text and JSON, and reports an unknown project as not found", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-office-gp09-e2e-"));
    roots.push(workspace);
    const root = join(workspace, "project");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"name":"gp09"}\n');
    const runtimeRoot = join(workspace, "runtime");
    mkdirSync(runtimeRoot);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const runtimePaths = resolveRuntimePaths({
      mode: "user",
      runtimeHome: runtimeRoot,
    });
    const catalog = new InMemoryInstalledDomainPackCatalog(1, [
      "local-distribution",
    ]);
    const legalBytes = readFileSync(
      new URL("../fixtures/domain-pack/legal.json", import.meta.url),
    );
    const legal = catalog.register({
      bytes: legalBytes,
      artifactDigest: computeArtifactDigest(legalBytes),
      provenance: { installerId: "local-distribution", reference: "gp09" },
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
        workingDirectory: root,
        io,
      });
      return { exitCode, stdout, stderr };
    };
    const legacy = (projectId: string, ...flags: string[]) =>
      run(["project:configuration:legacy", "--project", projectId, ...flags]);
    const show = (projectId: string) =>
      run(["project:configuration:show", "--project", projectId, "--json"]);
    /**
     * Every row of the project database, read through a second connection.
     * The host appends a `command.received` and a `command.completed` audit
     * row for every command it serves, this one and `show` alike. They carry
     * the command name, exit code and duration, no project and no profile.
     * They are returned apart so that everything else compares byte for byte.
     */
    const stored = () => {
      const database = new Database(runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        const rows = tableRows(database);
        const isEnvelope = (row: string) =>
          /"event_type":"command\.(?:received|completed)"/u.test(row);
        return {
          rows: {
            ...rows,
            audit_event: rows.audit_event!.filter((row) => !isEnvelope(row)),
          },
          envelope: rows.audit_event!.filter(isEnvelope),
        };
      } finally {
        database.close();
      }
    };
    try {
      const created = await run(["project:create", "Legacy office"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      const officeless = (
        await run(["project:create", "No office"])
      ).stdout[0]!.replace("Project created: ", "");

      // No office: a valid empty view and exit 0, in both forms.
      const emptyJson = await legacy(officeless, "--json");
      expect(emptyJson.exitCode).toBe(0);
      expect(JSON.parse(emptyJson.stdout[0]!)).toMatchObject({
        ok: true,
        profile: {
          source: "legacy_state",
          executable: false,
          profileDigest: emptyProfileDigest,
          office: null,
          roles: [],
          agents: [],
          taskKinds: [],
          pipelines: [],
          runtimeOnly: { roles: [], agents: [] },
          diagnostics: [],
        },
      });
      const emptyText = await legacy(officeless);
      expect(emptyText.exitCode).toBe(0);
      expect(emptyText.stdout.join("\n")).toContain(
        "Office: none (this project has no office manifest)",
      );

      // A legacy project: the default office and the repository's agents.
      const manifest = readFileSync(
        resolve(".agents/skills/ai-office/assets/default-office-manifest.json"),
        "utf8",
      );
      expect(
        (
          await run([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            manifest,
          ])
        ).exitCode,
      ).toBe(0);
      for (const directory of ["agents", "agent-catalog"])
        expect(
          (
            await run([
              "agent:sync",
              "--project",
              projectId,
              "--directory",
              resolve(directory),
            ])
          ).exitCode,
        ).toBe(0);

      const showBefore = await show(projectId);
      const before = stored();
      const json = await legacy(projectId, "--json");
      const text = await legacy(projectId);
      expect(json.exitCode).toBe(0);
      expect(text.exitCode).toBe(0);
      expect(json.stderr).toEqual([]);
      // Strictly read-only: every row is the same and no domain audit event
      // is written. The host's own envelope for the two commands is all.
      const after = stored();
      expect(after.rows).toEqual(before.rows);
      expect(before.rows.audit_event.length).toBeGreaterThan(0);
      expect(
        after.envelope.slice(before.envelope.length).map((row) => {
          const event = JSON.parse(row) as Record<string, string | null>;
          return [
            event.event_type,
            event.project_id,
            event.aggregate_type,
            (JSON.parse(event.payload_json!) as { command: string }).command,
          ];
        }),
      ).toEqual(
        [0, 1].flatMap(() =>
          ["command.received", "command.completed"].map((type) => [
            type,
            null,
            null,
            "project:configuration:legacy",
          ]),
        ),
      );
      for (const row of after.envelope)
        expect(row).not.toMatch(/sha256:|legacy_state|profileDigest/u);
      expect((await legacy(projectId, "--json")).stdout).toEqual(json.stdout);

      const { ok, profile } = JSON.parse(json.stdout[0]!);
      expect(ok).toBe(true);
      expect(Object.keys(profile)).toEqual([
        "profileId",
        "profileVersion",
        "source",
        "executable",
        "statement",
        "profileDigest",
        "metadata",
        "office",
        "roles",
        "agents",
        "taskKinds",
        "pipelines",
        "runtimeOnly",
        "diagnostics",
        "vocabularyGaps",
      ]);
      expect(profile).toMatchObject({
        profileId: "ai-office.legacy-development",
        profileVersion: 1,
        source: "legacy_state",
        executable: false,
        statement,
        metadata: {
          officeManifestRevision: 1,
          packBinding: { present: false },
        },
        office: { name: "Software delivery office" },
      });
      expect(profile.roles.map((role: { id: string }) => role.id)).toEqual([
        "architect",
        "developer",
        "qa",
        "reviewer",
      ]);
      expect(
        profile.agents.map((agent: { name: string }) => agent.name),
      ).toEqual(["architect", "developer", "qa", "reviewer"]);
      // The catalog's specialists are Runtime-only, each with its provenance.
      expect(profile.runtimeOnly.agents).toHaveLength(14);
      expect(profile.runtimeOnly.agents).toContainEqual({
        provenance: "runtime_agent_outside_office_manifest",
        name: "security",
        roleKey: "security-reviewer",
        enabled: true,
      });
      for (const role of profile.runtimeOnly.roles)
        expect(role.provenance).toBe("runtime_role_outside_office_manifest");
      // Guidance is a digest and a version; the text and local IDs stay out.
      expect(profile.roles[0].runtime.guidance).toEqual({
        version: 1,
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      const architectGuidance = readFileSync(
        resolve("agents/architect/system.md"),
        "utf8",
      );
      for (const output of [json, text]) {
        const printed = output.stdout.join("\n");
        expect(printed).not.toContain(architectGuidance.split("\n")[2]!);
        expect(printed).not.toContain(projectId);
        expect(printed).not.toMatch(
          /role:|agent:|\/home\/|\/tmp\/|createdAt|updatedAt|sourcePath|system\.md/u,
        );
      }

      // Routing equals `office:pipeline` for each of the five task kinds.
      for (const kind of officeTaskKinds) {
        const routed = await run([
          "office:pipeline",
          "--project",
          projectId,
          "--task-kind",
          kind,
        ]);
        const route = profile.taskKinds.find(
          (item: { kind: string }) => item.kind === kind,
        );
        expect(routed.exitCode).toBe(0);
        const pipeline = JSON.parse(routed.stdout[0]!);
        expect(route.pipelineId).toBe(pipeline.id);
        const described = profile.pipelines.find(
          (item: { id: string }) => item.id === pipeline.id,
        );
        expect({
          ...described,
          stages: described.stages.map(
            ({
              eligibleAgents: _eligible,
              ...stage
            }: {
              eligibleAgents: string[];
            }) => stage,
          ),
        }).toEqual(pipeline);
      }

      // The text form says the same thing about what this is.
      const printed = text.stdout.join("\n");
      expect(printed).toContain(
        "Legacy development profile ai-office.legacy-development version 1",
      );
      expect(printed).toContain("Source: legacy_state; executable: no");
      expect(printed).toContain(statement);
      expect(printed).toContain(`Profile digest: ${profile.profileDigest}`);
      expect(printed).toContain(
        "Pack binding present: no (metadata; not part of the profile or its digest)",
      );
      expect(printed).toContain("feature -> delivery");
      expect(printed).toContain(
        "1. design: role architect, approval not required, eligible agents: architect",
      );
      expect(printed).toContain(
        "agent security: role security-reviewer, enabled [provenance: runtime_agent_outside_office_manifest]",
      );

      // `project:configuration:show` is untouched: same bytes before and
      // after, the same key set and the pinned empty digest.
      const showAfter = await show(projectId);
      expect(showAfter.stdout).toEqual(showBefore.stdout);
      const configuration = JSON.parse(showAfter.stdout[0]!).configuration;
      expect(configuration.configurationDigest).toBe(emptyConfigurationDigest);
      expect(Object.keys(configuration)).toEqual([
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
      expect(showAfter.stdout[0]).not.toMatch(/legacy/iu);

      // A pack binding is reported and changes nothing else.
      expect(
        (
          await run([
            "project:pack:apply",
            "--project",
            projectId,
            "--packs",
            JSON.stringify([legal]),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
      const bound = JSON.parse(
        (await legacy(projectId, "--json")).stdout[0]!,
      ).profile;
      expect(bound.metadata.packBinding).toEqual({ present: true });
      expect(bound.profileDigest).toBe(profile.profileDigest);
      expect({
        ...bound,
        metadata: { ...bound.metadata, packBinding: { present: false } },
      }).toEqual(profile);
      expect((await legacy(projectId)).stdout.join("\n")).toContain(
        "Pack binding present: yes",
      );
      // The resolved configuration now has content; the profile has none of it.
      expect(JSON.stringify(bound)).not.toContain("org.example.legal");

      // An unknown project is not found, in both forms, without a write.
      const settled = stored().rows;
      for (const flags of [[], ["--json"]]) {
        const missing = await legacy("absent-project", ...flags);
        expect(missing.exitCode).toBe(1);
        expect(missing.stdout).toEqual([]);
        expect(missing.stderr.join("\n")).toBe(
          "Project absent-project not found",
        );
      }
      expect(stored().rows).toEqual(settled);

      // Usage errors are reported, not guessed.
      expect((await run(["project:configuration:legacy"])).exitCode).toBe(1);
      expect((await legacy(projectId, "extra")).exitCode).toBe(1);
    } finally {
      controller.abort();
      await running;
    }
  });
});
