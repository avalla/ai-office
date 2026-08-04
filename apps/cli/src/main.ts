import { runCli } from "./cli.ts";

process.exitCode = await runCli(Bun.argv.slice(2), { projectRoot: process.cwd() });
