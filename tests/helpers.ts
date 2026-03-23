import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const FRAMEWORK_DIR = join(import.meta.dir, "..");

/** Create a temp directory and return its path + a cleanup function. */
export function makeTempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ai-office-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run a shell script synchronously and return { exitCode, stdout, stderr }. */
export function runScript(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", script, ...args], {
    cwd: FRAMEWORK_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Run the ai-office CLI synchronously in a target project directory. */
export function runCli(
  projectDir: string,
  args: string[] = [],
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", join(FRAMEWORK_DIR, "bin/ai-office"), ...args], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Assert a path exists, throw with a descriptive message if not. */
export function assertExists(path: string, label?: string): void {
  if (!existsSync(path)) {
    throw new Error(`Expected ${label ?? path} to exist but it does not`);
  }
}
