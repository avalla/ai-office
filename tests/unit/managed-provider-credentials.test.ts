import { afterEach, describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  environmentProviderCredentials,
  loadProviderCredentials,
  resolvedProviderCredentialEnvironment,
  type ProviderCredentials,
} from "@ai-office/llm-gateway/provider-credentials.ts";
import { writeRuntimeHomeCredential } from "@ai-office/llm-gateway/runtime-home-credential-store.ts";
import { CredentialModelProviderCatalog } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { CredentialGatewayModelProviders } from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { ModelProviderRegistry } from "@ai-office/llm-gateway/model-provider-registry.ts";
import { defaultModelProviderDescriptors } from "@ai-office/llm-gateway/model-ref.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import { classifyManagedDefinition } from "@ai-office/application/service-management/managed-definition.ts";
import {
  renderSystemdUnit,
  systemdOwnershipLines,
} from "@ai-office/service-management/systemd-user-service-manager.ts";
import {
  launchdOwnershipLines,
  renderLaunchdPlist,
} from "@ai-office/service-management/launchd-user-service-manager.ts";
import {
  parseMinimalPlist,
  servicePlan,
} from "../helpers/service-management.ts";

const managedSecret = `aio-test-secret-${randomBytes(12).toString("hex")}`;
const ambientSecret = `aio-test-ambient-${randomBytes(12).toString("hex")}`;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function runtimeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ao-managed-credentials-"));
  homes.push(home);
  return home;
}

function plan(home: string) {
  return servicePlan({
    program: {
      launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
      runtimeHome: home,
      requiresSourceRuntimeOptIn: false,
    },
  });
}

function systemdEnvironment(definition: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of definition.split("\n")) {
    const match = /^Environment="([A-Z_]+)=(.*)"$/u.exec(line);
    if (match !== null) environment[match[1]!] = match[2]!;
  }
  return environment;
}

function launchdEnvironment(definition: string): Record<string, string> {
  return parseMinimalPlist(definition).EnvironmentVariables as Record<
    string,
    string
  >;
}

/** Environment assignments exactly as each service manager would pass them. */
const platforms: Record<
  "systemd" | "launchd",
  (
    home: string,
    service: OfficeServiceName,
  ) => { definition: string; environment: Record<string, string> }
> = {
  systemd: (home, service) => {
    const definition = renderSystemdUnit(plan(home), service);
    return { definition, environment: systemdEnvironment(definition) };
  },
  launchd: (home, service) => {
    const definition = renderLaunchdPlist(plan(home), service);
    return { definition, environment: launchdEnvironment(definition) };
  },
};

/**
 * A Runtime definition rendered before the credential source marker existed,
 * with how its manager classifies it and the environment it passes.
 */
const legacyDefinitions: Record<
  "systemd" | "launchd",
  (home: string) => {
    classification: string;
    environment: Record<string, string>;
  }
> = {
  systemd: (home) => {
    const current = renderSystemdUnit(plan(home), "runtime");
    const legacy = current.replace(
      'Environment="AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home"\n',
      "",
    );
    expect(legacy).not.toBe(current);
    return {
      classification: classifyManagedDefinition(
        legacy,
        current,
        systemdOwnershipLines("runtime"),
      ),
      environment: systemdEnvironment(legacy),
    };
  },
  launchd: (home) => {
    const current = renderLaunchdPlist(plan(home), "runtime");
    const legacy = current.replace(
      /\s*<key>AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE<\/key>\s*<string>runtime_home<\/string>/u,
      "",
    );
    expect(legacy).not.toBe(current);
    return {
      classification: classifyManagedDefinition(
        legacy,
        current,
        launchdOwnershipLines("runtime"),
      ),
      environment: launchdEnvironment(legacy),
    };
  },
};

/** What the gateway would hand the provider that declares `name`. */
function providerValue(
  credentials: ProviderCredentials,
  name: string,
): string | undefined {
  const descriptor = defaultModelProviderDescriptors.find((value) =>
    value.requiredEnvironmentVariables.includes(name),
  )!;
  return resolvedProviderCredentialEnvironment(credentials, descriptor)[name];
}

/** A managed start whose service manager environment also carries ambient keys. */
function managedStart(environment: Record<string, string>) {
  return loadProviderCredentials(
    { OPENAI_API_KEY: ambientSecret, ...environment },
    { runtimeHome: environment.AI_OFFICE_HOME! },
  );
}

describe.each(["systemd", "launchd"] as const)(
  "managed %s Runtime provider credentials",
  (platform) => {
    test("the definition carries only a non-secret source marker and no credential", () => {
      const home = runtimeHome();
      writeRuntimeHomeCredential(
        home,
        "OPENAI_API_KEY",
        Buffer.from(managedSecret),
      );
      const runtime = platforms[platform](home, "runtime");
      const dashboard = platforms[platform](home, "dashboard");
      expect(runtime.environment).toEqual({
        AI_OFFICE_HOME: home,
        AI_OFFICE_MODEL_ROUTING_SOURCE: "runtime_home",
        AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
      });
      expect(dashboard.environment).toEqual({ AI_OFFICE_HOME: home });
      for (const { definition } of [runtime, dashboard]) {
        expect(definition).not.toContain(managedSecret);
        expect(definition).not.toContain(ambientSecret);
        expect(definition).not.toMatch(/API_KEY/u);
      }
    });

    test("reads only the Runtime home credential and ignores the ambient provider key", () => {
      const home = runtimeHome();
      writeRuntimeHomeCredential(
        home,
        "OPENAI_API_KEY",
        Buffer.from(managedSecret),
      );
      const credentials = managedStart(
        platforms[platform](home, "runtime").environment,
      );
      expect(credentials.managed).toBe(true);
      expect(credentials.status("OPENAI_API_KEY")).toEqual({
        name: "OPENAI_API_KEY",
        state: "present",
        origin: "runtime_home",
        issue: null,
        ambientIgnored: true,
      });
      expect(providerValue(credentials, "OPENAI_API_KEY")).toBe(managedSecret);
      // Restart after reboot or login: the same definition gives the same source.
      expect(
        providerValue(
          managedStart(platforms[platform](home, "runtime").environment),
          "OPENAI_API_KEY",
        ),
      ).toBe(managedSecret);
    });

    test("without a Runtime home credential it reports missing and never uses the ambient key", () => {
      const home = runtimeHome();
      const credentials = managedStart(
        platforms[platform](home, "runtime").environment,
      );
      expect(credentials.status("OPENAI_API_KEY")).toMatchObject({
        state: "missing",
        origin: null,
        ambientIgnored: true,
      });
      expect(providerValue(credentials, "OPENAI_API_KEY")).toBeUndefined();
      expect(
        new CredentialModelProviderCatalog(credentials).missingCredentials(
          "openai",
        ),
      ).toEqual(["OPENAI_API_KEY"]);
    });

    test("a malformed Runtime home credential fails closed without falling back", () => {
      const home = runtimeHome();
      writeRuntimeHomeCredential(
        home,
        "OPENAI_API_KEY",
        Buffer.from(managedSecret),
      );
      chmodSync(join(home, "credentials", "OPENAI_API_KEY"), 0o644);
      const credentials = managedStart(
        platforms[platform](home, "runtime").environment,
      );
      expect(credentials.status("OPENAI_API_KEY")).toMatchObject({
        state: "invalid",
        origin: "runtime_home",
        issue: "CREDENTIAL_INSECURE_PERMISSIONS",
      });
      expect(providerValue(credentials, "OPENAI_API_KEY")).toBeUndefined();
    });
  },
);

test("systemd and launchd managed Runtimes load identical credential statuses", () => {
  const home = runtimeHome();
  writeRuntimeHomeCredential(
    home,
    "OPENAI_API_KEY",
    Buffer.from(managedSecret),
  );
  const systemd = managedStart(platforms.systemd(home, "runtime").environment);
  const launchd = managedStart(platforms.launchd(home, "runtime").environment);
  expect(JSON.stringify(systemd)).toBe(JSON.stringify(launchd));
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    expect(systemd.status(name)).toEqual(launchd.status(name));
    expect(providerValue(systemd, name)).toBe(providerValue(launchd, name));
  }
});

describe("foreground provider credentials (marker unset)", () => {
  test("the Runtime environment is used", () => {
    const home = runtimeHome();
    writeRuntimeHomeCredential(
      home,
      "OPENAI_API_KEY",
      Buffer.from(managedSecret),
    );
    const credentials = loadProviderCredentials(
      { OPENAI_API_KEY: ambientSecret },
      { runtimeHome: home },
    );
    expect(credentials.managed).toBe(false);
    expect(credentials.status("OPENAI_API_KEY")).toEqual({
      name: "OPENAI_API_KEY",
      state: "present",
      origin: "environment",
      issue: null,
      ambientIgnored: false,
    });
    expect(providerValue(credentials, "OPENAI_API_KEY")).toBe(ambientSecret);
  });

  // Mutation guard: restoring any environment -> Runtime home fallback makes
  // each of these fail, because each planted store would then be consulted.
  const planted: [string, (home: string) => void][] = [
    [
      "a valid Runtime home credential",
      (home) =>
        writeRuntimeHomeCredential(
          home,
          "OPENAI_API_KEY",
          Buffer.from(managedSecret),
        ),
    ],
    [
      "a malformed Runtime home credential",
      (home) => {
        writeRuntimeHomeCredential(
          home,
          "OPENAI_API_KEY",
          Buffer.from(managedSecret),
        );
        writeFileSync(
          join(home, "credentials", "OPENAI_API_KEY"),
          `${managedSecret} x`,
        );
      },
    ],
    [
      "an insecure Runtime home credential file",
      (home) => {
        writeRuntimeHomeCredential(
          home,
          "OPENAI_API_KEY",
          Buffer.from(managedSecret),
        );
        chmodSync(join(home, "credentials", "OPENAI_API_KEY"), 0o644);
      },
    ],
    [
      "an insecure credential directory",
      (home) => {
        writeRuntimeHomeCredential(
          home,
          "OPENAI_API_KEY",
          Buffer.from(managedSecret),
        );
        chmodSync(join(home, "credentials"), 0o777);
      },
    ],
    [
      "a symbolic link at the credential name",
      (home) => {
        mkdirSync(join(home, "credentials"), { mode: 0o700 });
        writeFileSync(join(home, "target"), managedSecret, { mode: 0o600 });
        symlinkSync(
          join(home, "target"),
          join(home, "credentials", "OPENAI_API_KEY"),
        );
      },
    ],
  ];

  test.each(planted)(
    "without the variable, %s is never inspected and the credential is missing",
    (_label, plant) => {
      const home = runtimeHome();
      plant(home);
      const credentials = loadProviderCredentials(
        { HOME: "/home/x" },
        { runtimeHome: home },
      );
      for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
        expect(credentials.status(name)).toEqual({
          name,
          state: "missing",
          origin: null,
          issue: null,
          ambientIgnored: false,
        });
        expect(providerValue(credentials, name)).toBeUndefined();
      }
      expect(
        new CredentialModelProviderCatalog(credentials).missingCredentials(
          "openai",
        ),
      ).toEqual(["OPENAI_API_KEY"]);
    },
  );

  test("a FIFO at the credential name is never opened", () => {
    const home = runtimeHome();
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    const made = spawnSync("mkfifo", [
      "-m",
      "600",
      join(home, "credentials", "OPENAI_API_KEY"),
    ]);
    if (made.status !== 0) return;
    expect(
      loadProviderCredentials({}, { runtimeHome: home }).status(
        "OPENAI_API_KEY",
      ),
    ).toMatchObject({ state: "missing", origin: null, issue: null });
  });

  test("an explicit foreground environment record keeps legacy variable behavior", () => {
    const credentials = environmentProviderCredentials({
      OPENAI_API_KEY: ambientSecret,
      AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
    });
    expect(providerValue(credentials, "OPENAI_API_KEY")).toBe(ambientSecret);
    expect(credentials.status("ANTHROPIC_API_KEY").state).toBe("missing");
  });
});

describe.each(["systemd", "launchd"] as const)(
  "a %s Runtime definition from before the credential source marker",
  (platform) => {
    test("is managed_outdated and stays environment-only until service install upgrades it", () => {
      const home = runtimeHome();
      writeRuntimeHomeCredential(
        home,
        "OPENAI_API_KEY",
        Buffer.from(managedSecret),
      );
      const legacy = legacyDefinitions[platform](home);
      expect(legacy.classification).toBe("managed_outdated");
      expect(legacy.environment).not.toHaveProperty(
        "AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE",
      );

      const withAmbient = loadProviderCredentials(
        { ...legacy.environment, OPENAI_API_KEY: ambientSecret },
        { runtimeHome: home },
      );
      expect(withAmbient.managed).toBe(false);
      expect(withAmbient.status("OPENAI_API_KEY")).toMatchObject({
        state: "present",
        origin: "environment",
      });
      expect(providerValue(withAmbient, "OPENAI_API_KEY")).toBe(ambientSecret);

      const withoutAmbient = loadProviderCredentials(legacy.environment, {
        runtimeHome: home,
      });
      expect(withoutAmbient.status("OPENAI_API_KEY")).toMatchObject({
        state: "missing",
        origin: null,
      });
      expect(providerValue(withoutAmbient, "OPENAI_API_KEY")).toBeUndefined();
    });
  },
);

test.each(["environment", "RUNTIME_HOME", "runtime-home", "file", "1"])(
  "an unsupported credential source marker (%s) fails every credential closed",
  (marker) => {
    const home = runtimeHome();
    writeRuntimeHomeCredential(
      home,
      "OPENAI_API_KEY",
      Buffer.from(managedSecret),
    );
    const credentials = loadProviderCredentials(
      {
        AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: marker,
        OPENAI_API_KEY: ambientSecret,
      },
      { runtimeHome: home },
    );
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(credentials.status(name)).toMatchObject({
        state: "invalid",
        origin: null,
        issue: "CREDENTIAL_SOURCE_INVALID",
      });
      expect(providerValue(credentials, name)).toBeUndefined();
    }
  },
);

describe.each([
  ["managed", { AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home" }],
  ["foreground", {}],
] as const)("%s gateway provider construction", (_label, marker) => {
  test("each registry receives only the resolved provider's own credential", async () => {
    const home = runtimeHome();
    const openaiSecret = `aio-test-openai-${randomBytes(12).toString("hex")}`;
    const anthropicSecret = `aio-test-anthropic-${randomBytes(12).toString("hex")}`;
    writeRuntimeHomeCredential(
      home,
      "OPENAI_API_KEY",
      Buffer.from(openaiSecret),
    );
    writeRuntimeHomeCredential(
      home,
      "ANTHROPIC_API_KEY",
      Buffer.from(anthropicSecret),
    );
    const seen: { providerId: string; environment: Record<string, string> }[] =
      [];
    const providers = new CredentialGatewayModelProviders(
      loadProviderCredentials(
        {
          ...marker,
          HOME: "/home/x",
          ...("AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE" in marker
            ? {}
            : {
                OPENAI_API_KEY: openaiSecret,
                ANTHROPIC_API_KEY: anthropicSecret,
              }),
        },
        { runtimeHome: home },
      ),
      {
        createRegistry: () =>
          new ModelProviderRegistry(
            defaultModelProviderDescriptors.map((descriptor) => ({
              ...descriptor,
              create: (_model, environment) => {
                seen.push({
                  providerId: descriptor.providerId,
                  environment: { ...environment } as Record<string, string>,
                });
                return new MockLlmProvider();
              },
            })),
          ),
      },
    );
    expect(providers.missingCredentials("openai")).toEqual([]);
    expect(providers.missingCredentials("anthropic")).toEqual([]);
    await providers.resolve("openai:economy-model");
    await providers.resolve("anthropic:claude-model");
    expect(seen).toEqual([
      { providerId: "openai", environment: { OPENAI_API_KEY: openaiSecret } },
      {
        providerId: "anthropic",
        environment: { ANTHROPIC_API_KEY: anthropicSecret },
      },
    ]);
    await expect(providers.resolve("ollama:qwen3")).rejects.toThrow(
      "Unsupported LLM provider",
    );
  });
});

test("a loaded credential source never serializes or inspects a value", () => {
  const home = runtimeHome();
  writeRuntimeHomeCredential(
    home,
    "OPENAI_API_KEY",
    Buffer.from(managedSecret),
  );
  const credentials = loadProviderCredentials(
    { AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home" },
    { runtimeHome: home },
  );
  expect(providerValue(credentials, "OPENAI_API_KEY")).toBe(managedSecret);
  for (const rendered of [
    JSON.stringify(credentials),
    inspect(credentials, { showHidden: true, depth: 10 }),
    String(credentials),
    JSON.stringify(Object.entries(credentials)),
    JSON.stringify(credentials.status("OPENAI_API_KEY")),
  ]) {
    expect(rendered).not.toContain(managedSecret);
    expect(rendered).not.toContain(home);
  }
  expect(Object.isFrozen(credentials)).toBe(true);
});
