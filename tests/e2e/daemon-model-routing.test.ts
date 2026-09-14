import { expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntime } from "../helpers/run-runtime.ts";
import {
  EnvironmentModelProviderCatalog,
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";

const secret = "sk-e2e-model-routing-secret";

const anthropicRouting = `schema_version: 1
profiles:
  economical: { model: "anthropic:claude-haiku-4-5", reasoning_effort: low }
  balanced: { model: "anthropic:claude-sonnet-4-6", reasoning_effort: medium }
  high_reasoning: { model: "anthropic:claude-opus-4-1", reasoning_effort: high }
agents:
  developer: { profile: economical }
`;

function hostRouting(root: string, name: string, text: string) {
  const path = join(root, `${name}.yaml`);
  writeFileSync(path, text);
  const environment = {
    AI_OFFICE_MODEL_ROUTING_FILE: path,
    OPENAI_API_KEY: secret,
  };
  return {
    modelRouting: loadModelRoutingState(environment),
    modelProviders: new EnvironmentModelProviderCatalog(environment),
  };
}

function fakeClaude(root: string): { bin: string; calls: () => string[][] } {
  const bin = join(root, "bin");
  const log = join(root, "claude-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  // A deterministic process double: no installed client or provider is called.
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.270 (Claude Code)'); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const input = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({type:'result', subtype:'success', is_error:false,
 structured_output:{summary:'Analysis', content:'Model ' + input.model.modelRef},
 modelUsage:{[input.model.model]:{}}, usage:{input_tokens:3,output_tokens:4}, total_cost_usd:0.002}));
`,
    { mode: 0o700 },
  );
  return {
    bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
  };
}

function runId(output: { stdout: string[] }): string {
  return output.stdout[0]!.replace("Agent run scheduled: ", "");
}

test("operators inspect routing, and a scheduled run keeps its model across host reconfiguration", async () => {
  const bootstrapRoot = mkdtempSync(join(tmpdir(), "ao-routing-config-"));
  const r = await runRuntime(
    undefined,
    hostRouting(bootstrapRoot, "initial", anthropicRouting),
  );
  const oldPath = process.env.PATH;
  try {
    const models = await r.command([
      "agent:models",
      "--project",
      r.projectId,
      "--json",
    ]);
    expect(models.exitCode).toBe(0);
    const table = JSON.parse(models.stdout[0]!) as {
      schemaVersion: number;
      routing: string;
      agents: Record<string, unknown>[];
    };
    expect(table).toMatchObject({ schemaVersion: 1, routing: "configured" });
    expect(
      table.agents.map((agent) => [
        agent.agent,
        agent.policy,
        agent.profile,
        agent.modelRef,
        agent.source,
      ]),
    ).toEqual([
      [
        "architect",
        "high_reasoning",
        "high_reasoning",
        "anthropic:claude-opus-4-1",
        "role_policy",
      ],
      [
        "developer",
        "balanced",
        "economical",
        "anthropic:claude-haiku-4-5",
        "agent_override",
      ],
      [
        "qa",
        "economical",
        "economical",
        "anthropic:claude-haiku-4-5",
        "role_policy",
      ],
      [
        "reviewer",
        "balanced",
        "balanced",
        "anthropic:claude-sonnet-4-6",
        "role_policy",
      ],
    ]);
    const text = await r.command(["agent:models", "--project", r.projectId]);
    expect(text.stdout).toContain(
      "AGENT\tPOLICY\tPROFILE\tMODEL\tSOURCE\tMAX_COST_MICROS",
    );
    expect(text.stdout).toContain(
      "architect\thigh_reasoning\thigh_reasoning\tanthropic:claude-opus-4-1\trole_policy\t3000000",
    );

    const check = await r.command([
      "model:check",
      "--project",
      r.projectId,
      "--json",
    ]);
    expect(check.exitCode).toBe(0);
    const report = JSON.parse(check.stdout[0]!) as {
      valid: boolean;
      findings: { severity: string; code: string }[];
    };
    expect(report.valid).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "PROVIDER_CREDENTIALS_MISSING",
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "PRICING_MISSING" }),
    );
    expect(JSON.stringify([models, text, check])).not.toContain(secret);
    expect(JSON.stringify(check)).not.toContain(bootstrapRoot);

    expect(
      (
        await r.command([
          "run:schedule",
          "--project",
          r.projectId,
          "--task",
          await r.task(),
          "--agent",
          r.agentId,
          "--model",
          "anthropic:claude-haiku-4-5",
        ])
      ).stderr.join(" "),
    ).toContain("Unknown option --model");

    const scheduled = runId(await r.schedule(await r.task()));
    const assigned = {
      status: "resolved",
      selection: {
        policy: "high_reasoning",
        profile: "high_reasoning",
        modelRef: "anthropic:claude-opus-4-1",
        providerId: "anthropic",
        model: "claude-opus-4-1",
        reasoningEffort: "high",
        maxOutputTokens: null,
        source: "role_policy",
      },
    };
    const show = async () =>
      JSON.parse(
        (
          await r.command([
            "run:show",
            "--project",
            r.projectId,
            "--run",
            scheduled,
            "--json",
          ])
        ).stdout[0]!,
      ) as Record<string, unknown>;
    expect((await show()).model).toEqual(assigned);

    // The host restarts with a different profile for the same policy and an
    // explicit override for the agent. The admitted run keeps its model.
    await r.restart(
      hostRouting(
        bootstrapRoot,
        "changed",
        `schema_version: 1
profiles:
  high_reasoning: { model: "anthropic:claude-sonnet-4-6" }
agents:
  architect: { model: "anthropic:claude-haiku-4-5" }
`,
      ),
    );
    expect((await show()).model).toEqual(assigned);
    const changed = JSON.parse(
      (await r.command(["agent:models", "--project", r.projectId, "--json"]))
        .stdout[0]!,
    ) as { agents: Record<string, unknown>[] };
    expect(changed.agents[0]).toMatchObject({
      agent: "architect",
      modelRef: "anthropic:claude-haiku-4-5",
      source: "agent_override",
    });

    const claude = fakeClaude(r.root);
    process.env.PATH = `${claude.bin}:${oldPath ?? ""}`;
    const tick = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "claude",
      "--json",
    ]);
    expect(tick, tick.stderr.join("\n")).toMatchObject({ exitCode: 0 });
    const args = claude.calls()[0]!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-1");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("3.000000");

    const completed = await show();
    expect(completed).toMatchObject({
      run: { status: "completed" },
      model: assigned,
      usage: {
        reportedModel: "claude-opus-4-1",
        tokens: { inputTokens: 3, outputTokens: 4 },
        estimatedCostUsd: 0.002,
      },
      roleLimits: {
        maxCostMicros: "3000000",
        maxIterations: 8,
        timeoutSeconds: 1800,
      },
    });
    const human = await r.command([
      "run:show",
      "--project",
      r.projectId,
      "--run",
      scheduled,
    ]);
    expect(human.stdout).toContain(
      "Model: anthropic:claude-opus-4-1 (policy high_reasoning; profile high_reasoning; source role_policy; provider anthropic)",
    );
    expect(human.stdout).toContain(
      "Budget: role max cost 3000000 micros; 8 iterations; 1800s timeout",
    );
    expect(JSON.stringify([completed, human])).not.toContain(secret);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await r.close();
    rmSync(bootstrapRoot, { recursive: true, force: true });
  }
});

test("invalid host routing fails closed for scheduling and diagnostics", async () => {
  const r = await runRuntime(undefined, {
    modelRouting: loadModelRoutingState(
      { AI_OFFICE_MODEL_ROUTING_FILE: "/ai-office-routing/model-routing.yaml" },
      {
        readFile: () => `schema_version: 1
profiles:
  high_reasoning: { model: "unknown-provider:big" }
`,
      },
    ),
  });
  try {
    const check = await r.command(["model:check", "--json"]);
    expect(check.exitCode).toBe(1);
    const report = JSON.parse(check.stdout[0]!) as {
      status: string;
      valid: boolean;
      findings: { severity: string; code: string; subject: string }[];
    };
    expect(report).toMatchObject({ status: "misconfigured", valid: false });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "PROVIDER_UNSUPPORTED",
        subject: "profiles.high_reasoning.model",
      }),
    );
    const human = await r.command(["model:check"]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout.join("\n")).toContain("ERROR PROVIDER_UNSUPPORTED");

    const taskId = await r.task();
    const scheduled = await r.schedule(taskId);
    expect(scheduled.exitCode).toBe(1);
    expect(scheduled.stderr.join(" ")).toContain("model:check");
    expect(
      (await r.command(["run:list", "--project", r.projectId])).stdout,
    ).toEqual(["No agent runs found."]);
    expect(
      JSON.parse(
        (
          await r.command([
            "task:transitions",
            "--project",
            r.projectId,
            "--task",
            taskId,
            "--json",
          ])
        ).stdout[0]!,
      ),
    ).toMatchObject({ taskId, status: "pending" });
  } finally {
    await r.close();
  }
});

test("a worker that cannot honor the assigned model leaves the queue unchanged", async () => {
  const r = await runRuntime(undefined, {
    modelRouting: loadModelRoutingState(
      { AI_OFFICE_MODEL_ROUTING_FILE: "/ai-office-routing/model-routing.yaml" },
      {
        readFile: () => `schema_version: 1
profiles:
  anthropic_default: { model: "anthropic:claude-sonnet-4-6" }
default_profile: anthropic_default
agents:
  architect: { model: "openai:gpt-astra" }
`,
      },
    ),
  });
  const oldPath = process.env.PATH;
  try {
    const claude = fakeClaude(r.root);
    process.env.PATH = `${claude.bin}:${oldPath ?? ""}`;
    const scheduled = runId(await r.schedule(await r.task()));
    const refused = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "claude",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain("openai:gpt-astra");
    expect(refused.stderr.join(" ")).toContain("No runs were started");
    expect(claude.calls()).toEqual([]);
    expect(
      (
        await r.command([
          "run:show",
          "--project",
          r.projectId,
          "--run",
          scheduled,
        ])
      ).stdout,
    ).toContain("Status: queued");
    expect(
      (
        await r.command([
          "run:cancel",
          "--project",
          r.projectId,
          "--run",
          scheduled,
          "--reason",
          "reroute",
        ])
      ).exitCode,
    ).toBe(0);

    // An anthropic assignment cannot be replaced by a per-tick worker model.
    const developer = (
      await r.command(["agent:list", "--project", r.projectId])
    ).stdout
      .map((line) => line.split("\t"))
      .find((columns) => columns[3] === "developer")![0]!;
    const second = runId(
      await r.command([
        "run:schedule",
        "--project",
        r.projectId,
        "--task",
        await r.task(),
        "--agent",
        developer,
      ]),
    );
    const conflict = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "claude",
      "--worker-model",
      "claude-opus-4-1",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr.join(" ")).toContain(
      "--worker-model cannot replace an assigned model",
    );
    expect(claude.calls()).toEqual([]);
    expect(
      (await r.command(["run:show", "--project", r.projectId, "--run", second]))
        .stdout,
    ).toContain("Status: queued");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await r.close();
  }
});

test("hosts without routing schedule unrouted runs and report them explicitly", async () => {
  const r = await runRuntime();
  try {
    const check = await r.command(["model:check", "--json"]);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout[0]!)).toMatchObject({
      status: "unconfigured",
      valid: true,
      findings: [],
    });
    const scheduled = runId(await r.schedule(await r.task()));
    const show = await r.command([
      "run:show",
      "--project",
      r.projectId,
      "--run",
      scheduled,
    ]);
    expect(show.stdout).toContain(
      "Model: unrouted (no model routing was configured at scheduling; the executor used its own default)",
    );
    const models = await r.command(["agent:models", "--project", r.projectId]);
    expect(models.stdout).toContain(
      "architect\thigh_reasoning\t-\t(executor default)\t-\t3000000",
    );
  } finally {
    await r.close();
  }
});
