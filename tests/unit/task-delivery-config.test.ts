import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkills } from "../../scripts/skills/install.ts";
import { repositoryRoot } from "../../scripts/skills/shared.ts";
import {
  taskDeliveryConfigName,
  validateTaskDeliveryConfig,
  validateTaskDeliveryConfigSource,
} from "../../scripts/skills/task-delivery-config.ts";
import { validateSkills } from "../../scripts/skills/validate.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "task-delivery-config-"));
  temporaryDirectories.push(root);
  return root;
}

const completeConfig = `integration_branch: main

verification:
  full: bun run check
  targeted: bunx vitest run <files>

git:
  worktree_required: true
  stacking_allowed: false

external_review:
  command: review-tool run

task_lifecycle:
  enabled: true
  start: tracker start
  complete: tracker complete
`;

describe("task-delivery configuration contract", () => {
  test("an absent configuration is valid", () => {
    expect(validateTaskDeliveryConfig(temporaryRoot())).toEqual([]);
  });

  test("accepts a complete configuration", () => {
    expect(validateTaskDeliveryConfigSource(completeConfig)).toEqual([]);
  });

  test.each([
    ["one top-level key", "integration_branch: develop\n"],
    ["one nested key", "git:\n  worktree_required: true\n"],
    ["an empty section", "verification: {}\n"],
    ["an empty mapping", "{}\n"],
  ])("accepts a partial configuration with %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([]);
  });

  test("rejects malformed YAML", () => {
    expect(
      validateTaskDeliveryConfigSource("git:\n  worktree_required: [true\n"),
    ).toEqual([expect.stringMatching(/^invalid YAML: /u)]);
  });

  test.each([
    ["a list", "- integration_branch: main\n"],
    ["a scalar", "main\n"],
    ["an empty document", ""],
    ["a comment-only document", "# nothing here\n"],
  ])("rejects a root that is %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([
      expect.stringMatching(/^the document root must be a mapping/u),
    ]);
  });

  test("rejects an unknown top-level key", () => {
    expect(
      validateTaskDeliveryConfigSource("integration_brnch: main\n"),
    ).toEqual([
      "unknown key integration_brnch (allowed: integration_branch, verification, git, external_review, task_lifecycle)",
    ]);
  });

  test("rejects a misspelled nested key instead of falling back to the default", () => {
    expect(
      validateTaskDeliveryConfigSource("git:\n  worktree_requred: true\n"),
    ).toEqual([
      "unknown key git.worktree_requred (allowed in git: worktree_required, stacking_allowed)",
    ]);
  });

  test.each([
    [
      "a repeated section, which would drop the first block",
      "git:\n  worktree_required: true\ngit:\n  stacking_allowed: true\n",
      ["git is defined 2 times; the parser would keep only the last one"],
    ],
    [
      "a repeated nested key",
      "git:\n  worktree_required: true\n  worktree_required: false\n",
      [
        "git.worktree_required is defined 2 times; the parser would keep only the last one",
      ],
    ],
    [
      "a repeated top-level scalar",
      "integration_branch: main\nintegration_branch: develop\n",
      [
        "integration_branch is defined 2 times; the parser would keep only the last one",
      ],
    ],
    [
      "a repeated quoted key",
      'git:\n  "worktree_required": true\n  worktree_required: false\n',
      [
        "git.worktree_required is defined 2 times; the parser would keep only the last one",
      ],
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(expected);
  });

  test.each([
    [
      "a flow mapping hiding a repeated key",
      "git: {worktree_required: true, worktree_required: false}\n",
      "git.worktree_required must be written on its own line in block style",
    ],
    [
      "a flow-style root",
      '{"integration_branch": "main"}\n',
      "integration_branch must be written on its own line in block style",
    ],
    [
      "a merge key",
      "base: &base\n  worktree_required: true\ngit:\n  <<: *base\n",
      "unknown key base",
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });

  test("accepts a byte-order mark, CRLF line endings, and comments", () => {
    expect(
      validateTaskDeliveryConfigSource(
        `\uFEFF# settings\r\n${completeConfig.replace(/\n/gu, "\r\n")}`,
      ),
    ).toEqual([]);
  });

  test("rejects keys that only exist on Object.prototype", () => {
    expect(
      validateTaskDeliveryConfigSource("constructor: x\ngit:\n  toString: y\n"),
    ).toEqual([
      expect.stringContaining("unknown key constructor"),
      expect.stringContaining("unknown key git.toString"),
    ]);
  });

  test.each([
    ["a quoted boolean", 'git:\n  worktree_required: "true"\n'],
    ["yes instead of true", "task_lifecycle:\n  enabled: yes\n"],
    ["a number", "git:\n  stacking_allowed: 1\n"],
  ])("rejects a boolean written as %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([
      expect.stringMatching(/must be a boolean \(true or false, unquoted\)$/u),
    ]);
  });

  test.each([
    [
      "an empty command",
      'external_review:\n  command: ""\n',
      "external_review.command must not be empty",
    ],
    [
      "a whitespace-only command",
      'verification:\n  full: "   "\n',
      "verification.full must not be empty",
    ],
    [
      "a missing value",
      "integration_branch:\n",
      "integration_branch must be a string",
    ],
    [
      "a boolean where a string is expected",
      "verification:\n  full: true\n",
      "verification.full must be a string",
    ],
    [
      "a number where a string is expected",
      "integration_branch: 7\n",
      "integration_branch must be a string",
    ],
    [
      "a list where a string is expected",
      "task_lifecycle:\n  start: [a, b]\n",
      "task_lifecycle.start must be a string",
    ],
    [
      "a scalar where a section is expected",
      "git: true\n",
      "git must be a mapping",
    ],
    [
      "an empty section value",
      "verification:\n",
      "verification must be a mapping",
    ],
    [
      "a section where a string is expected",
      "integration_branch:\n  name: main\n",
      "integration_branch must be a string",
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([expected]);
  });

  test("reports every problem in one pass", () => {
    expect(
      validateTaskDeliveryConfigSource(
        'integration_branch: ""\ngit:\n  worktree_requred: true\n  stacking_allowed: "false"\nextra: 1\n',
      ),
    ).toHaveLength(4);
  });

  test.each([
    ".task-delivery.yml",
    "task-delivery.yaml",
    "task-delivery.yml",
    ".task-delivery.YAML",
    ".Task-Delivery.yaml",
    ".task_delivery.yaml",
    ".taskdelivery.yaml",
    ".task-delivery.json",
  ])(
    "rejects a configuration named %s, which the skill never reads",
    (name) => {
      const root = temporaryRoot();
      writeFileSync(join(root, name), completeConfig);

      expect(validateTaskDeliveryConfig(root)).toEqual([
        `${name}: not read by the skill; rename it to ${taskDeliveryConfigName}`,
      ]);
    },
  );

  test("reports an unreadable configuration instead of crashing", () => {
    const root = temporaryRoot();
    const path = join(root, taskDeliveryConfigName);
    writeFileSync(path, completeConfig);
    chmodSync(path, 0o000);
    // A privileged user can read the file regardless of its mode.
    const expected =
      process.getuid?.() === 0
        ? []
        : [expect.stringMatching(/^\.task-delivery\.yaml: cannot be read \(/u)];

    expect(validateTaskDeliveryConfig(root)).toEqual(expected);
    chmodSync(path, 0o600);
  });

  test("rejects a configuration path that is not a regular file", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, taskDeliveryConfigName));

    expect(validateTaskDeliveryConfig(root)).toEqual([
      `${taskDeliveryConfigName}: must be a regular file`,
    ]);
  });

  test("the repository's own configuration and the shipped example are valid", () => {
    expect(validateTaskDeliveryConfig(repositoryRoot)).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource(
        readFileSync(join(repositoryRoot, taskDeliveryConfigName), "utf8"),
      ),
    ).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource(
        readFileSync(
          join(
            repositoryRoot,
            "skills",
            "task-delivery",
            "assets",
            "task-delivery.example.yaml",
          ),
          "utf8",
        ),
      ),
    ).toEqual([]);
  });
});

describe("skills:validate covers the project configuration", () => {
  function repositoryCopy(): string {
    const root = temporaryRoot();
    cpSync(join(repositoryRoot, "skills"), join(root, "skills"), {
      recursive: true,
    });
    installSkills({ sourceRoot: root });
    return root;
  }

  test("passes without a configuration and with a valid one", () => {
    const root = repositoryCopy();
    expect(validateSkills(root)).toEqual([]);

    writeFileSync(join(root, taskDeliveryConfigName), completeConfig);
    expect(validateSkills(root)).toEqual([]);
  });

  test("fails on a typo that would silently disable a policy", () => {
    const root = repositoryCopy();
    writeFileSync(
      join(root, taskDeliveryConfigName),
      "git:\n  worktree_requred: true\n",
    );

    expect(validateSkills(root)).toEqual([
      `${taskDeliveryConfigName}: unknown key git.worktree_requred (allowed in git: worktree_required, stacking_allowed)`,
    ]);
  });

  test("reports configuration problems together with skill problems", () => {
    const root = repositoryCopy();
    writeFileSync(join(root, taskDeliveryConfigName), "- not a mapping\n");
    rmSync(join(root, "skills", "task-delivery", "assets", "pr-template.md"));

    expect(validateSkills(root)).toEqual(
      expect.arrayContaining([
        "skills/task-delivery: Required file is missing: assets/pr-template.md",
        expect.stringContaining(
          `${taskDeliveryConfigName}: the document root must be a mapping`,
        ),
      ]),
    );
  });

  test("reports the configuration even when no canonical skill is found", () => {
    const missing = temporaryRoot();
    writeFileSync(join(missing, taskDeliveryConfigName), "bogus: 1\n");
    expect(validateSkills(missing)).toEqual([
      expect.stringContaining("Canonical skills directory is missing"),
      expect.stringContaining("unknown key bogus"),
    ]);

    mkdirSync(join(missing, "skills"));
    expect(validateSkills(missing)).toEqual([
      "No canonical skills found under skills/",
      expect.stringContaining("unknown key bogus"),
    ]);
    expect(validateSkills(join(missing, "nowhere"))).toEqual([
      expect.stringContaining("Canonical skills directory is missing"),
    ]);
  });

  test("the CLI exits non-zero on an invalid configuration", () => {
    const root = repositoryCopy();
    writeFileSync(
      join(root, taskDeliveryConfigName),
      'git:\n  worktree_required: "true"\n',
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, "scripts/skills/validate.ts", root],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "git.worktree_required must be a boolean",
    );
  });
});
