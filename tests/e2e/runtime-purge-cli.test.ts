import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { runRuntimePurgeCli } from "../../apps/cli/src/runtime-purge-cli.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";
import { ManageRuntimePurge } from "@ai-office/application/runtime/manage-runtime-purge.ts";
import {
  LocalRuntimePurgeAdapter,
  LocalRuntimePurgeError,
} from "../../apps/cli/src/local-runtime-purge-adapter.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("offline runtime purge CLI", () => {
  test("plans passively, removes known runtime artifacts, and preserves foreign files", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-");
    const state = join(root, ".ai-office");
    mkdirSync(join(state, "generated"), { recursive: true });
    writeFileSync(join(state, "project.sqlite"), "authoritative state");
    writeFileSync(join(state, "generated", "profile.md"), "generated");
    writeFileSync(join(state, "agent-instructions.json"), "{}\n");
    writeFileSync(join(state, "global.sqlite"), "global memory remains");
    writeFileSync(join(state, "notes.txt"), "keep me\n");

    const plannedOutput = captureIo();
    expect(
      await runDaemonCli(["runtime:purge"], {
        projectRoot: root,
        io: plannedOutput.io,
      }),
    ).toBe(0);
    const plan = JSON.parse(plannedOutput.stdout[0]!) as {
      planHash: string;
      artifacts: Array<{ relativePath: string }>;
      preservedPaths: string[];
    };
    expect(plan.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "generated/profile.md",
      "generated",
      "project.sqlite",
    ]);
    expect(plan.preservedPaths).toEqual([
      "agent-instructions.json",
      "global.sqlite",
      "notes.txt",
    ]);
    expect(existsSync(join(state, "project.sqlite"))).toBe(true);

    const appliedOutput = captureIo();
    expect(
      await runDaemonCli(["runtime:purge", "--approve", plan.planHash], {
        projectRoot: root,
        io: appliedOutput.io,
      }),
    ).toBe(0);
    expect(JSON.parse(appliedOutput.stdout[0]!)).toMatchObject({
      purged: true,
      stateDirectoryRemoved: false,
      removedPaths: [
        "generated/profile.md",
        "generated",
        "project.sqlite",
      ],
      preservedPaths: [
        "agent-instructions.json",
        "global.sqlite",
        "notes.txt",
      ],
    });
    expect(existsSync(join(state, "project.sqlite"))).toBe(false);
    expect(readFileSync(join(state, "notes.txt"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(state, "global.sqlite"), "utf8")).toBe(
      "global memory remains",
    );
  });

  test("rejects stale approval when runtime state changes after planning", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-stale-");
    const state = join(root, ".ai-office");
    mkdirSync(state);
    writeFileSync(join(state, "project.sqlite"), "first");
    const plannedOutput = captureIo();
    await runDaemonCli(["runtime:purge"], {
      projectRoot: root,
      io: plannedOutput.io,
    });
    const plan = JSON.parse(plannedOutput.stdout[0]!) as { planHash: string };
    writeFileSync(join(state, "project.sqlite"), "second");

    const appliedOutput = captureIo();
    expect(
      await runDaemonCli(["runtime:purge", "--approve", plan.planHash], {
        projectRoot: root,
        io: appliedOutput.io,
      }),
    ).toBe(1);
    expect(appliedOutput.stderr).toEqual([
      "Runtime purge approval does not match the current plan",
    ]);
    expect(readFileSync(join(state, "project.sqlite"), "utf8")).toBe("second");
  });

  test("removes the runtime state directory when no preserved entries remain", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-empty-");
    const state = join(root, ".ai-office");
    mkdirSync(state);
    writeFileSync(join(state, "project.sqlite"), "state");
    const plannedOutput = captureIo();
    await runDaemonCli(["runtime:purge"], {
      projectRoot: root,
      io: plannedOutput.io,
    });
    const plan = JSON.parse(plannedOutput.stdout[0]!) as { planHash: string };
    const appliedOutput = captureIo();

    expect(
      await runDaemonCli(["runtime:purge", "--approve", plan.planHash], {
        projectRoot: root,
        io: appliedOutput.io,
      }),
    ).toBe(0);
    expect(JSON.parse(appliedOutput.stdout[0]!)).toMatchObject({
      stateDirectoryRemoved: true,
    });
    expect(existsSync(state)).toBe(false);
  });

  test("refuses to purge while the daemon is running", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-live-");
    writeFileSync(join(root, "project.sqlite"), "state");
    const output = captureIo();
    expect(
      await runRuntimePurgeCli([], {
        runtimeRoot: root,
        daemonClient: {
          health: async () => ({
            protocolVersion: daemonProtocolVersion,
            status: "ok",
            startedAt: "2026-08-22T00:00:00.000Z",
          }),
        },
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual([
      "Runtime purge requires the AI Office daemon to be stopped",
    ]);
    expect(existsSync(join(root, "project.sqlite"))).toBe(true);
  });

  test("fails closed when the runtime state directory is a symlink", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-link-");
    const external = temporaryRoot("ai-office-runtime-purge-external-");
    writeFileSync(join(external, "project.sqlite"), "outside");
    symlinkSync(external, join(root, ".ai-office"));

    const output = captureIo();
    expect(
      await runDaemonCli(["runtime:purge"], {
        projectRoot: root,
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr[0]).toContain(
      "must be a real directory",
    );
    expect(readFileSync(join(external, "project.sqlite"), "utf8")).toBe(
      "outside",
    );
  });

  test("revalidates each artifact immediately before removal", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-race-");
    const state = join(root, ".ai-office");
    mkdirSync(state);
    const database = join(state, "project.sqlite");
    writeFileSync(database, "planned");
    const service = new ManageRuntimePurge(
      new LocalRuntimePurgeAdapter({
        beforeRemove: () => writeFileSync(database, "last-moment change"),
      }),
    );
    const plan = await service.plan(state);

    await expect(
      service.apply({ runtimeRoot: state, approvedPlanHash: plan.planHash }),
    ).rejects.toBeInstanceOf(LocalRuntimePurgeError);
    expect(readFileSync(database, "utf8")).toBe("last-moment change");
  });

  test("preserves an unexpected file introduced before planned directory cleanup", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-directory-race-");
    const state = join(root, ".ai-office");
    const generated = join(state, "generated");
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, "a.md"), "a");
    writeFileSync(join(generated, "b.md"), "b");
    writeFileSync(join(state, "project.sqlite"), "authoritative state");
    const unexpected = join(generated, "new-file.txt");
    const service = new ManageRuntimePurge(
      new LocalRuntimePurgeAdapter({
        beforeRemove: (relativePath) => {
          if (relativePath === "generated")
            writeFileSync(unexpected, "arrived during apply");
        },
      }),
    );
    const plan = await service.plan(state);
    expect(plan.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "generated/a.md",
      "generated/b.md",
      "generated",
      "project.sqlite",
    ]);

    await expect(
      service.apply({ runtimeRoot: state, approvedPlanHash: plan.planHash }),
    ).rejects.toBeInstanceOf(LocalRuntimePurgeError);
    expect(readFileSync(unexpected, "utf8")).toBe("arrived during apply");
    expect(existsSync(generated)).toBe(true);
    expect(existsSync(join(state, "project.sqlite"))).toBe(true);
  });

  test("preserves a known runtime path when its filesystem kind is unexpected", async () => {
    const root = temporaryRoot("ai-office-runtime-purge-kind-");
    const external = temporaryRoot("ai-office-runtime-purge-file-");
    const state = join(root, ".ai-office");
    mkdirSync(state);
    const externalDatabase = join(external, "outside.sqlite");
    writeFileSync(externalDatabase, "outside");
    symlinkSync(externalDatabase, join(state, "project.sqlite"));

    const plan = await new ManageRuntimePurge(
      new LocalRuntimePurgeAdapter(),
    ).plan(state);
    expect(plan.artifacts).toEqual([]);
    expect(plan.preservedPaths).toEqual(["project.sqlite"]);
    expect(readFileSync(externalDatabase, "utf8")).toBe("outside");
  });
});
