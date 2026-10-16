# M16.5 — Domain Pack Runtime Activation: scope proposal

Status: **owner decisions recorded 2026-10-15; no acceptance criteria are
committed here**. All five decisions below are resolved, and each M16.5 task
is still scoped by its own task record. The document was written so the
project owner could rule on the open decisions before any M16.5 task was
opened, per this project's "Architecture changes: approval-required" policy.
See the
[roadmap](roadmap.md#m165--domain-pack-runtime-activation) stub this document
expands on, and the
[M16 exit re-scope](generic-core-domain-packs.md#m16-exit-re-scope-owner-decision-2026-10-06)
that created M16.5.

## Why this exists

The user asked for ai-office to eventually have a working legal pack
(civil/criminal/labor). `packages/domain-pack-legal/manifest.json` now
declares that content at the definition layer (practice-area-depth addition,
2026-10-09), but nothing in the Runtime executes from a pack yet: pipeline
runs are still created from the legacy `OfficeManifest`, no run pins a pack
configuration, and no project has adopted any pack in production. Closing
that gap is M16.5. It has no owner-approved scope today — this document is the
first step toward one, not the scope itself.

## What M16.5 is already expected to contain

Carried over verbatim from the M16 exit re-scope decision
(`generic-core-domain-packs.md:5677-5684`); the "depends on" column is
provisional and set by each item's own future scope proposal, not by this
document:

| Item                                                                       | Depends on (provisional)              | Scope                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime activation (no task yet)                                           | GP-10B-2, GP-25                       | Runtime execution consumes the resolved configuration; a new run persists its `configurationDigest` and exact source pack tuples with its existing pins (ADR-0026). |
| GP-24 — block pack removal on active pack-pinned runs                      | Runtime activation                    | Block a pack removal while an active run pins that pack.                                                                                                            |
| Runtime task `a45ddb12-3159-4b60-9b8b-c26516720834`                        | GP-10B-1, GP-10B-2, GP-25, activation | Execution parity: compare execution from a resolved configuration with legacy execution.                                                                            |
| GP-14B — evidence and validator enforcement (moved to M11.6 on 2026-10-15) | GP-14A, M11.6 Phase B                 | Stale evidence and invalid validator output fail closed, with version-bound review.                                                                                 |
| GP-10C-2 — development pack adoption                                       | GP-10C-1, activation                  | Previewed explicit adoption of the development pack and its catalog registration, preserving old bindings.                                                          |
| GP-16 run gate                                                             | GP-16, activation                     | Bind registered providers at bootstrap; reject a missing required provider before runs.                                                                             |

ADR-0026 (`docs/adr/ADR-0026-core-domain-pack-boundary.md`) already describes
the target for most of this: Runtime consumption of generic effective
definitions with no domain-specific identity checks; run pins recording
`configurationDigest` and exact `(id, version, manifestDigest)` tuples in one
authoritative transaction; removal previewed and blocked while active pinned
runs or project-owned references need the pack; a previewed, explicit
migration to a development-pack binding; fail-closed resolution and policy
composition; and cross-domain fixtures (development, legal, manufacturing,
empty/custom) exercising the same Runtime contracts. The M16 doc itself
records these parts as accepted-but-unmet and reserved for M16.5
(`generic-core-domain-packs.md:5693-5697`).

A task ID for exactly this item is already reserved, outside this document,
by the in-progress Agent Workflow Studio program plan:
`docs/development/agent-workflow-studio.md:225` tracks "M16.5 — Runtime
activation (execution from the resolved configuration)" as Runtime task
`aa10a111-9658-4f11-b99f-7074fe522588`, a hard prerequisite of AWS-04-T4 and
AWS-09-T3. Any approved scope for this item should use that task ID rather
than minting a new one.

## Proposed first slice: Runtime activation (pin only, no pipeline-selection change)

At the user's request, this narrows "Runtime activation" to the smallest
piece that is both coherent and independently approvable: satisfy only
ADR-0026's run-pinning clause. It deliberately leaves pipeline/stage/role
_selection_ on its current legacy path, and leaves `officeTaskKinds`, the
GP-16 run gate, GP-24 and GP-14B for later slices (the decisions below, now resolved;
they applied to those, not to this one).

**As-is, grounded in code (file:line):**

- The only `PipelineRun.create` call site in the codebase is
  `ManagePipelineRuns.start` (`packages/application/src/pipeline/manage-pipeline-runs.ts:52-122`).
  It reads `this.manifests.findLatest(input.projectId)` — the legacy
  `OfficeManifestRepository` — at line 75, finds the named pipeline inside
  that manifest revision (`:78-84`), and calls `PipelineRun.create(...)`
  (`:86-96`). It never reads `ReadProjectConfiguration` or any pack state.
- `office:pipeline` / `GetOfficeContext.resolvePipeline`
  (`packages/application/src/queries/get-office-context.ts:44-58`) is a
  separate, read-only task-kind-to-pipeline lookup. It is **not** called by
  `ManagePipelineRuns` or any run-creation code; an operator runs it manually
  and passes the result to `pipeline:start --pipeline <id>` by hand.
- Today's `PipelineRun` pins: `manifestRevisionId`, `manifestRevision`, a
  frozen `definition: OfficePipeline` snapshot (`packages/domain/src/pipeline/pipeline-run.ts:23-39`).
  Enforced immutable after insert by `pipeline_run_immutable_definition`
  (`migrations/project/0020_pipeline_enforcement.sql:36-39`) and revalidated
  on every write by `migrations/project/0035_pipeline_manifest_revision_tuple.sql`.
  No `pipeline_run`, `pipeline_stage_run` or `agent_run` column anywhere
  stores a pack identity or a configuration digest (confirmed by repo-wide
  search).
- `ReadProjectConfiguration.read(projectId)` (`packages/application/src/domain-pack/read-project-configuration.ts:28-59`)
  already computes, fresh on every call inside one short transaction, exactly
  the shape ADR-0026 wants pinned: `pin: {configurationDigest,
coreContractVersion, bindingRevision, definitionRevision, selectedPacks,
resolvedPacks}` (`resolve-project-configuration.ts:328-335`), where each of
  `selectedPacks`/`resolvedPacks` is a `{id, version, manifestDigest}` tuple.
  Today its only caller is the inspection-only `project:configuration:show`
  CLI (`packages/runtime-host/src/commands/project-configuration.ts:27-44`);
  nothing persists or schedules from it.

**ADR-0026's target is additive, not a replacement**
(`docs/adr/ADR-0026-core-domain-pack-boundary.md:236-238,252`, exact text):
"A new run records `configurationDigest` and exact source `(id, version,
manifestDigest)` tuples **alongside its existing immutable manifest/definition
pins** in one authoritative transaction. This is a forward-only extension...
None of these cases changes the task, run, approval or action state
machines." The ADR does not say _how_ to thread the resolved pin into run
creation — that mechanism is this proposal's job, not something already
decided.

**The guardrail this slice must deliberately change, not route around.**
`tests/unit/architecture-boundaries.test.ts:38-94` ("GP-06 configuration
remains derived and outside scheduling and portable authority") mechanically
asserts that no file under `packages/application/src/runtime/**` contains the
string `ReadProjectConfiguration`, and no file under
`packages/storage-sqlite/src/**` contains `resolved_project_configuration`.
`ManagePipelineRuns` happens to live under `packages/application/src/pipeline/`,
not `src/runtime/` — so calling `ReadProjectConfiguration` from it would not
literally trip that specific path check. That would be a technicality, not
compliance: the test's own name states the accepted boundary this slice
changes in substance ("remains... outside scheduling... authority"), and the
test must be revised deliberately, with the owner's sign-off recorded, rather
than satisfied by which directory the calling file happens to sit in.

**Proposed shape, still only a proposal:**

- A forward-only migration adds nullable `configuration_digest`,
  `core_contract_version`, `binding_revision`, `definition_revision` columns
  to `pipeline_run`, plus a child table for the exact pack tuples (same shape
  as `project_pack_binding_pack` from `migrations/project/0041_project_pack_binding.sql`:
  project_id, pack_id, pack_version, manifest_digest), with an immutability
  trigger mirroring `pipeline_run_immutable_definition`.
- `ManagePipelineRuns.start` additionally calls `ReadProjectConfiguration.read(projectId)`
  inside its existing transaction when the project's pack selection is
  nonempty, and passes the resulting `pin` into `PipelineRun.create(...)`.
  When the selection is empty — every project in production today, since no
  pack is yet registered in the production catalog — the new columns stay
  null and nothing else changes.
- Which pipeline, stages and roles run, and every existing state transition
  (`assign`, `completeStage`, `approveStage`, `reject`, `cancel`, ...), are
  untouched. This is identity pinning only.

**Status: implemented (2026-10-11), at the user's explicit request.** See the
addendum in `generic-core-domain-packs.md` ("Runtime activation — first slice
implemented") for the exact files and the fix for a real bug this surfaced
(`SqlitePipelineRunRepository.restore` treated a database that predates
migration 0051 as if it had a pin, because `undefined !== null`). The
guardrail conflict above was resolved by moving `ReadProjectConfiguration`'s
construction out of `commands/pipeline.ts` entirely, into the one place
`CommandContext` is built (`runtime-command.ts`), exposed as
`context.projectConfiguration` -- so no scheduling command holds
`definitions`/`packBindings` directly, and `tests/unit/architecture-boundaries.test.ts`
gained an explicit test asserting this pin-only boundary.

**What this slice does _not_ do, stated plainly:** it does not make a legal,
civil, criminal or labor matter runnable — this slice leaves task-kind handling
unchanged (the list was closed when it shipped; it was opened afterwards by a
separate standalone change, see decision 1) and pipeline/stage/role selection
stays manifest-driven. It has **zero observable
effect in production** until GP-10C-2 (development pack adoption) also ships,
since every project's pack selection is empty until then. It is provable only
through the existing test fixtures (the same `InMemoryInstalledDomainPackCatalog`
pattern already used in `tests/integration/legal-reference-pack.test.ts` and
`tests/integration/four-domain-definition-gate.test.ts`). The execution-parity
task (`a45ddb12-3159-4b60-9b8b-c26516720834`) stays out of scope: comparing
pack-resolved execution against legacy execution is meaningless until pipeline
_selection_ also comes from a pack, which this slice does not change.

## Owner rulings, 2026-10-15

- Decision 2 (run gate): its own task `f8d75709`, after Runtime activation and
  GP-24. The execution-parity task and GP-24 do not own it.
- Decision 3 (GP-14B): deferred to M11.6, whose Phase B it depends on. It is
  requirement GP-14B-M116 and leaves M16.5.
- Decision 4 (ADR-0026): sufficient as the target; implement as accepted. A
  conflict found during implementation stops work for an owner decision.
- Decision 5 and the extent of activation: selection of pipeline, stages and
  roles comes from the resolved configuration only for projects that adopted
  a pack (GP-10C-2); projects without an adopted pack keep legacy selection.
  Execution parity proves the two paths equivalent for the development pack.
- Order: activation, then parity, GP-10C-2, GP-24, the run gate, and the two
  GP-12 follow-ups.

## Owner decisions (all resolved)

All five decisions are resolved: decision 1 on 2026-10-11 and decisions 2-5 on
2026-10-15, as summarized in the rulings above. The entries below keep the
original question for each, each marked with its resolution. The first slice
above needed none of them, since it only pins identity and leaves pipeline
selection, task-kind routing and policy enforcement untouched.

1. **Opening the closed `officeTaskKinds` list. — Resolved 2026-10-11 as a
   standalone change.** `packages/domain/src/office/office-manifest.ts` used to
   hard-code exactly five software task kinds. At the owner's explicit request
   the manifest schema, `office:pipeline` and the generated guidance now accept
   any manifest-declared kebab-case task kind; the five stay as shipped
   defaults (see the 2026-10-11 addendum in `generic-core-domain-packs.md`).
   This resolves only that question. It is not part of M16.5 delivery and does
   not approve the rest of this proposal; whether the M16 "no privileged core
   import or branch" rule covers the list is not decided here.
2. **Splitting the GP-16 run gate. — Resolved 2026-10-15: its own task
   `f8d75709`, after Runtime activation and GP-24.** The merged GP-16 delivered only
   capability declarations and fail-closed provider availability at
   resolution/binding preflight; "bind registered providers at bootstrap" and
   "reject a missing required provider before runs" are M16.5. The roadmap
   itself flags the split between the execution-parity task (`a45ddb12`) and
   GP-24 as undecided. **Needed decision:** which task owns the run gate, and
   in what order relative to Runtime activation.
3. **GP-14B's dependency on M11.6 Phase B. — Resolved 2026-10-15: GP-14B
   moves to M11.6 and leaves M16.5.** Evidence/validator _enforcement_
   (as opposed to the GP-14A declaration layer, already delivered) needs the
   M11.6 Phase B persisted artifact/evidence/review contract, which does not
   exist in code. **Needed decision:** whether M16.5 waits for M11.6 Phase B
   before scoping GP-14B, or ships Runtime activation first without
   enforcement and defers GP-14B again.
4. **ADR-0026 status. — Resolved 2026-10-15: ADR-0026 is sufficient and is
   implemented as accepted.** Several of its clauses are accepted-but-unmet. **Needed
   decision:** whether M16.5 treats ADR-0026 as already settling the target
   architecture (just needing implementation), or whether activation design
   work surfaces changes that need an ADR amendment/addendum before
   implementation starts.
5. **Which fixtures Runtime activation targets first.** Resolved for the
   pin-only first slice above: it is generic to any nonempty pack selection
   and is proven through the existing development/legal/manufacturing test
   fixtures without choosing one. Resolved 2026-10-15 for later slices:
   selection from a pack applies only to projects that adopted a pack, and
   execution parity proves the pack and legacy paths equivalent for the
   development pack (via GP-10C-2).

## Non-goals (carried from M16.5's roadmap stub)

Expected to match M16's non-goals until a scope proposal says otherwise:
complete legal software, MES/ERP/industrial integrations, third-party
marketplace/distribution, remote registry/dynamic downloading, untrusted
executable plugins or runtime-generated packs, and replacing the pipeline
engine, governance, `ProjectStorage`, `AgentKnowledgeStore`, model routing or
worker queue.

## What happens after this document

This document does not authorize work by itself. With the five decisions
resolved, each M16.5 item proceeds under its own task record and scope
(mirroring the GP-xx pattern used throughout `generic-core-domain-packs.md`),
in the order set by the rulings above.
