import type {
  ProviderCredentialSource,
  ProviderCredentialStatus,
} from "@ai-office/application/ports/provider-credential-source.port.ts";
import {
  providerCredentialSourceEnvironmentVariable,
  runtimeHomeProviderCredentialSource,
} from "@ai-office/runtime-paths/provider-credential-location.ts";
import {
  defaultModelProviderDescriptors,
  nonEmpty,
  type ModelProviderDescriptor,
  type ModelProviderEnvironment,
} from "./model-ref.ts";
import {
  loadRuntimeHomeCredentialValue,
  type RuntimeHomeCredentialValue,
} from "./runtime-home-credential-store.ts";

/** Every credential name a registered provider declares; the only names read. */
export function providerCredentialNames(
  descriptors: readonly ModelProviderDescriptor[] = defaultModelProviderDescriptors,
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        descriptors.flatMap((value) => value.requiredEnvironmentVariables),
      ),
    ].sort(),
  );
}

export interface LoadProviderCredentialsOptions {
  /**
   * The Runtime home whose `credentials/` directory a managed Runtime reads.
   * A foreground Runtime never inspects it.
   */
  readonly runtimeHome?: string;
  readonly descriptors?: readonly ModelProviderDescriptor[];
}

/**
 * Values of loaded snapshots, reachable only through
 * {@link resolvedProviderCredentialEnvironment}. No method or property of a
 * snapshot returns a value.
 */
const loadedValues = new WeakMap<
  LoadedProviderCredentials,
  ReadonlyMap<string, string>
>();

/**
 * An immutable in-memory credential snapshot, as infrastructure holds it. It
 * exposes statuses only: values are not enumerable, `JSON.stringify` and
 * `util.inspect` see statuses, and there is no secret-by-name accessor.
 */
class LoadedProviderCredentials implements ProviderCredentialSource {
  readonly #statuses: ReadonlyMap<string, ProviderCredentialStatus>;

  constructor(
    readonly managed: boolean,
    statuses: readonly ProviderCredentialStatus[],
    values: ReadonlyMap<string, string>,
  ) {
    this.#statuses = new Map(
      statuses.map((status) => [status.name, Object.freeze(status)]),
    );
    loadedValues.set(this, values);
    Object.freeze(this);
  }

  status(name: string): ProviderCredentialStatus {
    return (
      this.#statuses.get(name) ??
      Object.freeze({
        name,
        state: "missing",
        origin: null,
        issue: null,
        ambientIgnored: false,
      })
    );
  }

  toJSON(): unknown {
    return {
      managed: this.managed,
      credentials: [...this.#statuses.values()],
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): unknown {
    return this.toJSON();
  }
}

/**
 * A snapshot returned by {@link loadProviderCredentials}. The class is not
 * exported, so only this module creates one or reaches its values.
 */
export type ProviderCredentials = LoadedProviderCredentials;

/**
 * The credential values one resolved provider declares, keyed by name, for the
 * gateway's provider construction boundary (`CredentialGatewayModelProviders`)
 * and nothing else. Credentials another provider declares are never included,
 * and an architecture test keeps every other production caller out.
 */
export function resolvedProviderCredentialEnvironment(
  credentials: ProviderCredentials,
  descriptor: ModelProviderDescriptor,
): Record<string, string> {
  const values = loadedValues.get(credentials);
  const environment: Record<string, string> = {};
  if (values === undefined) return environment;
  for (const name of descriptor.requiredEnvironmentVariables) {
    const value = values.get(name);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Loads provider credentials once at Runtime composition. The source is chosen
 * by `AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE` alone, and sources never mix:
 *
 * - `runtime_home` (written by `service install`): only
 *   `<AI_OFFICE_HOME>/credentials/<NAME>`; the same name in the service manager
 *   environment is ignored and reported by name;
 * - unset (foreground, or a managed definition from before the marker): only
 *   the Runtime's own environment variables. The Runtime home credential
 *   directory is never inspected, so a credential configured for the managed
 *   Runtime cannot be picked up by a foreground invocation;
 * - any other value: every credential is invalid (fail closed).
 *
 * Changes take effect on Runtime restart; nothing here reloads.
 */
export function loadProviderCredentials(
  environment: ModelProviderEnvironment,
  options: LoadProviderCredentialsOptions = {},
): ProviderCredentials {
  const setting = nonEmpty(
    environment[providerCredentialSourceEnvironmentVariable],
  );
  const managed = setting === runtimeHomeProviderCredentialSource;
  const sourceInvalid = setting !== undefined && !managed;
  const statuses: ProviderCredentialStatus[] = [];
  const values = new Map<string, string>();
  for (const name of providerCredentialNames(options.descriptors)) {
    const ambient = nonEmpty(environment[name]);
    const base = { name, ambientIgnored: managed && ambient !== undefined };
    if (sourceInvalid) {
      statuses.push({
        ...base,
        state: "invalid",
        origin: null,
        issue: "CREDENTIAL_SOURCE_INVALID",
      });
      continue;
    }
    if (!managed) {
      if (ambient !== undefined) values.set(name, ambient);
      statuses.push({
        ...base,
        state: ambient === undefined ? "missing" : "present",
        origin: ambient === undefined ? null : "environment",
        issue: null,
      });
      continue;
    }
    const file: RuntimeHomeCredentialValue =
      options.runtimeHome === undefined
        ? { state: "invalid", issue: "CREDENTIAL_UNREADABLE" }
        : loadRuntimeHomeCredentialValue(options.runtimeHome, name);
    if (file.state === "present") values.set(name, file.value);
    statuses.push({
      ...base,
      state: file.state,
      origin: file.state === "missing" ? null : "runtime_home",
      issue: file.state === "invalid" ? file.issue : null,
    });
  }
  return new LoadedProviderCredentials(managed, statuses, values);
}

/**
 * Foreground environment credentials only, for hosts and tests that compose
 * providers from an explicit environment record.
 */
export function environmentProviderCredentials(
  environment: ModelProviderEnvironment,
  descriptors: readonly ModelProviderDescriptor[] = defaultModelProviderDescriptors,
): ProviderCredentials {
  const foreground = { ...environment };
  delete foreground[providerCredentialSourceEnvironmentVariable];
  return loadProviderCredentials(foreground, { descriptors });
}

/** Names of a provider's credentials that are not usable (missing or invalid). */
export function unusableProviderCredentials(
  credentials: ProviderCredentialSource,
  descriptor: ModelProviderDescriptor,
): readonly string[] {
  return descriptor.requiredEnvironmentVariables.filter(
    (name) => credentials.status(name).state !== "present",
  );
}
