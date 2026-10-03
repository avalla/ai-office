import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunModelSelection } from "@ai-office/domain/agent/agent-run-model.ts";
import {
  WorkerRuntimeError,
  type WorkerContext,
} from "@ai-office/application/ports/worker-runtime.port.ts";
import {
  CodexWorkerRuntime,
  auditedCodexVersions,
  codexDisabledFeatures,
  parseCodexWorkerOutput,
  verifyCodexFeatureIsolation,
} from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import type { WorkerProcessRequest } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  codexFeatureListing,
  codexFeatureListingAfter,
  createOperatorCodexHome,
} from "../helpers/fake-codex.ts";

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

const jsonl = (list: readonly object[]) =>
  list.map((event) => JSON.stringify(event)).join("\n");
const invalid = (list: readonly object[]) =>
  expect(() => parseCodexWorkerOutput(jsonl(list), selection.model)).toThrow(
    "The worker did not return a supported result.",
  );
/** Answers the inspection probes like codex-cli 0.160.0. */
const inspection = (request: WorkerProcessRequest): string | undefined =>
  request.args[0] === "--version"
    ? "codex-cli 0.160.0\n"
    : request.args[0] === "features"
      ? codexFeatureListingAfter(request.args)
      : undefined;

describe("bounded Codex worker", () => {
  let root: string;
  let operatorHome: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ao-codex-unit-"));
    operatorHome = createOperatorCodexHome(root, "sk-unit-secret");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const runtime = (
    runner: (request: WorkerProcessRequest) => Promise<string>,
    model?: string,
  ) =>
    new CodexWorkerRuntime("codex-test", runner, model, "posix", operatorHome);

  test("pins the selected model and effort in an isolated, read-only CLI invocation", async () => {
    const calls: WorkerProcessRequest[] = [];
    let isolatedEntries: string[] = [];
    const worker = runtime(async (request) => {
      calls.push(request);
      const probe = inspection(request);
      if (probe !== undefined) return probe;
      isolatedEntries = readdirSync(request.env!.CODEX_HOME!);
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
      return jsonl(events);
    });
    const output = await worker.execute(context, limits);
    expect(calls.map((call) => call.args[0])).toEqual([
      "--version",
      "features",
      "exec",
    ]);
    const request = calls[2]!;
    const value = (flag: string) =>
      request.args[request.args.indexOf(flag) + 1];
    const disabled = request.args.filter(
      (_, index) => request.args[index - 1] === "--disable",
    );
    expect(value("--sandbox")).toBe("read-only");
    expect(request.args).toContain("--ephemeral");
    expect(request.args).toContain("--ignore-user-config");
    expect(request.args).toContain("--strict-config");
    expect(request.args).not.toContain("--ignore-rules");
    expect(request.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(disabled).toEqual([...codexDisabledFeatures]);
    expect(disabled).toContain("view_image");
    expect(disabled).toContain("shell_tool");
    expect(request.args).toContain('web_search="disabled"');
    expect(request.args).toContain("mcp_servers={}");
    expect(request.args).toContain("skills.bundled.enabled=false");
    expect(request.args).toContain("project_doc_max_bytes=0");
    expect(value("--model")).toBe("gpt-5.6-sol");
    expect(request.args).toContain('model_reasoning_effort="high"');
    expect(request.input).toContain("Review evidence");

    // Every process, including the probes, gets its own private homes.
    for (const call of calls) {
      expect(Object.keys(call.env!).sort()).toEqual([
        "CODEX_HOME",
        "HOME",
        "PATH",
      ]);
      expect(call.env!.CODEX_HOME).not.toBe(operatorHome);
      expect(call.env!.HOME).not.toBe(homedir());
      expect(existsSync(call.env!.CODEX_HOME!)).toBe(false);
      expect(existsSync(call.cwd)).toBe(false);
    }
    expect(isolatedEntries).toEqual(["auth.json"]);
    expect(output).toMatchObject({
      summary: "Review",
      content: "Evidence checked",
      model: "gpt-5.6-sol",
      sessionId: "thread-1",
      usage: { inputTokens: 10, outputTokens: 20 },
      estimatedCostUsd: null,
    });
  });

  test("every disabled feature is a default-enabled key of the supported CLI", () => {
    const listed = new Map(
      codexFeatureListing
        .trim()
        .split("\n")
        .map((line) => {
          const columns = line.trim().split(/\s+/);
          return [columns[0]!, columns.at(-1) === "true"] as const;
        }),
    );
    for (const feature of codexDisabledFeatures)
      expect(listed.has(feature), feature).toBe(true);
    expect(listed.get("view_image")).toBe(true);
    // The audited state passes; it is the only state that does.
    const audited = codexFeatureListingAfter(
      codexDisabledFeatures.flatMap((feature) => ["--disable", feature]),
    );
    expect(() => verifyCodexFeatureIsolation(audited)).not.toThrow();
    const unavailable = "The selected worker is unavailable or unsupported.";
    expect(() => verifyCodexFeatureIsolation(codexFeatureListing)).toThrow(
      unavailable,
    );
    for (const feature of [
      "view_image",
      "shell_tool",
      "multi_agent",
      "apps",
      "hooks",
    ])
      expect(() =>
        verifyCodexFeatureIsolation(
          audited.replace(
            new RegExp(`^(${feature}\\s.*)false$`, "m"),
            "$1true",
          ),
        ),
      ).toThrow(unavailable);
    expect(() =>
      verifyCodexFeatureIsolation(audited + "new_local_tool  stable  true\n"),
    ).toThrow(unavailable);
    expect(() =>
      verifyCodexFeatureIsolation(audited + "unparseable line\n"),
    ).toThrow(unavailable);
    expect(() => verifyCodexFeatureIsolation("")).toThrow(unavailable);
  });

  test("an inexpressible isolation or unusable login stops before the task is sent", async () => {
    const dispatched: string[] = [];
    const refuses = async (
      runner: (request: WorkerProcessRequest) => Promise<string>,
    ) => {
      await expect(
        runtime(async (request) => {
          dispatched.push(request.args[0]!);
          return runner(request);
        }).execute(context, limits),
      ).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
      expect(dispatched).not.toContain("exec");
    };
    // The CLI rejects a feature key it does not know by exiting non-zero.
    await refuses(async (request) => {
      if (request.args[0] === "features")
        throw new WorkerRuntimeError("WORKER_FAILED");
      return inspection(request)!;
    });
    await refuses(async (request) =>
      request.args[0] === "features"
        ? codexFeatureListing
        : inspection(request)!,
    );
    await refuses(async (request) =>
      request.args[0] === "--version"
        ? "codex-cli 0.159.0\n"
        : inspection(request)!,
    );
    rmSync(join(operatorHome, "auth.json"));
    await refuses(async (request) => inspection(request)!);
    expect(dispatched.at(-1)).toBe("features");
    await expect(
      new CodexWorkerRuntime(
        "codex-test",
        async (request) => {
          dispatched.push(request.args[0]!);
          return inspection(request)!;
        },
        undefined,
        "win32",
        operatorHome,
      ).execute(context, limits),
    ).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
  });

  test("only an explicitly audited CLI version is accepted, before anything else runs", async () => {
    expect([...auditedCodexVersions]).toEqual(["0.160.0"]);
    const probes = async (versionOutput: string) => {
      const calls: string[] = [];
      const worker = runtime(async (request) => {
        calls.push(request.args[0]!);
        return request.args[0] === "--version"
          ? versionOutput
          : (inspection(request) ?? jsonl(events));
      });
      const result = await worker.execute(context, limits).then(
        (output) => output.summary,
        (error: unknown) => (error as WorkerRuntimeError).code,
      );
      return { result, calls };
    };
    for (const accepted of ["codex-cli 0.160.0\n", "codex-cli 0.160.0"])
      expect(await probes(accepted)).toEqual({
        result: "Review",
        calls: ["--version", "features", "exec"],
      });
    for (const rejected of [
      // Older.
      "codex-cli 0.159.0\n",
      "codex-cli 0.159.9\n",
      "codex-cli 0.16.0\n",
      // Newer patch, minor and major: unaudited until added.
      "codex-cli 0.160.1\n",
      "codex-cli 0.161.0\n",
      "codex-cli 1.0.0\n",
      "codex-cli 0.1600.0\n",
      // Pre-release, build and look-alike spellings.
      "codex-cli 0.160.0-alpha.1\n",
      "codex-cli 0.160.0+build\n",
      "codex-cli 0.160.0.1\n",
      "codex-cli 0.160\n",
      "codex-cli v0.160.0\n",
      "codex-cli 00.160.0\n",
      // Malformed output.
      "",
      "\n",
      "0.160.0\n",
      "codex 0.160.0\n",
      "codex-cli\n",
      "codex-cli  0.160.0\n",
      " codex-cli 0.160.0\n",
      "codex-cli 0.160.0 (extra)\n",
      "codex-cli 0.160.0\n\n",
      "codex-cli 0.160.0\ncodex-cli 0.161.0\n",
      "warning: something\ncodex-cli 0.160.0\n",
      "codex-cli >=0.160.0\n",
      "codex-cli ^0.160.0\n",
    ])
      expect(await probes(rejected), JSON.stringify(rejected)).toEqual({
        result: "WORKER_UNAVAILABLE",
        calls: ["--version"],
      });
  });

  test("routes only exact OpenAI models and never substitutes one", async () => {
    const worker = runtime(async (request) => inspection(request)!);
    const unsupported = { supported: false, code: "WORKER_MODEL_UNSUPPORTED" };
    expect(
      worker.supportsModel({ ...selection, providerId: "anthropic" }),
    ).toEqual(unsupported);
    expect(
      worker.supportsModel({ ...selection, maxOutputTokens: 100 }),
    ).toEqual(unsupported);
    expect(
      worker.supportsModel({ ...selection, reasoningEffort: "max" }),
    ).toEqual(unsupported);
    expect(
      worker.supportsModel({ ...selection, model: 'x" --sandbox=none' }),
    ).toEqual(unsupported);
    expect(worker.supportsModel(selection)).toEqual({ supported: true });

    // --worker-model never replaces a persisted model, before any process.
    const calls: string[] = [];
    const pinned = runtime(async (request) => {
      calls.push(request.args[0]!);
      return inspection(request) ?? jsonl(events);
    }, "gpt-other");
    expect(pinned.supportsModel(selection)).toEqual({
      supported: false,
      code: "WORKER_MODEL_CONFLICT",
    });
    await expect(pinned.execute(context, limits)).rejects.toMatchObject({
      code: "WORKER_MODEL_CONFLICT",
    });
    await expect(
      pinned.execute(
        { ...context, model: { ...selection, maxOutputTokens: 100 } },
        limits,
      ),
    ).rejects.toMatchObject({ code: "WORKER_MODEL_UNSUPPORTED" });
    expect(calls).toEqual([]);

    // An unrouted run uses --worker-model; with neither, no model is claimed.
    const argsOf = async (model?: string) => {
      let args: readonly string[] = [];
      const { model: _unrouted, ...unrouted } = context;
      const output = await runtime(async (request) => {
        if (request.args[0] === "exec") args = request.args;
        return inspection(request) ?? jsonl(events);
      }, model).execute(unrouted, limits);
      return { args, output };
    };
    const explicit = await argsOf("gpt-other");
    expect(explicit.args[explicit.args.indexOf("--model") + 1]).toBe(
      "gpt-other",
    );
    expect(explicit.output.model).toBe("gpt-other");
    expect(explicit.args.join(" ")).not.toContain("model_reasoning_effort");
    const neither = await argsOf();
    expect(neither.args).not.toContain("--model");
    expect(neither.output.model).toBeNull();
  });

  test("accepts one completed turn with one final message and nothing else", () => {
    const notice = {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "Code Mode is unavailable because code-mode host is disabled.",
      },
    };
    // Real 0.160.0 output for a code-mode model: a notice before the turn.
    const real = [events[0]!, notice, ...events.slice(1)];
    expect(parseCodexWorkerOutput(jsonl(real), "gpt-5.6-sol")).toMatchObject({
      summary: "Review",
      sessionId: "thread-1",
      model: "gpt-5.6-sol",
    });
    // The model identity is the routed one, never what the output says.
    expect(
      parseCodexWorkerOutput(
        jsonl(
          events.map((event) =>
            event.type === "turn.completed"
              ? { ...event, model: "gpt-reported" }
              : event,
          ),
        ),
        undefined,
      ).model,
    ).toBeNull();

    const message = events[3]!;
    for (const item of [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "collab_tool_call",
      "todo_list",
      "image_view",
      "future_item",
    ])
      for (const type of ["item.started", "item.updated", "item.completed"])
        invalid([
          ...events.slice(0, 2),
          { type, item: { type: item } },
          message,
          events[4]!,
        ]);
    invalid([
      ...events.slice(0, 2),
      { type: "item.started", item: null },
      message,
      events[4]!,
    ]);
    invalid([
      ...events.slice(0, 2),
      { type: "item.started", item: { type: "error" } },
      message,
      events[4]!,
    ]);
    invalid([
      ...events.slice(0, 4),
      { type: "turn.failed", error: { message: "x" } },
    ]);
    invalid([
      ...events.slice(0, 4),
      { type: "error", message: "stream failed" },
      events[4]!,
    ]);
    invalid([...events.slice(0, 4), { type: "future.event" }, events[4]!]);
    invalid([
      ...events,
      { type: "item.completed", item: { type: "reasoning" } },
    ]);
    invalid([...events, events[1]!, message, events[4]!]);
    invalid([...events.slice(0, 4), message, events[4]!]);
    invalid(events.slice(1));
    invalid([events[0]!, ...events]);
    invalid([events[0]!, ...events.slice(2)]);
    invalid(events.slice(0, 4));
    invalid([...events.slice(0, 3), events[4]!]);
    invalid([
      { ...events[0]!, thread_id: "../../etc/passwd" },
      ...events.slice(1),
    ]);
    invalid([
      { ...events[0]!, thread_id: "x".repeat(129) },
      ...events.slice(1),
    ]);
    const answer = (text: string) =>
      invalid([
        ...events.slice(0, 3),
        { type: "item.completed", item: { type: "agent_message", text } },
        events[4]!,
      ]);
    answer("not json");
    answer(JSON.stringify({ summary: "s", content: "c", extra: true }));
    answer(JSON.stringify({ summary: " ", content: "c" }));
    answer(
      JSON.stringify({ summary: "s", content: "x".repeat(64 * 1024 + 1) }),
    );
    expect(() => parseCodexWorkerOutput("", undefined)).toThrow();
    expect(() => parseCodexWorkerOutput("[]", undefined)).toThrow();
  });

  test("malformed usage is unknown and never becomes cost evidence", () => {
    for (const usage of [
      undefined,
      null,
      "10",
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1.5, output_tokens: 2 },
      { input_tokens: "1", output_tokens: 2 },
      { input_tokens: 1 },
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 },
    ]) {
      const output = parseCodexWorkerOutput(
        jsonl([
          ...events.slice(0, 4),
          { type: "turn.completed", usage, total_cost_usd: 0.01 },
        ]),
        selection.model,
      );
      expect(output.usage).toBeNull();
      expect(output.estimatedCostUsd).toBeNull();
      expect(output.metering).toBeUndefined();
    }
  });
});
