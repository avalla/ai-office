import { expect, test } from "vitest";
import {
  EnvironmentGatewayModelProviders,
  type GatewayModelProviders,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import type {
  LlmProvider,
  ModelRequest,
  ModelResponse,
} from "@ai-office/llm-gateway/provider.ts";
import { verifyDomainPackManifest } from "../../packages/domain-pack-contracts/src/index.ts";
import { developmentPackBytes } from "../helpers/development-pack-parity.ts";
import { runRuntime } from "../helpers/run-runtime.ts";

// GP-10B-2 PR 2, criterion 20: the requirement-assessment prompt of the
// development pack is the system message that `requirement:validate` sends to
// the provider. `requirement.ts` is not edited and exports no constant, so the
// message is captured from the request a deterministic provider receives. No
// network and no credential: the provider is a fake that answers a fixed JSON
// object.

const model = "assess-model";

/** A deterministic provider that records every request it receives. */
function capturingGateway() {
  const requests: ModelRequest[] = [];
  const provider: LlmProvider = {
    id: "openai",
    pricingCandidates: (request) => [
      { providerId: "openai", model: request.model },
    ],
    complete: async (request): Promise<ModelResponse> => {
      requests.push(structuredClone(request));
      return {
        providerId: "openai",
        model: request.model,
        text: JSON.stringify({
          verdict: "valid",
          confidence: 0.5,
          strengths: ["Clear"],
          issues: [],
          suggestedRevision: "",
        }),
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
        },
      };
    },
  };
  const host = new EnvironmentGatewayModelProviders({
    OPENAI_API_KEY: "sk-gp10b2-fake-never-sent",
  });
  const gatewayProviders: GatewayModelProviders = {
    descriptors: host.descriptors,
    missingCredentials: (providerId) => host.missingCredentials(providerId),
    resolve: async (modelRef) => ({
      ...(await host.resolve(modelRef)),
      provider,
    }),
  };
  return { requests, gatewayProviders };
}

test("the requirement-assessment prompt of the development pack is the system message of a captured requirement:validate request", async () => {
  const gateway = capturingGateway();
  const runtime = await runRuntime(undefined, {
    gatewayProviders: gateway.gatewayProviders,
  });
  try {
    expect(
      (
        await runtime.command([
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
    expect(
      (
        await runtime.command([
          "requirement:create",
          "--project",
          runtime.projectId,
          "--key",
          "REQ-1",
          "--title",
          "Export a report",
          "--description",
          "A user can export the report as CSV.",
        ])
      ).exitCode,
    ).toBe(0);
    const listed = await runtime.command([
      "requirement:list",
      "--project",
      runtime.projectId,
      "--json",
    ]);
    const requirement = (
      JSON.parse(listed.stdout[0]!) as {
        requirements: { id: string; key: string; title: string }[];
      }
    ).requirements[0]!;

    const validated = await runtime.command([
      "requirement:validate",
      "--project",
      runtime.projectId,
      "--requirement",
      requirement.id,
      "--model",
      `openai:${model}`,
      "--json",
    ]);
    expect(validated.stderr).toEqual([]);
    expect(validated.exitCode).toBe(0);

    // Exactly one request reached the provider: a system and a user message.
    expect(gateway.requests).toHaveLength(1);
    const [request] = gateway.requests;
    expect(request!.model).toBe(model);
    expect(request!.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    const system = request!.messages[0]!.content;
    // The user message is the requirement, as data, not instructions.
    expect(JSON.parse(request!.messages[1]!.content)).toMatchObject({
      key: "REQ-1",
      title: "Export a report",
    });

    const prompt = verifyDomainPackManifest(
      developmentPackBytes(),
    ).contributions.prompts.find(
      (candidate) => candidate.id === "requirement-assessment",
    )!;
    expect(prompt.text).toBe(system);
    // The comparison is exact: a changed byte is not the sent message.
    expect(`${prompt.text}.`).not.toBe(system);
    expect(system.split("\n")).toHaveLength(4);
  } finally {
    await runtime.close();
  }
}, 60_000);
