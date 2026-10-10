import { afterEach, describe, expect, test, vi } from "vitest";
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
  start: tracker start {task}
  review: tracker review {task}
  complete: tracker complete {task}
`;

const quoteHint =
  "wrap the whole value in quotes: double quotes, writing \\\" and \\\\ for a quote or backslash inside, or single quotes, writing '' for a single quote inside";

// Every layout problem names the line it was found on.
const notPlain = expect.stringMatching(/^line \d+\b/u);

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
    [
      "two sections",
      "git:\n  stacking_allowed: false\nverification:\n  full: make check\n",
    ],
    [
      "a document marker and comments",
      "---\n# settings\ngit:\n  # isolate\n  worktree_required: true # always\n",
    ],
    [
      "quoted values",
      "integration_branch: \"main\"\nverification:\n  full: 'make check'\n",
    ],
    [
      "a command containing braces, brackets, and colons",
      "verification:\n  full: find . -name '*.ts' -exec lint {} [a] x:y\n",
    ],
  ])("accepts a partial configuration with %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([]);
  });

  // A tool reading the file line by line would see a different first key
  // after a byte-order mark, and values ending in a carriage return.
  test("rejects a byte-order mark and CRLF line endings", () => {
    expect(validateTaskDeliveryConfigSource(`\uFEFF${completeConfig}`)).toEqual(
      ["the file starts with a byte-order mark; save it as UTF-8 without BOM"],
    );
    expect(
      validateTaskDeliveryConfigSource(completeConfig.replace(/\n/gu, "\r\n")),
    ).toEqual([
      "the file uses CRLF line endings; save it with LF line endings",
    ]);
    expect(
      validateTaskDeliveryConfigSource(
        `integration_branch: main\n\uFEFFgit:\n  stacking_allowed: true\n`,
      ),
    ).toEqual([
      "line 2 contains a character that is not printable ASCII (U+FEFF); remove it",
    ]);
  });

  test("accepts a file without a final newline", () => {
    expect(
      validateTaskDeliveryConfigSource("git:\n  stacking_allowed: true"),
    ).toEqual([]);
  });

  // Some readers break a line at a bare carriage return and others do not,
  // so text after it can be a key for one and a comment for another.
  test("rejects a bare carriage return that hides keys inside a comment", () => {
    expect(
      validateTaskDeliveryConfigSource(
        "# review is off for now:\rexternal_review: # see docs\r  command: review-tool\ngit:\n  stacking_allowed: false # default\r  worktree_required: true\n",
      ),
    ).toEqual(
      expect.arrayContaining([
        "line 1 contains a character that is not printable ASCII (U+000D); remove it",
        "line 3 contains a character that is not printable ASCII (U+000D); remove it",
      ]),
    );
    expect(
      validateTaskDeliveryConfigSource(completeConfig.replace(/\n/gu, "\r")),
    ).not.toEqual([]);
  });

  test.each([
    [
      "a word joiner as a command",
      "external_review:\n  command: \u2060\n",
      "2060",
    ],
    [
      "a quoted zero-width joiner",
      'external_review:\n  command: "\u200D"\n',
      "200D",
    ],
    [
      "a zero-width space inside a name",
      "integration_branch: ma\u200Bin\n",
      "200B",
    ],
    ["a soft hyphen", "integration_branch: \u00AD\n", "00AD"],
    ["a Hangul filler", "integration_branch: \u3164\n", "3164"],
    ["a braille blank", "integration_branch: \u2800\n", "2800"],
    ["a no-break space", "integration_branch:\u00A0main\n", "00A0"],
    ["a NUL character", 'integration_branch: "\u0000"\n', "0000"],
    [
      "a bidirectional override in a comment",
      "git:\n  worktree_required: true # \u202Eeslaf\n",
      "202E",
    ],
    ["a line separator", "git:\u2028  worktree_required: true\n", "2028"],
    ["a form feed", "integration_branch: main\f\n", "000C"],
  ])("rejects %s", (_label, source, codePoint) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `contains a character that is not printable ASCII (U+${codePoint})`,
        ),
      ]),
    );
  });

  test("rejects malformed or mis-indented YAML", () => {
    expect(
      validateTaskDeliveryConfigSource("git:\n  worktree_required: [true\n"),
    ).toEqual([
      "line 2: git.worktree_required must be a boolean: true or false, lowercase and unquoted",
    ]);
    expect(
      validateTaskDeliveryConfigSource(
        "git:\n worktree_required: true\n   stacking_allowed: true\n",
      ),
    ).toEqual([
      "line 3 is indented differently from the other keys of git; sections are one level deep",
    ]);
    expect(
      validateTaskDeliveryConfigSource(
        "verification:\n  full: make check\nexternal_review:\n  command: review-tool\n integration_branch: main\n",
      ),
    ).toEqual([
      "line 5 is indented differently from the other keys of external_review; sections are one level deep",
    ]);
    expect(
      validateTaskDeliveryConfigSource("---#c\nintegration_branch: main\n"),
    ).toEqual([notPlain]);
  });

  test.each([
    ["an empty document", ""],
    ["a comment-only document", "# nothing here\n"],
    ["only a document marker", "---\n"],
  ])("rejects a root that is %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([
      "the document root must be a mapping with at least one key; delete the file instead of leaving it empty",
    ]);
  });

  test.each([
    ["a list", "- integration_branch: main\n"],
    ["a scalar", "main\n"],
    ["an empty flow mapping", "{}\n"],
  ])("rejects a root that is %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([notPlain]);
  });

  test("task lifecycle commands may be given for start, review and complete only", () => {
    expect(
      validateTaskDeliveryConfigSource(
        "task_lifecycle:\n  enabled: true\n  review: tracker review {task}\n",
      ),
    ).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource(
        "task_lifecycle:\n  enabled: true\n  reveiw: tracker review {task}\n",
      ),
    ).toEqual([
      "unknown key task_lifecycle.reveiw (allowed in task_lifecycle: enabled, start, review, complete)",
    ]);
  });

  test("commands that could never run are rejected", () => {
    expect(
      validateTaskDeliveryConfigSource(
        "task_lifecycle:\n  enabled: false\n  start: tracker start {task}\n",
      ),
    ).toEqual([
      "task_lifecycle.enabled is false but a task_lifecycle command is configured; remove the commands or enable it",
    ]);
    // Without the key, a command alone means task state is tracked.
    expect(
      validateTaskDeliveryConfigSource(
        "task_lifecycle:\n  start: tracker start {task}\n",
      ),
    ).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource("task_lifecycle:\n  enabled: false\n"),
    ).toEqual([]);
  });

  test("rejects an unknown top-level key", () => {
    expect(
      validateTaskDeliveryConfigSource("integration_brnch: main\n"),
    ).toEqual([
      "unknown key integration_brnch (allowed: integration_branch, knowledgePolicy, checkpointFrequency, handoffMode, resumeDetail, contextThreshold, verification, git, external_review, task_lifecycle)",
    ]);
  });

  test.each([
    ["auto", "auto"],
    ["required", "required"],
    ["disabled", "disabled"],
  ])("accepts knowledgePolicy value %s", (_label, value) => {
    expect(
      validateTaskDeliveryConfigSource(`knowledgePolicy: ${value}\n`),
    ).toEqual([]);
  });

  test("accepts every setup key with a contract value", () => {
    expect(
      validateTaskDeliveryConfigSource(
        "checkpointFrequency: stage-boundaries\nhandoffMode: gate\nresumeDetail: full\nknowledgePolicy: required\ncontextThreshold: 0.5\n",
      ),
    ).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource("contextThreshold: 1\n"),
    ).toEqual([]);
  });

  test.each([
    ["checkpointFrequency", "whenever"],
    ["handoffMode", "sometimes"],
    ["resumeDetail", "verbose"],
  ])("rejects an out-of-vocabulary %s value", (key, value) => {
    const errors = validateTaskDeliveryConfigSource(`${key}: ${value}\n`);
    expect(errors).toEqual([
      expect.stringMatching(new RegExp(`^${key} must be one of:`, "u")),
    ]);
  });

  test.each([
    ["a word", "contextThreshold: high\n"],
    ["a quoted number", 'contextThreshold: "0.5"\n'],
    ["a negative number", "contextThreshold: -1\n"],
    ["a fraction out of range", "contextThreshold: 1.5\n"],
  ])("rejects contextThreshold written as %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).not.toEqual([]);
  });

  test.each([
    ["an unknown word", "knowledgePolicy: sometimes\n", /knowledgePolicy must be one of: auto, required, disabled/],
    ["a boolean", "knowledgePolicy: true\n", /line 1: knowledgePolicy must be a string/],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([
      expect.stringMatching(expected),
    ]);
  });

  test("rejects a misspelled nested key instead of falling back to the default", () => {
    expect(
      validateTaskDeliveryConfigSource("git:\n  worktree_requred: true\n"),
    ).toEqual([
      "unknown key git.worktree_requred (allowed in git: worktree_required, stacking_allowed)",
    ]);
  });

  test("rejects keys that only exist on Object.prototype", () => {
    expect(
      validateTaskDeliveryConfigSource("constructor: x\ngit:\n  toString: z\n"),
    ).toEqual([
      expect.stringContaining("unknown key constructor"),
      expect.stringContaining("unknown key git.toString"),
    ]);
  });

  test.each([
    [
      "a repeated section, which would drop the first block",
      "git:\n  worktree_required: true\ngit:\n  stacking_allowed: true\n",
      "line 3: git is defined more than once; the parser would keep only the last one",
    ],
    [
      "a repeated nested key",
      "git:\n  worktree_required: true\n  worktree_required: false\n",
      "line 3: git.worktree_required is defined more than once; the parser would keep only the last one",
    ],
    [
      "a repeated top-level scalar",
      "integration_branch: main\nintegration_branch: develop\n",
      "line 2: integration_branch is defined more than once; the parser would keep only the last one",
    ],
    [
      "a section repeated after another section",
      "git:\n  worktree_required: true\nverification:\n  full: make\ngit:\n  stacking_allowed: true\n",
      "line 5: git is defined more than once; the parser would keep only the last one",
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([expected]);
  });

  test("the same key name in two different sections is not a repeat", () => {
    // No schema key repeats across sections today; the layout check must
    // still scope repeats to their section rather than to the whole file.
    expect(
      validateTaskDeliveryConfigSource(
        "task_lifecycle:\n  start: a\nverification:\n  start: b\n",
      ),
    ).toEqual([expect.stringContaining("unknown key verification.start")]);
  });

  // Every notation below can spell a second definition of a key, or hide one
  // inside a collection, so none of them is accepted at all.
  test.each([
    [
      "a one-line flow mapping",
      "git: {worktree_required: true, worktree_required: false}\n",
    ],
    [
      "a flow mapping spanning lines",
      "git: {worktree_required: true,\n  worktree_required: false}\n",
    ],
    [
      "a flow mapping replacing a command",
      'external_review: {command: review-tool,\n  command: "true"}\n',
    ],
    ["a flow-style root", '{"integration_branch": "main"}\n'],
    [
      "a flow root spanning lines",
      "{git: {worktree_required: true},\ngit: {\nstacking_allowed: true}}\n",
    ],
    [
      "an escaped key inside a flow root",
      '{"g\\x69t": {"worktree_required": true},\n"git": {\n"stacking_allowed": true}}\n',
    ],
    [
      "a quoted key",
      'git:\n  "worktree_required": true\n  worktree_required: false\n',
    ],
    [
      "an escaped quoted key",
      '"g\\x69t":\n  worktree_required: true\ngit:\n  stacking_allowed: true\n',
    ],
    [
      "an explicit key",
      "? git\n: worktree_required: true\ngit:\n  stacking_allowed: true\n",
    ],
    [
      "a tagged key",
      "!!str git:\n  worktree_required: true\ngit:\n  stacking_allowed: true\n",
    ],
    [
      "an anchored key",
      "&a git:\n  worktree_required: true\ngit:\n  stacking_allowed: true\n",
    ],
    ["a merge key", "git:\n  <<: {worktree_required: true}\n"],
    ["an anchored value", "git: &g\n  worktree_required: true\n"],
    ["an alias value", "integration_branch: main\nverification:\n  full: *x\n"],
    ["a tagged value", "git:\n  worktree_required: !!bool true\n"],
    ["a block scalar", "verification:\n  full: |\n    start: now\n"],
    ["a folded scalar", "verification:\n  full: >\n    make\n"],
    ["a multi-line plain value", "verification:\n  full: make\n    check\n"],
    ["a list value", "task_lifecycle:\n  start: [a, b]\n"],
    ["a block list", "task_lifecycle:\n  start:\n    - a\n"],
    [
      "a second document",
      "git:\n  worktree_required: true\n---\ngit:\n  stacking_allowed: true\n",
    ],
    ["tab indentation", "git:\n\tworktree_required: true\n"],
  ])("rejects %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(
      expect.arrayContaining([notPlain]),
    );
  });

  // The same notations after two spaces or a space and a tab, where a
  // one-character lookahead would not see them.
  test.each([
    [
      "a flow mapping after two spaces",
      "git:  {worktree_required: true, worktree_required: false}\n",
    ],
    [
      "a flow mapping after a space and a tab",
      "git: \t{worktree_required: true, worktree_required: false}\n",
    ],
    [
      "a flow mapping with a quoted repeat",
      'external_review:  {command: review-tool, "command": "true"}\n',
    ],
    [
      "a flow mapping with an explicit-key repeat",
      "git:  {? worktree_required : true, worktree_required: false}\n",
    ],
    [
      "a flow mapping across lines after two spaces",
      "git:  {worktree_required: true,\n  stacking_allowed: false, worktree_required: false}\n",
    ],
    [
      "an anchored flow mapping after two spaces",
      "git:  &a {worktree_required: true}\n",
    ],
    [
      "a tagged section after two spaces",
      "git:  !!map\n  worktree_required: true\n",
    ],
    [
      "a tagged boolean after two spaces",
      "git:\n  worktree_required:  !!bool true\n",
    ],
    [
      "a block scalar after two spaces",
      "verification:\n  full:  |\n    targeted: x\n",
    ],
    ["an alias after two spaces", "verification:\n  full:  *x\n"],
  ])("rejects %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(
      expect.arrayContaining([notPlain]),
    );
  });

  // An open quote continues over the following lines: a YAML parser reads
  // them as text, so the keys written there would silently not exist.
  test.each([
    [
      "a double quote swallowing a section",
      'integration_branch: "main\n external_review:\n   command: review-tool"\ngit:\n  worktree_required: true\n',
    ],
    [
      "a single quote swallowing sibling keys",
      "task_lifecycle:\n  start: 'tracker start\n    enabled: true\n    complete: x'\n",
    ],
    [
      "a double quote swallowing a sibling key",
      'verification:\n  full: "make check\n   targeted: make test"\n',
    ],
    ["text after a closed quote", 'verification:\n  full: "a b" && c\n'],
    ["an unsupported escape", 'verification:\n  full: "a\\qb"\n'],
  ])("rejects %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^line \d+: [\w.]+ has (?:a (?:double|single)-quoted value|text after the closing quote)/u,
        ),
      ]),
    );
  });

  test.each([
    [
      "keys indented at different depths",
      "git:\n  worktree_required: true\n    stacking_allowed: true\n",
    ],
    ["a third level", "git:\n  worktree_required:\n    deep: true\n"],
    ["an indented first key", "  git:\n    worktree_required: true\n"],
    ["a nested key under a scalar", "integration_branch: main\n  full: make\n"],
    [
      "a colon-space inside an unquoted value",
      "verification:\n  full: echo a: b\n",
    ],
    ["a value starting with a list marker", "verification:\n  full: - x\n"],
  ])("rejects %s", (_label, source) => {
    expect(validateTaskDeliveryConfigSource(source)).not.toEqual([]);
  });

  // Whatever is accepted must mean to a YAML parser exactly what its lines
  // say: same keys, same strings, same booleans.
  test.each([
    [
      "flags and paths",
      "verification:\n  full: bun run check --bail -x ./a/b\n",
      "bun run check --bail -x ./a/b",
    ],
    [
      "shell operators mid-value",
      "verification:\n  full: a | b > c && d * {e} [f] !g\n",
      "a | b > c && d * {e} [f] !g",
    ],
    [
      "a colon without a space",
      "verification:\n  full: test --grep foo:bar http://x/y\n",
      "test --grep foo:bar http://x/y",
    ],
    [
      "a placeholder",
      "verification:\n  full: run <test files>\n",
      "run <test files>",
    ],
    [
      "a double-quoted command",
      'verification:\n  full: "[ -f x ] && y: z # q"\n',
      "[ -f x ] && y: z # q",
    ],
    [
      "a double-quoted escape",
      'verification:\n  full: "say \\"hi\\""\n',
      'say "hi"',
    ],
    [
      "a single-quoted command",
      "verification:\n  full: 'it''s: fine'\n",
      "it's: fine",
    ],
    [
      "a quoted value and a comment",
      'verification:\n  full: "make # not a comment" # comment\n',
      "make # not a comment",
    ],
  ])(
    "accepts %s and reads it as a YAML parser does",
    (_label, source, expected) => {
      expect(validateTaskDeliveryConfigSource(source)).toEqual([]);
      expect(
        (Bun.YAML.parse(source) as { verification: { full: string } })
          .verification.full,
      ).toBe(expected);
    },
  );

  // YAML cuts an unquoted value at " #". After a boolean that is a comment;
  // inside a command it would silently run a different command.
  test.each([
    [
      "an issue reference",
      "verification:\n  targeted: tool issue view #123\n",
      "verification.targeted",
    ],
    [
      "a hash inside an inner quoted span",
      'external_review:\n  command: review-tool --title "fix #12"\n',
      "external_review.command",
    ],
    [
      "a trailing comment on a command",
      "verification:\n  full: make check # all of it\n",
      "verification.full",
    ],
    [
      "a trailing comment on a branch name",
      "integration_branch: main # default\n",
      "integration_branch",
    ],
  ])("rejects an unquoted value cut short by %s", (_label, source, name) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([
      expect.stringContaining(
        `: ${name} has an unquoted value followed by " #", which YAML reads as a comment; put the comment on its own line, or wrap the whole value in quotes`,
      ),
    ]);
  });

  test("still accepts comments after booleans, quoted values, and section headers", () => {
    expect(
      validateTaskDeliveryConfigSource(
        "git: # policy\n  worktree_required: true # always\nverification:\n  full: \"make check\" # all of it\n  targeted: 'make #1' # quoted hash\n",
      ),
    ).toEqual([]);
  });

  test.each([
    ["True", "git:\n  stacking_allowed: True\n", "git.stacking_allowed"],
    ["FALSE", "task_lifecycle:\n  enabled: FALSE\n", "task_lifecycle.enabled"],
    [
      "a quoted boolean",
      'git:\n  worktree_required: "true"\n',
      "git.worktree_required",
    ],
    ["yes", "task_lifecycle:\n  enabled: yes\n", "task_lifecycle.enabled"],
    ["on", "git:\n  worktree_required: on\n", "git.worktree_required"],
    ["a number", "git:\n  stacking_allowed: 1\n", "git.stacking_allowed"],
    ["nothing", "git:\n  stacking_allowed:\n", "git.stacking_allowed"],
  ])(
    "rejects a boolean written as %s and says what the field needs",
    (_label, source, name) => {
      expect(validateTaskDeliveryConfigSource(source)).toEqual([
        `line 2: ${name} must be a boolean: true or false, lowercase and unquoted`,
      ]);
    },
  );

  // Unquoted text some YAML readers would type as a boolean, null, number or
  // date. It must be quoted to be a string for every reader.
  test.each([
    "no",
    "yes",
    "on",
    "off",
    "Yes",
    "ON",
    "y",
    "n",
    "null",
    "true",
    "False",
    "~",
    "7",
    "1.0",
    "2024",
    "2024-01-01",
    "1:30",
    "12:30:00",
    "-1:30",
    "1_000",
    "0b101",
    "0x1F",
    "0o17",
    ".inf",
    ".nan",
    "._",
    "=",
    "<<",
    "+1",
    "1e3",
    "e2",
    "E10",
    "e-5",
    "E+0",
    "./run",
    "<placeholder>",
    "v:",
    "a: b",
  ])("rejects the unquoted string value %s", (value) => {
    const errors = validateTaskDeliveryConfigSource(
      `integration_branch: ${value}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^line 1(?:: integration_branch (?:has an unquoted value that a YAML reader may not take as plain text .*|must be a string; to use the word as text, )wrap the whole value in quotes: .*| is not a plain "key: value" line)/u,
    );
    // Quoted, the same text is an ordinary string.
    expect(
      validateTaskDeliveryConfigSource(
        `integration_branch: "${value.replace(/\\/gu, "\\\\")}"\n`,
      ),
    ).toEqual([]);
  });

  test("names the line and the fix for common slips", () => {
    expect(
      validateTaskDeliveryConfigSource("verification:\n  full: *.test.ts\n"),
    ).toEqual([
      expect.stringMatching(
        /^line 2: verification\.full has an unquoted value .*it must start with a letter.* wrap the whole value in quotes: double quotes, .* or single quotes, .*$/u,
      ),
    ]);
    expect(
      validateTaskDeliveryConfigSource("git:\n\tworktree_required: true\n"),
    ).toEqual(["line 2 contains a tab; use spaces"]);
    expect(
      validateTaskDeliveryConfigSource("integration_branch: main\t\n\t\n"),
    ).toEqual([
      "line 1 contains a tab; use spaces",
      "line 2 contains a tab; use spaces",
    ]);
    expect(
      validateTaskDeliveryConfigSource("verification:\n  full: echo a: b\n"),
    ).toEqual([expect.stringContaining("wrap the whole value in quotes")]);
    expect(
      validateTaskDeliveryConfigSource("integration_branch:main\n"),
    ).toEqual([expect.stringContaining("with a space after the colon")]);
    expect(
      validateTaskDeliveryConfigSource(
        "--- # settings\ngit:\n  stacking_allowed: true\n",
      ),
    ).toEqual([]);
    expect(
      validateTaskDeliveryConfigSource('verification:\n  full: "a b" && c\n'),
    ).toEqual([
      `line 2: verification.full has text after the closing quote; ${quoteHint}`,
    ]);
    expect(
      validateTaskDeliveryConfigSource('verification:\n  full: "a\\tb"\n'),
    ).toEqual([
      'line 2: verification.full has a double-quoted value with an unsupported escape; only \\" and \\\\ are allowed',
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
      `line 2: verification.full must be a string; to use the word as text, ${quoteHint}`,
    ],
    [
      "a scalar where a section is expected",
      "git: true\n",
      "git must be a mapping",
    ],
    ["an empty section", "verification:\n", "verification must be a mapping"],
    [
      "a section where a string is expected",
      "integration_branch:\n  name: main\n",
      "integration_branch must be a string",
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateTaskDeliveryConfigSource(source)).toEqual([expected]);
  });

  // The line scan decides what the file says; a YAML parser must then read
  // the same thing. These cases replace the parser to prove the comparison
  // is what rejects a disagreement.
  test.each([
    ["a different value", { integration_branch: "other" }],
    ["a differently typed value", { integration_branch: 7 }],
    ["an extra key", { integration_branch: "main", git: {} }],
    ["a missing key", {}],
    ["a list", ["main"]],
    ["nothing", null],
  ])("rejects a file a YAML parser reads as %s", (_label, parsed) => {
    const parse = vi.spyOn(Bun.YAML, "parse").mockReturnValue(parsed);
    try {
      expect(
        validateTaskDeliveryConfigSource("integration_branch: main\n"),
      ).toEqual([
        expect.stringMatching(
          /^a YAML parser reads this file differently from its plain "key: value" lines/u,
        ),
      ]);
    } finally {
      parse.mockRestore();
    }
  });

  test("reports a file the YAML parser cannot read", () => {
    const parse = vi.spyOn(Bun.YAML, "parse").mockImplementation(() => {
      throw new Error("unexpected token");
    });
    try {
      expect(
        validateTaskDeliveryConfigSource("integration_branch: main\n"),
      ).toEqual(["invalid YAML: unexpected token"]);
    } finally {
      parse.mockRestore();
    }
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

  test("this repository marks tasks started, in review and done through its tracker", () => {
    const source = readFileSync(
      join(repositoryRoot, taskDeliveryConfigName),
      "utf8",
    );
    const parsed = Bun.YAML.parse(source) as {
      git: Record<string, unknown>;
      task_lifecycle: Record<string, unknown>;
    };

    expect(parsed.task_lifecycle.enabled).toBe(true);
    // A project identifier is local to one runtime, so none is written here.
    // The commands run from the primary checkout - the one bound to the
    // runtime - because a task worktree is not bound and would be refused.
    // Each key runs its own verb, in a subshell that leaves the caller's
    // working directory alone.
    const inPrimaryCheckout = (verb: string): string =>
      `(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && ai-office ${verb} --task {task})`;
    expect(parsed.task_lifecycle).toEqual({
      enabled: true,
      start: inPrimaryCheckout("task:start"),
      review: inPrimaryCheckout("task:submit-review"),
      complete: inPrimaryCheckout("task:complete"),
    });
    expect(parsed.git).toMatchObject({ worktree_required: true });
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
    writeFileSync(join(root, taskDeliveryConfigName), "extra: x\n");
    rmSync(join(root, "skills", "task-delivery", "assets", "pr-template.md"));

    expect(validateSkills(root)).toEqual(
      expect.arrayContaining([
        "skills/task-delivery: Required file is missing: assets/pr-template.md",
        expect.stringContaining(`${taskDeliveryConfigName}: unknown key extra`),
      ]),
    );
  });

  test("reports the configuration even when no canonical skill is found", () => {
    const missing = temporaryRoot();
    writeFileSync(join(missing, taskDeliveryConfigName), "bogus: x\n");
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

  test("reports setup key drift between the Runtime schema, the YAML schema, and the configuration reference", () => {
    const root = repositoryCopy();
    const configurationPath = join(
      root,
      "skills",
      "task-delivery",
      "references",
      "configuration.md",
    );
    const source = readFileSync(configurationPath, "utf8");
    writeFileSync(
      configurationPath,
      source.replace("| `resumeDetail`", "| `resumeDetailX`"),
    );

    expect(validateSkills(root)).toEqual([
      expect.stringContaining(
        "references/configuration.md setup keys",
      ),
    ]);
  });

  test("reports a missing setup keys table in the configuration reference", () => {
    const root = repositoryCopy();
    const configurationPath = join(
      root,
      "skills",
      "task-delivery",
      "references",
      "configuration.md",
    );
    const source = readFileSync(configurationPath, "utf8");
    writeFileSync(configurationPath, source.replace("### Setup keys", "### Setup"));

    expect(validateSkills(root)).toEqual([
      expect.stringContaining("no `### Setup keys` table"),
    ]);
  });
});
