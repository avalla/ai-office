import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgentRunModel,
  type ModelRoutingState,
} from "@ai-office/application/model-routing/model-routing.ts";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import { loadModelRoutingState } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { renderSystemdUnit } from "@ai-office/service-management/systemd-user-service-manager.ts";
import { renderLaunchdPlist } from "@ai-office/service-management/launchd-user-service-manager.ts";
import {
  parseMinimalPlist,
  servicePlan,
} from "../helpers/service-management.ts";

const secret = "sk-managed-routing-secret";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function runtimeHome(routing: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "ao-managed-routing-"));
  roots.push(root);
  if (routing !== null)
    writeFileSync(join(root, "model-routing.yaml"), routing);
  return root;
}

const canonicalRouting = `schema_version: 1
profiles:
  economical: { model: "openai:economy-model", reasoning_effort: low }
  high_reasoning: { model: "openai:reasoning-model", reasoning_effort: high }
`;

/** Environment assignments exactly as each service manager would pass them. */
const platforms: Record<
  "systemd" | "launchd",
  (
    home: string,
    service: OfficeServiceName,
  ) => {
    definition: string;
    environment: Record<string, string>;
  }
> = {
  systemd: (home, service) => {
    const definition = renderSystemdUnit(
      servicePlan({
        program: {
          launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
          runtimeHome: home,
          requiresSourceRuntimeOptIn: false,
        },
      }),
      service,
    );
    const environment: Record<string, string> = {};
    for (const line of definition.split("\n")) {
      const match = /^Environment="([A-Z_]+)=(.*)"$/u.exec(line);
      if (match !== null) environment[match[1]!] = match[2]!;
    }
    return { definition, environment };
  },
  launchd: (home, service) => {
    const definition = renderLaunchdPlist(
      servicePlan({
        program: {
          launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
          runtimeHome: home,
          requiresSourceRuntimeOptIn: false,
        },
      }),
      service,
    );
    return {
      definition,
      environment: parseMinimalPlist(definition).EnvironmentVariables as Record<
        string,
        string
      >,
    };
  },
};

function managedStart(environment: Record<string, string>): ModelRoutingState {
  // The service manager's own environment may carry ambient routing values
  // and credentials; only the rendered definition decides the routing source.
  return loadModelRoutingState(
    {
      AI_OFFICE_MODEL_ROUTING_FILE: "/somewhere/else/routing.yaml",
      AI_OFFICE_LLM_MODEL: "openai:ambient-model",
      OPENAI_API_KEY: secret,
      ...environment,
    },
    { runtimeHome: environment.AI_OFFICE_HOME! },
  );
}

function modelFor(state: ModelRoutingState, modelPolicy: string) {
  const routing = resolveAgentRunModel(state, {
    projectId: "p",
    agentName: "architect",
    modelPolicy,
  });
  return routing.status === "resolved"
    ? routing.selection.modelRef
    : routing.status;
}

describe.each(["systemd", "launchd"] as const)(
  "managed %s Runtime model routing",
  (platform) => {
    test("discovers routing from AI_OFFICE_HOME and ignores ambient routing variables", () => {
      const home = runtimeHome(canonicalRouting);
      const runtime = platforms[platform](home, "runtime");
      expect(runtime.environment).toEqual({
        AI_OFFICE_HOME: home,
        AI_OFFICE_MODEL_ROUTING_SOURCE: "runtime_home",
        AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
      });
      const state = managedStart(runtime.environment);
      expect(state).toMatchObject({
        status: "configured",
        sources: {
          file: true,
          fileOrigin: "runtime_home",
          legacyEnvironment: false,
          managed: true,
        },
      });
      expect(state.warnings.map((warning) => warning.subject).sort()).toEqual([
        "AI_OFFICE_LLM_MODEL",
        "AI_OFFICE_MODEL_ROUTING_FILE",
      ]);
      expect(modelFor(state, "high_reasoning")).toBe("openai:reasoning-model");
      // Restart after reboot or login: the same definition gives the same routing.
      expect(
        modelFor(managedStart(runtime.environment), "high_reasoning"),
      ).toBe("openai:reasoning-model");
      expect(JSON.stringify(state)).not.toContain(secret);
    });

    test("a managed Runtime without a routing file stays unrouted instead of using ambient values", () => {
      const home = runtimeHome(null);
      const state = managedStart(
        platforms[platform](home, "runtime").environment,
      );
      expect(state).toMatchObject({
        status: "unconfigured",
        sources: { file: false, legacyEnvironment: false, managed: true },
      });
      expect(modelFor(state, "high_reasoning")).toBe("unrouted");
    });

    test("an unreadable Runtime-home routing file fails closed", () => {
      const home = runtimeHome(null);
      mkdirSync(join(home, "model-routing.yaml"));
      const state = managedStart(
        platforms[platform](home, "runtime").environment,
      );
      expect(state).toMatchObject({ status: "misconfigured" });
      expect(JSON.stringify(state)).not.toContain(home);
    });

    test("generated definitions carry no provider credentials, and only the Runtime a routing source", () => {
      const home = runtimeHome(canonicalRouting);
      const previous = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = secret;
      try {
        const runtime = platforms[platform](home, "runtime");
        const dashboard = platforms[platform](home, "dashboard");
        for (const { definition } of [runtime, dashboard]) {
          expect(definition).not.toContain(secret);
          expect(definition).not.toMatch(/API_KEY|TOKEN|SECRET/u);
          expect(definition).not.toContain("AI_OFFICE_LLM_MODEL");
          expect(definition).not.toContain("AI_OFFICE_MODEL_ROUTING_FILE");
        }
        expect(dashboard.environment).toEqual({ AI_OFFICE_HOME: home });
      } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
      }
    });
  },
);

test("systemd and launchd managed Runtimes resolve identical routing", () => {
  const home = runtimeHome(canonicalRouting);
  const systemd = managedStart(platforms.systemd(home, "runtime").environment);
  const launchd = managedStart(platforms.launchd(home, "runtime").environment);
  expect(systemd).toEqual(launchd);
  for (const policy of ["economical", "high_reasoning"])
    expect(modelFor(systemd, policy)).toBe(modelFor(launchd, policy));
  for (const state of [systemd, launchd])
    expect(() => modelFor(state, "unmapped")).toThrow(/no model profile/u);
});

describe("foreground model routing sources", () => {
  test("the explicit file override wins over the Runtime-home file", () => {
    const home = runtimeHome(canonicalRouting);
    const override = join(home, "override.yaml");
    writeFileSync(
      override,
      `schema_version: 1
profiles:
  high_reasoning: { model: "openai:override-model" }
`,
    );
    const state = loadModelRoutingState(
      { AI_OFFICE_MODEL_ROUTING_FILE: override },
      { runtimeHome: home },
    );
    expect(state.sources).toEqual({
      file: true,
      fileOrigin: "environment",
      legacyEnvironment: false,
      managed: false,
    });
    expect(modelFor(state, "high_reasoning")).toBe("openai:override-model");
  });

  test("without an override the Runtime-home file applies, with the legacy default below it", () => {
    const home = runtimeHome(canonicalRouting);
    const state = loadModelRoutingState(
      { AI_OFFICE_LLM_MODEL: "openai:legacy-model" },
      { runtimeHome: home },
    );
    expect(state.sources).toEqual({
      file: true,
      fileOrigin: "runtime_home",
      legacyEnvironment: true,
      managed: false,
    });
    expect(modelFor(state, "economical")).toBe("openai:economy-model");
    expect(modelFor(state, "balanced")).toBe("openai:legacy-model");
    expect(
      loadModelRoutingState({}, { runtimeHome: runtimeHome(null) }).status,
    ).toBe("unconfigured");
  });

  test("an unknown routing source value fails closed", () => {
    expect(
      loadModelRoutingState(
        { AI_OFFICE_MODEL_ROUTING_SOURCE: "environment" },
        { runtimeHome: runtimeHome(canonicalRouting) },
      ),
    ).toMatchObject({
      status: "misconfigured",
      issues: [
        expect.objectContaining({ subject: "AI_OFFICE_MODEL_ROUTING_SOURCE" }),
      ],
    });
  });
});
