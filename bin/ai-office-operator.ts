#!/usr/bin/env bun

import { runDaemonCli } from "../apps/cli/src/daemon-cli.ts";
import {
  resolveRuntimePaths,
  RuntimePathError,
} from "@ai-office/runtime-paths/runtime-paths.ts";

if (!(process.stdin.isTTY && process.stdout.isTTY)) {
  console.error(
    "AI Office operator commands require an interactive operator surface",
  );
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await runDaemonCli(Bun.argv.slice(2), {
      runtimePaths: resolveRuntimePaths({ mode: "user" }),
      workingDirectory: process.cwd(),
      operatorSurface: true,
    });
  } catch (error) {
    console.error(
      error instanceof RuntimePathError
        ? error.message
        : "AI Office operator runtime could not be resolved",
    );
    process.exitCode = 1;
  }
}
