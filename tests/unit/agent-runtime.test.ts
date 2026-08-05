import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";

describe("agent runtime domain", () => {
  test("loads deterministic validated YAML definitions", () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "agents",
    );
    const loaded = new YamlAgentDefinitionLoader().load(root);
    expect(loaded.map((v) => v.definition.id)).toEqual([
      "architect",
      "developer",
      "qa",
      "reviewer",
    ]);
    expect(loaded[0]?.definition.limits.maxCostMicros).toBeTypeOf("bigint");
  });
  test("enforces the run state machine", () => {
    const now = new Date("2026-08-05T00:00:00Z");
    const run = AgentRun.create({
      id: "r",
      projectId: "p",
      taskId: "t",
      agentId: "a",
      now,
    });
    expect(() => run.transition("completed", now)).toThrow(
      DomainValidationError,
    );
    run.transition("preparing", now);
    run.transition("running", now);
    run.transition("reviewing", now);
    run.transition("completed", now, { result: { ok: true } });
    expect(run.snapshot()).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
  });
});
