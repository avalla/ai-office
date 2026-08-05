import { runDaemonCli } from "./daemon-cli.ts";

process.exitCode = await runDaemonCli(Bun.argv.slice(2), { projectRoot: process.cwd() });
