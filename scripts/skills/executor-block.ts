import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  executorBlockEnd,
  executorBlockStart,
} from "./package-validation.ts";
import { repositoryRoot } from "./shared.ts";
import { transferCoreFacts } from "./transfer-contract.ts";
import { renderClaudeTransferRow } from "./claude-transfer.ts";
import { renderCodexTransferRow } from "./codex-transfer.ts";

/**
 * Generator for the `task-delivery` SKILL.md executor block (M19-T4): the
 * block is the only executor-specific part of the skill, so it is rendered
 * here from the shared transfer contract plus per-executor adapters, and
 * `bun run skills:install` then ships the rendered block to every executor
 * location. The skill validation compares the checked-in block with
 * {@link renderExecutorsBlock}, so the file cannot drift from the contract.
 */

/** The continuity transfer table, one row per adapter executor. */
export function renderContinuityTransferTable(): string {
  return [
    "| Executor | Questions | Where checkpoints and the handoff live | Agent to person |",
    "| -------- | --------- | -------------------------------------- | --------------- |",
    renderClaudeTransferRow(transferCoreFacts),
    renderCodexTransferRow(transferCoreFacts),
    `| Every other executor | through the executor's own question mechanism | ${transferCoreFacts.checkpointsLocation} and ${transferCoreFacts.handoffLocation} | ${transferCoreFacts.agentToPerson} |`,
  ].join("\n");
}

/**
 * The full content between the executor block markers: the mapping table is
 * static skill text, the continuity transfer table is rendered from the
 * contract and the adapters.
 */
export function renderExecutorsBlock(): string {
  return [
    "",
    "## Executor mapping",
    "",
    "This block is the only executor-specific part of the skill. It translates the",
    "roles above into the primitives each executor offers.",
    "",
    "| Executor    | Skill location                 | Invoke                 | Independent context for review and verification                        |",
    "| ----------- | ------------------------------ | ---------------------- | ---------------------------------------------------------------------- |",
    "| Claude Code | `.claude/skills/task-delivery` | `/task-delivery`       | A fresh subagent given the task, acceptance criteria, and diff only    |",
    "| Codex       | `.agents/skills/task-delivery` | `$task-delivery`       | A separate session or non-interactive run started from a clean context |",
    "| Pi          | `.agents/skills/task-delivery` | `/skill:task-delivery` | A separate session started from a clean context                        |",
    "| Other       | wherever the executor reads it | as the executor allows | Another session, another agent, or another person who did not write it |",
    "",
    "For any executor: never pass the implementer's conclusions to the reviewer or",
    "verifier, and never let the context that wrote a change approve it.",
    "",
    "**External reviewer on Claude Code.** Codex, when present in the session - a",
    "Codex skill or plugin, or the `codex` command - is an available external",
    "reviewer for stage 9. Its presence alone does not make it required: it is best",
    "effort unless the project configures it or the authorizer requests it.",
    "",
    "**Continuity transfer.** Checkpoints and handoffs stay executor-neutral; an",
    "adapter only names how the executor asks questions and moves the packet:",
    "",
    renderContinuityTransferTable(),
    "",
  ].join("\n");
}

/** Reads the checked-in executor block of one SKILL.md, or null when absent. */
export function readExecutorsBlock(skillMd: string): string | null {
  const starts = skillMd.split(executorBlockStart).length - 1;
  const ends = skillMd.split(executorBlockEnd).length - 1;
  if (starts !== 1 || ends !== 1) return null;
  const startIndex = skillMd.indexOf(executorBlockStart);
  const endIndex = skillMd.indexOf(executorBlockEnd);
  if (endIndex < startIndex) return null;
  return skillMd.slice(
    startIndex + executorBlockStart.length,
    endIndex,
  );
}

/** Rewrites the executor block of the canonical SKILL.md; returns true when it changed. */
export function syncExecutorsBlock(
  skillRoot: string = join(repositoryRoot, "skills", "task-delivery"),
): boolean {
  const path = join(skillRoot, "SKILL.md");
  const source = readFileSync(path, "utf8");
  const current = readExecutorsBlock(source);
  if (current === null)
    throw new Error("SKILL.md has no well-formed executor block to rewrite");
  const rendered = renderExecutorsBlock();
  if (current === rendered) return false;
  const startIndex = source.indexOf(executorBlockStart);
  const endIndex = source.indexOf(executorBlockEnd);
  const next =
    source.slice(0, startIndex + executorBlockStart.length) +
    rendered +
    source.slice(endIndex);
  writeFileSync(path, next);
  return true;
}

if (import.meta.main) {
  const changed = syncExecutorsBlock();
  console.log(
    changed
      ? "Rewrote the task-delivery SKILL.md executor block."
      : "The task-delivery SKILL.md executor block is already in sync.",
  );
}
