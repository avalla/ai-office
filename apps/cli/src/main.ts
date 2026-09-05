import { runRuntimeCli } from "./daemon-cli.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLocalHelpInvocation,
  runtimeCommandHelp,
} from "@ai-office/command-support/help.ts";

if (isLocalHelpInvocation(Bun.argv.slice(2))) {
  console.log(runtimeCommandHelp);
  process.exit(0);
}

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const runtimePaths = resolveRuntimePaths({
  mode: "development",
  developmentRoot: projectRoot,
});
console.error(`Development Runtime: ${runtimePaths.runtimeHome}`);
console.error(`Global memory: ${runtimePaths.globalDatabasePath}`);

process.exitCode = await runRuntimeCli(Bun.argv.slice(2), {
  projectRoot,
  runtimePaths,
  workingDirectory: process.cwd(),
});
