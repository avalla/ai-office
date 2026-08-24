# ADR-0008: Separate portable repository identity from runtime project identity

- Status: Accepted
- Date: 2026-08-23

## Context

AI Office can manage several repositories in one local runtime. A repository
needs a visible, deterministic anchor for discovery, but authoritative project
state and the runtime's project record remain in SQLite.

The first lifecycle implementation proposed a committable binding containing
the creating runtime's `projectId`. That value identifies one row in one
`project.sqlite`; it is not portable to another developer, a fresh runtime, or
a clone. Calling such a file portable would make a normal clone immediately
stale and turn `--rebind` into routine onboarding.

The design must distinguish:

```text
portable repository identity
runtime-local project identity
canonical checkout association
authoritative project state
```

It must not add paths, credentials, capabilities, client state, or copied
authority to the repository.

## Decision

Use a strict, committable schema-version 2 artifact at
`<project-root>/.ai-office/project.json`:

```json
{
  "schemaVersion": 2,
  "managedBy": "ai-office",
  "repositoryId": "repo_<opaque-id>"
}
```

`install` generates `repositoryId` once when no artifact exists. The value is
opaque, contains no machine information, and is preserved across clones and
moves. Unknown fields and unsupported schemas fail closed. The file contains no
absolute path, runtime locator, project name, runtime `projectId`, credential,
capability, client executable path, or authoritative state.

The selected runtime maps `repositoryId` to exactly one local `projectId` in
`project_repository_identity`. A project has at most one portable repository
identity in that runtime. Canonical checkout paths remain in `project_source`;
multiple verified checkouts may map to the same project. SQLite remains the
only operational authority. The portable artifact is reconciliation metadata,
not a second project record.

On a runtime that has never seen the identity, `install` imports the checkout,
creates a local project, and records the mapping. If the runtime already knows
the identity but not the checkout path, install attaches the checkout only when
its detected Git remote matches a known source. An incompatible remote, or a
second unverifiable checkout with no common remote evidence, fails closed as a
probable copied identity. A brand-new runtime cannot distinguish an
intentionally cloned artifact from an accidentally copied one without external
identity infrastructure; accepting the first association is the explicit local
trust bootstrap.

No machine-local `local.json` is introduced. A second repository file would
duplicate association state and create stale coordination with SQLite. Status
reports the portable identity and the current runtime association separately.

Schema-version 1 bindings are read for compatibility. Install derives a stable
`repositoryId` from the legacy `projectId`, reuses that project when it exists
in the selected runtime, and atomically replaces the repository file with
schema version 2. If the legacy project no longer exists, status reports
`project_missing`; install may create a new local project under the derived
portable identity and reports the migration. No database or live runtime is
silently copied.

Install targets its explicit canonical directory. Status, uninstall, and
automatic project-scoped command resolution walk real ancestors on the same
filesystem device; the nearest binding wins. Traversal stops at the filesystem
root or before crossing a device boundary. Symlinked `.ai-office` or
`project.json`, malformed JSON, unsupported schemas, and non-regular filesystem
entries fail closed.

Binding writes use expected hashes and atomic replacement. Repository-local
uninstall preserves `project.json` as the committable participation signal and
removes only the current checkout association plus AI Office-owned client
artifacts. A detachment tombstone prevents compatibility fallbacks from
resurrecting the removed path. Project rows, other checkouts, repository
identity mappings, runtime state, and global memory survive.

## Considered alternatives

### Machine-local binding only

Rejected because a clone would contain no durable signal that the repository
participates in AI Office and discovery would again depend entirely on one
machine's state.

### Portable artifact plus machine-local association file

Rejected because the machine-local mapping would duplicate SQLite's
authoritative `repositoryId -> projectId` and canonical-source associations.

### Commit a runtime `projectId`

Rejected because a runtime-local row ID is not repository identity. It makes
normal collaboration look stale and couples a committed artifact to one
creator's authority.

### Derive identity only from Git remote or content

Rejected because repositories can be local, remotes can change, forks are
ambiguous, and content hashes change. Git remote is corroborating evidence for
additional checkout association, not authority.

### Put `project.sqlite` in every repository

Rejected because it fragments one logical office and duplicates operational
state.

## Consequences

- A clone carries a safe participation anchor but establishes its own runtime
  association with ordinary `ai-office install .`.
- Two runtimes may map one `repositoryId` to different `projectId` values
  without conflicting authority.
- Two verified checkouts in one runtime can share one project history.
- Repository moves reconcile when repository evidence matches; ambiguous copies
  fail closed with an actionable error.
- `--rebind` is exceptional recovery for a genuinely copied or intentionally
  split identity, not normal first-clone setup.
- Removing the portable artifact is a source-control decision, not part of
  local uninstall.
- Remote/shared identity federation and stronger copy detection remain future
  scope.
