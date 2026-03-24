#!/usr/bin/env bun

import { existsSync } from "fs";
import {
  ADAPTER_PROFILES,
  type AdapterHost,
} from "./adapter-manifest";
import { renderInstalledAdapter, renderShellMetadata } from "./adapter-renderer";

type EmitShellMetadataCommand = {
  command: "emit-shell-metadata";
};

type InstallAdapterCommand = {
  command: "install";
  frameworkDir: string;
  projectRoot: string;
  adapterHost: AdapterHost;
  instructionMode: "always" | "if-missing" | "never";
};

type CliCommand = EmitShellMetadataCommand | InstallAdapterCommand;

function isAdapterHost(value: string): value is AdapterHost {
  return ADAPTER_PROFILES.some((adapter) => adapter.host === value);
}

function parseArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === "emit-shell-metadata") {
    return { command };
  }

  if (command !== "install") {
    throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }

  let frameworkDir = "";
  let projectRoot = "";
  let adapterHost: AdapterHost | null = null;
  let instructionMode: "always" | "if-missing" | "never" = "if-missing";

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--framework-dir") {
      frameworkDir = rest[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--project-root") {
      projectRoot = rest[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--adapter") {
      const next = rest[index + 1] ?? "";
      if (!isAdapterHost(next)) {
        throw new Error(`Unknown adapter: ${next || "(missing)"}`);
      }
      adapterHost = next;
      index += 1;
      continue;
    }
    if (arg === "--instruction-mode") {
      const next = rest[index + 1] ?? "";
      if (next !== "always" && next !== "if-missing" && next !== "never") {
        throw new Error(`Unknown instruction mode: ${next || "(missing)"}`);
      }
      instructionMode = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!frameworkDir) {
    throw new Error("Missing value for --framework-dir");
  }
  if (!projectRoot) {
    throw new Error("Missing value for --project-root");
  }
  if (!adapterHost) {
    throw new Error("Missing value for --adapter");
  }
  if (!existsSync(frameworkDir)) {
    throw new Error(`Framework directory does not exist: ${frameworkDir}`);
  }

  return {
    command,
    frameworkDir,
    projectRoot,
    adapterHost,
    instructionMode,
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "emit-shell-metadata") {
    console.log(renderShellMetadata());
    return;
  }

  const summary = renderInstalledAdapter({
    frameworkRoot: parsed.frameworkDir,
    projectRoot: parsed.projectRoot,
    adapterHost: parsed.adapterHost,
    instructionMode: parsed.instructionMode,
  });

  console.log(JSON.stringify(summary));
}

main();
