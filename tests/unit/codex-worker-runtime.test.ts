import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
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
  auditedBoundedCodexModels,
  auditedCodexVersions,
  codexDisabledFeatures,
  codexRefreshBlockedUrl,
  parseCodexWorkerOutput,
  supportedPersonalPlanClaims,
  verifyCodexFeatureIsolation,
} from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import type { WorkerProcessRequest } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  codexFeatureListing,
  codexFeatureListingAfter,
  codexLogin,
  codexToken,
  createOperatorCodexHome,
  managedBundlePlans,
} from "../helpers/fake-codex.ts";

const selection: AgentRunModelSelection = {
  policy: "balanced",
  profile: "balanced",
  modelRef: "openai:gpt-5.5",
  providerId: "openai",
  model: "gpt-5.5",
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
    now?: () => number,
  ) =>
    new CodexWorkerRuntime(
      "codex-test",
      runner,
      model,
      "posix",
      operatorHome,
      now,
    );

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
    expect(request.args).toContain("project_root_markers=[]");
    // The feature probe runs under the same flags and overrides as the task.
    const overrides = (args: readonly string[]) =>
      args.filter(
        (value, index) =>
          value === "--disable" ||
          value === "--config" ||
          ["--disable", "--config"].includes(args[index - 1]!),
      );
    expect(overrides(calls[1]!.args)).toEqual(
      overrides(request.args)
        .filter((value) => !value.startsWith("model_reasoning_effort="))
        .slice(0, overrides(calls[1]!.args).length),
    );
    expect(calls[1]!.args).toContain("project_root_markers=[]");
    expect(value("--model")).toBe("gpt-5.5");
    expect(request.args).toContain('model_reasoning_effort="high"');
    expect(request.input).toContain("Review evidence");
    // The client still offers `apply_patch`, so the prompt must not claim a
    // tool-free worker; it forbids the use instead.
    expect(request.input).not.toMatch(/You have no .*tools/);
    expect(request.input).toContain(
      "Do not inspect or modify host files and do not call editing or other tools",
    );

    // Every process, including the probes, gets its own private homes.
    for (const call of calls) {
      expect(Object.keys(call.env!).sort()).toEqual([
        "CODEX_HOME",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
        "HOME",
        "PATH",
      ]);
      expect(call.env!.CODEX_REFRESH_TOKEN_URL_OVERRIDE).toBe(
        "http://127.0.0.1:0/ai-office-refresh-disabled",
      );
      expect(call.env!.CODEX_HOME).not.toBe(operatorHome);
      expect(call.env!.HOME).not.toBe(homedir());
      expect(existsSync(call.env!.CODEX_HOME!)).toBe(false);
      expect(existsSync(call.cwd)).toBe(false);
    }
    expect(isolatedEntries).toEqual(["auth.json"]);
    expect(output).toMatchObject({
      summary: "Review",
      content: "Evidence checked",
      model: "gpt-5.5",
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
    // A version probe that fails or cannot start is unavailable, not failed.
    await refuses(async (request) => {
      if (request.args[0] === "--version")
        throw new WorkerRuntimeError("WORKER_FAILED");
      return inspection(request)!;
    });
    await refuses(async (request) =>
      request.args[0] === "--version"
        ? "codex-cli 0.159.0\n"
        : inspection(request)!,
    );
    // A missing login is refused before any process, the probes included.
    rmSync(join(operatorHome, "auth.json"));
    const before = dispatched.length;
    await refuses(async (request) => inspection(request)!);
    expect(dispatched).toHaveLength(before);
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

  test("only a ChatGPT login of an audited personal plan is admitted, before any Codex process", async () => {
    expect([...supportedPersonalPlanClaims]).toEqual([
      "free",
      "go",
      "plus",
      "pro",
      "prolite",
      "promax",
    ]);
    const auth = join(operatorHome, "auth.json");
    const attempt = async (login: string) => {
      writeFileSync(auth, login, { mode: 0o600 });
      const calls: string[] = [];
      const runner = async (request: WorkerProcessRequest) => {
        calls.push(request.args[0]!);
        return inspection(request) ?? jsonl(events);
      };
      const outcome = (work: Promise<unknown>) =>
        work.then(
          () => "admitted",
          (error: unknown) => (error as WorkerRuntimeError).code,
        );
      // Both entry points: the executor inspects before it executes.
      const inspected = await outcome(runtime(runner).inspect());
      const probes = [...calls];
      calls.length = 0;
      const executed = await outcome(runtime(runner).execute(context, limits));
      return { inspected, probes, executed, calls };
    };
    const admitted = {
      inspected: "admitted",
      probes: ["--version", "features"],
      executed: "admitted",
      calls: ["--version", "features", "exec"],
    };
    const refused = {
      inspected: "WORKER_UNAVAILABLE",
      probes: [],
      executed: "WORKER_UNAVAILABLE",
      calls: [],
    };
    for (const plan of supportedPersonalPlanClaims)
      expect(await attempt(codexLogin(plan, "s")), plan).toEqual(admitted);

    // Every other class, known or not, is refused with zero Codex processes.
    for (const plan of [
      "team",
      "business",
      "self_serve_business_prolite",
      "self_serve_business_usage_based",
      "ent26",
      "enterprise",
      "enterprise_cbp_automation",
      "enterprise_cbp_usage_based",
      "hc",
      "edu",
      "education",
      "edu_pro",
      ...managedBundlePlans,
      "unknown",
      "plan_of_2027",
      "Pro",
      "PRO",
      " pro",
      "pro ",
      "pro\n",
      "",
      undefined,
      null,
      5,
      true,
      ["pro"],
      { plan: "pro" },
    ])
      expect(await attempt(codexLogin(plan, "s")), String(plan)).toEqual(
        refused,
      );

    // Malformed tokens and claims, and logins that are not plain ChatGPT.
    const login = (change: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(codexLogin("pro", "s")) as Record<
        string,
        unknown
      >;
      change(value);
      return JSON.stringify(value);
    };
    const tokens = (change: (value: Record<string, unknown>) => void) =>
      login((value) => change(value.tokens as Record<string, unknown>));
    const encoded = (value: string) => Buffer.from(value).toString("base64url");
    const pro = codexToken("pro");
    for (const [label, text] of [
      ["id token missing", tokens((t) => delete t.id_token)],
      ["id token not a string", tokens((t) => (t.id_token = 5))],
      ["id token opaque", tokens((t) => (t.id_token = "opaque"))],
      ["id token two parts", tokens((t) => (t.id_token = "a.b"))],
      ["id token four parts", tokens((t) => (t.id_token = `${pro}.x`))],
      ["payload not base64url", tokens((t) => (t.id_token = "a.b+c/d=.c"))],
      ["payload empty", tokens((t) => (t.id_token = "a..c"))],
      [
        "payload not JSON",
        tokens((t) => (t.id_token = `a.${encoded("not json")}.c`)),
      ],
      [
        "payload an array",
        tokens((t) => (t.id_token = `a.${encoded('["pro"]')}.c`)),
      ],
      [
        "claim not an object",
        tokens(
          (t) =>
            (t.id_token = `a.${encoded('{"https://api.openai.com/auth":"pro"}')}.c`),
        ),
      ],
      [
        "plan outside the claim",
        tokens(
          (t) => (t.id_token = `a.${encoded('{"chatgpt_plan_type":"pro"}')}.c`),
        ),
      ],
      // The two tokens must agree: neither may name another class.
      [
        "access token of a managed plan",
        tokens((t) => (t.access_token = codexToken("enterprise"))),
      ],
      [
        "id token of a managed plan",
        tokens((t) => (t.id_token = codexToken("enterprise"))),
      ],
      [
        "access token of another personal plan",
        tokens((t) => (t.access_token = codexToken("plus"))),
      ],
      ["access token missing", tokens((t) => delete t.access_token)],
      ["access token opaque", tokens((t) => (t.access_token = "opaque"))],
      ["tokens missing", login((value) => delete value.tokens)],
      ["tokens not an object", login((value) => (value.tokens = "x"))],
      // API-key and other credential kinds are separate trust models.
      ["API-key login", JSON.stringify({ OPENAI_API_KEY: "sk-key" })],
      [
        "API-key auth mode",
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-key" }),
      ],
      [
        "API key next to tokens",
        login((value) => (value.OPENAI_API_KEY = "sk-key")),
      ],
      ["auth mode missing", login((value) => delete value.auth_mode)],
      ["auth mode unknown", login((value) => (value.auth_mode = "sso"))],
      [
        "personal access token",
        login((value) => (value.personal_access_token = "pat")),
      ],
      ["agent identity", login((value) => (value.agent_identity = {}))],
      ["bedrock key", login((value) => (value.bedrock_api_key = {}))],
      ["unknown field", login((value) => (value.future_credential = 1))],
    ] as const)
      expect(await attempt(text), label).toEqual(refused);
  });

  test("an access token must stay outside the refresh window for the whole bounded run", async () => {
    expect(codexRefreshBlockedUrl).toBe(
      "http://127.0.0.1:0/ai-office-refresh-disabled",
    );
    // A fixed clock: 2027-01-15T08:00:00Z. The run may take ten minutes.
    const nowMs = 1_800_000_000_000;
    const now = nowMs / 1000;
    const run = { ...limits, timeoutMs: 600_000 };
    const refreshWindow = 300;
    const clockSkew = 60;
    const auth = join(operatorHome, "auth.json");
    const attempt = async (exp: unknown) => {
      writeFileSync(auth, codexLogin("plus", "s", exp), { mode: 0o600 });
      const calls: string[] = [];
      const outcome = (work: Promise<unknown>) =>
        work.then(
          () => "admitted",
          (error: unknown) => (error as WorkerRuntimeError).code,
        );
      const worker = () =>
        runtime(
          async (request) => {
            calls.push(request.args[0]!);
            return inspection(request) ?? jsonl(events);
          },
          undefined,
          () => nowMs,
        );
      const inspected = await outcome(worker().inspect());
      calls.length = 0;
      const executed = await outcome(worker().execute(context, run));
      return { inspected, executed, calls };
    };
    const admitted = {
      inspected: "admitted",
      executed: "admitted",
      calls: ["--version", "features", "exec"],
    };
    // Refused before any Codex process, the unauthenticated probes included.
    const refused = {
      inspected: "WORKER_UNAVAILABLE",
      executed: "WORKER_UNAVAILABLE",
      calls: [],
    };
    // Usable now but not for the whole run: the probes run, the task is not sent.
    const tooShort = {
      inspected: "admitted",
      executed: "WORKER_UNAVAILABLE",
      calls: ["--version", "features"],
    };
    const needed = now + 600 + refreshWindow + clockSkew;

    expect(await attempt(needed + 1)).toEqual(admitted);
    expect(await attempt(4102444800)).toEqual(admitted);
    // exp > now + timeout + refresh window + clock skew is strict.
    expect(await attempt(needed)).toEqual(tooShort);
    expect(await attempt(needed - 1)).toEqual(tooShort);
    // Beyond the refresh window, shorter than the run.
    expect(await attempt(now + refreshWindow + clockSkew + 1)).toEqual(
      tooShort,
    );
    expect(await attempt(now + 600)).toEqual(tooShort);
    // Inside the refresh window, at it, and already expired.
    expect(await attempt(now + refreshWindow + clockSkew)).toEqual(refused);
    expect(await attempt(now + 200)).toEqual(refused);
    expect(await attempt(now)).toEqual(refused);
    expect(await attempt(now - 1)).toEqual(refused);
    expect(await attempt(now - 86400)).toEqual(refused);
    // Missing, non-numeric, malformed and absurd values.
    for (const exp of [
      null,
      "4102444800",
      "",
      true,
      [4102444800],
      { exp: 4102444800 },
      4102444800.5,
      0,
      -1,
      -4102444800,
      1e300,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 2,
      9_007_199_254_741,
    ])
      expect(await attempt(exp), JSON.stringify(exp)).toEqual(refused);
    // The largest value whose millisecond form is still exact is accepted.
    expect(await attempt(9_007_199_254_740)).toEqual(admitted);
  });

  test("the refresh block is fixed by the worker and never taken from the operator's environment", async () => {
    const ambient = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
    process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE =
      "https://issuer.example.invalid/oauth/token";
    try {
      const seen: (string | undefined)[] = [];
      await runtime(async (request) => {
        seen.push(request.env!.CODEX_REFRESH_TOKEN_URL_OVERRIDE);
        return inspection(request) ?? jsonl(events);
      }).execute(context, limits);
      expect(seen).toEqual([
        codexRefreshBlockedUrl,
        codexRefreshBlockedUrl,
        codexRefreshBlockedUrl,
      ]);
    } finally {
      if (ambient === undefined)
        delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
      else process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = ambient;
    }
  });

  test("only audited bounded single-agent models run, and none is ever substituted", async () => {
    expect([...auditedBoundedCodexModels]).toEqual(["gpt-5.5"]);
    // Classification source: `codex debug models` of codex-cli 0.160.0.
    const multiAgentV2 = [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-daybreak-blue-latest",
      "gpt-daybreak-red-latest",
    ];
    const multiAgentV1 = ["gpt-5.6-luna", "codex-auto-review"];
    const unaudited = [
      "gpt-5.5-pro",
      "gpt-5.5-mini",
      "gpt-5.6",
      "gpt-5",
      "gpt-7-sol",
      "o3",
      "plan-of-2027",
      "GPT-5.5",
      "Gpt-5.5",
      " gpt-5.5",
      "gpt-5.5 ",
      "gpt-5.5\n",
      "gpt-5\u200b.5",
      "gpt-5.5/../gpt-6-sol",
      'gpt-5.5" --model gpt-6-sol',
      "--model",
      "",
    ];
    const calls: string[] = [];
    const runner = async (request: WorkerProcessRequest) => {
      calls.push(request.args[0]!);
      return inspection(request) ?? jsonl(events);
    };
    const unsupported = { supported: false, code: "WORKER_MODEL_UNSUPPORTED" };
    const { model: _route, ...unrouted } = context;

    for (const model of [...multiAgentV2, ...multiAgentV1, ...unaudited]) {
      const routed = { ...selection, model, modelRef: `openai:${model}` };
      // Admission (what run:tick asks before starting anything) refuses it,
      expect(runtime(runner).supportsModel(routed), model).toEqual(unsupported);
      // a routed run refuses it,
      await expect(
        runtime(runner).execute({ ...context, model: routed }, limits),
        model,
      ).rejects.toMatchObject({ code: "WORKER_MODEL_UNSUPPORTED" });
      // and so does an unrouted run naming it with --worker-model.
      await expect(
        runtime(runner, model).execute(unrouted, limits),
        model,
      ).rejects.toMatchObject({ code: "WORKER_MODEL_UNSUPPORTED" });
    }
    // A run with no model is never handed to Codex's own default.
    await expect(
      runtime(runner).execute(unrouted, limits),
    ).rejects.toMatchObject({ code: "WORKER_MODEL_REQUIRED" });
    // None of the refusals started a Codex process, the probes included.
    expect(calls).toEqual([]);

    const worker = runtime(runner);
    expect(worker.supportsModel(selection)).toEqual({ supported: true });
    expect(
      worker.supportsModel({ ...selection, providerId: "anthropic" }),
    ).toEqual(unsupported);
    expect(
      worker.supportsModel({ ...selection, maxOutputTokens: 100 }),
    ).toEqual(unsupported);
    expect(
      worker.supportsModel({ ...selection, reasoningEffort: "max" }),
    ).toEqual(unsupported);

    // --worker-model never replaces a persisted model, before any process.
    const pinned = runtime(runner, "gpt-6-sol");
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

    // Each admitted model reaches the client exactly as routed, once.
    for (const model of auditedBoundedCodexModels) {
      let args: readonly string[] = [];
      calls.length = 0;
      const output = await runtime(async (request) => {
        if (request.args[0] === "exec") args = request.args;
        return runner(request);
      }).execute({ ...context, model: { ...selection, model } }, limits);
      expect(args.filter((value) => value === "--model")).toHaveLength(1);
      expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(args).toContain('model_reasoning_effort="high"');
      expect(args).toContain("agents.enabled=false");
      expect(output.model).toBe(model);
      expect(calls).toEqual(["--version", "features", "exec"]);
    }
    // An unrouted run named with --worker-model carries no effort override.
    let unroutedArgs: readonly string[] = [];
    const output = await runtime(async (request) => {
      if (request.args[0] === "exec") unroutedArgs = request.args;
      return runner(request);
    }, "gpt-5.5").execute(unrouted, limits);
    expect(unroutedArgs[unroutedArgs.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(unroutedArgs.join(" ")).not.toContain("model_reasoning_effort");
    expect(output.model).toBe("gpt-5.5");
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
    expect(parseCodexWorkerOutput(jsonl(real), "gpt-5.5")).toMatchObject({
      summary: "Review",
      sessionId: "thread-1",
      model: "gpt-5.5",
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

    // The retry notice of a stream Codex then recovers is not a failure.
    const reconnecting = (text: string) => ({ type: "error", message: text });
    const retried = [
      ...events.slice(0, 2),
      reconnecting(
        "Reconnecting... 1/5 (stream disconnected before completion: x)",
      ),
      reconnecting("Reconnecting... 5/5"),
      ...events.slice(2),
    ];
    expect(parseCodexWorkerOutput(jsonl(retried), "m")).toMatchObject({
      summary: "Review",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    // It never replaces completion: no message, no completed turn, a failed
    // turn and a notice after completion all still fail.
    invalid(retried.slice(0, -1));
    invalid(retried.filter((event) => event !== events[3]));
    invalid([
      ...retried.slice(0, -1),
      { type: "turn.failed", error: { message: "gave up" } },
    ]);
    invalid([...retried, reconnecting("Reconnecting... 1/5")]);
    // Only that exact notice is tolerated; any other error is fatal.
    for (const text of [
      "stream failed",
      "stream disconnected before completion",
      "reconnecting... 1/5",
      "Reconnecting...",
      "Reconnecting... 0/5",
      "Reconnecting... 1/5: sandbox disabled",
      " Reconnecting... 1/5",
      "error: Reconnecting... 1/5",
      "Reconnecting... x/5",
      "Reconnecting... 1/",
    ])
      invalid([...events.slice(0, 2), reconnecting(text), ...events.slice(2)]);
    invalid([
      ...events.slice(0, 2),
      { type: "error", message: 5 },
      ...events.slice(2),
    ]);
    invalid([...events.slice(0, 2), { type: "error" }, ...events.slice(2)]);

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
