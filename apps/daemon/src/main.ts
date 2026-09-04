import { bootstrap } from "./bootstrap.ts";
import { resolveRuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
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
const daemon = await bootstrap({ projectRoot, runtimePaths });
await daemon.start(controller.signal);
