import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type {
  AgentRunDetail,
  AgentRunState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import type { RuntimeStatus } from "@ai-office/application/protocol/daemon-protocol.ts";
import type { WorkerOutput } from "@ai-office/application/ports/worker-runtime.port.ts";
import {
  RunPage,
  RuntimePage,
} from "../../apps/dashboard/src/features/pages.tsx";

const now = "2026-10-02T12:00:00.000Z";
const inputHash = "a".repeat(64);
const run: AgentRunState = {
  runId: "run-provenance",
  projectId: "project-1",
  task: { taskId: "task-1", title: "Inspect evidence" },
  agent: {
    agentId: "agent-1",
    name: "Research Agent",
    roleId: "role-1",
    roleKey: "research",
  },
  status: "completed",
  terminal: true,
  pipelineRunId: null,
  execution: {
    kind: "worker",
    adapterId: "claude-code",
    adapterVersion: "2.1.0",
    inputHash,
  },
  model: {
    status: "resolved",
    selection: {
      policy: "careful analysis",
      profile: "balanced",
      modelRef: "openai:gpt-4.1",
      providerId: "openai",
      model: "gpt-4.1",
      reasoningEffort: "medium",
      maxOutputTokens: 4096,
      source: "role_policy",
    },
  },
  actionIntent: null,
  hasResult: true,
  hasError: false,
  failure: null,
  worktreePath: "/tmp/ai-office-worktree",
  createdAt: now,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  durationMs: 2_000,
};
const output: WorkerOutput = {
  schemaVersion: 1,
  summary: "Generated summary",
  content: "<script>untrusted model text</script>",
  sessionId: "session-123",
  model: "gpt-4.1",
  usage: { inputTokens: 100, outputTokens: 50 },
  estimatedCostUsd: 0.0042,
  metering: {
    kind: "gateway",
    providerId: "openai",
    model: "gpt-4.1",
    providerRequestId: "request-123",
    usage: {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 60,
      reasoningTokens: 7,
    },
    appliedParameters: { reasoningEffort: "medium", maxOutputTokens: 4096 },
    currency: "USD",
    pricingVersionId: "pricing-v2",
    budgetScope: "agent_run",
    budgetLimitMicros: "2500",
    reservedMicros: "2000",
    estimatedMicros: "1900",
    actualMicros: "1750",
  },
};
function runDetail(
  state: AgentRunState,
  workerOutput: WorkerOutput | null,
): AgentRunDetail {
  return {
    run: state,
    workerOutput,
    events: { total: 0, items: [], truncated: false },
    actions: [],
    pipeline: null,
    reviews: [],
    activity: { items: [], nextCursor: null },
    attentionReasons: [],
  };
}
function markup(detail: AgentRunDetail): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RunPage, {
        data: { kind: "run", detail, task: null },
      }),
    ),
  );
}

describe("Run Detail operational provenance", () => {
  test("separates assigned model, worker report, advisory estimate, and gateway metering", () => {
    const rendered = markup(runDetail(run, output));
    for (const expected of [
      "Executor kind",
      "worker",
      "Adapter ID",
      "claude-code",
      "Adapter version",
      "2.1.0",
      "Input SHA-256",
      inputHash,
      "Model routing before execution",
      "Selected model",
      "openai:gpt-4.1",
      "Selection source",
      "role_policy",
      "Model policy",
      "careful analysis",
      "Model profile",
      "balanced",
      "Selected reasoning effort",
      "Selected max output tokens",
      "4096",
      "Worktree path",
      "/tmp/ai-office-worktree",
      "Worker report",
      "Reported model",
      "Session ID",
      "session-123",
      "Worker reported input tokens",
      "100",
      "Worker reported output tokens",
      "50",
      "CLI cost estimate (advisory)",
      "USD 0.0042",
      "Gateway metering",
      "Provider",
      "openai",
      "Actual model",
      "Provider request ID",
      "request-123",
      "Input tokens",
      "120",
      "Cached input tokens",
      "20",
      "Output tokens",
      "60",
      "Reasoning tokens",
      "7",
      "Applied reasoning effort",
      "Max output tokens",
      "Pricing version",
      "pricing-v2",
      "Budget scope",
      "agent_run",
      "Budget limit",
      "2500 micros USD",
      "Reserved cost",
      "2000 micros USD",
      "Estimated gateway cost",
      "1900 micros USD",
      "Actual gateway cost",
      "1750 micros USD",
      "Currency",
    ]) {
      expect(rendered).toContain(expected);
    }
    expect(rendered).toContain(
      "&lt;script&gt;untrusted model text&lt;/script&gt;",
    );
    expect(rendered).not.toContain("<script>untrusted model text</script>");
  });

  test("historical runs without optional provenance remain readable", () => {
    const historical: AgentRunState = {
      ...run,
      execution: null,
      model: null,
      worktreePath: null,
    };
    const rendered = markup(runDetail(historical, null));
    expect(rendered).toContain("Run run-provenance");
    expect(rendered).toContain("Not recorded (historical run)");
    expect(rendered).toContain("Input SHA-256");
    expect(rendered).toContain("Not recorded");
    expect(rendered).not.toContain("Gateway metering");
  });

  test("worker reports with missing optional fields show clear unknown values", () => {
    const rendered = markup(
      runDetail(run, {
        schemaVersion: 1,
        summary: "Historical worker result",
        content: "Recorded output",
        model: null,
        sessionId: null,
        usage: null,
        estimatedCostUsd: null,
      }),
    );
    expect(rendered).toContain("Worker report");
    expect(rendered).toContain("Not reported");
    expect(rendered).not.toContain("Gateway metering");
  });
});

describe("Runtime status page", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const base: RuntimeStatus = {
    protocolVersion: 1,
    status: "ok",
    productVersion: "0.1.0",
    sourceRevision: revision,
    startedAt: now,
    uptimeSeconds: 3_661,
    knowledge: { provider: "surrealdb", startup: "connected" },
    queue: {
      provider: "configured",
      redis: "reachable",
      outboxPending: 3,
      orchestrationWorker: true,
      agentRunWorker: false,
    },
    storage: { project: "available" },
  };
  function render(status: RuntimeStatus): string {
    return renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimePage, { data: { kind: "runtime", status } }),
      ),
    );
  }

  test("renders daemon, knowledge, queue, storage and distribution state", () => {
    const rendered = render(base);
    for (const expected of [
      "Daemon",
      "Protocol version",
      "Started",
      "Uptime",
      "1h 1m",
      "Knowledge store",
      "surrealdb",
      "connected",
      "Queue",
      "configured",
      "reachable",
      "Outbox pending",
      "3</dd>",
      "Orchestration worker",
      "Agent run worker",
      "Project store",
      "available",
      "Product version",
      "0.1.0",
      "Source revision",
      revision.slice(0, 12),
    ]) {
      expect(rendered).toContain(expected);
    }
    // The short SHA is displayed; the full revision is the tooltip.
    expect(rendered).toContain(`title="${revision}"`);
    expect(rendered).not.toContain(`>${revision}<`);
    // Startup state must not read like a live health check.
    expect(rendered).toContain(
      "opened at Runtime startup, not a live probe",
    );
    expect(rendered).toContain(
      "The project store opened when the Runtime started; this page does not probe it live.",
    );
  });

  test("a disabled knowledge store reads as disabled, not as an error", () => {
    const rendered = render({
      ...base,
      knowledge: { provider: "none", startup: "disabled" },
      sourceRevision: null,
    });
    expect(rendered).toContain("Agent knowledge is disabled on this Runtime.");
    expect(rendered).toContain(">none<");
    expect(rendered).toContain("Unknown");
  });
});
