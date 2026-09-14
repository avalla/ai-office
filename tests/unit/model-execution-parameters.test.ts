import { describe, expect, test } from "vitest";
import { LangChainModelProvider } from "@ai-office/llm-gateway/langchain-model-provider.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import {
  ExactModelProvider,
  ModelMismatchError,
  UnsupportedModelParameterError,
} from "@ai-office/llm-gateway/provider.ts";
import {
  GatewayWorkerRuntime,
  parseGatewayWorkerArtifact,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { defaultModelProviderDescriptors } from "@ai-office/llm-gateway/model-ref.ts";
import {
  WorkerRuntimeError,
  type WorkerContext,
} from "@ai-office/application/ports/worker-runtime.port.ts";
import type { CostRepository } from "@ai-office/application/ports/cost-repository.port.ts";
import type { AgentRunModelSelection } from "@ai-office/domain/agent/agent-run-model.ts";

describe("provider execution parameters are applied or rejected, never ignored", () => {
  test("the OpenAI Responses adapter sends reasoning effort and output cap exactly", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new OpenAiResponsesProvider(
      "key",
      "https://provider.test/v1/responses",
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return Response.json({
          id: "resp",
          model: body.model,
          status: "completed",
          output_text: "ok",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    );
    const response = await provider.complete({
      model: "configured-model",
      messages: [{ role: "user", content: "hi" }],
      parameters: { reasoningEffort: "medium", maxOutputTokens: 500 },
    });
    expect(bodies).toEqual([
      {
        model: "configured-model",
        input: [{ role: "user", content: "hi" }],
        store: false,
        reasoning: { effort: "medium" },
        max_output_tokens: 500,
      },
    ]);
    expect(response.providerMetadata).toEqual({ status: "completed" });
  });

  test("an effort outside the vendor vocabulary is rejected before any request", async () => {
    let called = false;
    const provider = new OpenAiResponsesProvider(
      "key",
      "https://x.test",
      async () => {
        called = true;
        return Response.json({});
      },
    );
    for (const parameters of [
      { reasoningEffort: "turbo" },
      { maxOutputTokens: 0 },
    ])
      await expect(
        provider.complete({ model: "m", messages: [], parameters }),
      ).rejects.toBeInstanceOf(UnsupportedModelParameterError);
    expect(called).toBe(false);
  });

  test("the LangChain compatibility adapter refuses parameters before invoking", async () => {
    let invoked = false;
    const provider = new LangChainModelProvider("anthropic", "model", {
      invoke: async () => {
        invoked = true;
        throw new Error("not reached");
      },
    });
    for (const parameters of [
      { reasoningEffort: "high" },
      { maxOutputTokens: 100 },
    ])
      await expect(
        provider.complete({ model: "model", messages: [], parameters }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
    expect(invoked).toBe(false);
  });

  test("an exact-model provider refuses substitution in the request and the response", async () => {
    const drifting = new MockLlmProvider({
      model: "other-model",
      text: "ok",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    });
    const exact = new ExactModelProvider(drifting, {
      providerId: "mock",
      model: "assigned-model",
    });
    await expect(
      exact.complete({ model: "assigned-model", messages: [] }),
    ).rejects.toBeInstanceOf(ModelMismatchError);
    await expect(
      exact.complete({ model: "another-request", messages: [] }),
    ).rejects.toBeInstanceOf(ModelMismatchError);
    expect(drifting.requests).toHaveLength(1);
  });
});

describe("gateway worker contract", () => {
  const selection: AgentRunModelSelection = {
    policy: "balanced",
    profile: "balanced",
    modelRef: "openai:assigned-model",
    providerId: "openai",
    model: "assigned-model",
    reasoningEffort: "low",
    maxOutputTokens: 1000,
    source: "role_policy",
  };
  const unusedCosts = new Proxy({} as CostRepository, {
    get: () => () => {
      throw new Error("cost repository must not be reached");
    },
  });
  const worker = (resolve: () => never) =>
    new GatewayWorkerRuntime(
      {
        descriptors: defaultModelProviderDescriptors,
        missingCredentials: () => [],
        resolve: async () => resolve(),
      },
      unusedCosts,
      { generate: () => "id" },
      { now: () => new Date(0) },
    );

  test("declares support only for exactly applicable providers and parameters", () => {
    const value = worker(() => {
      throw new Error("not reached");
    });
    expect(value.requiresModelSelection).toBe(true);
    expect(value.supportsModel(selection)).toEqual({ supported: true });
    for (const unsupported of [
      {
        ...selection,
        providerId: "anthropic",
        modelRef: "anthropic:assigned-model",
      },
      { ...selection, reasoningEffort: "turbo" },
    ])
      expect(value.supportsModel(unsupported)).toEqual({
        supported: false,
        code: "WORKER_MODEL_UNSUPPORTED",
      });
  });

  test("never executes without a persisted selection", async () => {
    let resolved = false;
    const value = worker(() => {
      resolved = true;
      throw new Error("not reached");
    });
    const context = { runId: "r", projectId: "p" } as unknown as WorkerContext;
    await expect(
      value.execute(context, {
        timeoutMs: 1000,
        maxTurns: 1,
        maxEstimatedCostUsd: "1.000000",
        maxCostMicros: 1_000_000n,
      }),
    ).rejects.toMatchObject({ code: "WORKER_MODEL_REQUIRED" });
    expect(resolved).toBe(false);
  });

  test("accepts only the bounded artifact object", () => {
    expect(
      parseGatewayWorkerArtifact('{"summary":" Plan ","content":"Body"}'),
    ).toEqual({ summary: "Plan", content: "Body" });
    for (const text of [
      "Plan: body",
      '{"summary":"Plan"}',
      '{"summary":"Plan","content":"Body","model":"other"}',
      '["Plan","Body"]',
    ])
      expect(() => parseGatewayWorkerArtifact(text)).toThrow(
        WorkerRuntimeError,
      );
  });
});
