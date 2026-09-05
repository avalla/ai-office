import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string | undefined>,
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${result.exitCode}\n${stderr || stdout}`,
    );
  }
  return { stdout, stderr };
}

function copyDistribution(target: string): void {
  for (const relativePath of [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "bin",
    "apps",
    "packages",
    "migrations",
    ".agents",
  ]) {
    cpSync(join(repositoryRoot, relativePath), join(target, relativePath), {
      recursive: true,
    });
  }
}

function assertLinkedLauncher(
  launcherPath: string,
  expectedEntrypoint: string,
): void {
  if (!lstatSync(launcherPath).isSymbolicLink())
    throw new Error(`Expected Bun launcher to be a symlink: ${launcherPath}`);
  const resolvedLauncher = realpathSync(launcherPath);
  const resolvedEntrypoint = realpathSync(expectedEntrypoint);
  if (resolvedLauncher !== resolvedEntrypoint) {
    throw new Error(
      `Bun launcher resolved to ${resolvedLauncher}, expected ${resolvedEntrypoint}`,
    );
  }
}

function assertHelp(
  distributionRoot: string,
  environment: Record<string, string | undefined>,
): void {
  const { stdout } = run(
    ["ai-office", "--help"],
    distributionRoot,
    environment,
  );
  if (
    !stdout.startsWith("AI Office CLI\n") ||
    !stdout.includes("update [--approve <plan-hash>] [--json]")
  ) {
    throw new Error(
      "Linked ai-office launcher returned unexpected help output",
    );
  }
}

if (process.platform === "win32")
  throw new Error("AI Office link smoke test requires macOS or Linux");

const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-office-bun-link-smoke-"));
try {
  const distributionRoot = join(temporaryRoot, "distribution");
  const isolatedHome = join(temporaryRoot, "home");
  const bunInstallRoot = join(temporaryRoot, "bun-install");
  const globalDirectory = join(temporaryRoot, "global");
  const globalBinDirectory = join(temporaryRoot, "global-bin");
  const runtimeHome = join(temporaryRoot, "runtime");
  for (const directory of [
    distributionRoot,
    isolatedHome,
    bunInstallRoot,
    globalDirectory,
    globalBinDirectory,
    runtimeHome,
  ])
    mkdirSync(directory, { recursive: true });
  copyDistribution(distributionRoot);

  const bunExecutable = process.execPath;
  const environment = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    BUN_INSTALL_CACHE_DIR: join(temporaryRoot, "cache"),
    AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "",
    BUN_INSTALL: bunInstallRoot,
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBinDirectory,
    AI_OFFICE_HOME: runtimeHome,
    PATH: [
      globalBinDirectory,
      dirname(bunExecutable),
      process.env.PATH ?? "",
    ].join(delimiter),
  };

  run(
    [bunExecutable, "install", "--frozen-lockfile"],
    distributionRoot,
    environment,
  );
  run([bunExecutable, "link"], distributionRoot, environment);

  const launcherPath = join(globalBinDirectory, "ai-office");
  const expectedEntrypoint = join(distributionRoot, "bin", "ai-office.ts");
  assertLinkedLauncher(launcherPath, expectedEntrypoint);
  assertHelp(distributionRoot, environment);

  const packageLink = join(globalDirectory, "node_modules", "ai-office");
  if (!lstatSync(packageLink).isSymbolicLink())
    throw new Error(`Expected Bun package registration: ${packageLink}`);
  rmSync(packageLink);
  if (existsSync(launcherPath))
    throw new Error(
      "Expected launcher to be dangling after package link removal",
    );
  if (readlinkSync(launcherPath) === "")
    throw new Error("Expected the dangling launcher symlink to remain present");

  run([bunExecutable, "link"], distributionRoot, environment);
  assertLinkedLauncher(launcherPath, expectedEntrypoint);
  assertHelp(distributionRoot, environment);

  console.log(
    `Bun ${Bun.version} source-link smoke passed with isolated global state`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
