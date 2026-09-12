/**
 * Bounded argument-array execution for per-user service managers.
 *
 * Every call is a fixed argv: no shell, no interpolation, and no
 * caller-supplied service identifier. The service names and labels are
 * constants of this package, so there is nothing to escape and nothing a shell
 * could reinterpret.
 */
export interface ServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The program could not be executed at all — missing binary, or the call
   * exceeded its bound. Distinct from a program that ran and reported an
   * ordinary non-zero status such as "unit not found".
   */
  readonly unavailable: boolean;
  /** True when the bound, not the program, ended the call. */
  readonly timedOut?: boolean;
}

export interface ServiceCommandRunner {
  run(command: readonly string[]): Promise<ServiceCommandResult>;
}

/** Service-manager calls are local and quick; a stuck one must not hang a CLI. */
export const serviceCommandTimeoutMilliseconds = 20_000;

/** How long a terminated child may take to exit before it is killed outright. */
export const serviceCommandTerminationGraceMilliseconds = 2_000;

/**
 * How long the runner waits after `SIGKILL` before abandoning the child.
 *
 * A killed process effectively always reaps immediately; this exists so the
 * returned promise has an absolute bound even when it does not — for instance
 * when a grandchild is holding the inherited pipes open.
 */
export const serviceCommandAbandonMilliseconds = 1_000;

export interface BunServiceCommandRunnerOptions {
  timeoutMilliseconds?: number;
  terminationGraceMilliseconds?: number;
  abandonMilliseconds?: number;
}

function timer(milliseconds: number, action: () => void): NodeJS.Timeout {
  const handle = setTimeout(action, milliseconds);
  // A pending bound must never be the reason a finished CLI stays alive.
  handle.unref?.();
  return handle;
}

export class BunServiceCommandRunner implements ServiceCommandRunner {
  private readonly timeoutMilliseconds: number;
  private readonly terminationGraceMilliseconds: number;
  private readonly abandonMilliseconds: number;

  constructor(options: BunServiceCommandRunnerOptions = {}) {
    this.timeoutMilliseconds =
      options.timeoutMilliseconds ?? serviceCommandTimeoutMilliseconds;
    this.terminationGraceMilliseconds =
      options.terminationGraceMilliseconds ??
      serviceCommandTerminationGraceMilliseconds;
    this.abandonMilliseconds =
      options.abandonMilliseconds ?? serviceCommandAbandonMilliseconds;
  }

  /**
   * Runs one command under an absolute wall-clock bound.
   *
   * The escalation is deliberate rather than a single `kill()`: a child that
   * ignores or is slow to handle `SIGTERM` must still be gone, and the caller
   * must still get an answer. `SIGTERM`, then `SIGKILL` after a grace
   * interval, then — only if even that has not been reaped — return without
   * continuing to await it. Nothing is left running either way, because the
   * kill has already been delivered.
   */
  async run(command: readonly string[]): Promise<ServiceCommandResult> {
    const spawn = () =>
      Bun.spawn([...command], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // A service manager must never inherit an interactive pager or a
        // locale that reflows the machine-readable output being parsed.
        env: { ...process.env, PAGER: "cat", SYSTEMD_PAGER: "", LC_ALL: "C" },
      });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn();
    } catch {
      return { exitCode: 127, stdout: "", stderr: "", unavailable: true };
    }

    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const abandoned = new Promise<null>((resolve) => {
      timers.push(
        timer(this.timeoutMilliseconds, () => {
          timedOut = true;
          child.kill();
          timers.push(
            timer(this.terminationGraceMilliseconds, () => {
              child.kill("SIGKILL");
              timers.push(timer(this.abandonMilliseconds, () => resolve(null)));
            }),
          );
        }),
      );
    });

    const collected = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    try {
      const settled = await Promise.race([collected, abandoned]);
      if (settled === null) {
        // The child was killed but has not been reaped. Its output is
        // unreadable rather than empty-and-trustworthy, so it is not reported.
        void collected.catch(() => {});
        return {
          exitCode: 124,
          stdout: "",
          stderr: "",
          unavailable: true,
          timedOut: true,
        };
      }
      const [exitCode, stdout, stderr] = settled;
      if (timedOut)
        return {
          exitCode: 124,
          stdout,
          stderr,
          unavailable: true,
          timedOut: true,
        };
      return { exitCode, stdout, stderr, unavailable: false };
    } finally {
      for (const handle of timers) clearTimeout(handle);
    }
  }
}

/**
 * One short, non-localized cause for a report; never the full command output.
 *
 * Shared by both adapters so a failure reads the same whichever platform
 * produced it.
 */
export function describeCommandFailure(result: ServiceCommandResult): string {
  if (result.timedOut === true) return " (the command exceeded its time bound)";
  if (result.unavailable) return " (the command could not be executed)";
  const line = result.stderr.split("\n").find((entry) => entry.trim() !== "");
  return line === undefined
    ? ` (exit ${result.exitCode})`
    : ` (exit ${result.exitCode}: ${line.trim()})`;
}
