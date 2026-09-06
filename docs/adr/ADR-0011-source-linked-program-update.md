# ADR-0011: Update source-linked program installations through an exact plan

- Status: Accepted
- Date: 2026-08-26
- Updated: 2026-09-05 for Runtime boundaries and source isolation (ADRs 0014/0016)

## Context

AI Office currently exposes its executable by registering a source checkout
whose package is marked private with bare `bun link`. It is not published and is
not installed with `bun add -g`, so `bun update -g` cannot update it. Project
`install` reconciles runtime and repository integration state; it does not and
must not mutate the program distribution.

Users otherwise have to coordinate Git, dependency installation, and link
registration manually. Updating a checkout while a Runtime host using it is
running can also leave the serving process and on-disk program at different revisions.
These side effects do not share a transaction and cannot truthfully be
presented as one atomic operation.

## Decision

The linkable CLI exposes an offline user-facing command:

```text
ai-office update [--approve <plan-hash>] [--json]
```

`update` resolves the distribution root from the executable, never from the
current project or runtime home. It supports only the current source-linked
package layout. `RuntimeCliOptions` / `runRuntimeCli` route maintenance before
operational Runtime selection. Shared help and parsing remain in
`packages/command-support`; no legacy CLI composition is restored.

### Runtime source isolation and health preflight

The current source bin, including `bun link`, normally requires
`AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1` for operational access to the user
Runtime. `update` is an explicit maintenance exception: it can check host
presence without that opt-in but cannot issue Runtime commands or queries, read
SQLite, start a host, or migrate state. It never changes that environment flag
or `AI_OFFICE_HOME`. Local help precedes even this maintenance path.

A health-only application port gates planning and apply. Its local adapter uses
the existing read-only path resolver to identify exactly:

1. the selected user Runtime home: `AI_OFFICE_HOME`, otherwise `~/.ai-office`;
2. the development Runtime home: `<executable-distribution-root>/.ai-office`,
   independent of caller cwd and of `AI_OFFICE_HOME`.

Duplicate socket paths are checked once. The probe sends only `GET /health` to
`<home>/daemon.sock`; any HTTP response establishes a listener and blocks update,
including incompatible/failed health. Only missing/refused socket connections
establish absence. Timeout, access errors, and ambiguous transport failures
block with `runtime_not_verified`, never a false “Runtime stopped” result.
Neither home nor database is created or opened. The guard runs before planning,
before apply's full replan, and once more before adapter mutation.

These are point-in-time presence checks, not a lock against concurrent host
startup or hostile same-user processes. Operators must keep hosts stopped for
the whole update. The system has no distribution-to-runtime registry and does
not scan arbitrary homes or claim to detect every `AI_OFFICE_HOME` used in other
terminals. An explicit user override selects that home, not an additional scan
of the default. Other known hosts using the distribution must be stopped by
the operator. No stronger exclusivity guarantee is claimed.

### Exact plan and application

Planning canonicalizes and validates the distribution, requires a clean
tracked Git worktree and a checked-out branch with a conventional upstream,
and uses `git ls-remote` to resolve the exact advertised target commit. When
that commit is absent locally, planning fetches the advertised upstream ref into
a random `refs/ai-office/update-plan/*` temporary ref with fetch-head writes and
submodule recursion disabled, an empty `--refmap=` to disable configured
tracking-ref updates, and auto-maintenance disabled. It verifies the fetched
commit and removes the temporary ref through an unconditional cleanup boundary.
Failure to remove the ref blocks plan creation. Planning then revalidates HEAD,
tracked worktree, branch and upstream selection, and proves fast-forward ancestry.

This acquisition may add immutable Git objects to the local object database; it
does not change the checked-out branch, index, tracked files, normal upstream
tracking ref, or program revision. A plan is never returned until
fast-forwardability has been proven. The plan binds the distribution root,
package identity, branch, remote name, a credential-safe SHA-256 fingerprint of
the ordered configured and effective fetch URLs (including Git URL rewrites),
upstream and remote-tracking refs, current and target revisions, and ordered steps into a deterministic hash. The raw remote URLs are
not exposed. Untracked files are preserved and do not invalidate the plan; Git
still fails closed if one conflicts with an
incoming tracked path. Detached, locally ahead, and divergent branches require
manual reconciliation.

After explicit approval, the application service repeats the complete preflight
including remote-object acquisition and ancestry proof, and rejects stale
approval. The adapter then:

1. fetches the approved upstream ref and verifies `FETCH_HEAD` still equals the
   approved target;
2. revalidates HEAD, tracked cleanliness, branch and upstream selection, then
   performs a fast-forward to that commit with hooks disabled and
   `--no-overwrite-ignore` to preserve ignored untracked files;
3. runs `bun install --frozen-lockfile` in the distribution root;
4. refreshes the package and executable registration with bare `bun link`.

The application owns planning, plan hashing, approval, and result semantics.
The local CLI adapter owns Git, filesystem inspection, Bun subprocesses, and
source-layout knowledge. No Runtime command, SQLite transaction, project
application service, or controlled-action capability is reused for program
maintenance.

The result contract distinguishes `updated`, `already_current`, `failed`, and
`partial`, and reports completed and failed steps. A failure after the
fast-forward is partial: the command gives deterministic dependency/link repair
instructions and does not attempt a destructive rollback. If HEAD cannot be
observed after a mutation attempt, `toRevision` is `null` and the outcome is
conservatively `partial`, requiring inspection rather than claiming success.
Normal Runtime host startup after a complete update applies forward SQLite
migrations using the existing migration runner.

## Preserved boundaries

- The distribution root is program code, not runtime authority.
- `AI_OFFICE_HOME` selects only a health-preflight destination and is never
  mutated. `project.sqlite`, `global.sqlite`, repository bindings and project
  integration state are never read or targeted for mutation by the updater.
- `update` does not update Bun, switch branches, stash changes, rewrite history,
  purge state, restart a Runtime host, or install a published package.
- Remote URLs and subprocess output are not emitted in the stable result, which
  avoids leaking embedded credentials or incidental local details.
- Approval is bound to one target commit; an upstream change requires a new
  plan and confirmation.

## Alternatives considered

### Use `bun update -g`

Rejected for the current packaging. Bun applies global update to packages
installed with `bun add -g`; AI Office is a bare source link and is not
published.

### Make `update` print manual instructions only

Rejected because it would advertise a lifecycle command without actually
updating the installed program or protecting step ordering and partial state.

### Pull automatically without approval

Rejected. It would combine network-selected code, checkout mutation, dependency
installation, and global link mutation without allowing the user to inspect the
source and target revisions.

### Roll back after dependency or link registration fails

Rejected. Git, dependency directories, package lifecycle behavior, and Bun's
global link registry do not share a transaction. An improvised rollback could
destroy user state or conceal an ambiguous installation.

### Update through the Runtime host

Rejected. The Runtime host would update the program implementing its own running
process and could become incompatible with the CLI or newly migrated storage.

## Consequences

- The source-linked installation has an honest, reviewable update lifecycle.
- Project and global data survive program updates and distribution moves.
- The selected user and distribution development Runtime hosts must be stopped
  and kept stopped; restart the desired host explicitly after a complete update.
- Presence checks cover only the two authoritative destinations described above.
- Network or authentication failure before fast-forward is non-mutating to
  program files; later failures are reported as partial with recovery.
- Published packages or compiled releases will require another infrastructure
  adapter while preserving the same application-level plan/result semantics.
