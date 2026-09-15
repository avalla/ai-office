import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialGatewayModelProviders,
  EnvironmentGatewayModelProviders,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { loadProviderCredentials } from "@ai-office/llm-gateway/provider-credentials.ts";
import { writeRuntimeHomeCredential } from "@ai-office/llm-gateway/runtime-home-credential-store.ts";

const homes: string[] = [];
let savedDebug: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (savedDebug === undefined) delete process.env.AI_OFFICE_DEBUG_LLM;
  else process.env.AI_OFFICE_DEBUG_LLM = savedDebug;
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

/** A random sentinel; its length is fixed so a length token is recognizable. */
function sentinel(label: string): string {
  return `aio-debug-${label}-${randomBytes(20).toString("hex")}`;
}

/** Everything written to the console or the standard streams while enabled. */
function captureDiagnostics(): () => string {
  const lines: string[] = [];
  const record = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  for (const method of ["error", "log", "warn", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation(record);
  for (const stream of [process.stdout, process.stderr])
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  return () => lines.join("\n");
}

/** Asserts no form derived from `value` appears in the captured diagnostics. */
function expectNoCredentialDerivedData(output: string, value: string): void {
  const sha256 = createHash("sha256").update(value).digest("hex");
  for (const derived of [
    value,
    sha256,
    // The truncated fingerprint the previous debug output printed.
    sha256.slice(0, 12),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("hex"),
    value.slice(-8),
    value.slice(-4),
  ])
    expect(output).not.toContain(derived);
  // No numeric token equal to the value's length, once the pid is set aside.
  const withoutPid = output.replaceAll(`pid=${process.pid}`, "pid=<pid>");
  expect(withoutPid).not.toMatch(new RegExp(`\\b${value.length}\\b`, "u"));
  expect(withoutPid).not.toMatch(/length|fingerprint|sha256|prefix|suffix/iu);
  expect(output).not.toContain("credentials/");
}

describe("AI_OFFICE_DEBUG_LLM=1 never emits credential-derived data", () => {
  test("foreground environment credentials", async () => {
    const openai = sentinel("openai");
    const anthropic = sentinel("anthropic");
    const diagnostics = captureDiagnostics();
    const providers = new EnvironmentGatewayModelProviders({
      AI_OFFICE_DEBUG_LLM: "1",
      OPENAI_API_KEY: openai,
      ANTHROPIC_API_KEY: anthropic,
    });
    await providers.resolve("openai:gpt-5.4");
    await providers.resolve("anthropic:claude-model");

    const output = diagnostics();
    expect(output).toContain("[llm:config] credential_available=true");
    expect(output).toContain("provider=openai model=gpt-5.4");
    expect(output).toContain("provider=anthropic model=claude-model");
    for (const value of [openai, anthropic])
      expectNoCredentialDerivedData(output, value);
  });

  test("an ambient debug flag cannot make a managed file credential leak derived metadata", async () => {
    savedDebug = process.env.AI_OFFICE_DEBUG_LLM;
    process.env.AI_OFFICE_DEBUG_LLM = "1";
    const home = mkdtempSync(join(tmpdir(), "ao-credential-debug-"));
    homes.push(home);
    const openai = sentinel("openai");
    const anthropic = sentinel("anthropic");
    const ambient = sentinel("ambient");
    writeRuntimeHomeCredential(home, "OPENAI_API_KEY", Buffer.from(openai));
    writeRuntimeHomeCredential(
      home,
      "ANTHROPIC_API_KEY",
      Buffer.from(anthropic),
    );
    const diagnostics = captureDiagnostics();
    // Composed as the Runtime host composes it from a managed service
    // environment that also carries the debug flag and an ambient key.
    const credentials = loadProviderCredentials(
      {
        AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
        AI_OFFICE_DEBUG_LLM: process.env.AI_OFFICE_DEBUG_LLM,
        OPENAI_API_KEY: ambient,
      },
      { runtimeHome: home },
    );
    const providers = new CredentialGatewayModelProviders(credentials, {
      debug: process.env.AI_OFFICE_DEBUG_LLM === "1",
    });
    await providers.resolve("openai:gpt-5.4");
    await providers.resolve("anthropic:claude-model");

    const output = diagnostics();
    expect(output).toContain("[llm:config] credential_available=true");
    for (const value of [openai, anthropic, ambient])
      expectNoCredentialDerivedData(output, value);
    expect(output).not.toContain(home);
  });

  test("a managed Runtime without its credential reports only unavailability", async () => {
    const home = mkdtempSync(join(tmpdir(), "ao-credential-debug-"));
    homes.push(home);
    const ambient = sentinel("ambient");
    const diagnostics = captureDiagnostics();
    const providers = new CredentialGatewayModelProviders(
      loadProviderCredentials(
        {
          AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE: "runtime_home",
          OPENAI_API_KEY: ambient,
        },
        { runtimeHome: home },
      ),
      { debug: true },
    );
    await expect(providers.resolve("openai:gpt-5.4")).rejects.toThrow(
      "OPENAI_API_KEY",
    );
    const output = diagnostics();
    expect(output).toContain("[llm:config] credential_available=false");
    expectNoCredentialDerivedData(output, ambient);
  });
});
