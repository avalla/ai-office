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
}

export interface ServiceCommandRunner {
  run(command: readonly string[]): Promise<ServiceCommandResult>;
}

/** Service-manager calls are local and quick; a stuck one must not hang a CLI. */
export const serviceCommandTimeoutMilliseconds = 20_000;

export class BunServiceCommandRunner implements ServiceCommandRunner {
  constructor(
    private readonly timeoutMilliseconds: number = serviceCommandTimeoutMilliseconds,
  ) {}

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
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.timeoutMilliseconds);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut) return { exitCode: 124, stdout, stderr, unavailable: true };
      return { exitCode, stdout, stderr, unavailable: false };
    } finally {
      clearTimeout(deadline);
    }
  }
}
