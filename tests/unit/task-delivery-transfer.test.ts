import { afterEach, describe, expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderClaudeTransferRow,
  claudeQuestionPhrase,
} from "../../scripts/skills/claude-transfer.ts";
import {
  renderCodexTransferRow,
  codexQuestionPhrase,
} from "../../scripts/skills/codex-transfer.ts";
import {
  renderContinuityTransferTable,
  renderExecutorsBlock,
  readExecutorsBlock,
} from "../../scripts/skills/executor-block.ts";
import {
  transferCoreFacts,
  transferExecutors,
} from "../../scripts/skills/transfer-contract.ts";
import {
  assessResume,
  parseCheckpoint,
  publishCheckpoint,
  type GitStateProvider,
} from "../../scripts/skills/checkpoint-store.ts";
import { repositoryRoot } from "../../scripts/skills/shared.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("continuity transfer adapters", () => {
  test("every adapter is registered exactly once in the contract", () => {
    expect([...transferExecutors].sort()).toEqual(["Claude Code", "Codex"]);
  });

  test("both renderers emit the identical core facts and differ only in the question phrase", () => {
    const claude = renderClaudeTransferRow(transferCoreFacts);
    const codex = renderCodexTransferRow(transferCoreFacts);
    for (const fact of Object.values(transferCoreFacts)) {
      expect(claude).toContain(fact);
      expect(codex).toContain(fact);
    }
    expect(claude).toContain(claudeQuestionPhrase);
    expect(codex).toContain(codexQuestionPhrase);
    expect(claudeQuestionPhrase).not.toEqual(codexQuestionPhrase);
    // Everything but the executor name and the question phrase is shared
    // text: normalize both and the rows must be byte-identical.
    const strip = (row: string, name: string, phrase: string) =>
      row.replace(`| ${name} | ${phrase} |`, "| EXECUTOR | QUESTIONS |");
    expect(strip(claude, "Claude Code", claudeQuestionPhrase)).toBe(
      strip(codex, "Codex", codexQuestionPhrase),
    );
  });

  test("the rendered table names both adapters and the shared facts", () => {
    const table = renderContinuityTransferTable();
    for (const executor of transferExecutors)
      expect(table).toContain(`| ${executor} |`);
    expect(table).toContain("Every other executor");
    expect(table).toContain(transferCoreFacts.checkpointsLocation);
    expect(table).toContain(transferCoreFacts.handoffLocation);
    expect(table).toContain(transferCoreFacts.agentToPerson);
  });

  test("the executors block stays within its line budget and matches the checked-in block", () => {
    const block = renderExecutorsBlock();
    // The content between the markers mirrors the split used by validation.
    expect(block.split("\n").length).toBeLessThanOrEqual(40);
    const skillMd = readFileSync(
      join(repositoryRoot, "skills", "task-delivery", "SKILL.md"),
      "utf8",
    );
    expect(readExecutorsBlock(skillMd)).toBe(block);
  });
});

describe("transfer round-trip through the checkpoint store", () => {
  const git: GitStateProvider = {
    headSha: () => "a".repeat(40),
    dirtyPaths: () => [],
  };

  function publishInput() {
    return {
      task: "task-1",
      branch: "feat/task-1",
      base: "main",
      profile: "standard",
      gate: "implementation",
      nextAction: "open the pull request",
      knowledgeReferences: ["ak:memory:ak_mem_1"],
    };
  }

  test("a published checkpoint parses back and assesses as resumable", () => {
    const root = mkdtempSync(join(tmpdir(), "task-delivery-transfer-"));
    temporaryDirectories.push(root);
    const taskDirectory = join(root, ".task-delivery", "task-1");
    const { checkpoint } = publishCheckpoint(
      taskDirectory,
      publishInput(),
      git,
      {
        now: () => new Date("2026-10-09T12:00:00.000Z"),
        idGen: () => "checkpoint-1",
      },
    );

    // The transfer facts name exactly where the store put the checkpoint.
    expect(join(taskDirectory, "checkpoints", "0001.json")).toBe(
      join(root, ".task-delivery", "task-1", "checkpoints", "0001.json"),
    );

    const body = `${JSON.stringify(checkpoint, null, 2)}\n`;
    const parsed = parseCheckpoint(body);
    expect(parsed).toEqual(checkpoint);

    const assessment = assessResume(taskDirectory, git);
    expect(assessment.usable).toBe(true);
    expect(assessment.checkpoint?.id).toBe("checkpoint-1");
    expect(assessment.headChanged).toBe(false);
    expect(assessment.invalidKnowledgeReferences).toEqual([]);
  });

  test("a checkpoint moved across the transfer still parses and assesses", () => {
    const origin = mkdtempSync(join(tmpdir(), "task-delivery-transfer-origin-"));
    const target = mkdtempSync(join(tmpdir(), "task-delivery-transfer-target-"));
    temporaryDirectories.push(origin, target);
    const { checkpoint } = publishCheckpoint(
      join(origin, ".task-delivery", "task-1"),
      publishInput(),
      git,
      {
        now: () => new Date("2026-10-09T12:00:00.000Z"),
        idGen: () => "checkpoint-2",
      },
    );

    // The packet moves executor-neutral: copy the directory, re-validate.
    const movedTaskDirectory = join(target, ".task-delivery", "task-1");
    mkdirSync(movedTaskDirectory, { recursive: true });
    cpSync(
      join(origin, ".task-delivery", "task-1"),
      movedTaskDirectory,
      { recursive: true },
    );

    const parsed = parseCheckpoint(
      JSON.stringify(checkpoint, null, 2),
    );
    expect(parsed.run.task).toBe("task-1");
    const assessment = assessResume(movedTaskDirectory, {
      headSha: () => parsed.head.sha,
      dirtyPaths: () => [],
    });
    expect(assessment.usable).toBe(true);
    expect(assessment.checkpoint?.id).toBe("checkpoint-2");
  });
});
