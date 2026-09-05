#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLocalHelpInvocation,
  runtimeCommandHelp,
} from "@ai-office/command-support/help.ts";
import { runRuntimeCli } from "../apps/cli/src/daemon-cli.ts";
import { parseRuntimeHostStart } from "../apps/cli/src/runtime-lifecycle.ts";
import {
  legacyCheckoutDatabasePath,
  resolveRuntimePaths,
  RuntimePathError,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Bun.argv.slice(2);
if (isLocalHelpInvocation(args)) {
  console.log(runtimeCommandHelp);
  process.exit(0);
}
const [command, ...arguments_] = args;
let runtimePaths: RuntimePaths;

try {
  // This bin is explicitly the source distribution (including bun link).
  // Packaging must supply its own installed entry point, not infer it from cwd.
  if (process.env.AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE !== "1")
    throw new RuntimePathError(
      "Source CLI user-runtime access requires AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1. For isolated development use bun run dev:daemon and bun run dev:cli.",
    );
  runtimePaths = resolveRuntimePaths({ mode: "user" });
} catch (error) {
  console.error(
    error instanceof RuntimePathError
      ? error.message
      : "AI Office runtime home could not be resolved",
  );
  process.exit(1);
}

const legacyDatabase = legacyCheckoutDatabasePath(
  distributionRoot,
  runtimePaths,
);
if (legacyDatabase !== null)
  console.error(
    `Legacy checkout runtime detected at ${legacyDatabase}. It was not moved. To select it explicitly, set AI_OFFICE_HOME=${dirname(legacyDatabase)}.`,
  );

const runtimeHostStart = parseRuntimeHostStart(
  command === undefined ? [] : [command, ...arguments_],
);

if (runtimeHostStart !== null) {
  if (runtimeHostStart.unexpectedArguments.length > 0) {
    console.error(
      runtimeHostStart.compatibilityAlias
        ? "daemon does not accept arguments"
        : "runtime start does not accept arguments",
    );
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => controller.abort());
    const { bootstrap } = await import("../apps/daemon/src/bootstrap.ts");
    const runtimeHost = await bootstrap({
      runtimePaths,
      projectRoot: distributionRoot,
    });
    if (runtimeHostStart.compatibilityAlias)
      console.log(`AI Office daemon using ${runtimePaths.runtimeHome}`);
    else {
      console.log(`AI Office Runtime using ${runtimePaths.runtimeHome}`);
      console.log("Persistent host: local daemon");
    }
    await runtimeHost.start(controller.signal);
  }
} else {
  process.exitCode = await runRuntimeCli(
    command === undefined ? [] : [command, ...arguments_],
    {
      runtimePaths,
      workingDirectory: process.cwd(),
    },
  );
}
