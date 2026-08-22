# External agent client integration

AI Office supports project-level integration with Codex CLI and Claude Code
through a common application port. Detection is derived from `PATH`; inspection,
planning, and validation are read-only. Mutation is a separate explicitly
approved command.

## Canonical instruction contract

`AGENTS.md` is the canonical project instruction artifact. AI Office can compile
a strict JSON schema-version `1` contract containing a small operating policy
plus mission, repository map, invariants, workflow, testing, documentation, and
definition-of-done sections.

The policy is tool independent. The Markdown compiler is an application concern;
client file names and import conventions remain infrastructure concerns.

A minimal contract has this shape:

```json
{
  "schemaVersion": 1,
  "policy": {
    "reasoning": "architecture_first",
    "autonomy": "high",
    "codeChanges": "autonomous",
    "architectureChanges": "approval_required",
    "adrCreation": "allowed",
    "inspectBeforeNonTrivialWork": true,
    "planBeforeNonTrivialWork": true,
    "implementationReview": true,
    "preserveInvariants": true
  },
  "project": {
    "name": "Example",
    "mission": "Deliver reliable software changes",
    "repositoryMap": ["apps contain composition roots"],
    "invariants": ["domain remains infrastructure independent"],
    "workflow": ["inspect and plan before non-trivial work"],
    "testing": ["run focused and full tests"],
    "documentation": ["README describes current product behavior"],
    "definitionOfDone": ["tests, typecheck, and review pass"]
  }
}
```

Codex reads `AGENTS.md` natively. Claude uses a minimal managed bridge:

```markdown
<!-- >>> ai-office managed: canonical-project-instructions -->

@AGENTS.md
<!-- <<< ai-office managed: canonical-project-instructions -->
```

## CLI workflow

```bash
bun run cli -- client:detect
bun run cli -- client:inspect --client claude --root /path/to/project
bun run cli -- client:plan \
  --client claude \
  --root /path/to/project \
  --contract .ai-office/agent-instructions.json
```

`client:plan` returns JSON containing the exact affected relative paths,
ownership after apply, expected hashes, issues, and `planHash`. It does not
return or persist unrelated user configuration.

After reviewing the plan, provide that exact hash:

```bash
bun run cli -- client:apply \
  --client claude \
  --root /path/to/project \
  --contract .ai-office/agent-instructions.json \
  --approve <plan-hash>

bun run cli -- client:validate --client claude --root /path/to/project
```

Removal follows the same plan-hash approval contract without requiring the
original installation contract:

```bash
bun run cli -- client:uninstall --client claude --root /path/to/project
bun run cli -- client:uninstall --client claude --root /path/to/project \
  --approve <plan-hash>
```

Claude removal deletes an AI Office-owned bridge file or removes only the
marked block from a merged `CLAUDE.md`. A user-owned direct `@AGENTS.md` import
is preserved. Codex removal deletes `AGENTS.md` only when it carries the AI
Office ownership header. Because the canonical file is shared, uninstall
Claude before Codex when removing both integrations.

The contract file must be a regular JSON file inside the integration root and is
limited to 256 KiB.

## Status and validation semantics

File ownership and integration status answer different questions. For canonical
instructions:

| `integrationStatus` | Meaning                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing`           | `AGENTS.md` does not exist.                                                                                                                    |
| `integrated`        | `AGENTS.md` carries the AI Office ownership header and is managed. A contract-aware plan proposes an update when its compiled content differs. |
| `unmanaged`         | `AGENTS.md` exists and is user-owned. The client can consume it, but AI Office does not attest that the supplied contract is represented.      |
| `conflict`          | Safe integration is blocked and requires intervention.                                                                                         |

For a client-specific instruction file such as `CLAUDE.md`, `integrated` means
the client bridge is operational; `unmanaged` means the file exists but the
bridge is absent or stale. The accompanying `ownership` field independently
identifies AI Office-owned, user-owned, or merged content.

`validation.valid` answers only whether the selected client can consume project
instructions without a blocking conflict. For Codex, an existing `AGENTS.md` is
operational regardless of ownership. For Claude, both `AGENTS.md` and an
operational `CLAUDE.md` import are required. `valid: true` does not mean that the
supplied AI Office contract was installed; callers must inspect the canonical
status and warnings for that fact.

## Ownership and conflicts

- A missing `AGENTS.md` may be created as AI Office-owned compiled output.
- An AI Office-owned `AGENTS.md` may be updated by a newly approved plan.
- An existing user-owned `AGENTS.md` remains authoritative and is never
  overwritten. It is reported as `unmanaged`, and plans include an actionable
  warning because manual reconciliation may be needed.
- A missing `CLAUDE.md` may be created with the bridge.
- Existing user Claude instructions are preserved; AI Office appends or updates
  only its marked bridge.
- An existing direct `@AGENTS.md` import needs no change.
- Malformed or duplicated markers fail closed.
- Existing `CODEX.md` is reported as legacy user-owned state and is never
  rewritten automatically.
- Any relevant concurrent edit changes the plan hash or file precondition and
  prevents apply.

When the canonical file is user-owned, planning never mutates it. Claude may
still plan or maintain a bridge to that file, but doing so does not change its
canonical ownership or status.

These commands are separate from `project:onboard`. Project import may detect
instruction files, but passive scanning never mutates them.

## Deliberate limitations

The implementation does not modify `~/.codex/config.toml`, user Claude
settings, or the developer's real home in tests. It does not launch clients to
probe versions, persist setup choices, support other clients, or assemble
internal-agent prompts. Those concerns require separate evidence and authority.
