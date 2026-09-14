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
  readRuntimeHomeCredential,
  type RuntimeHomeCredentialRead,
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

/**
 * Loaded credentials as infrastructure sees them. Application code receives
 * only the status view; the value accessor exists for gateway provider
 * adapters that authenticate a request.
 */
export interface ProviderCredentials extends ProviderCredentialSource {
  secret(name: string): string | undefined;
}

export interface LoadProviderCredentialsOptions {
  /** The Runtime home whose `credentials/` directory is the canonical source. */
  readonly runtimeHome?: string;
  readonly descriptors?: readonly ModelProviderDescriptor[];
}

/**
 * An immutable in-memory credential snapshot. Values live in a private field:
 * they are not enumerable, `JSON.stringify` and `util.inspect` see statuses
 * only, and no method lists them.
 */
class LoadedProviderCredentials implements ProviderCredentials {
  readonly #values: ReadonlyMap<string, string>;
  readonly #statuses: ReadonlyMap<string, ProviderCredentialStatus>;

  constructor(
    readonly managed: boolean,
    statuses: readonly ProviderCredentialStatus[],
    values: ReadonlyMap<string, string>,
  ) {
    this.#values = values;
    this.#statuses = new Map(
      statuses.map((status) => [status.name, Object.freeze(status)]),
    );
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

  secret(name: string): string | undefined {
    return this.#values.get(name);
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
 * Loads provider credentials once at Runtime composition. Sources, per
 * credential name declared by a provider descriptor:
 *
 * - managed (`AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home`, written by
 *   `service install`): only `<AI_OFFICE_HOME>/credentials/<NAME>`; the same
 *   name in the service manager environment is ignored and reported by name;
 * - foreground: the Runtime's own environment variable when set, otherwise the
 *   Runtime home file when present. An invalid file is reported invalid and
 *   never falls through to "missing".
 *
 * Any other marker value makes every credential invalid (fail closed). Changes
 * take effect on Runtime restart; nothing here reloads.
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
    if (!managed && ambient !== undefined) {
      values.set(name, ambient);
      statuses.push({
        ...base,
        state: "present",
        origin: "environment",
        issue: null,
      });
      continue;
    }
    const file: RuntimeHomeCredentialRead =
      options.runtimeHome === undefined
        ? managed
          ? { state: "invalid", issue: "CREDENTIAL_UNREADABLE" }
          : { state: "missing" }
        : readRuntimeHomeCredential(options.runtimeHome, name);
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
