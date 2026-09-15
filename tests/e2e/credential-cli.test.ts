import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CredentialInput } from "../../apps/cli/src/credential-cli.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";

const secret = `aio-test-secret-${randomBytes(12).toString("hex")}`;
const entryPoint = resolve("bin/ai-office.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function runtimeHome(): string {
  const root = mkdtempSync(join(tmpdir(), "ao-credential-cli-"));
  roots.push(root);
  return join(root, "home");
}

/** The linkable entry point with real stdin, as an operator runs it. */
function linked(home: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [entryPoint, ...args], {
    input: input ?? "",
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AI_OFFICE_HOME: home,
      AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "1",
    },
    timeout: 30_000,
  });
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    stdout: result.stdout,
  };
}

async function inProcess(home: string, args: string[], input: CredentialInput) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runRuntimeCli(args, {
    runtimePaths: resolveRuntimePaths({ mode: "user", runtimeHome: home }),
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    credentialInput: input,
  });
  return { exitCode, output: [...stdout, ...stderr].join("\n") };
}

test("credential set reads stdin, writes owner-only without the Runtime, and never prints the value", () => {
  const home = runtimeHome();
  const stored = linked(
    home,
    ["credential", "set", "OPENAI_API_KEY"],
    `${secret}\n`,
  );
  expect(stored.exitCode, stored.output).toBe(0);
  expect(stored.output).toContain("Credential OPENAI_API_KEY stored");
  expect(stored.output).toContain("Restart the Runtime");
  expect(stored.output).not.toContain(secret);
  expect(stored.output).not.toContain(join(home, "credentials"));

  const file = join(home, "credentials", "OPENAI_API_KEY");
  expect(statSync(home).mode & 0o077).toBe(0);
  expect(statSync(join(home, "credentials")).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe(secret);
  // No Runtime was started and no Runtime state was created by the write.
  expect(readdirSync(home).sort()).toEqual(["credentials"]);

  const status = linked(home, ["credential", "status", "--json"]);
  expect(status.exitCode, status.output).toBe(0);
  expect(JSON.parse(status.stdout)).toEqual({
    schemaVersion: 1,
    source: "runtime_home",
    credentials: [
      { name: "ANTHROPIC_API_KEY", state: "missing", issue: null },
      { name: "OPENAI_API_KEY", state: "present", issue: null },
    ],
  });
  const human = linked(home, ["credential", "status"]);
  expect(human.output).toContain("  OPENAI_API_KEY: present");
  for (const output of [status.output, human.output]) {
    expect(output).not.toContain(secret);
    expect(output).not.toContain(String(secret.length));
    expect(output).not.toContain(home);
  }

  const removed = linked(home, ["credential", "remove", "OPENAI_API_KEY"]);
  expect(removed.exitCode, removed.output).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(
    linked(home, ["credential", "remove", "OPENAI_API_KEY"]).output,
  ).toContain("is not configured");
});

test("a credential value is never accepted from arguments and never echoed", () => {
  const home = runtimeHome();
  for (const args of [
    ["credential", "set", "OPENAI_API_KEY", secret],
    ["credential", "set", secret],
    ["credential", "set", `--${secret}`],
    ["credential", secret],
    ["credential", "status", secret],
    ["credential", "remove", secret],
  ]) {
    const refused = linked(home, args, secret);
    expect(refused.exitCode, refused.output).toBe(1);
    expect(refused.output).not.toContain(secret);
  }
  expect(existsSync(join(home, "credentials"))).toBe(false);
});

test("credential set refuses a terminal, oversized or malformed input and writes nothing", async () => {
  const home = runtimeHome();
  const terminal = await inProcess(
    home,
    ["credential", "set", "OPENAI_API_KEY"],
    {
      isTTY: true,
      read: async () => {
        throw new Error("a terminal must not be read");
      },
    },
  );
  expect(terminal.exitCode).toBe(1);
  expect(terminal.output).toContain("refuses a terminal");

  for (const value of [
    "a".repeat(8192),
    `${secret} ${secret}`,
    "",
    `${secret}\0`,
  ]) {
    const refused = await inProcess(
      home,
      ["credential", "set", "OPENAI_API_KEY"],
      {
        isTTY: false,
        read: async () => Buffer.from(value),
      },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("CREDENTIAL_MALFORMED");
    expect(refused.output).not.toContain(secret);
  }
  expect(existsSync(join(home, "credentials", "OPENAI_API_KEY"))).toBe(false);
});

test("credential status reports an insecure credential by code without its value or path", () => {
  const home = runtimeHome();
  expect(
    linked(home, ["credential", "set", "OPENAI_API_KEY"], secret).exitCode,
  ).toBe(0);
  chmodSync(join(home, "credentials", "OPENAI_API_KEY"), 0o644);
  const status = linked(home, ["credential", "status"]);
  expect(status.exitCode).toBe(1);
  expect(status.output).toContain(
    "OPENAI_API_KEY: invalid CREDENTIAL_INSECURE_PERMISSIONS",
  );
  expect(status.output).not.toContain(secret);
  expect(status.output).not.toContain(home);
});

test("credential help documents stdin input, both service managers and restart", () => {
  const help = linked(runtimeHome(), ["credential", "--help"]);
  expect(help.exitCode).toBe(0);
  for (const text of [
    "reads the value from stdin (never from arguments)",
    "systemctl --user restart ai-office-runtime.service",
    "launchctl kickstart -k gui/$(id -u)/com.ai-office.runtime",
    "OPENAI_API_KEY",
  ])
    expect(help.stdout).toContain(text);
});
