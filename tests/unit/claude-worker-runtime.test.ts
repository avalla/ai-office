import { describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClaudeWorkerRuntime,
  parseClaudeWorkerOutput,
  runWorkerProcess,
  type WorkerProcessRequest,
} from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  workerLimits,
  type WorkerContext,
} from "@ai-office/application/ports/worker-runtime.port.ts";
import { projectWorkerOutput } from "@ai-office/application/read-models/worker-output.ts";

const context: WorkerContext = {
  schemaVersion: 1,
  projectId: "p",
  runId: "r",
  task: {
    id: "t",
    title: "Explain a tradeoff",
    description: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  agent: {
    id: "a",
    name: "Architect",
    roleId: "role",
    roleKey: "architect",
    roleVersion: 1,
  },
  stage: null,
  memory: { results: [] },
};
const limits = {
  timeoutMs: 1000,
  maxTurns: 2,
  maxEstimatedCostUsd: "0.100000",
};
const envelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: {
    summary: "A tradeoff",
    content: "<script>untrusted</script>\nAn analysis",
  },
  session_id: "session-1",
  usage: { input_tokens: 12, output_tokens: 24 },
  modelUsage: { "test-model": {} },
  total_cost_usd: 0.0123,
  hidden_reasoning: "must not be published",
  api_key: "must not be published",
};
const help =
  "--safe-mode --tools --disallowedTools --strict-mcp-config --setting-sources --no-session-persistence --json-schema --disable-slash-commands";

describe("bounded Claude worker", () => {
  test("pins a supported CLI and executes only explicit input with model-visible tools disabled", async () => {
    const calls: WorkerProcessRequest[] = [];
    const runtime = new ClaudeWorkerRuntime(
      "test-claude",
      async (request) => {
        calls.push(request);
        expect(existsSync(request.cwd)).toBe(true);
        if (request.args[0] === "--version") return "2.1.236 (Claude Code)\n";
        if (request.args[0] === "--help") return help;
        return JSON.stringify(envelope);
      },
      "test-model",
    );
    expect(await runtime.inspect()).toEqual({ version: "2.1.236" });
    const result = await runtime.execute(context, limits);
    expect(calls).toHaveLength(3);
    const request = calls[2]!;
    const value = (flag: string) =>
      request.args[request.args.indexOf(flag) + 1];
    expect(value("--tools")).toBe("");
    expect(value("--disallowedTools")).toBe("mcp__*");
    expect(value("--setting-sources")).toBe("");
    expect(value("--mcp-config")).toBe('{"mcpServers":{}}');
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--max-turns")).toBe("2");
    expect(value("--max-budget-usd")).toBe("0.100000");
    expect(value("--model")).toBe("test-model");
    expect(request.args).not.toContain("--dangerously-skip-permissions");
    expect(JSON.parse(request.input)).toEqual(context);
    expect(calls.every((call) => !existsSync(call.cwd))).toBe(true);
    expect(result).toMatchObject({
      sessionId: "session-1",
      model: "test-model",
      usage: { inputTokens: 12, outputTokens: 24 },
      estimatedCostUsd: 0.0123,
    });
    expect(JSON.stringify(result)).not.toContain("must not be published");
    expect(
      projectWorkerOutput({ workerOutput: result, secret: "hidden" }),
    ).toEqual(result);
    expect(existsSync(calls[2]!.cwd)).toBe(false);
  });

  test("refuses clients without customization isolation before task dispatch", async () => {
    const calls: WorkerProcessRequest[] = [];
    const runtime = new ClaudeWorkerRuntime("test", async (request) => {
      calls.push(request);
      return request.args[0] === "--version"
        ? "2.0.0 (Claude Code)"
        : "--tools";
    });
    await expect(runtime.execute(context, limits)).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
  });

  test.each([
    "secret raw error",
    JSON.stringify({ ...envelope, is_error: true }),
    JSON.stringify({ ...envelope, subtype: "error_max_turns" }),
    JSON.stringify({
      ...envelope,
      structured_output: { summary: "", content: "text" },
    }),
    JSON.stringify({
      ...envelope,
      structured_output: {
        summary: "ok",
        content: "x".repeat(workerLimits.contentLength + 1),
      },
    }),
  ])(
    "rejects malformed or unsuccessful output without exposing the envelope",
    (value) => {
      expect(() => parseClaudeWorkerOutput(value)).toThrow(
        "The worker did not return a supported result.",
      );
    },
  );

  test("missing usage remains unknown rather than zero", () => {
    expect(
      parseClaudeWorkerOutput(
        JSON.stringify({
          ...envelope,
          usage: { input_tokens: -1 },
          total_cost_usd: null,
          modelUsage: {},
        }),
      ),
    ).toMatchObject({ usage: null, estimatedCostUsd: null, model: null });
  });

  test("the subprocess boundary bounds output and redacts raw failures", async () => {
    const request = {
      executable: process.execPath,
      cwd: tmpdir(),
      input: "",
      timeoutMs: 5000,
    };
    await expect(
      runWorkerProcess({
        ...request,
        args: ["-e", "console.error('secret credential'); process.exit(1)"],
      }),
    ).rejects.toMatchObject({
      code: "WORKER_FAILED",
      message:
        "The worker failed. Check its local authentication and configuration.",
    });
    await expect(
      runWorkerProcess({
        ...request,
        args: [
          "-e",
          `process.stdout.write('x'.repeat(${workerLimits.outputBytes + 1}))`,
        ],
      }),
    ).rejects.toMatchObject({ code: "WORKER_OUTPUT_TOO_LARGE" });
    expect(
      await runWorkerProcess({
        ...request,
        args: ["-e", "process.stdout.write('città 👩🏽‍💻')"],
      }),
    ).toBe("città 👩🏽‍💻");
  });

  test("deadline and cancellation stop the subprocess before returning", async () => {
    const request = {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      input: "",
      timeoutMs: 100,
    };
    await expect(runWorkerProcess(request)).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
    });
    const control = new AbortController();
    const execution = runWorkerProcess({
      ...request,
      timeoutMs: 5000,
      signal: control.signal,
    });
    control.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
  });

  test.skipIf(process.platform === "win32")(
    "POSIX cancellation kills a persistent grandchild and cleans the test directory",
    async () => {
    const root = mkdtempSync(join(tmpdir(), "ao-worker-tree-"));
    const pidFile = join(root, "grandchild.pid");
    try {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      await expect(
        runWorkerProcess({
          executable: process.execPath,
          args: ["-e", script],
          cwd: root,
          input: "",
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          break;
        }
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
    },
  );

  test.skipIf(process.platform === "win32")(
    "POSIX AbortSignal cancellation also kills the whole worker group",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ao-worker-abort-tree-"));
      const pidFile = join(root, "grandchild.pid");
      try {
        const script = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "setInterval(() => {}, 1000);",
        ].join(" ");
        const control = new AbortController();
        const execution = runWorkerProcess({
          executable: process.execPath,
          args: ["-e", script],
          cwd: root,
          input: "",
          timeoutMs: 5000,
          signal: control.signal,
        });
        for (let attempt = 0; attempt < 50 && !existsSync(pidFile); attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const pid = Number(readFileSync(pidFile, "utf8"));
        control.abort();
        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    },
  );
});
