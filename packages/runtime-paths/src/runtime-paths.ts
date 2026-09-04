import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const runtimeHomeEnvironmentVariable = "AI_OFFICE_HOME";

export interface RuntimePaths {
  runtimeHome: string;
  projectDatabasePath: string;
  socketPath: string;
  globalDatabasePath: string;
  draftsDirectory: string;
  generatedDirectory: string;
}

export class RuntimePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimePathError";
  }
}

interface ResolveRuntimePathsOptions {
  mode: "user" | "development";
  developmentRoot?: string;
  runtimeHome?: string;
  globalMemoryHome?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  userHome?: string;
}

function canonicalPotentialDirectory(inputPath: string, label: string): string {
  const absolute = resolve(inputPath);
  if (existsSync(absolute)) {
    const status = lstatSync(absolute);
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new RuntimePathError(
        `${label} must be a real directory and cannot be a symbolic link: ${absolute}`,
      );
    return realpathSync(absolute);
  }

  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current)
      throw new RuntimePathError(
        `${label} has no existing ancestor: ${absolute}`,
      );
    missing.unshift(
      current.slice(parent.length + (parent.endsWith("/") ? 0 : 1)),
    );
    current = parent;
  }
  const status = lstatSync(current);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new RuntimePathError(
      `${label} ancestor must be a real directory: ${current}`,
    );
  return join(realpathSync(current), ...missing);
}

export function resolveRuntimePaths(
  options: ResolveRuntimePathsOptions,
): RuntimePaths {
  const environment = options.environment ?? process.env;
  const userHome = options.userHome ?? homedir();
  const selectedRuntimeHome =
    options.runtimeHome ??
    (options.mode === "user"
      ? (environment[runtimeHomeEnvironmentVariable] ??
        join(userHome, ".ai-office"))
      : join(options.developmentRoot ?? process.cwd(), ".ai-office"));
  if (options.mode === "user" && !isAbsolute(selectedRuntimeHome))
    throw new RuntimePathError(
      "AI Office runtime home must be an absolute path",
    );
  const runtimeHome = canonicalPotentialDirectory(
    selectedRuntimeHome,
    "AI Office runtime home",
  );
  const globalMemoryHome = canonicalPotentialDirectory(
    options.globalMemoryHome ?? runtimeHome,
    "AI Office global memory home",
  );

  return Object.freeze({
    runtimeHome,
    projectDatabasePath: join(runtimeHome, "project.sqlite"),
    socketPath: join(runtimeHome, "daemon.sock"),
    globalDatabasePath: join(globalMemoryHome, "global.sqlite"),
    draftsDirectory: join(runtimeHome, "drafts"),
    generatedDirectory: join(runtimeHome, "generated"),
  });
}

export function withRuntimePathOverrides(
  paths: RuntimePaths,
  overrides: {
    socketPath?: string;
    globalDatabasePath?: string;
  },
): RuntimePaths {
  return Object.freeze({
    ...paths,
    ...(overrides.socketPath === undefined
      ? {}
      : { socketPath: resolve(overrides.socketPath) }),
    ...(overrides.globalDatabasePath === undefined
      ? {}
      : { globalDatabasePath: resolve(overrides.globalDatabasePath) }),
  });
}

export function ensureRuntimeHome(paths: RuntimePaths): void {
  if (!existsSync(paths.runtimeHome))
    mkdirSync(paths.runtimeHome, { recursive: true, mode: 0o700 });
  const status = lstatSync(paths.runtimeHome);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new RuntimePathError(
      `AI Office runtime home must be a real directory: ${paths.runtimeHome}`,
    );
  try {
    accessSync(
      paths.runtimeHome,
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
  } catch {
    throw new RuntimePathError(
      `AI Office runtime home is not readable and writable: ${paths.runtimeHome}`,
    );
  }
}

export function legacyCheckoutDatabasePath(
  distributionRoot: string,
  paths: RuntimePaths,
): string | null {
  const legacy = join(
    realpathSync(resolve(distributionRoot)),
    ".ai-office",
    "project.sqlite",
  );
  return legacy === paths.projectDatabasePath || !existsSync(legacy)
    ? null
    : legacy;
}
