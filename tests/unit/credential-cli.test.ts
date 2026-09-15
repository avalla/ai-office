import { afterEach, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBoundedInput,
  runCredentialCli,
  type CredentialInput,
} from "../../apps/cli/src/credential-cli.ts";
import {
  maximumProviderCredentialBytes,
  writeRuntimeHomeCredential,
} from "@ai-office/llm-gateway/runtime-home-credential-store.ts";

const secret = `aio-test-secret-${randomBytes(12).toString("hex")}`;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function runtimeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ao-credential-cli-unit-"));
  homes.push(home);
  return home;
}

async function cli(home: string, args: string[], input?: CredentialInput) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCredentialCli(args, {
    runtimeHome: home,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    ...(input === undefined ? {} : { input }),
  });
  return {
    exitCode,
    stdout,
    stderr,
    output: [...stdout, ...stderr].join("\n"),
  };
}

async function* chunks(
  ...values: (Uint8Array | string)[]
): AsyncGenerator<Uint8Array | string> {
  for (const value of values) yield value;
}

describe("bounded credential input", () => {
  const limit = maximumProviderCredentialBytes + 3;

  test("one very large chunk retains at most the bound plus one byte", async () => {
    const chunk = Buffer.alloc(16 * 1024 * 1024, "s");
    const read = await readBoundedInput(chunks(chunk), limit);
    expect(read.length).toBe(limit + 1);
    // The backing store is the preallocated bound, not the incoming chunk.
    expect(read.buffer.byteLength).toBe(limit + 1);
    expect(read.buffer).not.toBe(chunk.buffer);
    // The consumed chunk was zeroed after its bytes were copied.
    expect(chunk.every((byte) => byte === 0)).toBe(true);
  });

  test("many chunks stop at the first byte past the bound", async () => {
    let yielded = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        yielded += 1;
        yield Buffer.alloc(1000, "x");
      }
    }
    const read = await readBoundedInput(endless(), limit);
    expect(read.length).toBe(limit + 1);
    expect(yielded).toBe(Math.ceil((limit + 1) / 1000));
  });

  test("input within the bound is returned exactly, including string chunks", async () => {
    const read = await readBoundedInput(
      chunks(Buffer.from(secret.slice(0, 10)), secret.slice(10), "\n"),
      limit,
    );
    expect(read.toString("latin1")).toBe(`${secret}\n`);
  });

  test("credential set refuses one oversized chunk without printing or writing any of it", async () => {
    const home = runtimeHome();
    const marker = `aio-oversize-${randomBytes(8).toString("hex")}`;
    const chunk = Buffer.from(
      marker.repeat(Math.ceil((1 << 20) / marker.length)),
    );
    let retained = 0;
    const refused = await cli(home, ["set", "OPENAI_API_KEY"], {
      isTTY: false,
      read: async (bound) => {
        const read = await readBoundedInput(chunks(chunk), bound);
        retained = read.length;
        return read;
      },
    });
    expect(refused.exitCode).toBe(1);
    expect(retained).toBe(limit + 1);
    expect(refused.stderr.join("\n")).toContain("CREDENTIAL_MALFORMED");
    expect(refused.output).not.toContain(marker.slice(0, 12));
    expect(refused.output).not.toContain(marker.slice(-8));
    expect(existsSync(join(home, "credentials", "OPENAI_API_KEY"))).toBe(false);
  });
});

describe("credential status is metadata only", () => {
  function expectNoDerivedData(output: string, home: string): void {
    for (const derived of [
      secret,
      secret.slice(-8),
      String(secret.length),
      createHash("sha256").update(secret).digest("hex").slice(0, 12),
      home,
      join(home, "credentials"),
    ])
      expect(output).not.toContain(derived);
  }

  test.each([
    [
      "valid",
      (home: string): void =>
        writeRuntimeHomeCredential(home, "OPENAI_API_KEY", Buffer.from(secret)),
      "present",
      null,
      0,
    ],
    ["missing", (_home: string): void => undefined, "missing", null, 0],
    [
      "malformed",
      (home: string): void => {
        writeRuntimeHomeCredential(home, "OPENAI_API_KEY", Buffer.from(secret));
        writeFileSync(
          join(home, "credentials", "OPENAI_API_KEY"),
          `${secret} x`,
        );
      },
      "invalid",
      "CREDENTIAL_MALFORMED",
      1,
    ],
    [
      "insecure",
      (home: string): void => {
        writeRuntimeHomeCredential(home, "OPENAI_API_KEY", Buffer.from(secret));
        chmodSync(join(home, "credentials", "OPENAI_API_KEY"), 0o640);
      },
      "invalid",
      "CREDENTIAL_INSECURE_PERMISSIONS",
      1,
    ],
  ] as const)(
    "reports a %s credential by state and code only, in JSON and human form",
    async (_label, plant, state, issue, exitCode) => {
      const home = runtimeHome();
      plant(home);
      const json = await cli(home, ["status", "--json"]);
      expect(json.exitCode).toBe(exitCode);
      expect(JSON.parse(json.stdout.join(""))).toEqual({
        schemaVersion: 1,
        source: "runtime_home",
        credentials: [
          { name: "ANTHROPIC_API_KEY", state: "missing", issue: null },
          { name: "OPENAI_API_KEY", state, issue },
        ],
      });
      const human = await cli(home, ["status"]);
      expect(human.exitCode).toBe(exitCode);
      expect(human.stdout).toEqual([
        "Provider credentials in AI_OFFICE_HOME",
        "  ANTHROPIC_API_KEY: missing",
        `  OPENAI_API_KEY: ${state}${issue === null ? "" : ` ${issue}`}`,
        "A managed Runtime reads only these; a foreground Runtime reads only its own environment and never these. model:check reports what the running Runtime loaded.",
      ]);
      for (const output of [json.output, human.output])
        expectNoDerivedData(output, home);
    },
  );
});
