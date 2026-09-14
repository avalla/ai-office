/**
 * Canonical model references and provider descriptors.
 *
 * Deliberately free of provider SDK imports, so configuration validation and
 * diagnostics can run without constructing (or loading) any provider client.
 */
import {
  providerIdPattern,
  providerModelPattern,
} from "@ai-office/domain/agent/agent-run-model.ts";

export type ModelProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ModelProviderDescriptor {
  readonly providerId: string;
  /** Credential environment variable names; values are never read here. */
  readonly requiredEnvironmentVariables: readonly string[];
  readonly apiKeyEnvironmentVariable?: string;
}

export const defaultModelProviderDescriptors: readonly ModelProviderDescriptor[] =
  [
    {
      providerId: "openai",
      requiredEnvironmentVariables: ["OPENAI_API_KEY"],
      apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    },
    {
      providerId: "anthropic",
      requiredEnvironmentVariables: ["ANTHROPIC_API_KEY"],
      apiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
    },
  ];

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

export function configurationError(
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

export function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

export interface ParsedModelRef {
  modelRef: string;
  providerId: string;
  model: string;
  compatibilityConfiguration: boolean;
}

export function parseModelRef(
  configuredModel: string,
  compatibilityProvider?: string,
  label = "AI_OFFICE_LLM_MODEL",
): ParsedModelRef {
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
      `Invalid ${label} "${value}". Expected <provider>:<model>.`,
      value,
    );
  return {
    modelRef: `${providerId}:${model}`,
    providerId,
    model,
    compatibilityConfiguration: false,
  };
}

/**
 * Strict canonical form for explicitly supplied references (routing profiles,
 * agent overrides, persisted run selections): `<provider>:<model>` only, with
 * no compatibility provider and no surrounding whitespace.
 */
export function parseCanonicalModelRef(modelRef: string): ParsedModelRef {
  const separator = modelRef.indexOf(":");
  const providerId = separator < 0 ? "" : modelRef.slice(0, separator);
  const model = separator < 0 ? "" : modelRef.slice(separator + 1);
  if (!providerIdPattern.test(providerId) || !providerModelPattern.test(model))
    throw new ModelProviderConfigurationError(
      `Invalid model reference "${modelRef.slice(0, 200)}". Expected <provider>:<model>.`,
      modelRef,
    );
  return {
    modelRef: `${providerId}:${model}`,
    providerId,
    model,
    compatibilityConfiguration: false,
  };
}
