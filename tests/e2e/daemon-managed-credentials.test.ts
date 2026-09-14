import { expect, test, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRuntime } from "../helpers/run-runtime.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CredentialInput } from "../../apps/cli/src/credential-cli.ts";
import { CredentialGatewayModelProviders } from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { ModelProviderRegistry } from "@ai-office/llm-gateway/model-provider-registry.ts";
import { defaultModelProviderDescriptors } from "@ai-office/llm-gateway/model-ref.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";
import { loadProviderCredentials } from "@ai-office/llm-gateway/provider-credentials.ts";

const managedSecret = `aio-test-secret-${randomBytes(12).toString("hex")}`;
const ambientSecret = `aio-test-ambient-${randomBytes(12).toString("hex")}`;
const anthropicSecret = `aio-test-anthropic-${randomBytes(12).toString("hex")}`;

/** Console and standard stream output of the in-process Runtime while enabled. */
function captureDiagnostics(): { output: () => string; restore: () => void } {
  const lines: string[] = [];
  const record = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  const spies = [
    ...(["error", "log", "warn", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    ),
    ...[process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }),
    ),
  ];
  return {
    output: () => lines.join("\n"),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Credential-derived forms that must never appear in diagnostics. */
function credentialDerivedForms(value: string): string[] {
  const sha256 = createHash("sha256").update(value).digest("hex");
  return [value, sha256, sha256.slice(0, 12), value.slice(-8)];
}

const routing = `schema_version: 1
profiles:
  economical: { model: "openai:economy-model", reasoning_effort: low, max_output_tokens: 2000 }
  balanced: { model: "openai:economy-model", reasoning_effort: medium, max_output_tokens: 2000 }
  high_reasoning: { model: "openai:reasoning-model", reasoning_effort: high, max_output_tokens: 4000 }
`;

const stdin = (value: string): CredentialInput => ({
  isTTY: false,
  read: async () => Buffer.from(value),
});

/**
 * The default gateway composition over the managed credential source, with
 * only the vendor HTTP transport replaced. The registry receives credentials
 * from the source, exactly as the Runtime composition root passes them.
 */
function fakeVendorGateway(runtimeHome: string, debug = false) {
  /** Credential names each provider construction received, by provider. */
  const constructed: {
    providerId: string;
    names: string[];
    values: string[];
  }[] = [];
  const requests: {
    authorization: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    return Response.json({
      id: `resp_${requests.length}`,
      model: body.model,
      status: "completed",
      output_text: JSON.stringify({
        summary: "Plan",
        content: "Gateway draft",
      }),
      usage: { input_tokens: 1000, output_tokens: 250 },
    });
  };
  const openai = defaultModelProviderDescriptors.find(
    (value) => value.providerId === "openai",
  )!;
  const gatewayProviders = new CredentialGatewayModelProviders(
    loadProviderCredentials(process.env, { runtimeHome }),
    {
      debug,
      createRegistry: () =>
        new ModelProviderRegistry([
          {
            ...openai,
            create: (_model, environment) => {
              const names = Object.keys(environment)
                .filter((name) => name.endsWith("_API_KEY"))
                .sort();
              constructed.push({
                providerId: "openai",
                names,
                values: names.map((name) => environment[name]!),
              });
              return new OpenAiResponsesProvider(
                environment.OPENAI_API_KEY!,
                "https://provider.test/v1/responses",
                fetcher,
              );
            },
          },
        ]),
    },
  );
  return { requests, constructed, gatewayProviders };
}

function databaseBytesContain(directory: string, value: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.includes(".sqlite"))
    .filter((name) => readFileSync(join(directory, name)).includes(value));
}

test("a managed Runtime executes a gateway run with its Runtime home credential and leaks it nowhere", async () => {
  const names = [
    "AI_OFFICE_MODEL_ROUTING_SOURCE",
    "AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE",
    "AI_OFFICE_DEBUG_LLM",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const r = await runRuntime();
  const runtimeHome = join(r.root, ".ai-office");
  const cli = async (args: string[], input?: CredentialInput) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runDaemonCli(args, {
      projectRoot: r.root,
      socketPath: r.socketPath,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      ...(input === undefined ? {} : { credentialInput: input }),
    });
    return { exitCode, stdout, stderr };
  };
  const outputs: unknown[] = [];
  let diagnostics: ReturnType<typeof captureDiagnostics> | undefined;
  try {
    const stored = await cli(
      ["credential", "set", "OPENAI_API_KEY"],
      stdin(`${managedSecret}\n`),
    );
    expect(stored, JSON.stringify(stored)).toMatchObject({ exitCode: 0 });
    outputs.push(stored);
    const storedAnthropic = await cli(
      ["credential", "set", "ANTHROPIC_API_KEY"],
      stdin(anthropicSecret),
    );
    expect(storedAnthropic.exitCode).toBe(0);
    outputs.push(storedAnthropic);
    writeFileSync(join(runtimeHome, "model-routing.yaml"), routing);

    // What a generated service definition sets, plus an ambient key and debug
    // flag a service manager environment might still carry.
    process.env.AI_OFFICE_MODEL_ROUTING_SOURCE = "runtime_home";
    process.env.AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE = "runtime_home";
    process.env.AI_OFFICE_DEBUG_LLM = "1";
    process.env.OPENAI_API_KEY = ambientSecret;
    delete process.env.ANTHROPIC_API_KEY;
    diagnostics = captureDiagnostics();
    const vendor = fakeVendorGateway(
      runtimeHome,
      process.env.AI_OFFICE_DEBUG_LLM === "1",
    );
    await r.restart({ gatewayProviders: vendor.gatewayProviders });

    expect(
      (
        await r.command([
          "pricing:set",
          "--provider",
          "openai",
          "--model",
          "reasoning-model",
          "--currency",
          "USD",
          "--input",
          "1000000",
          "--cached-input",
          "500000",
          "--output",
          "4000000",
          "--reasoning",
          "4000000",
        ])
      ).exitCode,
    ).toBe(0);
    const scheduled = await r.schedule(await r.task());
    expect(scheduled.exitCode).toBe(0);
    const runId = scheduled.stdout[0]!.replace("Agent run scheduled: ", "");

    // model:check comes from the Runtime's own default composition.
    const checkJson = await r.command([
      "model:check",
      "--project",
      r.projectId,
      "--json",
    ]);
    const check = JSON.parse(checkJson.stdout[0]!) as {
      credentialSource: string;
      providers: Record<string, unknown>[];
      findings: { code: string; subject: string }[];
    };
    expect(check.credentialSource).toBe("managed");
    expect(check.providers).toEqual([
      {
        providerId: "openai",
        supported: true,
        gatewayExecution: true,
        missingCredentials: [],
        credentials: [
          {
            name: "OPENAI_API_KEY",
            state: "present",
            origin: "runtime_home",
            issue: null,
          },
        ],
      },
    ]);
    expect(check.findings).toContainEqual(
      expect.objectContaining({
        code: "MANAGED_ENVIRONMENT_IGNORED",
        subject: "OPENAI_API_KEY",
      }),
    );
    const checkHuman = await r.command(["model:check"]);
    expect(checkHuman.stdout).toContain(
      "  OPENAI_API_KEY: present (runtime_home)",
    );
    expect(checkHuman.stdout).toContain(
      "Provider credentials: credentials directory in AI_OFFICE_HOME only (managed service)",
    );
    outputs.push(checkJson, checkHuman);

    const tick = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
      "--json",
    ]);
    expect(tick, JSON.stringify(tick)).toMatchObject({ exitCode: 0 });
    outputs.push(tick);
    // The credential reaches only the fake vendor boundary, and it is the
    // Runtime home credential, never the ambient one.
    expect(vendor.requests).toHaveLength(1);
    expect(vendor.requests[0]!.authorization).toBe(`Bearer ${managedSecret}`);
    expect(vendor.requests[0]!.body).toMatchObject({
      model: "reasoning-model",
    });
    expect(JSON.stringify(vendor.requests[0]!.body)).not.toContain(
      managedSecret,
    );
    // The OpenAI provider was constructed with its own credential only; the
    // Anthropic credential never crossed into it.
    expect(vendor.constructed).toEqual([
      {
        providerId: "openai",
        names: ["OPENAI_API_KEY"],
        values: [managedSecret],
      },
    ]);
    expect(JSON.stringify(vendor.requests)).not.toContain(anthropicSecret);

    const shown = await r.command([
      "run:show",
      "--project",
      r.projectId,
      "--run",
      runId,
      "--json",
    ]);
    expect(JSON.parse(shown.stdout[0]!)).toMatchObject({
      run: { status: "completed" },
      model: {
        status: "resolved",
        selection: {
          modelRef: "openai:reasoning-model",
          source: "role_policy",
        },
      },
      usage: { metering: { kind: "gateway", actualMicros: "2000" } },
    });
    outputs.push(
      shown,
      await r.command(["run:show", "--project", r.projectId, "--run", runId]),
    );
    outputs.push(await r.command(["credential", "status", "--json"]));
    outputs.push(await r.command(["credential", "status"]));

    const exported = await r.command([
      "project:export",
      "--project",
      r.projectId,
    ]);
    expect(exported.exitCode).toBe(0);
    outputs.push(exported);
    const archive = join(r.root, "backup.aioffice");
    const backup = await r.command([
      "project:backup",
      "--project",
      r.projectId,
      "--output",
      archive,
      "--json",
    ]);
    expect(backup, JSON.stringify(backup)).toMatchObject({ exitCode: 0 });
    outputs.push(backup);
    expect(existsSync(archive)).toBe(true);
    const backupBytes = readFileSync(archive);

    const readModels: string[] = [];
    for (const path of [
      "/api/dashboard",
      "/api/projects",
      `/api/projects/${r.projectId}`,
      "/api/runs",
      `/api/runs/${runId}`,
      "/api/activity?limit=100",
    ]) {
      const response = await fetch(`http://localhost${path}`, {
        unix: r.socketPath,
        signal: AbortSignal.timeout(10_000),
      });
      readModels.push(`${response.status} ${await response.text()}`);
    }
    expect(readModels.some((body) => body.includes(runId))).toBe(true);

    const rendered = JSON.stringify(outputs);
    const debugOutput = diagnostics.output();
    diagnostics.restore();
    diagnostics = undefined;
    // Debug was active, and reported availability only.
    expect(debugOutput).toContain("[llm:config] credential_available=true");
    for (const value of [managedSecret, ambientSecret, anthropicSecret])
      for (const derived of credentialDerivedForms(value))
        expect(debugOutput).not.toContain(derived);
    expect(debugOutput).not.toMatch(/api_key_length|fingerprint/u);
    expect(debugOutput).not.toContain(join(runtimeHome, "credentials"));
    for (const value of [managedSecret, ambientSecret, anthropicSecret]) {
      expect(rendered).not.toContain(value);
      expect(readModels.join("\n")).not.toContain(value);
      expect(backupBytes.includes(value)).toBe(false);
      expect(databaseBytesContain(runtimeHome, value)).toEqual([]);
    }
    expect(rendered).not.toContain(join(runtimeHome, "credentials"));
  } finally {
    diagnostics?.restore();
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await r.close();
  }
});

test("a managed Runtime with a malformed credential refuses gateway runs before any request", async () => {
  const names = [
    "AI_OFFICE_MODEL_ROUTING_SOURCE",
    "AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE",
    "OPENAI_API_KEY",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const r = await runRuntime();
  const runtimeHome = join(r.root, ".ai-office");
  try {
    writeFileSync(join(runtimeHome, "model-routing.yaml"), routing);
    expect(
      await runDaemonCli(["credential", "set", "OPENAI_API_KEY"], {
        projectRoot: r.root,
        io: { stdout: () => undefined, stderr: () => undefined },
        credentialInput: stdin(managedSecret),
      }),
    ).toBe(0);
    writeFileSync(
      join(runtimeHome, "credentials", "OPENAI_API_KEY"),
      `${managedSecret}\0`,
    );
    process.env.AI_OFFICE_MODEL_ROUTING_SOURCE = "runtime_home";
    process.env.AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE = "runtime_home";
    process.env.OPENAI_API_KEY = ambientSecret;
    const vendor = fakeVendorGateway(runtimeHome);
    await r.restart({ gatewayProviders: vendor.gatewayProviders });
    expect((await r.schedule(await r.task())).exitCode).toBe(0);

    const check = await r.command(["model:check"]);
    expect(check.stdout).toContain(
      "  OPENAI_API_KEY: invalid (runtime_home) CREDENTIAL_MALFORMED",
    );
    const refused = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain(
      "the Runtime host has no usable OPENAI_API_KEY",
    );
    expect(vendor.requests).toEqual([]);
    for (const value of [managedSecret, ambientSecret])
      expect(JSON.stringify([check, refused])).not.toContain(value);
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await r.close();
  }
});

test("a foreground Runtime never uses the Runtime home credential configured for the managed Runtime", async () => {
  const names = [
    "AI_OFFICE_MODEL_ROUTING_SOURCE",
    "AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE",
    "OPENAI_API_KEY",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  const r = await runRuntime();
  const runtimeHome = join(r.root, ".ai-office");
  try {
    writeFileSync(join(runtimeHome, "model-routing.yaml"), routing);
    expect(
      await runDaemonCli(["credential", "set", "OPENAI_API_KEY"], {
        projectRoot: r.root,
        io: { stdout: () => undefined, stderr: () => undefined },
        credentialInput: stdin(managedSecret),
      }),
    ).toBe(0);
    process.env.AI_OFFICE_MODEL_ROUTING_SOURCE = "runtime_home";
    // Foreground: no credential source marker and no environment credential.
    delete process.env.AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE;
    delete process.env.OPENAI_API_KEY;
    const vendor = fakeVendorGateway(runtimeHome);
    await r.restart({ gatewayProviders: vendor.gatewayProviders });
    expect((await r.schedule(await r.task())).exitCode).toBe(0);

    const check = await r.command(["model:check", "--json"]);
    const report = JSON.parse(check.stdout[0]!) as {
      credentialSource: string;
      providers: { credentials: Record<string, unknown>[] }[];
    };
    expect(report.credentialSource).toBe("foreground");
    expect(report.providers[0]!.credentials).toEqual([
      { name: "OPENAI_API_KEY", state: "missing", origin: null, issue: null },
    ]);
    const human = await r.command(["model:check"]);
    expect(human.stdout).toContain("  OPENAI_API_KEY: missing");
    expect(human.stdout).toContain(
      "Provider credentials: Runtime environment only (foreground; the credentials directory in AI_OFFICE_HOME is not read)",
    );
    const refused = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "gateway",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join(" ")).toContain(
      "the Runtime host has no usable OPENAI_API_KEY",
    );
    expect(vendor.requests).toEqual([]);
    expect(vendor.constructed).toEqual([]);
    expect(JSON.stringify([check, human, refused])).not.toContain(
      managedSecret,
    );
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await r.close();
  }
});
