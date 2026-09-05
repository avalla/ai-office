import { describe, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import {
  YamlAgentDefinitionLoader,
  type LoadedAgentDefinition,
} from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const loader = new YamlAgentDefinitionLoader();
const core = loader.load(join(repositoryRoot, "agents"));
const specialists = loader.load(join(repositoryRoot, "agent-catalog"));

describe("bundled agent synchronization through the daemon", () => {
  test("enables only deliberately synchronized agents without grants or office changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-catalog-sync-"));
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const run = async (args: string[], expectedCode = 0) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        workingDirectory: repositoryRoot,
        socketPath,
        io: {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      });
      expect(exitCode, `${args[0]}: ${stderr.join("\n")}`).toBe(expectedCode);
      if (expectedCode !== 1) expect(stderr).toEqual([]);
      return { stdout, stderr };
    };

    try {
      const client = new DaemonClient(socketPath);
      await expect
        .poll(async () => {
          try {
            await client.health();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      const project = await run(["project:create", "Catalog selection"]);
      const projectId = project.stdout[0]!.replace("Project created: ", "");
      const manifest = readFileSync(
        join(
          repositoryRoot,
          ".agents/skills/ai-office/assets/default-office-manifest.json",
        ),
        "utf8",
      );
      await run([
        "office:apply",
        "--project",
        projectId,
        "--manifest",
        manifest,
      ]);
      const office = async () => {
        const output = await run(["office:context", "--project", projectId]);
        return (JSON.parse(output.stdout[0]!) as { current: unknown }).current;
      };
      const originalOffice = await office();
      expect(originalOffice).toMatchObject({
        revision: 1,
        manifest: {
          office: {
            roles: [
              { id: "architect" },
              { id: "developer" },
              { id: "reviewer" },
              { id: "qa" },
            ],
          },
        },
      });
      const task = await run([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Explore a hypothesis",
      ]);
      const taskId = task.stdout[0]!.replace("Task created: ", "");
      await run(["task:start", "--project", projectId, "--task", taskId]);

      const assertAgents = async (definitions: LoadedAgentDefinition[]) => {
        const listed = await run(["agent:list", "--project", projectId]);
        expect(listed.stdout.slice(1).sort()).toEqual(
          definitions
            .map(
              ({ definition }) =>
                `agent:${projectId}:${definition.id}\trole:${projectId}:${definition.roleKey}\ttrue\t${definition.id}`,
            )
            .sort(),
        );
      };
      const schedule = (id: string, expectedCode = 0) =>
        run(
          [
            "run:schedule",
            "--project",
            projectId,
            "--task",
            taskId,
            "--agent",
            `agent:${projectId}:${id}`,
          ],
          expectedCode,
        );
      const assertNoGrants = async () => {
        expect(
          (await run(["capability:list", "--project", projectId])).stdout,
        ).toEqual(["id\tprincipal\tresource\tactions\tstate"]);
      };

      // Omitted --directory resolves to the invoking client's agents/ directory.
      expect(
        (await run(["agent:sync", "--project", projectId])).stdout,
      ).toEqual(["Agent definitions synchronized: 4"]);
      await assertAgents(core);
      await assertNoGrants();
      expect(specialists).toHaveLength(14);
      for (const { definition } of specialists) {
        expect((await schedule(definition.id, 1)).stderr).toEqual([
          `Agent agent:${projectId}:${definition.id} not found`,
        ]);
      }
      expect((await run(["run:list", "--project", projectId])).stdout).toEqual([
        "No agent runs found.",
      ]);

      // Reproduce the documented subset recipe with disposable YAML-only input.
      const selected = specialists.filter(({ definition }) =>
        ["hacker", "mad-scientist"].includes(definition.id),
      );
      const selection = join(root, "selection");
      for (const { definition, sourcePath } of selected) {
        const directory = join(selection, definition.id);
        mkdirSync(directory, { recursive: true });
        copyFileSync(sourcePath, join(directory, "agent.yaml"));
      }
      expect(
        (
          await run([
            "agent:sync",
            "--project",
            projectId,
            "--directory",
            selection,
          ])
        ).stdout,
      ).toEqual(["Agent definitions synchronized: 2"]);
      await assertAgents([...core, ...selected]);
      expect((await schedule("chaos-gremlin", 1)).stderr).toEqual([
        `Agent agent:${projectId}:chaos-gremlin not found`,
      ]);
      expect((await schedule("hacker")).stdout[0]).toMatch(
        /^Agent run scheduled: /,
      );
      expect(await office()).toEqual(originalOffice);

      // Sync upserts: a later core-only sync cannot revoke this deliberate choice.
      await run(["agent:sync", "--project", projectId]);
      await assertAgents([...core, ...selected]);
      expect(
        (
          await run([
            "agent:sync",
            "--project",
            projectId,
            "--directory",
            "agent-catalog",
          ])
        ).stdout,
      ).toEqual(["Agent definitions synchronized: 14"]);
      await assertAgents([...core, ...specialists]);
      await assertNoGrants();
      expect(await office()).toEqual(originalOffice);

      const resource = await run([
        "resource:create",
        "--project",
        projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "fake",
        "--name",
        "No-authority fixture",
        "--external-ref",
        join(root, "untouched"),
      ]);
      const resourceId = resource.stdout[0]!.replace("Resource created: ", "");
      const action = await run(
        [
          "action:request",
          "--project",
          projectId,
          "--agent",
          `agent:${projectId}:hacker`,
          "--resource",
          resourceId,
          "--operation",
          "fake.read",
        ],
        2,
      );
      expect(action.stdout.at(-1)).toBe("Decision: denied");
      await assertNoGrants();
    } finally {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
