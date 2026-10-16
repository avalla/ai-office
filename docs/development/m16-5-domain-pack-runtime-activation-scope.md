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
2026-10-09). Pipeline selection still uses the legacy `OfficeManifest`; the
first activation slice delivered in PR #168 pins the resolved configuration
for nonempty pack selections. Production pack adoption remains GP-10C-2 work.
M16.5 closes the remaining execution gap under the owner rulings below;
each task records its own scope and acceptance criteria.

## What M16.5 is already expected to contain

Carried over from the M16 exit re-scope and updated to the owner's
2026-10-15 order. The table records the accepted ordering prerequisites;
each item's task record defines its remaining scope and acceptance criteria:

| Item                                                       | Depends on                              | Scope                                                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime activation (task `aa10a111`, requirement M165-ACT) | GP-10B-2, GP-25                         | Consume the resolved configuration. The configuration digest and exact source pack tuples are already pinned by PR #168; pipeline, stage and role selection is the remaining activation work. |
| Execution parity (task `a45ddb12`)                         | GP-10B-1, GP-10B-2, GP-25, activation   | Compare execution from a resolved configuration with legacy execution.                                                                                                                        |
| GP-10C-2 — development pack adoption                       | GP-10C-1, activation; after parity      | Preview explicit adoption and catalog registration, preserving old bindings.                                                                                                                  |
| GP-24 — block pack removal on active pack-pinned runs      | Runtime activation; after GP-10C-2      | Use activation's persisted pins to block removal. Its own scope determines whether workflow changes are also blocked.                                                                         |
| GP-16 run gate (task `f8d75709`)                           | GP-16, activation, GP-24                | Bind registered providers at bootstrap and reject a missing required provider before runs. Neither parity nor GP-24 owns this gate.                                                           |
| GP-12 follow-ups (`57a1833f`, `e003843f`; M165-GP12-FU)    | After the run gate in the owner's order | Each follow-up retains its own task scope.                                                                                                                                                    |

GP-14B moved to M11.6 on 2026-10-15 (requirement GP-14B-M116, task
`d991b5be`). It depends on GP-14A and M11.6 Phase B's artifact, evidence and
review contract; it is outside this M16.5 sequence.

ADR-0026 (`docs/adr/ADR-0026-core-domain-pack-boundary.md`) already describes
the target for most of this: Runtime consumption of generic effective
definitions with no domain-specific identity checks; run pins recording
`configurationDigest` and exact `(id, version, manifestDigest)` tuples in one
authoritative transaction; removal previewed and blocked while active pinned
runs or project-owned references need the pack; a previewed, explicit
migration to a development-pack binding; fail-closed resolution and policy
composition; and cross-domain fixtures (development, legal, manufacturing,
empty/custom) exercising the same Runtime contracts. The
[M16 exit record](generic-core-domain-packs.md#m16-exit-re-scope-owner-decision-2026-10-06)
reserved these clauses for M16.5 rather than claiming them at the M16 exit.
PR #168 subsequently delivered run pinning; the remaining execution,
removal and adoption clauses are still task-owned work.

The [roadmap's M16.5 record](roadmap.md#m165--domain-pack-runtime-activation)
assigns Runtime activation to task `aa10a111-9658-4f11-b99f-7074fe522588`
(requirement M165-ACT). Activation slices retain that task identity.

## Proposed first slice: Runtime activation (pin only, no pipeline-selection change)

At the user's request, this narrows "Runtime activation" to the smallest
piece that is both coherent and independently approvable: satisfy only
ADR-0026's run-pinning clause. It deliberately leaves pipeline/stage/role
_selection_ on its current legacy path, and leaves `officeTaskKinds`, the
GP-16 run gate and GP-24 for later slices (GP-14B left M16.5 for M11.6; the
decisions below are now resolved).

**Historical baseline before PR #168, grounded in code at proposal time:**

The following baseline and proposed shape explain the delivered pin-only
slice; the implementation status below supersedes their pre-implementation
statements.

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
- Decision 4 (ADR-0026): sufficient as the target; implement it as accepted, task by task. A
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
   "reject a missing required provider before runs" belong to `f8d75709`.
   Neither execution parity (`a45ddb12`) nor GP-24 owns this gate.
3. **GP-14B's dependency on M11.6 Phase B. — Resolved 2026-10-15: GP-14B
   moves to M11.6 and leaves M16.5.** Evidence/validator _enforcement_
   (as opposed to the GP-14A declaration layer, already delivered) needs the
   M11.6 Phase B persisted artifact/evidence/review contract, which does not
   exist in code. M16.5 proceeds without GP-14B; M11.6 owns its prerequisite
   contract and enforcement delivery.
4. **ADR-0026 status. — Resolved 2026-10-15: ADR-0026 is sufficient and is
   the target to implement as accepted.** Several clauses remain
   accepted-but-unmet. Implement them task by task; any architectural conflict
   discovered during implementation stops work for an owner decision.
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
