import { expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadModelRoutingState } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { runRuntime } from "../helpers/run-runtime.ts";
import {
  createOperatorCodexHome,
  installFakeCodex,
} from "../helpers/fake-codex.ts";

test("Codex CLI worker runs isolated from the operator's Codex home and persists bounded provenance", async () => {
  const runtime = await runRuntime();
  const ambient = {
    PATH: process.env.PATH,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  const secret = "sk-e2e-operator-credential";
  try {
    const fake = installFakeCodex(runtime.root);
    const operatorHome = createOperatorCodexHome(runtime.root, secret);
    process.env.PATH = `${fake.bin}:${ambient.PATH ?? ""}`;
    process.env.CODEX_HOME = operatorHome;
    const taskId = await runtime.task();
    const runId = (await runtime.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const result = await runtime.command([
      "run:tick",
      "--project",
      runtime.projectId,
      "--worker",
      "codex",
      "--json",
    ]);
    expect(result, result.stderr.join("\n")).toMatchObject({ exitCode: 0 });

    const report = fake.report();
    expect(report.args[0]).toBe("exec");
    expect(report.args[report.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(report.args[report.args.indexOf("view_image") - 1]).toBe(
      "--disable",
    );
    expect(report.prompt).toContain("Test task");
    expect(Object.keys(report.env).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "PATH",
    ]);
    expect(report.env.CODEX_HOME).not.toBe(operatorHome);
    expect(report.env.HOME).not.toBe(homedir());
    expect(report.codexHome.entries).toEqual(["auth.json"]);
    expect(report.home.entries).toEqual([]);

    const response = await fetch(`http://localhost/api/runs/${runId}`, {
      unix: runtime.socketPath,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const { run: detail } = JSON.parse(text) as {
      run: {
        run: { status: string; execution: Record<string, unknown> };
        workerOutput: { summary: string; estimatedCostUsd: number | null };
      };
    };
    // Provenance names the adapter, its version and the Runtime context hash.
    // It makes no claim about what else the client put in the model context.
    expect(detail.run.status).toBe("completed");
    expect(detail.run.execution).toEqual({
      kind: "worker",
      adapterId: "codex-cli",
      adapterVersion: "0.160.0",
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(detail.workerOutput).toMatchObject({
      summary: "Codex analysis",
      estimatedCostUsd: null,
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain(operatorHome);
    expect(result.stdout.join("\n") + result.stderr.join("\n")).not.toContain(
      secret,
    );

    // A missing login fails the run closed through the same Runtime path.
    const second = await runtime.schedule(await runtime.task());
    expect(second.exitCode).toBe(0);
    process.env.CODEX_HOME = `${operatorHome}-absent`;
    const refused = await runtime.command([
      "run:tick",
      "--project",
      runtime.projectId,
      "--worker",
      "codex",
      "--json",
    ]);
    const refusedText = refused.stdout.join("\n") + refused.stderr.join("\n");
    expect(refusedText).toContain("WORKER_UNAVAILABLE");
    expect(refusedText).not.toContain(operatorHome);
  } finally {
    for (const [name, value] of Object.entries(ambient))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await runtime.close();
  }
});

test("Codex executes exactly the persisted OpenAI route and refuses what it cannot honor before dispatch", async () => {
  const runtime = await runRuntime(undefined, {
    modelRouting: loadModelRoutingState(
      { AI_OFFICE_MODEL_ROUTING_FILE: "/ai-office-routing/model-routing.yaml" },
      {
        readFile: () => `schema_version: 1
profiles:
  openai_default: { model: "openai:gpt-5.6-sol", reasoning_effort: high }
  capped: { model: "openai:gpt-5.6-sol", max_output_tokens: 2000 }
default_profile: openai_default
agents:
  developer: { profile: capped }
`,
      },
    ),
  });
  const ambient = {
    PATH: process.env.PATH,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  try {
    const fake = installFakeCodex(runtime.root);
    process.env.PATH = `${fake.bin}:${ambient.PATH ?? ""}`;
    process.env.CODEX_HOME = createOperatorCodexHome(runtime.root, "sk-route");
    const reportPath = join(runtime.root, "codex-report.json");
    const tick = (...extra: string[]) =>
      runtime.command([
        "run:tick",
        "--project",
        runtime.projectId,
        "--worker",
        "codex",
        ...extra,
      ]);
    const scheduled = (output: { stdout: string[] }) =>
      output.stdout[0]!.replace("Agent run scheduled: ", "");
    const queuedThenCancelled = async (run: string) => {
      expect(existsSync(reportPath)).toBe(false);
      expect(
        (
          await runtime.command([
            "run:show",
            "--project",
            runtime.projectId,
            "--run",
            run,
          ])
        ).stdout,
      ).toContain("Status: queued");
      expect(
        (
          await runtime.command([
            "run:cancel",
            "--project",
            runtime.projectId,
            "--run",
            run,
            "--reason",
            "reroute",
          ])
        ).exitCode,
      ).toBe(0);
    };

    // The persisted model and effort reach the client unchanged.
    await runtime.schedule(await runtime.task());
    const routed = await tick();
    expect(routed, routed.stderr.join("\n")).toMatchObject({ exitCode: 0 });
    const { args } = fake.report();
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.filter((value) => value === "--model")).toHaveLength(1);
    rmSync(reportPath);

    // --worker-model cannot replace it, and nothing is started.
    const pinned = scheduled(await runtime.schedule(await runtime.task()));
    const conflict = await tick("--worker-model", "gpt-other");
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr.join(" ")).toContain(
      "--worker-model cannot replace an assigned model",
    );
    await queuedThenCancelled(pinned);

    // An output-token cap cannot be applied by the client: refused at admission.
    const developer = (
      await runtime.command(["agent:list", "--project", runtime.projectId])
    ).stdout
      .map((line) => line.split("\t"))
      .find((columns) => columns[3] === "developer")![0]!;
    const capped = scheduled(
      await runtime.command([
        "run:schedule",
        "--project",
        runtime.projectId,
        "--task",
        await runtime.task(),
        "--agent",
        developer,
      ]),
    );
    const refused = await tick();
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain(
      "which the codex worker cannot execute with its assigned parameters",
    );
    expect(refused.stderr.join(" ")).toContain("No runs were started");
    await queuedThenCancelled(capped);
  } finally {
    for (const [name, value] of Object.entries(ambient))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await runtime.close();
  }
});

test("a managed-workspace Codex login fails the run before any Codex process and is not rerouted", async () => {
  const runtime = await runRuntime();
  const ambient = {
    PATH: process.env.PATH,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  try {
    const fake = installFakeCodex(runtime.root);
    process.env.PATH = `${fake.bin}:${ambient.PATH ?? ""}`;
    process.env.CODEX_HOME = createOperatorCodexHome(
      runtime.root,
      "sk-managed",
      "enterprise",
    );
    const runId = (
      await runtime.schedule(await runtime.task())
    ).stdout[0]!.replace("Agent run scheduled: ", "");
    const tick = await runtime.command([
      "run:tick",
      "--project",
      runtime.projectId,
      "--worker",
      "codex",
      "--json",
    ]);
    expect(tick.stdout.join("\n") + tick.stderr.join("\n")).toContain(
      "WORKER_UNAVAILABLE",
    );
    expect(fake.calls()).toEqual([]);
    // The run is not completed by another executor.
    const { run: detail } = (await (
      await fetch(`http://localhost/api/runs/${runId}`, {
        unix: runtime.socketPath,
      })
    ).json()) as {
      run: { run: { status: string }; workerOutput: unknown };
    };
    expect(detail.run.status).not.toBe("completed");
    expect(detail.workerOutput ?? null).toBeNull();
  } finally {
    for (const [name, value] of Object.entries(ambient))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await runtime.close();
  }
});
