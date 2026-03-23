#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  ADAPTER_PROFILES,
  ALL_SUPPORTED_COMMAND_IDS,
  COMMAND_SPECS,
  TEMPLATE_COMMAND_IDS,
  type AdapterHost,
  WINDSURF_RULE_BODY,
} from "./adapter-manifest";

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

function renderStaticTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((current, [token, value]) => current.replaceAll(token, value), template);
}

function replaceTokens(input: string, host: AdapterHost, selfId?: string): string {
  return input
    .replace(/\{\{SELF\}\}/g, selfId ? hostCommand(host, selfId) : "")
    .replace(/\{\{CMD:([^}]+)\}\}/g, (_, id: string) => hostCommand(host, id));
}

function renderInstructionTemplate(template: string, host: AdapterHost, adapterLabel: string): string {
  return `${renderStaticTemplate(template, {
    "{{ADAPTER_LABEL}}": adapterLabel,
    "{{ROUTE_COMMAND}}": hostCommand(host, "office-route"),
    "{{TASK_MOVE_COMMAND}}": hostCommand(host, "office-task-move"),
    "{{TASK_INTEGRATE_COMMAND}}": hostCommand(host, "office-task-integrate"),
    "{{VALIDATE_COMMAND}}": hostCommand(host, "office-validate"),
    "{{ADVANCE_COMMAND}}": hostCommand(host, "office-advance"),
  }).trim()}\n`;
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: "", body: markdown };
  }
  return { frontmatter: match[1], body: match[2] };
}

function frontmatterField(frontmatter: string, field: string): string {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
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

function renderSkillTemplate(
  template: string,
  host: AdapterHost,
  version: string,
  wrapperRoot: string,
  versionFilePath: string,
): string {
  const tokenized = renderStaticTemplate(template, {
    "{{FRAMEWORK_VERSION}}": version,
    "{{ADAPTER_SKILL_ROOT}}": wrapperRoot,
    "{{ADAPTER_WRAPPER_ROOT}}": wrapperRoot,
    "{{ADAPTER_VERSION_FILE}}": versionFilePath,
    "{{EXPECTED_SKILL_COUNT}}": String(ALL_SUPPORTED_COMMAND_IDS.length),
    "{{EXPECTED_WRAPPER_COUNT}}": String(ALL_SUPPORTED_COMMAND_IDS.length),
  });

  return `${replaceTokens(tokenized, host).trim()}\n`;
}

function renderOpencodeCommand(version: string, spec: (typeof COMMAND_SPECS)[number]): string {
  const lines: string[] = [
    `# ${hostCommand("opencode", spec.id)}`,
    "",
    `Description: ${replaceTokens(spec.description, "opencode", spec.id)}`,
    "",
  ];

  if (spec.argumentsFormat) {
    lines.push(`Usage: \`${hostCommand("opencode", spec.id)} ${spec.argumentsFormat}\``, "");
  }

  if (spec.argumentGuidance && spec.argumentGuidance.length > 0) {
    lines.push("Argument guidance:");
    for (const item of spec.argumentGuidance) {
      lines.push(`- ${replaceTokens(item, "opencode", spec.id)}`);
    }
    lines.push("");
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push("Examples:");
    for (const example of spec.examples) {
      lines.push(`- \`${replaceTokens(example, "opencode", spec.id)}\``);
    }
    lines.push("");
  }

  lines.push("Follow these steps:");
  spec.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${replaceTokens(step, "opencode", spec.id)}`);
  });
  lines.push("", `<!-- ai-office-version: ${version} -->`, "");

  return lines.join("\n");
}

function renderOpencodeTemplateCommand(
  template: string,
  commandId: string,
  version: string,
  wrapperRoot: string,
  versionFilePath: string,
): string {
  const { frontmatter, body } = splitFrontmatter(template);
  const description = replaceTokens(
    frontmatterField(frontmatter, "description") || `AI Office command: ${commandId}`,
    "opencode",
    commandId,
  );
  const tokenizedBody = renderStaticTemplate(body, {
    "{{FRAMEWORK_VERSION}}": version,
    "{{ADAPTER_SKILL_ROOT}}": wrapperRoot,
    "{{ADAPTER_WRAPPER_ROOT}}": wrapperRoot,
    "{{ADAPTER_VERSION_FILE}}": versionFilePath,
    "{{EXPECTED_SKILL_COUNT}}": String(ALL_SUPPORTED_COMMAND_IDS.length),
    "{{EXPECTED_WRAPPER_COUNT}}": String(ALL_SUPPORTED_COMMAND_IDS.length),
  });

  return [
    `# ${hostCommand("opencode", commandId)}`,
    "",
    `Description: ${description}`,
    "",
    replaceTokens(tokenizedBody, "opencode", commandId).trim(),
    "",
    `<!-- ai-office-version: ${version} -->`,
    "",
  ].join("\n");
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

function renderShellCaseFunction(
  name: string,
  valueFor: (adapter: (typeof ADAPTER_PROFILES)[number]) => string
): string {
  const lines = [`${name}() {`, '  case "$1" in'];
  for (const adapter of ADAPTER_PROFILES) {
    lines.push(`    ${adapter.host}) echo "${valueFor(adapter)}" ;;`);
  }
  lines.push("    *) echo \"\" ;;", "  esac", "}");
  return lines.join("\n");
}

function renderShellMetadata(): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# Generated by src/build-adapters.ts. Do not edit by hand.",
    "",
    `AI_OFFICE_ADAPTERS=(${ADAPTER_PROFILES.map((adapter) => `"${adapter.host}"`).join(" ")})`,
    "",
    "adapter_exists() {",
    '  case "$1" in',
    ...ADAPTER_PROFILES.map((adapter) => `    ${adapter.host}) return 0 ;;`),
    "    *) return 1 ;;",
    "  esac",
    "}",
    "",
    renderShellCaseFunction("adapter_kind", (adapter) => {
      if (adapter.commandOutputRoot) {
        return "commands";
      }
      if (adapter.skillOutputRoot) {
        return "skills";
      }
      if (adapter.rulesOutputRoot || adapter.workflowOutputRoot) {
        return "rules-workflows";
      }
      return "base";
    }),
    "",
    renderShellCaseFunction("adapter_instruction_target", (adapter) =>
      adapter.instructionFileName ?? ""
    ),
    "",
    renderShellCaseFunction("adapter_instruction_source_rel", (adapter) =>
      adapter.instructionOutputPath ?? ""
    ),
    "",
    renderShellCaseFunction("adapter_version_file_rel", (adapter) => adapter.versionStampPath ?? ""),
    "",
    renderShellCaseFunction("adapter_skill_source_rel", (adapter) => adapter.skillOutputRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_skill_dest_rel", (adapter) => adapter.installedSkillRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_commands_source_rel", (adapter) => adapter.commandOutputRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_commands_dest_rel", (adapter) => adapter.installedCommandRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_rules_source_rel", (adapter) => adapter.rulesOutputRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_rules_dest_rel", (adapter) => adapter.installedRulesRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_workflows_source_rel", (adapter) => adapter.workflowOutputRoot ?? ""),
    "",
    renderShellCaseFunction("adapter_workflows_dest_rel", (adapter) => adapter.installedWorkflowRoot ?? ""),
    "",
  ];

  return lines.join("\n");
}

function cleanGeneratedCommandOutput(root: string): void {
  for (const adapter of ADAPTER_PROFILES) {
    if (adapter.skillOutputRoot) {
      const outputRoot = join(root, adapter.skillOutputRoot);
      for (const commandId of ALL_SUPPORTED_COMMAND_IDS) {
        rmSync(join(outputRoot, commandId), { recursive: true, force: true });
      }
    }

    if (adapter.workflowOutputRoot) {
      const outputRoot = join(root, adapter.workflowOutputRoot);
      for (const spec of COMMAND_SPECS) {
        rmSync(join(outputRoot, `${spec.id}.md`), { force: true });
      }
    }

    if (adapter.commandOutputRoot) {
      const outputRoot = join(root, adapter.commandOutputRoot);
      for (const commandId of ALL_SUPPORTED_COMMAND_IDS) {
        rmSync(join(outputRoot, `${commandId}.md`), { force: true });
      }
    }
  }
}

function build(root: string): void {
  const version = readText(join(root, "VERSION")).trim();
  const defaultInstructionTemplate = readText(join(root, "skeleton/core/templates/adapter-instructions.md.tmpl"));
  const templateRoot = join(root, "skeleton/core/templates/skills");

  cleanGeneratedCommandOutput(root);

  for (const adapter of ADAPTER_PROFILES) {
    if (adapter.instructionOutputPath) {
      const instructionContent = adapter.instructionTemplatePath
        ? `${readText(join(root, adapter.instructionTemplatePath)).trim()}\n`
        : renderInstructionTemplate(defaultInstructionTemplate, adapter.host, adapter.adapterLabel);
      writeText(join(root, adapter.instructionOutputPath), instructionContent);
    }

    if (adapter.skillOutputRoot) {
      const outputRoot = join(root, adapter.skillOutputRoot);
      ensureDir(outputRoot);
      for (const spec of COMMAND_SPECS) {
        writeText(join(outputRoot, spec.id, "SKILL.md"), renderSkill(adapter.host, version, spec));
      }
      if (adapter.installedSkillRoot && adapter.versionStampPath) {
        for (const commandId of TEMPLATE_COMMAND_IDS) {
          const template = readText(join(templateRoot, `${commandId}.md.tmpl`));
          writeText(
            join(outputRoot, commandId, "SKILL.md"),
            renderSkillTemplate(template, adapter.host, version, adapter.installedSkillRoot, adapter.versionStampPath)
          );
        }
      }
    }

    if (adapter.commandOutputRoot && adapter.installedCommandRoot && adapter.versionStampPath) {
      const outputRoot = join(root, adapter.commandOutputRoot);
      ensureDir(outputRoot);
      for (const spec of COMMAND_SPECS) {
        writeText(join(outputRoot, `${spec.id}.md`), renderOpencodeCommand(version, spec));
      }
      for (const commandId of TEMPLATE_COMMAND_IDS) {
        const template = readText(join(templateRoot, `${commandId}.md.tmpl`));
        writeText(
          join(outputRoot, `${commandId}.md`),
          renderOpencodeTemplateCommand(template, commandId, version, adapter.installedCommandRoot, adapter.versionStampPath),
        );
      }
    }

    if (adapter.workflowOutputRoot) {
      const outputRoot = join(root, adapter.workflowOutputRoot);
      ensureDir(outputRoot);
      for (const spec of COMMAND_SPECS) {
        writeText(join(outputRoot, `${spec.id}.md`), renderWindsurfWorkflow(spec));
      }
    }

    if (adapter.rulesOutputRoot) {
      writeText(join(root, adapter.rulesOutputRoot, "ai-office-workspace.md"), `${WINDSURF_RULE_BODY.trim()}\n`);
    }
  }

  writeText(join(root, "generated/adapter-metadata.sh"), renderShellMetadata());
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
