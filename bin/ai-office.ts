#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../apps/daemon/src/bootstrap.ts";
import { runDaemonCli } from "../apps/cli/src/daemon-cli.ts";

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...arguments_] = Bun.argv.slice(2);

if (command === "daemon") {
  if (arguments_.length > 0) {
    console.error("daemon does not accept arguments");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => controller.abort());
    const daemon = await bootstrap({ projectRoot: distributionRoot });
    console.log(`AI Office daemon running from ${distributionRoot}`);
    await daemon.start(controller.signal);
  }
} else {
  process.exitCode = await runDaemonCli(
    command === undefined ? [] : [command, ...arguments_],
    {
      projectRoot: distributionRoot,
      workingDirectory: process.cwd(),
    },
  );
}
