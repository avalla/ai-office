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

// GP-23 outcome: U+0000 is allowed in pack manifest text by design. This is
// the Runtime-socket half: what a CLI client sends and receives.

const NUL = "\u0000";
/** Raw U+0000 or its JSON escape. */
const carriesNul = (text: string): boolean =>
  text.includes(NUL) || text.includes("\\u0000");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const template = parseDomainPackManifest(
  readFileSync(new URL("../fixtures/domain-pack/custom.json", import.meta.url)),
);

function packBytes(
  version: string,
  roles: unknown[],
  metadata = template.metadata,
): Uint8Array {
  const manifest = {
    ...template,
    version,
    metadata,
    contributions: { ...template.contributions, roles },
  } as unknown as typeof template;
  return new TextEncoder().encode(
    JSON.stringify({
      ...manifest,
      manifestDigest: computeManifestDigest(manifest),
    }),
  );
}

function catalogOf(...artifacts: Uint8Array[]) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const packs = artifacts.map((bytes, index) =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: `gp23-${index}`,
      },
    }),
  );
  return { catalog, packs };
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

describe("GP-23 pack manifest U+0000 policy over the Runtime socket", () => {
  test("pack text with U+0000 is served escaped, and copying it into a project override is refused without writing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ai-office-gp23-e2e-"));
    roots.push(workspace);
    const root = join(workspace, "project");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"name":"gp23"}\n');
    const {
      catalog,
      packs: [plain, nul],
    } = catalogOf(
      packBytes("1.0.0", [{ id: "counsel", description: "Plain" }]),
      packBytes(
        "2.0.0",
        [{ id: "counsel", title: `T${NUL}`, description: `a${NUL}b` }],
        { name: `N${NUL}`, description: `D${NUL}` },
      ),
    );
    const runtimeRoot = join(workspace, "runtime");
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
        workingDirectory: root,
        io,
      });
      return { exitCode, stdout, stderr };
    };
    const stored = () => {
      const database = new Database(runtimePaths.projectDatabasePath, {
        readonly: true,
      });
      try {
        return {
          payloads: database
            .query<{ payload_json: string | null }, []>(
              "SELECT payload_json FROM project_definition_override",
            )
            .all()
            .map((row) => row.payload_json),
          upgrades: database
            .query<{ payload_json: string }, []>(
              "SELECT payload_json FROM audit_event WHERE event_type='project.pack_upgrade_applied'",
            )
            .all()
            .map((row) => row.payload_json),
        };
      } finally {
        database.close();
      }
    };
    try {
      const installed = await run(["install", ".", "--json"]);
      expect([0, 2]).toContain(installed.exitCode);
      const projectId = (
        JSON.parse(installed.stdout[0]!) as { project: { id: string } }
      ).project.id;
      const project = ["--project", projectId];
      expect(
        (
          await run([
            "project:pack:apply",
            ...project,
            "--packs",
            JSON.stringify([plain]),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
      const counsel = { ...plain, kind: "roles", localId: "counsel" };
      expect(
        (
          await run([
            "project:definition:apply",
            ...project,
            "--mutation",
            JSON.stringify({
              action: "put_override",
              source: counsel,
              operation: "extend",
              payload: { title: "Ours" },
            }),
            "--expected-revision",
            "0",
            "--json",
          ])
        ).exitCode,
      ).toBe(0);
      const upgrade = (action: string, ...extra: string[]) =>
        run([
          "project:pack:upgrade",
          ...project,
          "--packs",
          JSON.stringify([nul]),
          "--resolutions",
          JSON.stringify([{ source: counsel, action }]),
          ...extra,
          "--json",
        ]);

      // Converting would copy the template's description into a stored
      // project payload, which the project text rule refuses.
      const blocked = await upgrade("convert_to_replace");
      expect(blocked.exitCode).toBe(1);
      const blockedPlan = JSON.parse(blocked.stdout[0]!) as {
        planDigest: string;
      };
      expect(blockedPlan).toMatchObject({
        issues: [
          {
            code: "prospective_configuration_invalid",
            detail: "unresolved_override",
          },
        ],
      });
      const refused = await upgrade(
        "convert_to_replace",
        "--approve",
        blockedPlan.planDigest,
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toEqual([]);
      expect(refused.stderr).toEqual([
        "Pack upgrade is blocked: The reconciled project configuration would not resolve: Stored override violates the override contract: malformed_origin_reference",
      ]);
      expect(stored()).toEqual({
        payloads: [JSON.stringify({ title: "Ours" })],
        upgrades: [],
      });

      // Dropping the extension reaches the same pack version.
      const preview = await upgrade("remove_override");
      expect(preview.exitCode).toBe(0);
      const applied = await upgrade(
        "remove_override",
        "--approve",
        (JSON.parse(preview.stdout[0]!) as { planDigest: string }).planDigest,
      );
      expect(applied.exitCode).toBe(0);

      for (const flags of [["--json"], []]) {
        const shown = await run([
          "project:configuration:show",
          ...project,
          ...flags,
        ]);
        expect(shown.exitCode).toBe(0);
        expect(shown.stderr).toEqual([]);
        expect(shown.stdout).toHaveLength(1);
        // The frame and the printed text hold the JSON escape, never U+0000.
        expect(shown.stdout[0]).not.toContain(NUL);
        expect(shown.stdout[0]).toContain("a\\u0000b");
        expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
          ok: true,
          configuration: {
            selectedPacks: [nul],
            effectiveDefinitions: {
              roles: [
                {
                  payload: {
                    id: "counsel",
                    title: `T${NUL}`,
                    description: `a${NUL}b`,
                  },
                },
              ],
            },
            roles: [{ title: `T${NUL}`, description: `a${NUL}b` }],
          },
        });
      }

      // Stored and exported project state names the pack; it holds no pack
      // text.
      const after = stored();
      expect(after.payloads).toEqual([]);
      expect(after.upgrades).toHaveLength(1);
      expect(carriesNul(after.upgrades[0]!)).toBe(false);
      const archivePath = join(workspace, "project.aioffice");
      const backedUp = await run([
        "project:backup",
        "--output",
        archivePath,
        "--json",
      ]);
      expect(backedUp.stderr).toEqual([]);
      expect(backedUp.exitCode).toBe(0);
      const archive = readFileSync(archivePath, "utf8");
      expect(archive).toContain(nul!.manifestDigest);
      expect(carriesNul(archive)).toBe(false);
    } finally {
      controller.abort();
      await running;
    }
  });
});
