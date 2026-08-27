import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDistributionUpdateCli } from "../../apps/cli/src/distribution-update-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import type {
  DistributionUpdateAdapter,
  DistributionUpdateDraft,
} from "@ai-office/application/ports/distribution-update-adapter.port.ts";
import { DaemonUnavailableError } from "../../apps/cli/src/daemon-client.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-update-cli-"));
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

function updateDraft(root: string): DistributionUpdateDraft {
  return {
    contractVersion: 1,
    distributionRoot: root,
    packageName: "ai-office",
    branch: "main",
    remote: "origin",
    remoteIdentity: `sha256:${"1".repeat(64)}`,
    upstreamRef: "refs/heads/main",
    trackingRef: "refs/remotes/origin/main",
    currentRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    steps: ["fetch", "fast_forward", "install_dependencies", "register_link"],
  };
}

const stoppedDaemon = {
  health: async (): Promise<never> => {
    throw new DaemonUnavailableError("/tmp/missing-ai-office.sock");
  },
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("source-linked distribution update CLI", () => {
  test("prints a deterministic JSON plan and applies only its approved hash", async () => {
    const root = temporaryRoot();
    const draft = updateDraft(root);
    let applied = false;
    const adapter: DistributionUpdateAdapter = {
      plan: async () => draft,
      apply: async (approved) => {
        applied = true;
        return {
          contractVersion: 1,
          status: "updated",
          distributionRoot: approved.distributionRoot,
          fromRevision: approved.currentRevision,
          toRevision: approved.targetRevision,
          completedSteps: approved.steps,
          message: "updated",
        };
      },
    };
    const planned = captureIo();
    expect(
      await runDistributionUpdateCli(["--json"], {
        distributionRoot: root,
        daemonClient: stoppedDaemon,
        io: planned.io,
        adapter,
      }),
    ).toBe(0);
    const plan = JSON.parse(planned.stdout[0]!) as { planHash: string };
    expect(applied).toBe(false);

    const appliedOutput = captureIo();
    expect(
      await runDistributionUpdateCli(["--approve", plan.planHash, "--json"], {
        distributionRoot: root,
        daemonClient: stoppedDaemon,
        io: appliedOutput.io,
        adapter,
      }),
    ).toBe(0);
    expect(applied).toBe(true);
    expect(JSON.parse(appliedOutput.stdout[0]!)).toMatchObject({
      contractVersion: 1,
      status: "updated",
      distributionRoot: root,
    });
  });

  test("refuses to mutate program files while the daemon is running", async () => {
    const root = temporaryRoot();
    let planned = false;
    const output = captureIo();
    expect(
      await runDistributionUpdateCli([], {
        distributionRoot: root,
        daemonClient: { health: async () => ({ status: "ok" }) },
        io: output.io,
        adapter: {
          plan: async () => {
            planned = true;
            return updateDraft(root);
          },
          apply: async () => {
            throw new Error("must not apply");
          },
        },
      }),
    ).toBe(1);
    expect(planned).toBe(false);
    expect(output.stderr[0]).toContain("daemon to be stopped");
  });

  test("reports a partial update and preserves runtime data", async () => {
    const root = temporaryRoot();
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "project.sqlite"), "authority");
    writeFileSync(join(runtime, "global.sqlite"), "memory");
    const draft = updateDraft(root);
    const adapter: DistributionUpdateAdapter = {
      plan: async () => draft,
      apply: async () => ({
        contractVersion: 1,
        status: "partial",
        distributionRoot: root,
        fromRevision: draft.currentRevision,
        toRevision: draft.targetRevision,
        completedSteps: ["fetch", "fast_forward"],
        failedStep: "install_dependencies",
        message: "source updated; dependency installation failed",
      }),
    };
    const servicePlan = captureIo();
    await runDistributionUpdateCli(["--json"], {
      distributionRoot: root,
      daemonClient: stoppedDaemon,
      io: servicePlan.io,
      adapter,
    });
    const hash = (JSON.parse(servicePlan.stdout[0]!) as { planHash: string })
      .planHash;
    const output = captureIo();

    expect(
      await runDistributionUpdateCli(["--approve", hash, "--json"], {
        distributionRoot: root,
        daemonClient: stoppedDaemon,
        io: output.io,
        adapter,
      }),
    ).toBe(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      status: "partial",
      failedStep: "install_dependencies",
      completedSteps: ["fetch", "fast_forward"],
    });
    await expect(
      Bun.file(join(runtime, "project.sqlite")).text(),
    ).resolves.toBe("authority");
    await expect(Bun.file(join(runtime, "global.sqlite")).text()).resolves.toBe(
      "memory",
    );
  });
});
