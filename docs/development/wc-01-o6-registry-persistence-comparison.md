# WC-01 open decision O6: registry persistence comparison

Status: input to an owner decision. Non-normative. It does not choose, and
ADR-0037 stays Proposed. The owner's stated preference (2026-10-19, a design
preference and not yet a decision) is a dedicated SQLite database separate from
`global.sqlite`; this document tests that preference against the file design in
ADR-0037 decision 4 so the decision can be taken on evidence.

Both options keep the same admission semantics: immutable content-addressed
evidence and decisions, revocations in force once committed, at most one active
decision per subject, a fail-closed load, and no previously loaded snapshot kept
across a failed reload (ADR-0037 decision 4, "Loading"). They differ in where
atomicity, ordering and verification live.

## Options

**A. Content-addressed files** (ADR-0037 as written): digest-named immutable
objects, a manifest chain, a current pointer moved by rename, a publication
exclusion shared by every pointer writer, and a separate state file for the last
accepted generation.

**B. Dedicated host-level SQLite** (`registry.sqlite` in the Runtime home, not
`global.sqlite`): the Runtime is the only writer. Evidence bundles, decisions
and revocations are immutable rows keyed by digest. Generations are rows in an
append-only chain, each naming its predecessor's digest. The last accepted
generation is a row written in the same transaction that publishes the
generation, not a second file.

## Comparison

| Concern                     | A. Files                                                                                                                 | B. Dedicated SQLite                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alignment with AGENTS.md    | A second persistence mechanism for authoritative registry state; needs a recorded justification.                         | Matches the SQLite and migration-runner direction of AGENTS.md (project state in SQLite; a new persistence mechanism is an architectural decision). A new database is still a new persistence surface, so the choice is recorded in the ADR. |
| Atomic publication          | Objects first, then a rename of the pointer. Correctness depends on write ordering, fsync discipline and the exclusion.  | One transaction inserts objects, the generation row and the recorded-generation update. A reader sees the old or the new set.                                                                                                                |
| Crash between publish/state | Possible by construction (pointer renamed, state file not yet written). The load rule recovers it by chain verification. | Not possible inside one database: publication and recorded generation commit together. The lagging-state rule still covers restored backups.                                                                                                 |
| One active per subject      | Enforced by planning code under the exclusion.                                                                           | A partial unique index on subject for active decisions, in addition to code. A violation is a hard failure.                                                                                                                                  |
| Immutability                | Create-exclusive files; relies on never rewriting.                                                                       | Triggers rejecting UPDATE and DELETE on object tables, plus the digest check on every load. Defence in depth against Runtime bugs, not against a same-user writer.                                                                           |
| Verification at load        | Every digest and the chain are read from many files; a torn or partial directory is a normal failure mode to classify.   | Same digest and chain checks over rows. `integrity_check` and the schema version are extra fail-closed inputs. A corrupt database refuses everything.                                                                                        |
| Anti-rollback               | Separate state file plus chain. Restoring directory and state together is undetectable.                                  | Recorded-generation row plus chain. Restoring the whole database file is undetectable unless a second record exists outside it (see below).                                                                                                  |
| Same-user adversary         | Out of scope (decision 7); coordinated rewrite is M10.                                                                   | Out of scope; the file is writable by the same user. SQLite is not a boundary, and this limit must be stated for both options.                                                                                                               |
| Recovery and backup         | Copy a directory plus the state file; restoring one without the other must refuse.                                       | Copy one file with the SQLite backup API; restore is atomic. A restored older database is a rollback and is caught only by an anchor held outside it.                                                                                        |
| Migrations                  | No migration runner. A format change needs a reader for every retained record version.                                   | Existing versioned runner and `schema_migration` tracking, with fresh and upgrade tests. Retained rows keep their canonical digest; migration never rewrites them.                                                                           |
| Inspectability              | A file per object, verifiable without opening the Runtime database.                                                      | Needs a read-only verifier. `registry:verify` is in WC-02 scope under either option.                                                                                                                                                         |
| Concurrency                 | Explicit publication exclusion (lock file); staleness and crash recovery of the lock are part of the design.             | The write transaction is the exclusion. `BEGIN IMMEDIATE` plus an expected-generation check gives the same compare-and-set.                                                                                                                  |
| WC-02 effort                | Object store, manifest codec, pointer, exclusion, state file, torn-write classification.                                 | Schema, migration, repository port and adapter in `packages/storage-sqlite`, sharing the canonical digest code. Less bespoke recovery code.                                                                                                  |
| Layering                    | A file adapter behind a registry port.                                                                                   | A SQLite adapter behind the same registry port. The domain and the admission function do not change.                                                                                                                                         |

## What B needs to be as safe as A

- The anti-rollback anchor must not live only inside the file that a restore
  replaces. B writes the recorded generation and manifest digest both in the
  registry database and in a small separate state record in the Runtime home,
  and refuses when they disagree. This keeps A's property that restoring one
  part without the other is detected. Restoring both together remains the
  coordinated rewrite left to M10.
- A database that cannot be opened, fails `integrity_check`, has an unknown
  schema version, or is missing while the state record names an accepted
  generation refuses every subject with `registry_unreadable`.
- WAL and `synchronous=FULL` for the registry connection, so a committed
  generation survives a crash. Admission uses an immutable snapshot built at
  load, never a live query per admission.
- Triggers or equivalent rejecting updates and deletes of object and revocation
  rows, as defence in depth.
- No reuse of `global.sqlite` or `project.sqlite`: a memory or project migration
  must not change what is admitted (ADR-0037 decision 4).

## Residual risks of B

- A second SQLite file in the Runtime home enlarges the surface that
  `runtime:purge`, update, health checks and backup must know about.
- Atomic commit can make a change look verified when it is only consistent. The
  load-time chain and digest verification stays mandatory.
- The M22 PostgreSQL project authority is unaffected: the registry is host-level
  and its facts describe clients installed on one machine.

## If B is chosen

Decision 4 "Layout", "Atomic update" and the pointer and state-file paragraphs
are replaced by the schema, the publication transaction and the dual
anti-rollback record. The "Loading" rule, revocation and subject-binding rules,
the single-active-decision rule and the refusal reasons do not change. The
file design moves to alternatives, with its cost (a second ordering and recovery
protocol to own). WC-02 scope becomes schema, migration and repository adapter.

## If A is chosen

Keep decision 4 with the corrected "Loading" rule and record why a second
persistence mechanism is justified: verification without opening the Runtime
database, and a retained chain that survives a database migration bug.

## Recommendation

B follows the AGENTS.md direction (project state in SQLite, versioned migrations) and removes
the largest bespoke surface of A (pointer ordering, publication lock, crash
between pointer and state). With the dual anti-rollback record it weakens no
fail-closed property. The owner's preference is consistent with the repository's
architecture. This is a recommendation only: O6 is the owner's decision, and
WC-02 does not start before it is taken and ADR-0037 is accepted.
