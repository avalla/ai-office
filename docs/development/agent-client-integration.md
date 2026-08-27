# External agent client integration

AI Office supports repository-local Codex CLI and Claude Code integration
through one application port. Detection is derived from `PATH`; inspection,
planning, and validation are read-only. Every mutation uses an exact approved
plan, file-hash preconditions, ownership checks, and atomic per-file writes.

## Repository artifacts

Normal `ai-office install .` derives the current instruction contract in memory
from the authoritative office manifest and projects it into:

```text
<integration-root>/
├── AI-OFFICE.md                         shared project guidance
├── AGENTS.md                            minimal Codex pointer
├── CLAUDE.md                            Claude @AI-OFFICE.md bridge
├── .agents/skills/ai-office/SKILL.md    primary AI Office skill
└── .claude/skills/ai-office/SKILL.md    Claude discovery wrapper
```

`AI-OFFICE.md` is the only full project-guidance projection. It contains the
mission, operating policy, repository map, invariants, workflow, testing,
documentation, and definition of done. It is derived Markdown, not authority;
the approved office manifest and project state remain in SQLite.

Codex discovers `AGENTS.md` but does not implement Markdown imports. The
AI Office-owned file therefore contains an explicit short instruction to read
`AI-OFFICE.md` and use `$ai-office`. Claude supports imports, so AI Office adds
this marked block to `CLAUDE.md`:

```markdown
<!-- >>> ai-office managed: canonical-project-instructions -->

@AI-OFFICE.md
<!-- <<< ai-office managed: canonical-project-instructions -->
```

Codex discovers the primary skill under `.agents/skills`. Claude discovers the
small wrapper under `.claude/skills`; that wrapper directs the host to the
primary skill and shared guide without duplicating the workflow. AI Office does
not create symlinks. The wrapper uses Claude Code's documented
[`${CLAUDE_PROJECT_DIR}` project-root variable](https://code.claude.com/docs/en/plugins-reference#environment-variables)
for project-rooted paths, so it is independent of the wrapper directory depth.

These files contain no credentials, absolute machine paths, runtime project ID,
capability grant, approval, or copied authoritative state. They may be
committed. A clone still runs `ai-office install .` to establish its runtime
association and reconcile the projections with that runtime.

## CLI workflow

The normal lifecycle composes client integration:

```bash
ai-office install .
ai-office status
```

Install detects supported executables without launching them, preflights every
detected or already-managed adapter, then plans and applies clients
sequentially. The output lists each created, updated, or preserved path.

The lower-level commands remain available for automation, debugging, custom
contracts, and one-client repair:

```bash
ai-office client:detect
ai-office client:inspect --client claude --root /path/to/project
ai-office client:plan \
  --client claude \
  --root /path/to/project \
  --contract .ai-office/agent-instructions.json
ai-office client:apply \
  --client claude \
  --root /path/to/project \
  --contract .ai-office/agent-instructions.json \
  --approve <plan-hash>
ai-office client:validate --client claude --root /path/to/project
```

The optional contract must be a regular JSON file inside the integration root
and is limited to 256 KiB. Normal lifecycle install does not persist it.

## Ownership and status

File ownership and integration status are independent:

| State        | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `missing`    | The expected artifact is absent.                                                         |
| `integrated` | The artifact has the expected managed marker or host reference.                          |
| `drifted`    | The artifact is AI Office-owned but differs from deterministic expected content.         |
| `unmanaged`  | A user-owned artifact occupies the path or lacks the managed reference; it is preserved. |
| `conflict`   | Markers or filesystem state are ambiguous and mutation fails closed.                     |

A client is `configured` only when its shared guide, host discovery file, and
skill are all integrated and its contract-aware plan has no changes. A
user-owned artifact is never reported as configured merely because the host can
read it. Having no supported executable detected is a distinct state from a
detected but incomplete integration.

Online lifecycle status compares every derived artifact with the current
authoritative contract. Offline status remains local: it verifies deterministic
host pointers and both repository skills, but cannot reconstruct the current
`AI-OFFICE.md` body without the SQLite office manifest. Consequently an intact
offline integration is `unverified`; deterministic local drift is still
reported as `drifted`, and missing, unmanaged, or conflicting files retain
their more specific states.

AI Office follows these rules:

- unmarked `AI-OFFICE.md`, `AGENTS.md`, and skill files are user-owned and are
  never overwritten or deleted;
- an old AI Office-managed schema-v1 `AGENTS.md` is migratable, not user-owned;
- a missing `CLAUDE.md` may be created as AI Office-owned;
- an existing user `CLAUDE.md` keeps all user content and receives only the
  marked block;
- malformed or duplicated managed markers fail closed;
- LF and CRLF are equivalent only during parsing and deterministic comparison;
  original user-owned bytes are never rewritten;
- every relevant concurrent edit invalidates the plan hash or file
  precondition;
- nested skill directories are created only under the canonical integration
  root, and symlinked or non-directory parents are rejected;
- unrelated entries under `.agents`, `.claude`, and `.ai-office` are outside
  the integration ownership boundary.

## Upgrade from the original layout

The first lifecycle version stored the complete compiled guide in an
AI Office-managed `AGENTS.md` and made Claude import `@AGENTS.md`. Ordinary
idempotent install migrates that layout after preflight:

1. create schema-v2 `AI-OFFICE.md` from the current authoritative manifest;
2. replace only the recognized managed schema-v1 `AGENTS.md` with the minimal
   Codex pointer;
3. update only the managed Claude block to `@AI-OFFICE.md`;
4. install the primary and Claude wrapper skills.

User-owned files are not treated as legacy managed output. A partial migration
is repaired by rerunning install; there is no cross-filesystem/SQLite rollback
claim.

## Uninstall

Direct client removal retains the same exact-plan contract:

```bash
ai-office client:uninstall --client claude --root /path/to/project
ai-office client:uninstall --client claude --root /path/to/project \
  --approve <plan-hash>
```

Claude uninstall deletes its managed skill wrapper and removes only its managed
bridge. Codex uninstall deletes its managed pointer. Shared `AI-OFFICE.md` and
the primary `.agents` skill are removed by the adapter removing the final host
reference. They are preserved while a Codex instruction file, Claude bridge, or
direct user import still depends on them. A user-owned direct
`@AI-OFFICE.md` import is preserved and keeps the shared files in place until
its owner changes that dependency.

The user-facing `ai-office uninstall .` preflights one aggregate plan, removes
Claude before Codex, and detaches the current checkout association. It removes
only AI Office-owned files and reports any partial result with already removed
or possibly modified paths. It preserves user content, unrelated skills, the
portable `.ai-office/project.json` identity, runtime project state, and global
memory. Empty host directories may remain because AI Office does not infer
directory ownership.

## Boundaries

Client integration never:

- modifies global Codex or Claude settings;
- installs or launches either coding client;
- grants capabilities or action approvals;
- persists client detection as authority;
- moves the runtime database into the repository;
- owns conversational onboarding.

Conversational questions and office synthesis remain host-only. AI Office owns
manifest validation, persistence, policy, controlled execution, and audit. See
[ADR-0012](../adr/ADR-0012-shared-project-guide-and-repository-skills.md).
