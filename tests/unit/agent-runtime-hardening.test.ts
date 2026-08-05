import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidAgentDefinitionError,
  parseAgentDefinition,
} from "@ai-office/agent-runtime/agent-definition.ts";
import {
  AgentDefinitionDirectoryError,
  YamlAgentDefinitionLoader,
} from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";

const directories: string[] = [];
const valid = (overrides: Record<string, unknown> = {}) => ({
  id: "developer",
  role_key: "software-developer",
  role: "Software Developer",
  version: 1,
  capabilities: ["code"],
  tools: ["shell"],
  model_policy: "mock",
  limits: {
    max_iterations: 2,
    max_cost_micros: "100000000",
    timeout_seconds: 60,
  },
  ...overrides,
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("agent definition validation", () => {
  test.each([
    [100, 100n],
    ["100", 100n],
  ])("accepts a safe max_cost_micros value", (value, expected) => {
    expect(
      parseAgentDefinition(
        valid({
          limits: {
            max_iterations: 2,
            max_cost_micros: value,
            timeout_seconds: 60,
          },
        }),
        "agent.yaml",
      ).limits.maxCostMicros,
    ).toBe(expected);
  });
  test.each([[Number.MAX_SAFE_INTEGER + 1], [1.5], [-1], ["not-a-number"]])(
    "rejects unsafe max_cost_micros %s",
    (value) => {
      expect(() =>
        parseAgentDefinition(
          valid({
            limits: {
              max_iterations: 2,
              max_cost_micros: value,
              timeout_seconds: 60,
            },
          }),
          "agent.yaml",
        ),
      ).toThrow(InvalidAgentDefinitionError);
    },
  );
  test.each([
    ["version", valid({ version: 1.5 })],
    ["version negative", valid({ version: -1 })],
    [
      "iterations",
      valid({
        limits: {
          max_iterations: 0,
          max_cost_micros: "1",
          timeout_seconds: 60,
        },
      }),
    ],
    [
      "timeout",
      valid({
        limits: {
          max_iterations: 1,
          max_cost_micros: "1",
          timeout_seconds: Infinity,
        },
      }),
    ],
    ["missing", valid({ limits: { max_iterations: 1, max_cost_micros: "1" } })],
  ])("rejects invalid integer field: %s", (_name, value) =>
    expect(() => parseAgentDefinition(value, "agent.yaml")).toThrow(
      InvalidAgentDefinitionError,
    ),
  );
});

describe("YAML agent definition loader", () => {
  const root = () => {
    const value = mkdtempSync(join(tmpdir(), "ai-office-agent-loader-"));
    directories.push(value);
    return value;
  };
  const add = (directory: string, name: string, yaml: string) => {
    const child = join(directory, name);
    mkdirSync(child);
    writeFileSync(join(child, "agent.yaml"), yaml);
  };
  const yaml = (id: string, roleKey: string) =>
    `id: ${id}\nrole_key: ${roleKey}\nrole: ${roleKey}\nversion: 1\ncapabilities: [code]\ntools: [shell]\nmodel_policy: mock\nlimits:\n  max_iterations: 1\n  max_cost_micros: "10"\n  timeout_seconds: 60\n`;

  test("rejects a missing directory", () =>
    expect(() =>
      new YamlAgentDefinitionLoader().load(join(root(), "missing")),
    ).toThrow(AgentDefinitionDirectoryError));
  test("rejects a partially configured subdirectory", () => {
    const directory = root();
    mkdirSync(join(directory, "broken"));
    expect(() => new YamlAgentDefinitionLoader().load(directory)).toThrow(
      "missing",
    );
  });
  test("rejects invalid YAML", () => {
    const directory = root();
    add(directory, "broken", "id: [unterminated");
    expect(() => new YamlAgentDefinitionLoader().load(directory)).toThrow(
      InvalidAgentDefinitionError,
    );
  });
  test("rejects duplicate agent IDs", () => {
    const directory = root();
    add(directory, "a", yaml("same", "role-a"));
    add(directory, "b", yaml("same", "role-b"));
    expect(() => new YamlAgentDefinitionLoader().load(directory)).toThrow(
      "duplicate agent id",
    );
  });
  test("rejects duplicate role keys", () => {
    const directory = root();
    add(directory, "a", yaml("a", "same"));
    add(directory, "b", yaml("b", "same"));
    expect(() => new YamlAgentDefinitionLoader().load(directory)).toThrow(
      "duplicate role_key",
    );
  });
  test("returns definitions in deterministic path order", () => {
    const directory = root();
    add(directory, "z", yaml("z", "role-z"));
    add(directory, "a", yaml("a", "role-a"));
    expect(
      new YamlAgentDefinitionLoader()
        .load(directory)
        .map((value) => value.definition.id),
    ).toEqual(["a", "z"]);
  });
});
