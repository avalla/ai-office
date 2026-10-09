import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessResume,
  CheckpointFormatError,
  decodeCheckpointDirectoryName,
  defaultCheckpointRetentionCap,
  encodeCheckpointDirectoryName,
  listCheckpoints,
  parseCheckpoint,
  pruneCheckpoints,
  publishCheckpoint,
  reservationGraceMs,
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

function fakeGit(
  sha: string,
  dirtyPaths: readonly string[] = [],
): GitStateProvider {
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

function baseInput(
  overrides: Partial<PublishCheckpointInput> = {},
): PublishCheckpointInput {
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

function checkpointsDir(root: string): string {
  return join(taskDir(root), "checkpoints");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Backdates a file past the reservation grace period, as a prior crash would. */
function agePastGrace(path: string): void {
  const past = new Date(Date.now() - reservationGraceMs * 2);
  utimesSync(path, past, past);
}

describe("publishCheckpoint", () => {
  test("publishes the first checkpoint with sequence 1 and no supersedes", () => {
    const root = temporaryRoot();
    const { checkpoint, pruned, pruneError } = publishCheckpoint(
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
    expect(pruneError).toBeNull();
    expect(checkpoint.run.task).toBe("M19-T2");
    expect(checkpoint.id).toBe("checkpoint-id-1");
    const file = join(checkpointsDir(root), "000001.json");
    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
    const index = JSON.parse(
      readFileSync(join(checkpointsDir(root), "index.json"), "utf8"),
    ) as { latest: { seq: number; file: string; id: string; sha256: string } };
    expect(index.latest.seq).toBe(1);
    expect(index.latest.file).toBe("000001.json");
    expect(index.latest.id).toBe(checkpoint.id);
  });

  test("each publish supersedes the previous one and bumps the sequence", () => {
    const root = temporaryRoot();
    const first = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
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
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: "Design" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/gate must be lowercase/);
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: "../escape" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/gate must be lowercase/);
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput({ nextAction: "  " }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/nextAction must not be empty/);
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput(),
        fakeGit("not-a-sha"),
        deterministicOptions(),
      ),
    ).toThrow(/not a full commit sha/);
  });

  test("refuses to publish a document its own reader would reject", () => {
    const root = temporaryRoot();
    // Write/read symmetry: a provider handing absolute dirty paths must fail
    // at publish time, not surface later as a "corrupt checkpoint".
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput(),
        fakeGit(cleanSha, ["/etc/passwd"]),
        deterministicOptions(),
      ),
    ).toThrow(/refusing to publish a checkpoint its own reader would reject/);
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput({ task: "bad/task" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/refusing to publish a checkpoint its own reader would reject/);
  });

  test("recovers from a colliding corrupt artifact instead of deadlocking", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    // A crashed or hand-dropped file, old enough to be a crash artifact,
    // occupies the next sequence name.
    const artifact = join(checkpointsDir(root), "000002.json");
    writeFileSync(artifact, "{}");
    agePastGrace(artifact);
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.stage.seq).toBe(2);
    expect(
      parseCheckpoint(readFileSync(join(checkpointsDir(root), "000002.json"), "utf8")).id,
    ).toBe(checkpoint.id);
  });

  test("removes a zero-byte reservation artifact left by a crash", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const artifact = join(checkpointsDir(root), "000002.json");
    writeFileSync(artifact, "");
    agePastGrace(artifact);
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.stage.seq).toBe(2);
    expect(readFileSync(join(checkpointsDir(root), "000002.json"), "utf8")).not.toBe("");
  });

  test("a fresh in-flight reservation is never deleted, and surfaces contention", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    // A concurrent publisher's live reservation: zero-byte and young.
    writeFileSync(join(checkpointsDir(root), "000002.json"), "");
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: "implementation" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/concurrent publisher won the sequence/);
    expect(readFileSync(join(checkpointsDir(root), "000002.json"), "utf8")).toBe("");
  });

  test("a fresh in-flight reservation is skipped by listCheckpoints, not thrown", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    writeFileSync(join(checkpointsDir(root), "000002.json"), "");
    const listed = listCheckpoints(taskDir(root));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stage.seq).toBe(1);
  });

  test("a fresh corrupt file at the next sequence surfaces contention, not deletion", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const path = join(checkpointsDir(root), "000002.json");
    writeFileSync(path, "{}");
    expect(() =>
      publishCheckpoint(
        taskDir(root),
        baseInput({ gate: "implementation" }),
        fakeGit(cleanSha),
        deterministicOptions(),
      ),
    ).toThrow(/concurrent publisher won the sequence/);
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test("never forks the sequence when a valid checkpoint occupies the next name", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    // A sibling at the next sequence whose name disagrees with its content
    // is an aged artifact, not a checkpoint; it is removed and the sequence
    // reused.
    const { checkpoint: orphan } = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    const artifact = join(checkpointsDir(root), "000003.json");
    writeFileSync(
      artifact,
      JSON.stringify({ ...orphan, stage: { gate: "implementation", seq: 2 } }),
    );
    agePastGrace(artifact);
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.stage.seq).toBe(3);
    expect(listCheckpoints(taskDir(root))).toHaveLength(3);
  });
});

describe("parseCheckpoint", () => {
  const valid = () =>
    publishCheckpoint(
      taskDir(temporaryRoot()),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    ).checkpoint;

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
      JSON.stringify(
        Object.fromEntries(
          Object.entries(valid()).filter(([k]) => k !== "nextAction"),
        ),
      ),
      /nextAction must be a non-empty string/,
    ],
    [
      "an inconsistent dirty flag",
      JSON.stringify({
        ...valid(),
        head: {
          sha: cleanSha,
          dirty: false,
          dirtyPaths: ["a.ts"],
          capturedAt: "2026-10-08T12:00:00.000Z",
        },
      }),
      /dirty must be a boolean consistent with dirtyPaths/,
    ],
    [
      "an absolute dirty path",
      JSON.stringify({
        ...valid(),
        head: {
          sha: cleanSha,
          dirty: true,
          dirtyPaths: ["/etc/passwd"],
          capturedAt: "2026-10-08T12:00:00.000Z",
        },
      }),
      /not a relative in-repository path/,
    ],
    [
      "a parent-traversing dirty path",
      JSON.stringify({
        ...valid(),
        head: {
          sha: cleanSha,
          dirty: true,
          dirtyPaths: ["../escape"],
          capturedAt: "2026-10-08T12:00:00.000Z",
        },
      }),
      /not a relative in-repository path/,
    ],
    [
      "a non-sha head",
      JSON.stringify({
        ...valid(),
        head: {
          sha: "abc",
          dirty: false,
          dirtyPaths: [],
          capturedAt: "2026-10-08T12:00:00.000Z",
        },
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
      "a garbage timestamp",
      JSON.stringify({ ...valid(), publishedAt: "zzzz" }),
      /not an ISO-8601 UTC timestamp/,
    ],
    [
      "an overflowing timestamp",
      JSON.stringify({ ...valid(), publishedAt: "2026-13-45T99:99:99.000Z" }),
      /not an ISO-8601 UTC timestamp|not a valid ISO-8601 UTC timestamp/,
    ],
    [
      "a timestamp without milliseconds",
      JSON.stringify({ ...valid(), publishedAt: "2026-10-08T12:00:00Z" }),
      /not an ISO-8601 UTC timestamp/,
    ],
    [
      "a pre-2000 timestamp",
      JSON.stringify({ ...valid(), publishedAt: "1999-12-31T23:59:59.000Z" }),
      /not a valid ISO-8601 UTC timestamp/,
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

  test("rejects a relative root and an empty name", () => {
    expect(() => taskCheckpointDirectory("relative/root", "task")).toThrow(
      /must be an absolute path/,
    );
    expect(() => taskCheckpointDirectory(temporaryRoot(), "")).toThrow(
      /must not be empty/,
    );
  });
});

describe("checkpoint directory name encoding", () => {
  test("keeps valid identifiers unchanged", () => {
    for (const name of ["M19-T2", "task-1", "main", "GP 14.5_x"])
      expect(encodeCheckpointDirectoryName(name)).toBe(name);
  });

  test("encodes a slash-delimited branch name deterministically", () => {
    expect(encodeCheckpointDirectoryName("feat/m19-t2-checkpoints")).toBe(
      "_666561742f6d31392d74322d636865636b706f696e7473",
    );
    // The encoding is a pure function of the name.
    expect(encodeCheckpointDirectoryName("feat/m19-t2-checkpoints")).toBe(
      encodeCheckpointDirectoryName("feat/m19-t2-checkpoints"),
    );
  });

  test("the encoded branch directory sits under .task-delivery as one segment", () => {
    const root = temporaryRoot();
    const directory = taskCheckpointDirectory(root, "feat/m19-t2-checkpoints");
    expect(directory).toBe(
      join(
        root,
        ".task-delivery",
        "_666561742f6d31392d74322d636865636b706f696e7473",
      ),
    );
    expect(directory.startsWith(join(root, ".task-delivery"))).toBe(true);
  });

  test("round-trips special characters and cannot traverse", () => {
    const names = ["feature/äöü·@", "../escape", "..", "a/b/c", "x\\y"];
    for (const name of names) {
      const encoded = encodeCheckpointDirectoryName(name);
      expect(decodeCheckpointDirectoryName(encoded)).toBe(name);
      expect(encoded).toMatch(/^[0-9a-zA-Z ._-]+$/u);
      expect(encoded.split("/")).toHaveLength(1);
    }
  });

  test("encoded names cannot collide with plain identifiers", () => {
    const encoded = encodeCheckpointDirectoryName("feat/x");
    expect(encoded.startsWith("_")).toBe(true);
    // A leading underscore is outside the plain-identifier grammar, so no
    // task identifier can name this directory by accident.
    expect(encoded === "feat/x").toBe(false);
    expect(
      encodeCheckpointDirectoryName("other/branch"),
    ).not.toBe(encoded);
  });

  test("decoding rejects malformed names", () => {
    expect(() => decodeCheckpointDirectoryName("_zz")).toThrow(
      CheckpointFormatError,
    );
    expect(() => decodeCheckpointDirectoryName("_")).toThrow(
      CheckpointFormatError,
    );
    expect(() => decodeCheckpointDirectoryName("bad/name")).toThrow(
      CheckpointFormatError,
    );
  });

  test("refuses names too long to encode within a filename limit", () => {
    expect(() => encodeCheckpointDirectoryName("x".repeat(200))).toThrow(
      /too long to encode/,
    );
  });

  test("publishing into a branch-named directory works end to end", () => {
    const root = temporaryRoot();
    const { checkpoint } = publishCheckpoint(
      taskCheckpointDirectory(root, "feat/m19-t2-checkpoints"),
      baseInput({ task: null }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(checkpoint.stage.seq).toBe(1);
    expect(
      existsSync(
        join(
          taskCheckpointDirectory(root, "feat/m19-t2-checkpoints"),
          "checkpoints",
          "000001.json",
        ),
      ),
    ).toBe(true);
  });
});

describe("crash recovery", () => {
  test("recovers the latest checkpoint when the index is lost", () => {
    const root = temporaryRoot();
    const first = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    rmSync(join(checkpointsDir(root), "index.json"));
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

  test("a stale-but-valid index does not hide a newer published checkpoint", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    // The documented crash: between the checkpoint rename and the index
    // rename. Rewind the index to the first entry, as that crash would.
    const firstBytes = readFileSync(join(checkpointsDir(root), "000001.json"));
    const first = parseCheckpoint(firstBytes.toString("utf8"));
    const staleIndex = {
      schemaVersion: 1,
      latest: {
        seq: 1,
        file: "000001.json",
        id: first.id,
        sha256: sha256(firstBytes),
      },
      updatedAt: first.publishedAt,
    };
    writeFileSync(
      join(checkpointsDir(root), "index.json"),
      JSON.stringify(staleIndex),
    );
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(true);
    expect(assessment.checkpoint?.id).toBe(second.checkpoint.id);
    expect(assessment.checkpoint?.stage.seq).toBe(2);
    // And publishing does not deadlock or fork: it continues at sequence 3.
    const third = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(third.checkpoint.stage.seq).toBe(3);
    expect(third.checkpoint.supersedes).toBe(second.checkpoint.id);
  });

  test("a corrupt index falls back to the scan and is rewritten on publish", () => {
    const root = temporaryRoot();
    const first = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    writeFileSync(join(checkpointsDir(root), "index.json"), "not json");
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(true);
    expect(assessment.checkpoint?.id).toBe(first.checkpoint.id);
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    expect(second.checkpoint.stage.seq).toBe(2);
    expect(second.checkpoint.supersedes).toBe(first.checkpoint.id);
    const index = JSON.parse(
      readFileSync(join(checkpointsDir(root), "index.json"), "utf8"),
    ) as { latest: { seq: number } };
    expect(index.latest.seq).toBe(2);
  });

  test("ignores leftover temp files from a crashed publish", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    writeFileSync(join(checkpointsDir(root), ".tmp-deadbeef"), "{}");
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
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
    const mismatched = { ...checkpoint, stage: { gate: "design", seq: 2 } };
    writeFileSync(
      join(checkpointsDir(root), "000009.json"),
      JSON.stringify(mismatched),
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
    const { checkpoint } = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      deterministicOptions(),
    );
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
    const path = join(checkpointsDir(root), "000001.json");
    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()} tampered\n`);
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(false);
    expect(assessment.invalidReason).toMatch(/does not match the hash recorded/);
  });

  test("refuses an unsupported schema version rather than crashing", () => {
    const root = temporaryRoot();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), deterministicOptions());
    const file = join(checkpointsDir(root), "000001.json");
    const tampered = JSON.parse(readFileSync(file, "utf8")) as {
      schemaVersion: number;
    };
    tampered.schemaVersion = 2;
    writeFileSync(file, JSON.stringify(tampered));
    const indexPath = join(checkpointsDir(root), "index.json");
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
      else if (seq === 3) expect(pruned).toEqual(["000001.json"]);
      else expect(pruned).toEqual(["000002.json"]);
    }
    const remaining = listCheckpoints(taskDir(root));
    expect(remaining.map((c) => c.stage.seq)).toEqual([3, 4, 5]);
  });

  test("never prunes a checkpoint cited by the handoff packet", () => {
    const root = temporaryRoot();
    const options = deterministicOptions(2);
    const first = publishCheckpoint(
      taskDir(root),
      baseInput(),
      fakeGit(cleanSha),
      options,
    );
    publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      options,
    );
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
    expect(third.pruned).toEqual(["000002.json"]);
    expect(listCheckpoints(taskDir(root)).map((c) => c.stage.seq)).toEqual([1, 3]);
  });

  test("manual prune keeps the latest and the cited, deleting the rest", () => {
    const root = temporaryRoot();
    const options = deterministicOptions();
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), options);
    const second = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      options,
    );
    const third = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      options,
    );
    writeFileSync(
      join(taskDir(root), "handoff.md"),
      `cites ${second.checkpoint.id}\n`,
    );
    const deleted = pruneCheckpoints(taskDir(root), 1);
    expect(deleted).toEqual(["000001.json"]);
    expect(listCheckpoints(taskDir(root))).toHaveLength(2);
    expect(third.checkpoint.id).not.toBe(second.checkpoint.id);
    expect(defaultCheckpointRetentionCap).toBe(20);
  });

  test("prune skips unparseable leftovers instead of failing the publish", () => {
    const root = temporaryRoot();
    const options = deterministicOptions(2);
    publishCheckpoint(taskDir(root), baseInput(), fakeGit(cleanSha), options);
    publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "implementation" }),
      fakeGit(cleanSha),
      options,
    );
    // Something corrupts the oldest file; retention must not explode, and
    // the corrupt file is nobody's prune target.
    writeFileSync(join(checkpointsDir(root), "000001.json"), "garbage");
    const third = publishCheckpoint(
      taskDir(root),
      baseInput({ gate: "pull_request" }),
      fakeGit(cleanSha),
      options,
    );
    expect(third.pruneError).toBeNull();
    expect(third.pruned).toEqual([]);
    expect(readFileSync(join(checkpointsDir(root), "000001.json"), "utf8")).toBe("garbage");
    const assessment = assessResume(taskDir(root), fakeGit(cleanSha));
    expect(assessment.usable).toBe(true);
    expect(assessment.checkpoint?.id).toBe(third.checkpoint.id);
  });
});

describe("format errors surface as store errors", () => {
  test("parseCheckpoint throws the typed format error", () => {
    expect(() => parseCheckpoint("{}")).toThrow(CheckpointFormatError);
  });
});
