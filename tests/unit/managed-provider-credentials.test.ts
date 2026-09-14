import { afterEach, describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  environmentProviderCredentials,
  loadProviderCredentials,
} from "@ai-office/llm-gateway/provider-credentials.ts";
import { writeRuntimeHomeCredential } from "@ai-office/llm-gateway/runtime-home-credential-store.ts";
import { CredentialModelProviderCatalog } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { CredentialGatewayModelProviders } from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { ModelProviderRegistry } from "@ai-office/llm-gateway/model-provider-registry.ts";
import { defaultModelProviderDescriptors } from "@ai-office/llm-gateway/model-ref.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import { renderSystemdUnit } from "@ai-office/service-management/systemd-user-service-manager.ts";
import { renderLaunchdPlist } from "@ai-office/service-management/launchd-user-service-manager.ts";
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
    const environment: Record<string, string> = {};
    for (const line of definition.split("\n")) {
      const match = /^Environment="([A-Z_]+)=(.*)"$/u.exec(line);
      if (match !== null) environment[match[1]!] = match[2]!;
    }
    return { definition, environment };
  },
  launchd: (home, service) => {
    const definition = renderLaunchdPlist(plan(home), service);
    return {
      definition,
      environment: parseMinimalPlist(definition).EnvironmentVariables as Record<
        string,
        string
      >,
    };
  },
};

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
      expect(credentials.secret("OPENAI_API_KEY")).toBe(managedSecret);
      // Restart after reboot or login: the same definition gives the same source.
      expect(
        managedStart(platforms[platform](home, "runtime").environment).secret(
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
      expect(credentials.secret("OPENAI_API_KEY")).toBeUndefined();
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
      expect(credentials.secret("OPENAI_API_KEY")).toBeUndefined();
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
    expect(systemd.secret(name)).toBe(launchd.secret(name));
  }
});

describe("foreground provider credentials", () => {
  test("the Runtime environment takes precedence over the Runtime home file", () => {
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
    expect(credentials.status("OPENAI_API_KEY")).toMatchObject({
      state: "present",
      origin: "environment",
      ambientIgnored: false,
    });
    expect(credentials.secret("OPENAI_API_KEY")).toBe(ambientSecret);
  });

  test("without the variable the Runtime home file is used, and a malformed one is invalid", () => {
    const home = runtimeHome();
    writeRuntimeHomeCredential(
      home,
      "OPENAI_API_KEY",
      Buffer.from(managedSecret),
    );
    expect(
      loadProviderCredentials({}, { runtimeHome: home }).secret(
        "OPENAI_API_KEY",
      ),
    ).toBe(managedSecret);
    writeFileSync(
      join(home, "credentials", "OPENAI_API_KEY"),
      `${managedSecret} x`,
    );
    const invalid = loadProviderCredentials({}, { runtimeHome: home });
    expect(invalid.status("OPENAI_API_KEY")).toMatchObject({
      state: "invalid",
      issue: "CREDENTIAL_MALFORMED",
    });
    expect(invalid.secret("OPENAI_API_KEY")).toBeUndefined();
  });

  test("an explicit foreground environment record keeps legacy variable behavior", () => {
    const credentials = environmentProviderCredentials({
      OPENAI_API_KEY: ambientSecret,
      AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
    });
    expect(credentials.secret("OPENAI_API_KEY")).toBe(ambientSecret);
    expect(credentials.status("ANTHROPIC_API_KEY").state).toBe("missing");
  });
});

test("an unknown credential source marker fails every credential closed", () => {
  const home = runtimeHome();
  writeRuntimeHomeCredential(
    home,
    "OPENAI_API_KEY",
    Buffer.from(managedSecret),
  );
  const credentials = loadProviderCredentials(
    {
      AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "environment",
      OPENAI_API_KEY: ambientSecret,
    },
    { runtimeHome: home },
  );
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    expect(credentials.status(name)).toMatchObject({
      state: "invalid",
      issue: "CREDENTIAL_SOURCE_INVALID",
    });
    expect(credentials.secret(name)).toBeUndefined();
  }
});

test("the gateway registry receives only the resolved provider's own credential", async () => {
  const home = runtimeHome();
  writeRuntimeHomeCredential(
    home,
    "OPENAI_API_KEY",
    Buffer.from(managedSecret),
  );
  writeRuntimeHomeCredential(
    home,
    "ANTHROPIC_API_KEY",
    Buffer.from(ambientSecret),
  );
  const seen: Record<string, string | undefined>[] = [];
  const openai = defaultModelProviderDescriptors.find(
    (value) => value.providerId === "openai",
  )!;
  const providers = new CredentialGatewayModelProviders(
    loadProviderCredentials(
      { AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home", HOME: "/home/x" },
      { runtimeHome: home },
    ),
    {
      createRegistry: () =>
        new ModelProviderRegistry([
          {
            ...openai,
            create: (_model, environment) => {
              seen.push({ ...environment });
              return new MockLlmProvider();
            },
          },
        ]),
    },
  );
  expect(providers.missingCredentials("openai")).toEqual([]);
  await providers.resolve("openai:economy-model");
  expect(seen).toEqual([{ OPENAI_API_KEY: managedSecret }]);
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
  expect(credentials.secret("OPENAI_API_KEY")).toBe(managedSecret);
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
