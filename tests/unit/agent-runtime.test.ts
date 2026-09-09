import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import {
  AgentExecutorNotConfiguredError,
  AuthoritativeExecutorRequiresPrepareError,
  AuthoritativeWorkerAgentExecutor,
  ControlledActionAgentExecutor,
} from "@ai-office/agent-runtime/executor.ts";

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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentRunId: "run" });
    expect((calls[0] as { signal: AbortSignal }).signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  test("never sends an action intent to an injected generic fallback", async () => {
    let fallbackCalls = 0;
    let gatewayCalls = 0;
    const fallback = {
      execute: async () => {
        fallbackCalls += 1;
        return { summary: "bypassed", artifacts: [] };
      },
    };
    const executor = new ControlledActionAgentExecutor(
      {
        invoke: async () => {
          gatewayCalls += 1;
          return {
            requestId: "action-boundary",
            outcome: "denied" as const,
            status: "denied" as const,
          };
        },
      },
      fallback,
    );
    const run = AgentRun.create({
      id: "run-boundary",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      actionIntent: {
        resourceId: "workspace",
        operation: "filesystem.read",
        arguments: { path: "notes/hello.txt" },
      },
      now: new Date("2026-08-05T00:00:00Z"),
    });

    await executor.execute(run);
    expect(gatewayCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test("rejects an execute-only adapter from the authoritative worker contract", async () => {
    const run = AgentRun.create({
      id: "run-contract",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      now: new Date("2026-08-05T00:00:00Z"),
    });
    const executor = new AuthoritativeWorkerAgentExecutor({
      execute: async () => ({ summary: "raw", artifacts: [] }),
    });
    await expect(executor.prepare(run)).rejects.toBeInstanceOf(
      AgentExecutorNotConfiguredError,
    );
  });

  test("fails closed when authoritative execute is called directly", async () => {
    let delegateCalls = 0;
    const run = AgentRun.create({
      id: "run-direct-execute",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      now: new Date("2026-08-05T00:00:00Z"),
    });
    const executor = new AuthoritativeWorkerAgentExecutor({
      execute: async () => {
        delegateCalls += 1;
        return { summary: "must not run", artifacts: [] };
      },
    });
    await expect(executor.execute(run)).rejects.toBeInstanceOf(
      AuthoritativeExecutorRequiresPrepareError,
    );
    expect(delegateCalls).toBe(0);
  });

  test("requires worker provenance and an acceptance fence before dispatch", async () => {
    const run = AgentRun.create({
      id: "run-prepared-contract",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      now: new Date("2026-08-05T00:00:00Z"),
    });
    const prepared = new AuthoritativeWorkerAgentExecutor({
      prepare: async () => ({
        provenance: {
          kind: "worker" as const,
          adapterId: "configured-worker",
          adapterVersion: "1",
          inputHash: "a".repeat(64),
        },
        usesWorktree: false,
        execute: async () => ({ summary: "prepared", artifacts: [] }),
        accept: async () => undefined,
      }),
      execute: async () => ({ summary: "unused", artifacts: [] }),
    });
    await expect(prepared.prepare(run)).resolves.toMatchObject({
      provenance: {
        kind: "worker",
        adapterId: "configured-worker",
      },
    });
  });

  test("bounds controlled-action waiting with the role deadline without detaching a non-cooperative connector", async () => {
    let observedSignal!: AbortSignal;
    let release!: () => void;
    const connectorReturned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = AgentRun.create({
      id: "run-timeout",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      actionIntent: {
        resourceId: "workspace",
        operation: "filesystem.read",
        arguments: { path: "notes/hello.txt" },
      },
      now: new Date("2026-08-05T00:00:00Z"),
    });
    const executor = new ControlledActionAgentExecutor(
      {
        invoke: async (input) => {
          observedSignal = input.signal!;
          // Deliberately ignore AbortSignal: the caller must wait for the
          // connector to return instead of reporting a false failure.
          await connectorReturned;
          return {
            requestId: "action-timeout",
            outcome: "allowed" as const,
            status: "completed" as const,
          };
        },
      },
      undefined,
      () => 5,
    );
    let settled = false;
    const execution = executor.execute(run).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observedSignal.aborted).toBe(true);
    expect(settled).toBe(false);
    release();
    await expect(execution).resolves.toMatchObject({
      actions: [{ requestId: "action-timeout", status: "completed" }],
    });
    expect(settled).toBe(true);
  });
});
