import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { LangChainModelProvider } from "./langchain-model-provider.ts";
import type { LlmProvider } from "./provider.ts";

export type ModelProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ModelProviderRegistration {
  readonly providerId: string;
  readonly requiredEnvironmentVariables: readonly string[];
  create(model: string, environment: ModelProviderEnvironment): LlmProvider;
}

export interface ResolvedModelProvider {
  readonly modelRef: string;
  readonly providerId: string;
  readonly model: string;
  readonly provider: LlmProvider;
  readonly compatibilityConfiguration: boolean;
}

export class ModelProviderConfigurationError extends Error {
  constructor(
    message: string,
    readonly configuredModel?: string,
    readonly missing: readonly string[] = [],
  ) {
    super(message);
    this.name = "ModelProviderConfigurationError";
  }
}

function configurationError(
  configuredModel: string | undefined,
  missing: readonly string[],
): ModelProviderConfigurationError {
  return new ModelProviderConfigurationError(
    [
      "No usable LLM provider configuration found.",
      "",
      "Configured model:",
      `  ${configuredModel ?? "(not set)"}`,
      "",
      "Missing:",
      ...missing.map((value) => `  ${value}`),
    ].join("\n"),
    configuredModel,
    missing,
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

export function parseModelRef(
  configuredModel: string,
  compatibilityProvider?: string,
): {
  modelRef: string;
  providerId: string;
  model: string;
  compatibilityConfiguration: boolean;
} {
  const value = configuredModel.trim();
  const separator = value.indexOf(":");
  if (separator < 0) {
    const providerId = nonEmpty(compatibilityProvider)?.toLowerCase();
    if (providerId === undefined)
      throw configurationError(value, ["AI_OFFICE_LLM_PROVIDER"]);
    return {
      modelRef: `${providerId}:${value}`,
      providerId,
      model: value,
      compatibilityConfiguration: true,
    };
  }

  const providerId = value.slice(0, separator).trim().toLowerCase();
  const model = value.slice(separator + 1).trim();
  if (providerId === "" || model === "")
    throw new ModelProviderConfigurationError(
      `Invalid AI_OFFICE_LLM_MODEL "${value}". Expected <provider>:<model>.`,
      value,
    );
  return {
    modelRef: `${providerId}:${model}`,
    providerId,
    model,
    compatibilityConfiguration: false,
  };
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

  resolve(environment: ModelProviderEnvironment): ResolvedModelProvider {
    const configuredModel = nonEmpty(environment.AI_OFFICE_LLM_MODEL);
    if (configuredModel === undefined)
      throw configurationError(undefined, ["AI_OFFICE_LLM_MODEL"]);
    const parsed = parseModelRef(
      configuredModel,
      environment.AI_OFFICE_LLM_PROVIDER,
    );
    const registration = this.registrations.get(parsed.providerId);
    if (registration === undefined) {
      const supported = [...this.registrations.keys()].sort().join(", ");
      throw new ModelProviderConfigurationError(
        `Unsupported LLM provider "${parsed.providerId}" in model "${parsed.modelRef}".\n\nSupported providers:\n  ${supported}`,
        parsed.modelRef,
      );
    }
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

export function createDefaultModelProviderRegistry(): ModelProviderRegistry {
  return new ModelProviderRegistry([
    {
      providerId: "openai",
      requiredEnvironmentVariables: ["OPENAI_API_KEY"],
      create: (model, environment) =>
        new LangChainModelProvider(
          "openai",
          model,
          new ChatOpenAI({
            model,
            apiKey: required(environment, "OPENAI_API_KEY"),
            maxRetries: 0,
          }),
        ),
    },
    {
      providerId: "anthropic",
      requiredEnvironmentVariables: ["ANTHROPIC_API_KEY"],
      create: (model, environment) =>
        new LangChainModelProvider(
          "anthropic",
          model,
          new ChatAnthropic({
            model,
            apiKey: required(environment, "ANTHROPIC_API_KEY"),
            maxRetries: 0,
          }),
        ),
    },
  ]);
}
