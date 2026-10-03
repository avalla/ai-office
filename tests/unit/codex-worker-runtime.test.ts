import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { AgentRunModelSelection } from "@ai-office/domain/agent/agent-run-model.ts";
import type { WorkerContext } from "@ai-office/application/ports/worker-runtime.port.ts";
import {
  CodexWorkerRuntime,
  parseCodexWorkerOutput,
} from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import type { WorkerProcessRequest } from "@ai-office/agent-runtime/claude-worker-runtime.ts";

const selection: AgentRunModelSelection = {
  policy: "balanced",
  profile: "balanced",
  modelRef: "openai:gpt-5.6-sol",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  maxOutputTokens: null,
  source: "role_policy",
};
const context: WorkerContext = {
  schemaVersion: 1,
  projectId: "project",
  runId: "run",
  task: {
    id: "task",
    title: "Review evidence",
    description: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  agent: {
    id: "reviewer",
    name: "Reviewer",
    roleId: "role",
    roleKey: "reviewer",
    roleVersion: 1,
  },
  model: selection,
  stage: null,
  memory: { results: [] },
};
const limits = {
  timeoutMs: 1000,
  maxTurns: 2,
  maxEstimatedCostUsd: "0.100000",
  maxCostMicros: 100000n,
};
const events = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "item.updated", item: { type: "reasoning" } },
  {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ summary: "Review", content: "Evidence checked" }),
    },
  },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } },
];

describe("bounded Codex worker", () => {
  test("pins the selected model and effort in an isolated, read-only CLI invocation", async () => {
    const calls: WorkerProcessRequest[] = [];
    const worker = new CodexWorkerRuntime("codex-test", async (request) => {
      calls.push(request);
      if (request.args[0] === "--version") return "codex-cli 0.160.0\n";
      expect(
        JSON.parse(
          readFileSync(
            request.args[request.args.indexOf("--output-schema") + 1]!,
            "utf8",
          ),
        ),
      ).toMatchObject({
        required: ["summary", "content"],
      });
      return events.map((event) => JSON.stringify(event)).join("\n");
    });
    const output = await worker.execute(context, limits);
    const request = calls[1]!;
    const value = (flag: string) =>
      request.args[request.args.indexOf(flag) + 1];
    expect(value("--sandbox")).toBe("read-only");
    expect(request.args).toContain("--ephemeral");
    expect(request.args).toContain("--ignore-user-config");
    expect(request.args).toContain("--strict-config");
    expect(request.args).not.toContain("--ignore-rules");
    expect(request.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(request.args).toContain("shell_tool");
    expect(request.args).toContain("unified_exec");
    expect(request.args).toContain('web_search="disabled"');
    expect(request.args).toContain("mcp_servers={}");
    expect(value("--model")).toBe("gpt-5.6-sol");
    expect(request.args).toContain('model_reasoning_effort="high"');
    expect(request.cwd).not.toContain("ai-office-codex-worker/packages");
    expect(request.input).toContain("Review evidence");
    expect(output).toMatchObject({
      summary: "Review",
      content: "Evidence checked",
      model: "gpt-5.6-sol",
      sessionId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 20 },
      estimatedCostUsd: null,
    });
    expect(calls.every((call) => !existsSync(call.cwd))).toBe(true);
  });

  test("rejects unsupported routing, version and output without dispatching", async () => {
    const worker = new CodexWorkerRuntime(
      "codex-test",
      async () => "codex-cli 0.160.0\n",
    );
    expect(
      worker.supportsModel({ ...selection, providerId: "anthropic" }),
    ).toEqual({
      supported: false,
      code: "WORKER_MODEL_UNSUPPORTED",
    });
    expect(
      worker.supportsModel({ ...selection, maxOutputTokens: 100 }),
    ).toEqual({
      supported: false,
      code: "WORKER_MODEL_UNSUPPORTED",
    });
    expect(
      new CodexWorkerRuntime(
        "codex-test",
        async () => "codex-cli 0.159.0\n",
      ).inspect(),
    ).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    expect(() =>
      parseCodexWorkerOutput(
        [
          ...events.slice(0, 2),
          { type: "item.started", item: { type: "command_execution" } },
          ...events.slice(2),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
        selection.model,
      ),
    ).toThrow("The worker did not return a supported result.");
  });
});
