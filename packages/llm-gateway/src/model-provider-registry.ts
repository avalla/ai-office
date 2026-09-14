import { ChatAnthropic } from "@langchain/anthropic";
import { createHash } from "node:crypto";
import { LangChainModelProvider } from "./langchain-model-provider.ts";
import { OpenAiResponsesProvider } from "./openai-provider.ts";
import type { LlmProvider } from "./provider.ts";
import {
  configurationError,
  defaultModelProviderDescriptors,
  ModelProviderConfigurationError,
  nonEmpty,
  parseCanonicalModelRef,
  parseModelRef,
  type ModelProviderDescriptor,
  type ModelProviderEnvironment,
  type ParsedModelRef,
} from "./model-ref.ts";

export {
  ModelProviderConfigurationError,
  parseCanonicalModelRef,
  parseModelRef,
  type ModelProviderEnvironment,
} from "./model-ref.ts";

export interface ModelProviderRegistration extends ModelProviderDescriptor {
  create(model: string, environment: ModelProviderEnvironment): LlmProvider;
}

export interface ResolvedModelProvider {
  readonly modelRef: string;
  readonly providerId: string;
  readonly model: string;
  readonly provider: LlmProvider;
  readonly compatibilityConfiguration: boolean;
}

export class ModelProviderRegistry {
  private readonly registrations = new Map<string, ModelProviderRegistration>();

  constructor(registrations: readonly ModelProviderRegistration[]) {
    for (const registration of registrations) {
      const providerId = registration.providerId.trim().toLowerCase();
      if (providerId === "") throw new Error("Provider ID is required");
      if (this.registrations.has(providerId))
        throw new Error(`Provider ${providerId} is already registered`);
      this.registrations.set(providerId, registration);
    }
  }

  /** Legacy single-model resolution through `AI_OFFICE_LLM_MODEL`. */
  resolve(environment: ModelProviderEnvironment): ResolvedModelProvider {
    const configuredModel = nonEmpty(environment.AI_OFFICE_LLM_MODEL);
    if (configuredModel === undefined)
      throw configurationError(undefined, ["AI_OFFICE_LLM_MODEL"]);
    return this.construct(
      parseModelRef(configuredModel, environment.AI_OFFICE_LLM_PROVIDER),
      environment,
    );
  }

  /**
   * Resolves an explicitly supplied canonical `<provider>:<model>`, such as a
   * run's persisted model selection. Ambient `AI_OFFICE_LLM_MODEL` is ignored.
   */
  resolveModelRef(
    modelRef: string,
    environment: ModelProviderEnvironment,
  ): ResolvedModelProvider {
    return this.construct(parseCanonicalModelRef(modelRef), environment);
  }

  private construct(
    parsed: ParsedModelRef,
    environment: ModelProviderEnvironment,
  ): ResolvedModelProvider {
    const registration = this.registrations.get(parsed.providerId);
    if (registration === undefined) {
      const supported = [...this.registrations.keys()].sort().join(", ");
      throw new ModelProviderConfigurationError(
        `Unsupported LLM provider "${parsed.providerId}" in model "${parsed.modelRef}".\n\nSupported providers:\n  ${supported}`,
        parsed.modelRef,
      );
    }
    if (
      llmDebugEnabled(environment) &&
      registration.apiKeyEnvironmentVariable !== undefined
    )
      logProviderConfiguration(
        parsed.providerId,
        parsed.model,
        nonEmpty(environment[registration.apiKeyEnvironmentVariable]) ?? "",
      );
    const missing = registration.requiredEnvironmentVariables.filter(
      (name) => nonEmpty(environment[name]) === undefined,
    );
    if (missing.length > 0) throw configurationError(parsed.modelRef, missing);
    return {
      ...parsed,
      provider: registration.create(parsed.model, environment),
    };
  }
}

const required = (
  environment: ModelProviderEnvironment,
  name: string,
): string => nonEmpty(environment[name])!;

function llmDebugEnabled(environment: ModelProviderEnvironment): boolean {
  return environment.AI_OFFICE_DEBUG_LLM === "1";
}

function logProviderConfiguration(
  providerId: string,
  model: string,
  apiKey: string,
): void {
  const fingerprint = createHash("sha256")
    .update(apiKey)
    .digest("hex")
    .slice(0, 12);
  console.error(
    `[llm:config] pid=${process.pid} provider=${providerId} model=${model}`,
  );
  console.error(
    `[llm:config] api_key_present=${apiKey.length > 0} api_key_length=${apiKey.length} api_key_fingerprint=${fingerprint}`,
  );
}

function descriptor(providerId: string): ModelProviderDescriptor {
  const value = defaultModelProviderDescriptors.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (value === undefined)
    throw new Error(`Provider ${providerId} has no descriptor`);
  return value;
}

export function createDefaultModelProviderRegistry(): ModelProviderRegistry {
  return new ModelProviderRegistry([
    {
      ...descriptor("openai"),
      // The native Responses adapter applies reasoning effort and output caps
      // exactly, requires the vendor-reported effective model and request ID,
      // and never retries on its own (ADR-0019 amends ADR-0005 here).
      create: (_model, environment) =>
        new OpenAiResponsesProvider(required(environment, "OPENAI_API_KEY")),
    },
    {
      ...descriptor("anthropic"),
      create: (model, environment) => {
        const apiKey = required(environment, "ANTHROPIC_API_KEY");
        const debug = llmDebugEnabled(environment);
        return new LangChainModelProvider(
          "anthropic",
          model,
          new ChatAnthropic({
            model,
            apiKey,
            maxRetries: 0,
          }),
          undefined,
          debug,
        );
      },
    },
  ]);
}
