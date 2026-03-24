#!/usr/bin/env bun

import { existsSync } from "fs";
import { join, resolve } from "path";
import { buildBundledAdapters } from "./adapter-renderer";

type CliOptions = {
  rootDir: string;
};

function parseArgs(argv: string[]): CliOptions {
  let rootDir = resolve(import.meta.dir, "..");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root-dir") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --root-dir");
      }
      rootDir = resolve(next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { rootDir };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.rootDir, "VERSION"))) {
    throw new Error(`Not an AI Office framework root: ${options.rootDir}`);
  }

  buildBundledAdapters(options.rootDir);
  console.log("Generated adapter outputs from neutral manifest.");
}

main();
