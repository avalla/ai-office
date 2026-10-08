import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessResume,
  CheckpointExistsError,
  CheckpointFormatError,
  defaultCheckpointRetentionCap,
  listCheckpoints,
  parseCheckpoint,
  pruneCheckpoints,
  publishCheckpoint,
  taskCheckpointDirectory,
  type GitStateProvider,
  type PublishCheckpointInput,
} from "../../scripts/skills/checkpoint-store.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-store-"));
  temporaryDirectories.push(root);
  return root;
}

const cleanSha = "ab".repeat(20);
const dirtySha = "cd".repeat(20);

function fakeGit(sha: string, dirtyPaths: readonly string[] = []): GitStateProvider {
  return { headSha: () => sha, dirtyPaths: () => dirtyPaths };
}

let idCounter = 0;

beforeEach(() => {
  idCounter = 0;
});

function deterministicOptions(retentionCap?: number) {
  return {
    now: () => new Date("2026-10-08T12:00:00.000Z"),
    idGen: () => `checkpoint-id-${(idCounter += 1)}`,
    ...(retentionCap === undefined ? {} : { retentionCap }),
  };
}

function baseInput(overrides: Partial<PublishCheckpointInput> = {}): PublishCheckpointInput {
  return {
    task: "M19-T2",
    milestone: "55afba0f",
    branch: "feat/m19-t2-checkpoints",
    base: "main",
    profile: "full",
    gate: "design",
    nextAction: "open the pull request",
    ...overrides,
  };
}

function taskDir(root: string, name = "M19-T2"): string {
  return taskCheckpointDirectory(root, name);
}

describe("publishCheckpoint", () => {
  test("publishes the first checkpoint with sequence 1 and no supersedes", () => {
    const root = temporaryRoot();
    const { checkpoint, pruned } = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.stage.seq).toBe(1);
    expect(checkpoint.supersedes).toBeNull();
    expect(checkpoint.head).toEqual({
      sha: cleanSha,
      dirty: false,
      dirtyPaths: [],
      capturedAt: "2026-10-08T12:00:00.000Z",
    });
    expect(pruned).toEqual([]);
    expect(checkpoint.run.task).toBe("M19-T2");
    expect(checkpoint.id).toBe("checkpoint-id-1");
    const file = join(
      taskDir(root),
      "checkpoints",
      "000001-design.json",
    );
    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
    const index = JSON.parse(
      readFileSync(join(taskDir(root), "checkpoints", "index.json"), "utf8"),
    ) as { latest: { seq: number; file: string; id: string; sha256: string } };
    expect(index.latest.seq).toBe(1);
    expect(index.latest.file).toBe("000001-design.json");
    expect(index.latest.id).toBe(checkpoint.id);
  });

  test("each publish supersedes the previous one and bumps the sequence", () => {
    const root = temporaryRoot();
    const first = publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation", nextAction: "write the module" }),
      fakeGit(cleanSha, ["scripts/new.ts"]),
      deterministicOptions(),
    );
    expect(second.checkpoint.stage.seq).toBe(2);
    expect(second.checkpoint.supersedes).toBe(first.checkpoint.id);
    expect(second.checkpoint.head.dirty).toBe(true);
    expect(second.checkpoint.head.dirtyPaths).toEqual(["scripts/new.ts"]);
    expect(listCheckpoints(taskDir(root)).map((c) => c.stage.seq)).toEqual([1, 2]);
  });

  test("captures evidence, findings, decisions, dependencies, limitations and knowledge references", () => {
    const root = temporaryRoot();
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput({
        gate: "review",
        evidence: [
          {
            claim: "bun run check is green",
            ref: { kind: "command", value: "bun run check" },
          },
          {
            claim: "the diff is attached",
            ref: {
              kind: "file",
              value: "patches/0001.diff",
              sha256: "ef".repeat(32),
            },
          },
        ],
        openFindings: [{ id: "R1", severity: "major", status: "open" }],
        decisions: [{ what: "layout per-task", authorizedBy: "authorizer" }],
        unresolvedDependencies: ["M19-T1"],
        knownLimitations: ["no Runtime storage"],
        knowledgeReferences: ["knowledge://record/1"],
        nextAction: "answer R1",
      }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.evidence).toHaveLength(2);
    expect(checkpoint.openFindings).toEqual([
      { id: "R1", severity: "major", status: "open" },
    ]);
    expect(checkpoint.decisions).toEqual([
      { what: "layout per-task", authorizedBy: "authorizer" },
    ]);
    expect(checkpoint.unresolvedDependencies).toEqual(["M19-T1"]);
    expect(checkpoint.knownLimitations).toEqual(["no Runtime storage"]);
    expect(checkpoint.knowledgeReferences).toEqual(["knowledge://record/1"]);
  });

  test("rejects an unsafe gate, an empty next action, and a non-sha head", () => {
    const root = temporaryRoot();
    expect(() =>
      publishCheckpoint(taskDir(root), baseInput({ gate: "Design" }), fakeGit(cleanSha), deterministicOptions()),
    ).toThrow(/gate must be lowercase/);
    expect(() =>
      publishCheckpoint(taskDir(root), baseInput({ gate: "../escape" }), fakeGit(cleanSha), deterministicOptions()),
    ).toThrow(/gate must be lowercase/);
    expect(() =>
      publishCheckpoint(taskDir(root), baseInput({ nextAction: "  " }), fakeGit(cleanSha), deterministicOptions()),
    ).toThrow(/nextAction must not be empty/);
    expect(() =>
      publishCheckpoint(taskDir(root), baseInput(), fakeGit("not-a-sha"), deterministicOptions()),
    ).toThrow(/not a full commit sha/);
  });

  test("loses a race with a typed error instead of overwriting", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    // A concurrent publisher lands on the next sequence name first.
    writeFileSync(
      join(taskDir(root), "checkpoints", "000002-implementation.json"),
      "{}",
    );
    let error: unknown;
    try {
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: "implementation" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CheckpointExistsError);
    expect((error as CheckpointExistsError).seq).toBe(2);
    expect(readFileSync(join(taskDir(root), "checkpoints", "000002-implementation.json"), "utf8")).toBe("{}");
  });
});

describe("parseCheckpoint", () => {
  const valid = () =>
    publishCheckpoint(taskDir(temporaryRoot()), baseInput(), fakeGit(cleanSha), deterministicOptions()).checkpoint;

  test("round-trips a published checkpoint", () => {
    const checkpoint = valid();
    expect(parseCheckpoint(JSON.stringify(checkpoint))).toEqual(checkpoint);
  });

  test.each([
    ["not JSON", "{", /not valid JSON/],
    ["a non-object document", "[]", /must be an object/],
    [
      "an unsupported schemaVersion",
      JSON.stringify({ ...valid(), schemaVersion: 2 }),
      /schemaVersion is 2.*exactly 1/,
    ],
    [
      "a string schemaVersion",
      JSON.stringify({ ...valid(), schemaVersion: "1" }),
      /schemaVersion is 1.*exactly 1/,
    ],
    [
      "an unknown top-level key",
      JSON.stringify({ ...valid(), future: true }),
      /unknown key "future"/,
    ],
    [
      "a missing next action",
      JSON.stringify(Object.fromEntries(Object.entries(valid()).filter(([k]) => k !== "nextAction"))),
      /nextAction must be a non-empty string/,
    ],
    [
      "an inconsistent dirty flag",
      JSON.stringify({
        ...valid(),
        head: { sha: cleanSha, dirty: false, dirtyPaths: ["a.ts"], capturedAt: "2026-10-08T12:00:00.000Z" },
      }),
      /dirty must be a boolean consistent with dirtyPaths/,
    ],
    [
      "an absolute dirty path",
      JSON.stringify({
        ...valid(),
        head: { sha: cleanSha, dirty: true, dirtyPaths: ["/etc/passwd"], capturedAt: "2026-10-08T12:00:00.000Z" },
      }),
      /not a relative in-repository path/,
    ],
    [
      "a parent-traversing dirty path",
      JSON.stringify({
        ...valid(),
        head: { sha: cleanSha, dirty: true, dirtyPaths: ["../escape"], capturedAt: "2026-10-08T12:00:00.000Z" },
      }),
      /not a relative in-repository path/,
    ],
    [
      "a non-sha head",
      JSON.stringify({
        ...valid(),
        head: { sha: "abc", dirty: false, dirtyPaths: [], capturedAt: "2026-10-08T12:00:00.000Z" },
      }),
      /checkpoint.head.sha has an invalid value/,
    ],
    [
      "a file evidence without sha256",
      JSON.stringify({
        ...valid(),
        evidence: [{ claim: "x", ref: { kind: "file", value: "log.txt" } }],
      }),
      /sha256 is required for a file reference/,
    ],
    [
      "an unknown evidence kind",
      JSON.stringify({
        ...valid(),
        evidence: [{ claim: "x", ref: { kind: "screenshot", value: "s.png" } }],
      }),
      /must be command, link, or file/,
    ],
    [
      "a zero sequence",
      JSON.stringify({ ...valid(), stage: { gate: "design", seq: 0 } }),
      /seq must be an integer >= 1/,
    ],
    [
      "a fractional sequence",
      JSON.stringify({ ...valid(), stage: { gate: "design", seq: 1.5 } }),
      /seq must be an integer >= 1/,
    ],
    [
      "a pre-2000 timestamp",
      JSON.stringify({ ...valid(), publishedAt: "1999-12-31T23:59:59.000Z" }),
      /not an ISO timestamp/,
    ],
  ])("rejects %s", (_label, raw, pattern) => {
    expect(() => parseCheckpoint(raw)).toThrow(pattern);
  });

  test("rejects a checkpoint whose run is missing", () => {
    const checkpoint = valid() as unknown as Record<string, unknown>;
    delete checkpoint.run;
    expect(() => parseCheckpoint(JSON.stringify(checkpoint))).toThrow(
      /checkpoint.run must be an object/,
    );
  });
});

describe("taskCheckpointDirectory", () => {
  test("builds a per-task directory under the repository root", () => {
    const root = temporaryRoot();
    expect(taskCheckpointDirectory(root, "M19-T2")).toBe(
      join(root, ".task-delivery", "M19-T2"),
    );
  });

  test("rejects a relative root and an unsafe name", () => {
    expect(() => taskCheckpointDirectory("relative/root", "task")).toThrow(
      /must be an absolute path/,
    );
    expect(() => taskCheckpointDirectory(temporaryRoot(), "a/b")).toThrow(
      /single safe path segment/,
    );
    expect(() => taskCheckpointDirectory(temporaryRoot(), "..")).toThrow(
      /single safe path segment/,
    );
  });
});

describe("crash recovery", () => {
  test("recovers the latest checkpoint when the index is lost", () => {
    const root = temporaryRoot();
    const first = publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    rmSync(join(taskDir(root), "checkpoints", "index.json"));
    const third = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(third.checkpoint.stage.seq).toBe(3);
    expect(third.checkpoint.supersedes).toBe(second.checkpoint.id);
    expect(first.checkpoint.id).not.toBe(second.checkpoint.id);
  });

  test("ignores leftover temp files from a crashed publish", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    writeFileSync(join(taskDir(root), "checkpoints", ".tmp-deadbeef"), "{}");
    const recovered = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(recovered.checkpoint.stage.seq).toBe(2);
    expect(listCheckpoints(taskDir(root))).toHaveLength(2);
  });

  test("skips published files whose name disagrees with their content", () => {
    const root = temporaryRoot();
    const { checkpoint } = publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    // A hand-edited copy with a mismatched sequence is not the latest.
    const renamed = { ...checkpoint, stage: { gate: "design", seq: 9 } };
    writeFileSync(
      join(taskDir(root), "checkpoints", "000009-design.json"),
      JSON.stringify(renamed),
    );
    const next = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(next.checkpoint.stage.seq).toBe(2);
  });
});

describe("assessResume", () => {
  test("reports a clean resume when head and tree match", () => {
    const root = temporaryRoot();
    const { checkpoint } = publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(true);
    expect(assessment.invalidReason).toBeNull();
    expect(assessment.checkpoint?.id).toBe(checkpoint.id);
    expect(assessment.headChanged).toBe(false);
    expect(assessment.recordedHead).toBe(cleanSha);
    expect(assessment.dirty).toBe(false);
  });

  test("reports a head change without invalidating the checkpoint itself", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const assessment = assessResume(taskDir(root), fakeGit(dirtySha));
    expect(assessment.usable).toBe(true);
    expect(assessment.headChanged).toBe(true);
    expect(assessment.recordedHead).toBe(cleanSha);
    expect(assessment.liveHead).toBe(dirtySha);
  });

  test("reports a dirty live tree explicitly", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha, ["a.ts", "b.ts"]));
    expect(assessment.usable).toBe(true);
    expect(assessment.dirty).toBe(true);
    expect(assessment.dirtyPaths).toEqual(["a.ts", "b.ts"]);
  });

  test("reports the absence of any checkpoint", () => {
    const root = temporaryRoot();
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(false);
    expect(assessment.invalidReason).toMatch(/no checkpoint has been published/);
    expect(assessment.checkpoint).toBeNull();
  });

  test("refuses a checkpoint that fails the recorded hash", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const path = join(taskDir(root), "checkpoints", "000001-design.json");
    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()} tampered\n`);
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(false);
    expect(assessment.invalidReason).toMatch(/does not match the hash recorded/);
  });

  test("refuses an unsupported schema version rather than crashing", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const file = join(taskDir(root), "checkpoints", "000001-design.json");
    const tampered = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number };
    tampered.schemaVersion = 2;
    writeFileSync(file, JSON.stringify(tampered));
    const indexPath = join(taskDir(root), "checkpoints", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      latest: { sha256: string };
    };
    index.latest.sha256 = "00".repeat(32);
    writeFileSync(indexPath, JSON.stringify(index));
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(false);
    expect(assessment.invalidReason).toMatch(/does not match the hash recorded/);
  });
});

describe("retention", () => {
  test("does not prune below the default cap", () => {
    const root = temporaryRoot();
    for (let seq = 0; seq < 5; seq += 1)
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: `gate${seq}`, nextAction: `step ${seq}` }),
        fakeGit(cleanSha),
        deterministicOptions(),
      );
    expect(listCheckpoints(taskDir(root))).toHaveLength(5);
  });

  test("prunes the oldest beyond the cap after publishing, keeping the latest", () => {
    const root = temporaryRoot();
    const options = deterministicOptions(3);
    for (let seq = 0; seq < 5; seq += 1) {
      const { pruned } = publishCheckpoint(
        taskDir(root),
        baseInput({ gate: `gate${seq}`, nextAction: `step ${seq}` }),
        fakeGit(cleanSha),
        options,
      );
      if (seq < 3) expect(pruned).toEqual([]);
      else if (seq === 3) expect(pruned).toEqual(["000001-gate0.json"]);
      else expect(pruned).toEqual(["000002-gate1.json"]);
    }
    const remaining = listCheckpoints(taskDir(root));
    expect(remaining.map((c) => c.stage.seq)).toEqual([3, 4, 5]);
  });

  test("never prunes a checkpoint cited by the handoff packet", () => {
    const root = temporaryRoot();
    const options = deterministicOptions(2);
    const first = publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), options);
    publishCheckpoint(taskDir(root), baseInput({ gate: "implementation" }), fakeGit(cleanSha), options);
    mkdirSync(taskDir(root), { recursive: true });
    writeFileSync(
      join(taskDir(root), "handoff.md"),
      `Resume map; latest checkpoint ${first.checkpoint.id}.\n`,
    );
    const third = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      options,
    );
    // Cap 2 with 3 published: seq 1 is cited, seq 2 is the prune victim.
    expect(third.pruned).toEqual(["000002-implementation.json"]);
    expect(listCheckpoints(taskDir(root)).map((c) => c.stage.seq)).toEqual([1, 3]);
  });

  test("manual prune keeps the latest and the cited, deleting the rest", () => {
    const root = temporaryRoot();
    const options = deterministicOptions();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), options);
    const second = publishCheckpoint(taskDir(root), baseInput({ gate: "implementation" }), fakeGit(cleanSha), options);
    const third = publishCheckpoint(taskDir(root), baseInput({ gate: "pull_request" }), fakeGit(cleanSha), options);
    writeFileSync(
      join(taskDir(root), "handoff.md"),
      `cites ${second.checkpoint.id}\n`,
    );
    const deleted = pruneCheckpoints(taskDir(root), 1);
    expect(deleted).toEqual(["000001-design.json"]);
    expect(listCheckpoints(taskDir(root))).toHaveLength(2);
    expect(third.checkpoint.id).not.toBe(second.checkpoint.id);
    expect(defaultCheckpointRetentionCap).toBe(20);
  });
});

describe("format errors surface as store errors", () => {
  test("parseCheckpoint throws the typed format error", () => {
    expect(() => parseCheckpoint("{}")).toThrow(CheckpointFormatError);
  });
});
