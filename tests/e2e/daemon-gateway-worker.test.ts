import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntime } from "../helpers/run-runtime.ts";
import {
  EnvironmentModelProviderCatalog,
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";
import {
  EnvironmentGatewayModelProviders,
  type GatewayModelProviders,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";

const secret = "sk-e2e-gateway-worker-secret";

/** Placeholder model names; no concrete vendor model is assumed. */
const openAiRouting = (highReasoningModel: string) => `schema_version: 1
profiles:
  economical: { model: "openai:economy-model", reasoning_effort: low, max_output_tokens: 2000 }
  balanced: { model: "openai:economy-model", reasoning_effort: medium, max_output_tokens: 2000 }
  high_reasoning: { model: "openai:${highReasoningModel}", reasoning_effort: high, max_output_tokens: 4000 }
`;

function hostRouting(
  root: string,
  name: string,
  text: string,
  environment: Record<string, string> = {},
) {
  const path = join(root, `${name}.yaml`);
  writeFileSync(path, text);
  const values = { ...environment, AI_OFFICE_MODEL_ROUTING_FILE: path };
  return {
    modelRouting: loadModelRoutingState(values),
    modelProviders: new EnvironmentModelProviderCatalog(values),
  };
}

/** Real gateway resolution and OpenAI adapter; only HTTP is replaced. */
function gatewayHost(environment: Record<string, string>) {
  const requests: Record<string, unknown>[] = [];
  const fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return Response.json({
      id: `resp_${requests.length}`,
      model: body.model,
      status: "completed",
      output_text: JSON.stringify({
        summary: "Plan",
        content: "Gateway draft",
      }),
      usage: { input_tokens: 1000, output_tokens: 250 },
    });
  };
  const host = new EnvironmentGatewayModelProviders(environment);
  const gatewayProviders: GatewayModelProviders = {
    descriptors: host.descriptors,
    missingCredentials: (providerId) => host.missingCredentials(providerId),
    resolve: async (modelRef) => ({
      ...(await host.resolve(modelRef)),
      provider: new OpenAiResponsesProvider(
        environment.OPENAI_API_KEY ?? "unused",
        "https://provider.test/v1/responses",
        fetcher,
      ),
    }),
  };
  return { requests, gatewayProviders };
}

function runId(output: { stdout: string[] }): string {
  return output.stdout[0]!.replace("Agent run scheduled: ", "");
}

test("the gateway worker executes a routed openai run with its persisted model and metered cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-routing-gateway-"));
  const first = gatewayHost({ OPENAI_API_KEY: secret });
  const r = await runRuntime(undefined, {
    ...hostRouting(root, "initial", openAiRouting("reasoning-model"), {
      OPENAI_API_KEY: secret,
    }),
    gatewayProviders: first.gatewayProviders,
  });
  try {
    for (const model of ["reasoning-model", "economy-model"])
      expect(
        (
          await r.command([
            "pricing:set",
            "--provider",
            "openai",
            "--model",
            model,
            "--currency",
            "USD",
            "--input",
            "1000000",
            "--cached-input",
            "500000",
            "--output",
            "4000000",
            "--reasoning",
            "4000000",
          ])
        ).exitCode,
      ).toBe(0);
    const scheduled = runId(await r.schedule(await r.task()));

    // The host restarts with the policy remapped and an ambient legacy model;
    // neither may replace the persisted selection.
    const changedEnvironment = {
      OPENAI_API_KEY: secret,
      AI_OFFICE_LLM_MODEL: "openai:ambient-model",
    };
    const changed = gatewayHost(changedEnvironment);
    await r.restart({
      ...hostRouting(
        root,
        "changed",
        openAiRouting("economy-model"),
        changedEnvironment,
      ),
      gatewayProviders: changed.gatewayProviders,
    });

    const checkOutput = await r.command([
      "model:check",
      "--project",
      r.projectId,
      "--json",
    ]);
    const check = JSON.parse(checkOutput.stdout[0]!) as {
      providers: Record<string, unknown>[];
    };
    expect(check.providers).toEqual([
      {
        providerId: "openai",
        supported: true,
        gatewayExecution: true,
        missingCredentials: [],
      },
    ]);

    const override = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
      "--worker-model",
      "economy-model",
    ]);
    expect(override.exitCode).toBe(1);
    expect(override.stderr.join(" ")).toContain(
      "the gateway worker executes each run's assigned model",
    );
    expect(changed.requests).toEqual([]);

    const tick = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
      "--json",
    ]);
    expect(tick, JSON.stringify(tick)).toMatchObject({ exitCode: 0 });
    expect(changed.requests).toHaveLength(1);
    expect(changed.requests[0]).toMatchObject({
      model: "reasoning-model",
      reasoning: { effort: "high" },
      max_output_tokens: 4000,
      store: false,
    });

    const shownOutput = await r.command([
      "run:show",
      "--project",
      r.projectId,
      "--run",
      scheduled,
      "--json",
    ]);
    const shown = JSON.parse(shownOutput.stdout[0]!) as Record<string, unknown>;
    expect(shown).toMatchObject({
      run: { status: "completed" },
      execution: { kind: "worker", adapterId: "llm-gateway" },
      model: {
        status: "resolved",
        selection: {
          modelRef: "openai:reasoning-model",
          reasoningEffort: "high",
          maxOutputTokens: 4000,
        },
      },
      usage: {
        reportedModel: "reasoning-model",
        estimatedCostUsd: null,
        metering: {
          kind: "gateway",
          providerId: "openai",
          model: "reasoning-model",
          currency: "USD",
          budgetLimitMicros: "3000000",
          // 1000 input tokens at 1 micro, 250 output tokens at 4 micros.
          actualMicros: "2000",
        },
      },
      roleLimits: { maxCostMicros: "3000000" },
    });
    const human = await r.command([
      "run:show",
      "--project",
      r.projectId,
      "--run",
      scheduled,
    ]);
    expect(human.stdout).toContain(
      "Usage: actual openai:reasoning-model; tokens 1000 input (0 cached) / 250 output (0 reasoning); max output tokens 4000",
    );
    expect(human.stdout.join("\n")).toContain(
      "Metered cost: actual 2000 USD micros",
    );
    const costs = await r.command([
      "cost:list",
      "--project",
      r.projectId,
      "--group-by",
      "agent_run",
    ]);
    expect(costs.stdout.join("\n")).toContain(scheduled);
    expect(
      JSON.stringify([checkOutput, tick, shownOutput, human, costs]),
    ).not.toContain(secret);
  } finally {
    await r.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Runtime host with the managed routing marker discovers AI_OFFICE_HOME routing on every restart", async () => {
  const names = [
    "AI_OFFICE_MODEL_ROUTING_SOURCE",
    "AI_OFFICE_MODEL_ROUTING_FILE",
    "AI_OFFICE_LLM_MODEL",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const r = await runRuntime();
  try {
    writeFileSync(
      join(r.root, ".ai-office", "model-routing.yaml"),
      openAiRouting("reasoning-model"),
    );
    // What a generated service definition sets, plus ambient shell values a
    // service manager environment might still carry.
    process.env.AI_OFFICE_MODEL_ROUTING_SOURCE = "runtime_home";
    process.env.AI_OFFICE_MODEL_ROUTING_FILE = "/shell-only/routing.yaml";
    process.env.AI_OFFICE_LLM_MODEL = "openai:shell-model";
    for (let start = 0; start < 2; start += 1) {
      await r.restart({});
      const check = JSON.parse(
        (await r.command(["model:check", "--project", r.projectId, "--json"]))
          .stdout[0]!,
      ) as {
        status: string;
        sources: unknown;
        findings: { code: string }[];
        project: { agents: { agent: string; modelRef: string }[] };
      };
      expect(check).toMatchObject({
        status: "configured",
        sources: {
          file: true,
          fileOrigin: "runtime_home",
          legacyEnvironment: false,
          managed: true,
        },
      });
      expect(
        check.findings.filter(
          (finding) => finding.code === "MANAGED_ENVIRONMENT_IGNORED",
        ),
      ).toHaveLength(2);
      expect(
        check.project.agents.find((agent) => agent.agent === "architect")
          ?.modelRef,
      ).toBe("openai:reasoning-model");
    }
    const human = await r.command(["model:check"]);
    expect(human.stdout.join("\n")).toContain(
      "Sources: routing file model-routing.yaml in AI_OFFICE_HOME; AI_OFFICE_LLM_MODEL ignored (managed service)",
    );
    expect(human.stdout.join("\n")).not.toContain(r.root);
    expect(human.stdout.join("\n")).not.toContain("/shell-only/routing.yaml");
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await r.close();
  }
});

test("the gateway worker refuses unrouted runs and missing credentials before any request", async () => {
  const unrouted = gatewayHost({ OPENAI_API_KEY: secret });
  const plain = await runRuntime(undefined, {
    gatewayProviders: unrouted.gatewayProviders,
  });
  try {
    const scheduled = runId(await plain.schedule(await plain.task()));
    const refused = await plain.command([
      "run:tick",
      "--project",
      plain.projectId,
      "--worker",
      "gateway",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain(
      `Run ${scheduled} has no assigned model (unrouted)`,
    );
    expect(unrouted.requests).toEqual([]);
  } finally {
    await plain.close();
  }

  const root = mkdtempSync(join(tmpdir(), "ao-routing-credentials-"));
  const missing = gatewayHost({});
  const r = await runRuntime(undefined, {
    ...hostRouting(root, "routing", openAiRouting("reasoning-model")),
    gatewayProviders: missing.gatewayProviders,
  });
  try {
    const scheduled = runId(await r.schedule(await r.task()));
    const refused = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain(
      "the Runtime host environment has no OPENAI_API_KEY",
    );
    expect(missing.requests).toEqual([]);
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
  } finally {
    await r.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("controlled-action payload fields named model are ordinary data and never select the run model", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-routing-actions-"));
  const r = await runRuntime(
    undefined,
    hostRouting(root, "routing", openAiRouting("reasoning-model")),
  );
  try {
    const resource = (
      await r.command([
        "resource:create",
        "--project",
        r.projectId,
        "--type",
        "filesystem_scope",
        "--provider",
        "fake",
        "--name",
        "Vehicle catalog",
        "--external-ref",
        root,
      ])
    ).stdout[0]!.replace("Resource created: ", "");
    expect(
      (
        await r.command([
          "capability:grant",
          "--project",
          r.projectId,
          "--principal-type",
          "agent",
          "--principal",
          r.agentId,
          "--resource",
          resource,
          "--actions",
          "fake.write",
          "--granted-by",
          "owner",
          "--reason",
          "vehicle lookup",
        ])
      ).exitCode,
    ).toBe(0);
    const payload = {
      vehicle: { manufacturer: "Tesla", model: "Model 3" },
      model: "openai:economy-model",
      modelRef: "anthropic:client-model",
      reasoningEffort: "max",
    };
    const scheduled = await r.command([
      "run:schedule",
      "--project",
      r.projectId,
      "--task",
      await r.task(),
      "--agent",
      r.agentId,
      "--resource",
      resource,
      "--operation",
      "fake.write",
      "--arguments",
      JSON.stringify(payload),
    ]);
    expect(scheduled, scheduled.stderr.join("\n")).toMatchObject({
      exitCode: 0,
      stderr: [],
    });
    const id = runId(scheduled);
    const show = async () =>
      JSON.parse(
        (
          await r.command([
            "run:show",
            "--project",
            r.projectId,
            "--run",
            id,
            "--json",
          ])
        ).stdout[0]!,
      ) as { model: unknown; run: { status: string } };
    const assigned = {
      status: "resolved",
      selection: {
        policy: "high_reasoning",
        profile: "high_reasoning",
        modelRef: "openai:reasoning-model",
        providerId: "openai",
        model: "reasoning-model",
        reasoningEffort: "high",
        maxOutputTokens: 4000,
        source: "role_policy",
      },
    };
    // The assignment comes from host routing and the architect's role policy.
    expect((await show()).model).toEqual(assigned);

    // Invoked under normal capability rules: the grant allows the request and
    // the connector receives the payload unchanged.
    const tick = await r.command(["run:tick", "--project", r.projectId]);
    expect(tick, JSON.stringify(tick)).toMatchObject({ exitCode: 0 });
    const actionLine = tick.stdout.find((line) =>
      line.startsWith(`Run ${id} action: `),
    );
    expect(actionLine).toBeDefined();
    const action = actionLine!
      .replace(`Run ${id} action: `, "")
      .replace(/ \(.*\)$/u, "");
    const detail = await r.command([
      "action:show",
      "--project",
      r.projectId,
      "--action",
      action,
    ]);
    expect(detail.stdout.join("\n")).toContain("Model 3");
    expect(detail.stdout.join("\n")).toContain("allowed");
    expect((await show()).model).toEqual(assigned);
  } finally {
    await r.close();
    rmSync(root, { recursive: true, force: true });
  }
});
