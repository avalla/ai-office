#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { ADAPTER_PROFILES, COMMAND_SPECS, type AdapterHost, WINDSURF_RULE_BODY } from "./adapter-manifest";

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

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeText(path: string, content: string): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, content, "utf8");
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function hostCommand(host: AdapterHost, id: string): string {
  if (host === "codex") {
    return `$${id}`;
  }
  return `/${id}`;
}

function replaceTokens(input: string, host: AdapterHost, selfId?: string): string {
  return input
    .replace(/\{\{SELF\}\}/g, selfId ? hostCommand(host, selfId) : "")
    .replace(/\{\{CMD:([^}]+)\}\}/g, (_, id: string) => hostCommand(host, id));
}

function renderInstructionTemplate(template: string, host: AdapterHost, adapterLabel: string): string {
  const replacements: Record<string, string> = {
    "{{ADAPTER_LABEL}}": adapterLabel,
    "{{ROUTE_COMMAND}}": hostCommand(host, "office-route"),
    "{{TASK_MOVE_COMMAND}}": hostCommand(host, "office-task-move"),
    "{{TASK_INTEGRATE_COMMAND}}": hostCommand(host, "office-task-integrate"),
    "{{VALIDATE_COMMAND}}": hostCommand(host, "office-validate"),
    "{{ADVANCE_COMMAND}}": hostCommand(host, "office-advance"),
  };

  return `${Object.entries(replacements).reduce((current, [token, value]) => current.replaceAll(token, value), template).trim()}\n`;
}

function renderSkill(host: AdapterHost, version: string, spec: (typeof COMMAND_SPECS)[number]): string {
  const usage = spec.argumentsFormat ? ` Usage: ${hostCommand(host, spec.id)} ${spec.argumentsFormat}` : "";
  const lines: string[] = [
    "---",
    `name: ${spec.id}`,
    `description: ${spec.description}${usage}`,
    "disable-model-invocation: true",
    "---",
    "",
  ];

  if (spec.argumentsFormat) {
    lines.push(`$ARGUMENTS format: \`${spec.argumentsFormat}\``, "");
  }

  if (spec.argumentGuidance && spec.argumentGuidance.length > 0) {
    lines.push("Argument guidance:");
    for (const item of spec.argumentGuidance) {
      lines.push(`- ${replaceTokens(item, host, spec.id)}`);
    }
    lines.push("");
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push("Examples:");
    for (const example of spec.examples) {
      lines.push(`- \`${replaceTokens(example, host, spec.id)}\``);
    }
    lines.push("");
  }

  lines.push("---", "", "## Steps", "");
  spec.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${replaceTokens(step, host, spec.id)}`);
  });
  lines.push("", `<!-- ai-office-version: ${version} -->`, "");

  return lines.join("\n");
}

function renderWindsurfWorkflow(spec: (typeof COMMAND_SPECS)[number]): string {
  const lines: string[] = [
    `# ${hostCommand("windsurf", spec.id)}`,
    "",
    `Description: ${replaceTokens(spec.description, "windsurf", spec.id)}`,
    "",
  ];

  if (spec.argumentsFormat) {
    lines.push(`Arguments: \`${spec.argumentsFormat}\``, "");
  }

  if (spec.argumentGuidance && spec.argumentGuidance.length > 0) {
    lines.push("Argument guidance:");
    for (const item of spec.argumentGuidance) {
      lines.push(`- ${replaceTokens(item, "windsurf", spec.id)}`);
    }
    lines.push("");
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push("Examples:");
    for (const example of spec.examples) {
      lines.push(`- \`${replaceTokens(example, "windsurf", spec.id)}\``);
    }
    lines.push("");
  }

  spec.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${replaceTokens(step, "windsurf", spec.id)}`);
  });
  lines.push("");

  return lines.join("\n");
}

function cleanGeneratedCommandOutput(root: string): void {
  for (const adapter of ADAPTER_PROFILES) {
    if (adapter.skillOutputRoot) {
      const outputRoot = join(root, adapter.skillOutputRoot);
      for (const spec of COMMAND_SPECS) {
        rmSync(join(outputRoot, spec.id), { recursive: true, force: true });
      }
    }

    if (adapter.workflowOutputRoot) {
      const outputRoot = join(root, adapter.workflowOutputRoot);
      for (const spec of COMMAND_SPECS) {
        rmSync(join(outputRoot, `${spec.id}.md`), { force: true });
      }
    }
  }
}

function build(root: string): void {
  const version = readText(join(root, "VERSION")).trim();
  const instructionTemplate = readText(join(root, "skeleton/core/templates/adapter-instructions.md.tmpl"));

  cleanGeneratedCommandOutput(root);

  for (const adapter of ADAPTER_PROFILES) {
    const instructionContent = renderInstructionTemplate(instructionTemplate, adapter.host, adapter.adapterLabel);
    writeText(join(root, adapter.instructionOutputPath), instructionContent);

    if (adapter.skillOutputRoot) {
      const outputRoot = join(root, adapter.skillOutputRoot);
      ensureDir(outputRoot);
      for (const spec of COMMAND_SPECS) {
        writeText(join(outputRoot, spec.id, "SKILL.md"), renderSkill(adapter.host, version, spec));
      }
    }

    if (adapter.workflowOutputRoot) {
      const outputRoot = join(root, adapter.workflowOutputRoot);
      ensureDir(outputRoot);
      for (const spec of COMMAND_SPECS) {
        writeText(join(outputRoot, `${spec.id}.md`), renderWindsurfWorkflow(spec));
      }
    }

    if (adapter.workspaceRuleOutputPath) {
      writeText(join(root, adapter.workspaceRuleOutputPath), `${WINDSURF_RULE_BODY.trim()}\n`);
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.rootDir, "VERSION"))) {
    throw new Error(`Not an AI Office framework root: ${options.rootDir}`);
  }

  build(options.rootDir);
  console.log("Generated adapter outputs from neutral manifest.");
}

main();
