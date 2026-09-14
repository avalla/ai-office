import { describe, expect, test } from "vitest";
import {
  ModelRoutingError,
  resolveAgentRunModel,
  unconfiguredModelRouting,
  type ModelRoutingState,
} from "@ai-office/application/model-routing/model-routing.ts";
import {
  EnvironmentModelProviderCatalog,
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";
import {
  createDefaultModelProviderRegistry,
  ModelProviderConfigurationError,
} from "@ai-office/llm-gateway/model-provider-registry.ts";
import {
  parseAgentRunModelRouting,
  type AgentRunModelSelection,
} from "@ai-office/domain/agent/agent-run-model.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { ClaudeWorkerRuntime } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  WorkerRuntimeError,
  type WorkerContext,
} from "@ai-office/application/ports/worker-runtime.port.ts";

const exampleRouting = `
schema_version: 1
profiles:
  economical:
    model: openai:gpt-luna
    reasoning_effort: low
  balanced:
    model: openai:gpt-sol
    reasoning_effort: medium
  high_reasoning:
    model: openai:gpt-astra
    reasoning_effort: high
    max_output_tokens: 32000
policies:
  default: balanced
agents:
  developer:
    profile: economical
  reviewer:
    model: anthropic:claude-sonnet-4-6
`;

function load(
  text: string | null,
  environment: Record<string, string> = {},
): ModelRoutingState {
  return loadModelRoutingState(
    {
      ...(text === null
        ? {}
        : { AI_OFFICE_MODEL_ROUTING_FILE: "/host/model-routing.yaml" }),
      ...environment,
    },
    {
      readFile: (path) => {
        expect(path).toBe("/host/model-routing.yaml");
        if (text === null) throw new Error("not reached");
        return text;
      },
    },
  );
}

function selection(
  state: ModelRoutingState,
  agentName: string,
  modelPolicy: string,
): AgentRunModelSelection {
  const routing = resolveAgentRunModel(state, {
    projectId: "p",
    agentName,
    modelPolicy,
  });
  if (routing.status !== "resolved") throw new Error("expected a selection");
  return routing.selection;
}

function issueCodes(state: ModelRoutingState): string[] {
  return state.status === "misconfigured"
    ? state.issues.map((issue) => issue.code)
    : [];
}

describe("model routing resolution", () => {
  test("maps economical, balanced and high_reasoning policies through profiles", () => {
    const state = load(exampleRouting);
    expect(state.status).toBe("configured");
    expect(selection(state, "qa", "economical")).toEqual({
      policy: "economical",
      profile: "economical",
      modelRef: "openai:gpt-luna",
      providerId: "openai",
      model: "gpt-luna",
      reasoningEffort: "low",
      maxOutputTokens: null,
      source: "role_policy",
    });
    expect(selection(state, "architect", "balanced")).toMatchObject({
      profile: "balanced",
      modelRef: "openai:gpt-sol",
      reasoningEffort: "medium",
      source: "role_policy",
    });
    expect(selection(state, "security", "high_reasoning")).toMatchObject({
      profile: "high_reasoning",
      modelRef: "openai:gpt-astra",
      reasoningEffort: "high",
      maxOutputTokens: 32000,
      source: "role_policy",
    });
    // An explicit policy mapping names another profile.
    expect(selection(state, "someone", "default")).toMatchObject({
      policy: "default",
      profile: "balanced",
      source: "role_policy",
    });
  });

  test("an agent override takes precedence over the role policy", () => {
    const state = load(exampleRouting);
    expect(selection(state, "developer", "high_reasoning")).toMatchObject({
      policy: "high_reasoning",
      profile: "economical",
      modelRef: "openai:gpt-luna",
      source: "agent_override",
    });
    expect(selection(state, "reviewer", "balanced")).toEqual({
      policy: "balanced",
      profile: null,
      modelRef: "anthropic:claude-sonnet-4-6",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: null,
      maxOutputTokens: null,
      source: "agent_override",
    });
  });

  test("falls back to the default profile, then the legacy environment model", () => {
    const withDefault = load(
      `schema_version: 1
profiles:
  cheap: { model: "openai:gpt-luna" }
default_profile: cheap
`,
      { AI_OFFICE_LLM_MODEL: "anthropic:claude-sonnet-4-6" },
    );
    expect(selection(withDefault, "qa", "mock")).toMatchObject({
      profile: "cheap",
      modelRef: "openai:gpt-luna",
      source: "default",
    });

    const legacyOnly = load(null, {
      AI_OFFICE_LLM_MODEL: "anthropic:claude-sonnet-4-6",
    });
    expect(legacyOnly.status).toBe("configured");
    expect(selection(legacyOnly, "qa", "high_reasoning")).toEqual({
      policy: "high_reasoning",
      profile: null,
      modelRef: "anthropic:claude-sonnet-4-6",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: null,
      maxOutputTokens: null,
      source: "legacy_default",
    });

    const compatibility = load(null, {
      AI_OFFICE_LLM_MODEL: "gpt-5.4",
      AI_OFFICE_LLM_PROVIDER: "OpenAI",
    });
    expect(selection(compatibility, "qa", "x").modelRef).toBe("openai:gpt-5.4");
    expect(compatibility.warnings.map((value) => value.code)).toEqual([
      "LEGACY_PROVIDER_FORM_DEPRECATED",
    ]);
  });

  test("unconfigured hosts schedule unrouted runs and never invent a model", () => {
    expect(load(null)).toMatchObject({ status: "unconfigured" });
    expect(
      resolveAgentRunModel(unconfiguredModelRouting, {
        projectId: "p",
        agentName: "architect",
        modelPolicy: "high_reasoning",
      }),
    ).toEqual({ status: "unrouted" });
  });

  test("an unmapped policy without a default fails closed", () => {
    const state = load(`schema_version: 1
profiles:
  balanced: { model: "openai:gpt-sol" }
`);
    expect(() =>
      resolveAgentRunModel(state, {
        projectId: "p",
        agentName: "qa",
        modelPolicy: "mock",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ModelRoutingError",
        code: "MODEL_POLICY_UNRESOLVED",
      }),
    );
  });

  test("explicit invalid configuration never falls through to a lower rule", () => {
    const state = load(
      `schema_version: 1
profiles:
  balanced: { model: "openai:gpt-sol" }
agents:
  developer: { profile: missing }
`,
      { AI_OFFICE_LLM_MODEL: "openai:gpt-5.4" },
    );
    expect(state.status).toBe("misconfigured");
    let caught: unknown;
    try {
      resolveAgentRunModel(state, {
        projectId: "p",
        agentName: "architect",
        modelPolicy: "balanced",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelRoutingError);
    expect((caught as ModelRoutingError).code).toBe(
      "MODEL_ROUTING_MISCONFIGURED",
    );
  });
});

describe("model routing configuration diagnostics", () => {
  test("reports malformed refs, unsupported providers and invalid references", () => {
    const state = load(`schema_version: 1
profiles:
  bad_ref: { model: "gpt-without-provider" }
  unsupported: { model: "ollama:qwen3" }
  bad_effort: { model: "openai:gpt-sol", reasoning_effort: "Very High" }
  bad_tokens: { model: "openai:gpt-sol", max_output_tokens: 0 }
policies:
  balanced: nowhere
default_profile: absent
agents:
  developer: { profile: nowhere }
  qa: { model: "local:thing" }
  both: { profile: bad_ref, model: "openai:gpt-sol" }
`);
    expect(state.status).toBe("misconfigured");
    expect(issueCodes(state).sort()).toEqual(
      [
        "MODEL_REF_MALFORMED",
        "PROVIDER_UNSUPPORTED",
        "EXECUTION_PARAMETER_INVALID",
        "EXECUTION_PARAMETER_INVALID",
        "PROFILE_UNDEFINED",
        "DEFAULT_UNRESOLVED",
        "AGENT_OVERRIDE_UNAVAILABLE",
        "PROVIDER_UNSUPPORTED",
        "AGENT_OVERRIDE_UNAVAILABLE",
      ].sort(),
    );
  });

  test("rejects credentials, unknown keys, relative paths and unreadable files without echoing values", () => {
    const withSecret = load(`schema_version: 1
profiles:
  balanced:
    model: openai:gpt-sol
    api_key: sk-routing-secret-value
`);
    expect(issueCodes(withSecret)).toEqual(["CONFIGURATION_INVALID"]);
    expect(JSON.stringify(withSecret)).not.toContain("sk-routing-secret-value");
    expect(JSON.stringify(withSecret)).toContain(
      "Credentials are not accepted",
    );

    expect(issueCodes(load("schema_version: 2\n"))).toEqual([
      "CONFIGURATION_INVALID",
    ]);
    expect(issueCodes(load("profiles: [\n"))).toEqual([
      "CONFIGURATION_INVALID",
    ]);

    const relative = loadModelRoutingState({
      AI_OFFICE_MODEL_ROUTING_FILE: "private/routing.yaml",
    });
    expect(issueCodes(relative)).toEqual(["CONFIGURATION_INVALID"]);
    expect(JSON.stringify(relative)).not.toContain("private/routing.yaml");

    const unreadable = loadModelRoutingState(
      { AI_OFFICE_MODEL_ROUTING_FILE: "/secret/location.yaml" },
      {
        readFile: () => {
          throw new Error("ENOENT /secret/location.yaml");
        },
      },
    );
    expect(issueCodes(unreadable)).toEqual(["CONFIGURATION_UNREADABLE"]);
    expect(JSON.stringify(unreadable)).not.toContain("/secret/location.yaml");

    const pasted = load(`schema_version: 1
profiles:
  balanced: { model: "sk-pasted-into-model-field" }
`);
    expect(issueCodes(pasted)).toEqual(["MODEL_REF_MALFORMED"]);
    expect(JSON.stringify(pasted)).not.toContain("sk-pasted-into-model-field");

    expect(issueCodes(load(null, { AI_OFFICE_LLM_MODEL: "gpt-5.4" }))).toEqual([
      "MODEL_REF_MALFORMED",
    ]);
    expect(
      issueCodes(load(null, { AI_OFFICE_LLM_MODEL: "ollama:qwen3" })),
    ).toEqual(["PROVIDER_UNSUPPORTED"]);
  });

  test("the provider catalog reports missing credential names, never values", () => {
    const catalog = new EnvironmentModelProviderCatalog({
      OPENAI_API_KEY: "sk-present-value",
      ANTHROPIC_API_KEY: " ",
    });
    expect(catalog.supportedProviders()).toEqual(["anthropic", "openai"]);
    expect(catalog.missingCredentials("openai")).toEqual([]);
    expect(catalog.missingCredentials("anthropic")).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    expect(catalog.missingCredentials("ollama")).toBeNull();
  });
});

describe("provider registry explicit model refs", () => {
  test("resolves a supplied canonical ref independently of AI_OFFICE_LLM_MODEL", () => {
    const resolved = createDefaultModelProviderRegistry().resolveModelRef(
      "anthropic:claude-sonnet-4-6",
      {
        AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
        ANTHROPIC_API_KEY: "test-anthropic-key",
      },
    );
    expect(resolved).toMatchObject({
      modelRef: "anthropic:claude-sonnet-4-6",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(resolved.provider.id).toBe("anthropic");
  });

  test("fails closed for malformed, unsupported and uncredentialed refs", () => {
    const registry = createDefaultModelProviderRegistry();
    for (const value of [
      "gpt-5.4",
      "openai:",
      " openai:gpt-5.4",
      "ollama:qwen3",
    ])
      expect(() =>
        registry.resolveModelRef(value, { OPENAI_API_KEY: "key" }),
      ).toThrow(ModelProviderConfigurationError);
    let missing: unknown;
    try {
      registry.resolveModelRef("openai:gpt-5.4", {});
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({ missing: ["OPENAI_API_KEY"] });
  });
});

describe("run model snapshot", () => {
  const resolved = {
    status: "resolved",
    selection: {
      policy: "economical",
      profile: "economical",
      modelRef: "openai:gpt-luna",
      providerId: "openai",
      model: "gpt-luna",
      reasoningEffort: "low",
      maxOutputTokens: null,
      source: "role_policy",
    },
  } as const;

  test("accepts only the strict non-secret shape", () => {
    expect(parseAgentRunModelRouting(resolved)).toEqual(resolved);
    expect(parseAgentRunModelRouting({ status: "unrouted" })).toEqual({
      status: "unrouted",
    });
    for (const invalid of [
      { status: "unrouted", selection: resolved.selection },
      { status: "resolved" },
      {
        status: "resolved",
        selection: { ...resolved.selection, apiKey: "sk-secret" },
      },
      {
        status: "resolved",
        selection: { ...resolved.selection, modelRef: "openai:other" },
      },
      {
        status: "resolved",
        selection: { ...resolved.selection, source: "worker" },
      },
      {
        status: "resolved",
        selection: { ...resolved.selection, profile: null },
      },
      {
        status: "resolved",
        selection: { ...resolved.selection, maxOutputTokens: -1 },
      },
    ])
      expect(() => parseAgentRunModelRouting(invalid)).toThrow(
        DomainValidationError,
      );
  });

  test("lifecycle transitions keep the model assigned at scheduling", () => {
    const now = new Date("2026-09-14T00:00:00.000Z");
    const run = AgentRun.create({
      id: "r",
      projectId: "p",
      taskId: "t",
      agentId: "a",
      modelRouting: resolved,
      now,
    });
    run.transition("preparing", now);
    run.transition("running", now, {
      execution: {
        kind: "simulation",
        adapterId: "simulated",
        adapterVersion: "1",
      },
    });
    run.transition("failed", now, { error: { code: "X" } });
    expect(run.snapshot().modelRouting).toEqual(resolved);
    expect(Object.isFrozen(run.snapshot().modelRouting)).toBe(true);
  });

  test("controlled-action payload fields named like model settings are ordinary data", () => {
    const now = new Date("2026-09-14T00:00:00.000Z");
    for (const argumentsValue of [
      { manufacturer: "Tesla", model: "Model 3" },
      { path: "README.md", options: { model_ref: "openai:gpt-astra" } },
      { items: [{ reasoningEffort: "max", modelPolicy: "high_reasoning" }] },
    ]) {
      const run = AgentRun.create({
        id: "r",
        projectId: "p",
        taskId: "t",
        agentId: "a",
        actionIntent: {
          resourceId: "resource",
          operation: "vehicle.lookup",
          arguments: argumentsValue,
        },
        modelRouting: resolved,
        now,
      });
      // The payload is kept verbatim and never becomes model authority.
      expect(run.snapshot().actionIntent?.arguments).toEqual(argumentsValue);
      expect(run.snapshot().modelRouting).toEqual(resolved);
    }
  });
});

describe("claude worker model honoring", () => {
  const base: AgentRunModelSelection = {
    policy: "balanced",
    profile: "balanced",
    modelRef: "anthropic:claude-sonnet-4-6",
    providerId: "anthropic",
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    maxOutputTokens: null,
    source: "role_policy",
  };
  const context: WorkerContext = {
    schemaVersion: 1,
    projectId: "p",
    runId: "r",
    task: {
      id: "t",
      title: "Explain",
      description: null,
      updatedAt: "2026-09-07T00:00:00.000Z",
    },
    agent: {
      id: "a",
      name: "architect",
      roleId: "role",
      roleKey: "architect",
      roleVersion: 1,
    },
    model: base,
    stage: null,
    memory: { results: [] },
  };
  const output = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { summary: "s", content: "c" },
  });

  test("supports only the exact assigned Anthropic model and parameters", () => {
    const worker = new ClaudeWorkerRuntime("claude", async () => output);
    expect(worker.supportsModel(base)).toEqual({ supported: true });
    for (const selection of [
      {
        ...base,
        providerId: "openai",
        modelRef: "openai:gpt-sol",
        model: "gpt-sol",
      },
      { ...base, maxOutputTokens: 4000 },
      { ...base, reasoningEffort: "minimal" },
      { ...base, model: "vendor/model", modelRef: "anthropic:vendor/model" },
    ])
      expect(worker.supportsModel(selection)).toEqual({
        supported: false,
        code: "WORKER_MODEL_UNSUPPORTED",
      });
    expect(
      new ClaudeWorkerRuntime(
        "claude",
        async () => output,
        "claude-opus-4-1",
      ).supportsModel(base),
    ).toEqual({ supported: false, code: "WORKER_MODEL_CONFLICT" });
    expect(
      new ClaudeWorkerRuntime(
        "claude",
        async () => output,
        "claude-sonnet-4-6",
      ).supportsModel(base),
    ).toEqual({ supported: true });
  });

  test("passes the persisted model and effort, and refuses a substitute", async () => {
    const calls: string[][] = [];
    const runner = async (request: { args: readonly string[] }) => {
      calls.push([...request.args]);
      return request.args[0] === "--version"
        ? "2.1.270 (Claude Code)\n"
        : output;
    };
    const limits = {
      timeoutMs: 1000,
      maxTurns: 2,
      maxEstimatedCostUsd: "0.100000",
      maxCostMicros: 100000n,
    };
    await new ClaudeWorkerRuntime("claude", runner, undefined, "posix").execute(
      context,
      limits,
    );
    const args = calls.at(-1)!;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");

    calls.length = 0;
    await expect(
      new ClaudeWorkerRuntime(
        "claude",
        runner,
        "claude-opus-4-1",
        "posix",
      ).execute(context, limits),
    ).rejects.toEqual(new WorkerRuntimeError("WORKER_MODEL_CONFLICT"));
    await expect(
      new ClaudeWorkerRuntime("claude", runner, undefined, "posix").execute(
        {
          ...context,
          model: {
            ...base,
            providerId: "openai",
            modelRef: "openai:gpt-sol",
            model: "gpt-sol",
          },
        },
        limits,
      ),
    ).rejects.toEqual(new WorkerRuntimeError("WORKER_MODEL_UNSUPPORTED"));
    expect(calls).toEqual([]);

    const { model: _model, ...unrouted } = context;
    await new ClaudeWorkerRuntime(
      "claude",
      runner,
      "claude-opus-4-1",
      "posix",
    ).execute(unrouted, limits);
    const legacy = calls.at(-1)!;
    expect(legacy[legacy.indexOf("--model") + 1]).toBe("claude-opus-4-1");
    expect(legacy).not.toContain("--effort");
  });
});
