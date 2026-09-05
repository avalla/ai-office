import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import { ControlledActionAgentExecutor } from "@ai-office/agent-runtime/executor.ts";

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
      "alien-user",
      "architect",
      "chaos-gremlin",
      "code-archaeologist",
      "designer",
      "developer",
      "devil-advocate",
      "forensic-detective",
      "future-keeper",
      "hacker",
      "mad-scientist",
      "product",
      "qa",
      "radical-minimalist",
      "release",
      "researcher",
      "reviewer",
      "security",
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

  test("normalizes immutable controlled-action intent", () => {
    const run = AgentRun.create({
      id: "run",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      actionIntent: {
        resourceId: " workspace ",
        operation: " filesystem.create ",
        arguments: { content: "hello", path: "notes/hello.txt" },
      },
      now: new Date("2026-08-05T00:00:00Z"),
    });
    expect(run.snapshot().actionIntent).toEqual({
      resourceId: "workspace",
      operation: "filesystem.create",
      arguments: { content: "hello", path: "notes/hello.txt" },
    });
    expect(Object.isFrozen(run.snapshot().actionIntent?.arguments)).toBe(true);
  });

  test("routes run intent through the controlled-action gateway", async () => {
    const calls: unknown[] = [];
    const executor = new ControlledActionAgentExecutor({
      invoke: async (input) => {
        calls.push(input);
        return {
          requestId: "action-1",
          outcome: "approval_required",
          status: "approval_pending",
        };
      },
    });
    const run = AgentRun.create({
      id: "run",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      actionIntent: {
        resourceId: "workspace",
        operation: "filesystem.create",
        arguments: { path: "notes/hello.txt", content: "hello" },
      },
      now: new Date("2026-08-05T00:00:00Z"),
    });

    await expect(executor.execute(run)).resolves.toEqual({
      summary: "Controlled action action-1 reached approval_pending",
      artifacts: ["action:action-1"],
      actions: [
        {
          requestId: "action-1",
          outcome: "approval_required",
          status: "approval_pending",
        },
      ],
    });
    expect(calls).toEqual([
      {
        agentRunId: "run",
      },
    ]);
  });
});
