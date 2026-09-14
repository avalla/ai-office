import { describe, expect, test } from "vitest";
import {
  FrozenMap,
  resolveAgentRunModel,
  type ModelRoutingState,
} from "@ai-office/application/model-routing/model-routing.ts";
import { loadModelRoutingState } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { parseAgentRunModelRouting } from "@ai-office/domain/agent/agent-run-model.ts";

function load(text: string, environment: Record<string, string> = {}) {
  return loadModelRoutingState(
    {
      AI_OFFICE_MODEL_ROUTING_FILE: "/host/model-routing.yaml",
      ...environment,
    },
    { readFile: () => text },
  );
}

const scopedRouting = `schema_version: 1
profiles:
  economical: { model: "openai:economy-model" }
  balanced: { model: "openai:balanced-model" }
  high_reasoning: { model: "openai:reasoning-model", reasoning_effort: high }
policies:
  default: balanced
agents:
  developer: { profile: economical }
projects:
  project-a:
    agents:
      developer: { profile: high_reasoning }
      reviewer: { model: "anthropic:client-model" }
  project-b:
    agents:
      qa: { profile: balanced }
`;

function route(state: ModelRoutingState, projectId: string, agentName: string) {
  return resolveAgentRunModel(state, {
    projectId,
    agentName,
    modelPolicy: "economical",
  });
}

describe("project-scoped agent overrides", () => {
  test("precedence is project override, host-global override, then role policy", () => {
    const state = load(scopedRouting);
    expect(state.status).toBe("configured");
    expect(route(state, "project-a", "developer")).toMatchObject({
      selection: {
        modelRef: "openai:reasoning-model",
        profile: "high_reasoning",
        source: "project_agent_override",
      },
    });
    // The same agent name in another project keeps the host-global override.
    expect(route(state, "project-b", "developer")).toMatchObject({
      selection: { modelRef: "openai:economy-model", source: "agent_override" },
    });
    expect(route(state, "project-a", "reviewer")).toMatchObject({
      selection: {
        modelRef: "anthropic:client-model",
        profile: null,
        source: "project_agent_override",
      },
    });
    // A project override never leaks into another project.
    expect(route(state, "project-a", "qa")).toMatchObject({
      selection: { modelRef: "openai:economy-model", source: "role_policy" },
    });
    expect(route(state, "project-b", "qa")).toMatchObject({
      selection: {
        modelRef: "openai:balanced-model",
        source: "project_agent_override",
      },
    });
  });

  test("a project-override selection round-trips through the persisted run shape", () => {
    const routing = route(load(scopedRouting), "project-a", "reviewer");
    expect(
      parseAgentRunModelRouting(JSON.parse(JSON.stringify(routing))),
    ).toEqual(routing);
  });

  test("invalid project overrides make routing misconfigured without echoing values", () => {
    const state = load(`schema_version: 1
profiles:
  balanced: { model: "openai:balanced-model" }
projects:
  "/home/operator/repository":
    agents:
      qa: { profile: balanced }
  project-a:
    agents:
      qa: { profile: missing }
      developer: { model: "not-a-ref" }
    token: "sk-should-not-appear"
`);
    expect(state.status).toBe("misconfigured");
    if (state.status !== "misconfigured") return;
    expect(state.issues.map((issue) => [issue.code, issue.subject])).toEqual([
      ["CONFIGURATION_INVALID", "projects.(invalid project id)"],
      ["CONFIGURATION_INVALID", "projects.project-a.token"],
      ["AGENT_OVERRIDE_UNAVAILABLE", "projects.project-a.agents.qa.profile"],
      ["MODEL_REF_MALFORMED", "projects.project-a.agents.developer.model"],
    ]);
    expect(JSON.stringify(state)).not.toContain("sk-should-not-appear");
    expect(JSON.stringify(state)).not.toContain("not-a-ref");
    expect(JSON.stringify(state)).not.toContain("/home/operator");
  });
});

describe("loaded routing is structurally immutable", () => {
  test("maps, entries, sources and diagnostics cannot be changed at runtime", () => {
    const state = load(scopedRouting, {
      AI_OFFICE_LLM_PROVIDER: "openai",
      AI_OFFICE_LLM_MODEL: "legacy-model",
    });
    if (state.status !== "configured") throw new Error("expected configured");
    const configuration = state.configuration;
    for (const map of [
      configuration.profiles,
      configuration.policies,
      configuration.agentOverrides,
      configuration.projectAgentOverrides,
      configuration.projectAgentOverrides.get("project-a")!,
    ]) {
      expect(map).toBeInstanceOf(FrozenMap);
      // No mutators exist, and the backing Map is unreachable.
      for (const method of ["set", "delete", "clear"])
        expect(
          (map as unknown as Record<string, unknown>)[method],
        ).toBeUndefined();
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.getOwnPropertyNames(map)).toEqual([]);
      let exposed: unknown;
      map.forEach((_value, _key, owner) => {
        exposed = owner;
      });
      expect(exposed).toBe(map);
      expect(() =>
        Map.prototype.set.call(map as unknown as Map<string, unknown>, "x", 1),
      ).toThrow(TypeError);
    }
    for (const value of [
      state,
      state.sources,
      state.warnings,
      ...state.warnings,
      configuration,
      configuration.legacyDefault,
      configuration.profiles.get("high_reasoning"),
      configuration.agentOverrides.get("developer"),
    ])
      expect(Object.isFrozen(value)).toBe(true);
    const before = route(state, "project-a", "developer");
    expect(() => {
      (configuration as unknown as { agentOverrides: unknown }).agentOverrides =
        new Map();
    }).toThrow(TypeError);
    expect(() => {
      (
        configuration.profiles.get("high_reasoning") as unknown as {
          model: string;
        }
      ).model = "other";
    }).toThrow(TypeError);
    expect(route(state, "project-a", "developer")).toEqual(before);
  });
});
