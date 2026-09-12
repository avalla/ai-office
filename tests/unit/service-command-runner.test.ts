import { describe, expect, test } from "vitest";
import {
  BunServiceCommandRunner,
  describeCommandFailure,
} from "@ai-office/service-management/service-command-runner.ts";

/**
 * These exercise the real process boundary, because the bound only means
 * anything against a real child that ignores signals. Every timeout here is a
 * few hundred milliseconds, so a regression fails fast rather than hanging CI.
 */
const bounded = () =>
  new BunServiceCommandRunner({
    timeoutMilliseconds: 150,
    terminationGraceMilliseconds: 100,
    abandonMilliseconds: 100,
  });

/** A child that installs a SIGTERM handler and then refuses to leave. */
function stubbornChild(): readonly string[] {
  return [
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ];
}

describe("bounded service command execution", () => {
  test("an ordinary command returns its output and status", async () => {
    const result = await bounded().run([
      process.execPath,
      "-e",
      "console.log('out'); console.error('err'); process.exit(3);",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.unavailable).toBe(false);
    expect(result.timedOut).toBeUndefined();
  });

  test("a missing executable is unavailable rather than a thrown error", async () => {
    const result = await bounded().run([
      "ai-office-definitely-not-a-real-binary",
    ]);
    expect(result.unavailable).toBe(true);
    expect(result.exitCode).toBe(127);
  });

  test("a child that ignores SIGTERM is still bounded and killed", async () => {
    const started = Date.now();
    const result = await bounded().run(stubbornChild());
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.exitCode).toBe(124);
    // SIGTERM at 150ms, SIGKILL at 250ms, abandoned at 350ms. A `kill()` that
    // merely awaited `exited` would never return here at all.
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);

  test("the child does not survive the bound", async () => {
    const runner = new BunServiceCommandRunner({
      timeoutMilliseconds: 100,
      terminationGraceMilliseconds: 100,
      abandonMilliseconds: 500,
    });
    // The child writes its own pid, so the test can prove it was reaped
    // rather than merely abandoned.
    const result = await runner.run([
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);",
    ]);
    expect(result.timedOut).toBe(true);
    const pid = Number(result.stdout.trim());
    expect(Number.isInteger(pid)).toBe(true);
    // SIGKILL has landed by now; signal 0 only probes for existence.
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  test("a timed-out command is reported as timed out, not as an exit status", () => {
    expect(
      describeCommandFailure({
        exitCode: 124,
        stdout: "",
        stderr: "",
        unavailable: true,
        timedOut: true,
      }),
    ).toContain("exceeded its time bound");
  });

  test("an ordinary failure reports one short cause, never the whole output", () => {
    expect(
      describeCommandFailure({
        exitCode: 1,
        stdout: "",
        stderr: "Failed to disable unit\nlots\nmore\nnoise\n",
        unavailable: false,
      }),
    ).toBe(" (exit 1: Failed to disable unit)");
  });
});
