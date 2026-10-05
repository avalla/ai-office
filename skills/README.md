# Portable agent skills

`skills/` holds vendor-neutral skills in the Agent Skills (`SKILL.md`) format.
Each skill has exactly one canonical source here. Executors discover skills in
their own directories, so a deterministic installer copies the canonical source
there; the copies are generated, committed, and never edited by hand.

```text
skills/task-delivery/            canonical source - edit here
├── SKILL.md                     workflow, rules, and the executor block
├── references/                  lifecycle, stop conditions, checklists, ...
└── assets/                      pull request template, example configuration

.claude/skills/task-delivery/    generated copy - Claude Code
.agents/skills/task-delivery/    generated copy - Codex, Pi, other hosts
```

These skills are independent of the Runtime-managed `ai-office` skill
([ADR-0012](../docs/adr/ADR-0012-shared-project-guide-and-repository-skills.md)):
they need no Runtime, no daemon, and no AI Office project.

## Commands

| Task                                      | Command                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Install or update the copies              | `bun run skills:install`                                                                                                                      |
| Verify the copies are in sync (no writes) | `bun run skills:check`                                                                                                                        |
| Validate source and copies (CI)           | `bun run skills:validate`                                                                                                                     |
| Install into another repository           | `bun run skills:install --root /abs/path/to/repo`                                                                                             |
| Install for one executor family           | `bun run skills:install --scope agents`                                                                                                       |
| Run the tests                             | `bunx --bun vitest run tests/unit/skills-install.test.ts tests/unit/skill-package-validation.test.ts tests/unit/task-delivery-config.test.ts` |

`bun run check` runs `skills:validate`, so CI fails on an invalid skill or a
drifted copy. Exit codes: `0` success or in sync, `1` drift, conflict, or error,
`2` usage error.

## Updating a skill

1. Edit files under `skills/<name>/` only.
2. Bump `metadata.version` in `SKILL.md`.
3. Run `bun run skills:install`, then `bun run skills:validate`.
4. Commit the source and the regenerated copies together.

## Ownership and overwrite safety

Each installed copy carries `.skill-install.json`, recording the content hash of
every file the installer wrote. The installer:

- updates or removes only files it recorded and that are still unmodified;
- refuses a locally modified file, or an existing directory it did not install,
  and writes nothing to any target until the conflict is resolved (`--force`
  overwrites modified files and adopts an existing directory);
- adopts an existing directory without `--force` only when every file in it
  already matches the canonical source;
- never deletes a file it did not write, even with `--force`;
- refuses to write through symbolic links (a symlinked executor directory is
  reported as a conflict; use `--scope` to install the other locations);
- reports installed copies whose canonical skill no longer exists, and leaves
  their removal to you.

The manifest is the ownership record and is trusted: do not edit it by hand.

## Using `task-delivery`

- **Claude Code**: discovered from `.claude/skills/task-delivery`. Invoke with
  `/task-delivery`, or ask to "deliver task X".
- **Codex**: discovered from `.agents/skills/task-delivery`. Invoke with
  `$task-delivery`.
- **Pi**: discovered from `.agents/skills/task-delivery`. Invoke with
  `/skill:task-delivery`.

Project settings are optional and live in `.task-delivery.yaml` at the
repository root; the contract is in
[configuration.md](task-delivery/references/configuration.md). A present file
must match the contract exactly: `bun run skills:validate` fails on malformed
YAML, unknown or misspelled keys at any level, wrong types, and empty strings,
so a typo cannot silently fall back to a default.

## Adding an executor

The workflow names roles (implementation context, independent reviewer,
verification context, external reviewer), never tools.

- If the executor reads `.agents/skills`, nothing needs to change.
- If it reads another directory, add one entry to `installTargets` in
  [`scripts/skills/shared.ts`](../scripts/skills/shared.ts) and run
  `bun run skills:install`.
- If its primitives need explaining, add one row to the executor block in
  `SKILL.md` (between `<!-- executors:start -->` and `<!-- executors:end -->`).
  That block is the only place executor names are allowed. It must stay the
  last section and short. The validator rejects known executor names anywhere
  else; that denylist is a tripwire for common slips, not proof of neutrality.

## Relation to AI Office

The skill does not depend on AI Office. It is shaped so that a future domain
pack can distribute it unchanged, keeping these concepts separate:

```text
Skill    = task-delivery
Roles    = developer / reviewer / qa
Pipeline = development-delivery
Executor = Claude Code / Codex / human / other
```

The pipeline is the sequence of gates; the executor is whoever performs a
stage. Changing the executor does not change the pipeline.

## Known limits

- The validator's content checks (required stages in order, required policy
  sentences, executor denylist) detect accidental removal, not a rewrite that
  keeps the words and changes the meaning. Review skill edits like code.
- `validate:skills` is the older, separate validator of the Runtime-managed
  `ai-office` skill; `skills:validate` covers the skills in this directory.
- The installer covers project-level locations only, not per-user ones.
- Independence between implementation, review, and verification is an
  instruction to the executor; nothing here enforces it.
- `.task-delivery.yaml` is validated by `skills:validate` only in a repository
  that carries these scripts. In a repository that merely received the copies
  through `--root`, the skill's own instruction applies: stop on any key or
  value outside the contract.
