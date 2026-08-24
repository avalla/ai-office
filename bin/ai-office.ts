#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../apps/cli/src/daemon-cli.ts";
import {
  legacyCheckoutDatabasePath,
  resolveRuntimePaths,
  RuntimePathError,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...arguments_] = Bun.argv.slice(2);
let runtimePaths: RuntimePaths;

try {
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

if (command === "daemon") {
  if (arguments_.length > 0) {
    console.error("daemon does not accept arguments");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => controller.abort());
    const daemon = await bootstrap({ runtimePaths, projectRoot: distributionRoot });
    console.log(`AI Office daemon using ${runtimePaths.runtimeHome}`);
    await daemon.start(controller.signal);
  }
} else {
  process.exitCode = await runDaemonCli(
    command === undefined ? [] : [command, ...arguments_],
    {
      runtimePaths,
      workingDirectory: process.cwd(),
    },
  );
}
