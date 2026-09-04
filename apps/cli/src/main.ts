import { runRuntimeCli } from "./daemon-cli.ts";

process.exitCode = await runRuntimeCli(Bun.argv.slice(2), {
  projectRoot: process.cwd(),
});
