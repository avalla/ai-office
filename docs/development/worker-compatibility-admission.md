# M24 — Worker Compatibility & Capability Admission

Status: planned 2026-10-16; WC-01 (this plan, the gap analysis and the
[proposed ADR-0037](../adr/ADR-0037-worker-compatibility-and-capability-admission.md))
delivered as documentation only. No guarantee contract, audit registry, probe
suite or admission change is implemented, and the Codex, Claude and gateway
workers, the allowlists, model routing and local configuration are unchanged.
The authoritative milestone, requirement, task, task→requirement and
task-dependency records live in the AI Office Runtime; this document explains
them. The normative contract is ADR-0037; this plan does not restate it.

## Why this milestone exists

Which worker versions and models the Runtime may dispatch to is decided by
constants in adapter source files, and the evidence behind them lives in code
comments, hand-run checks and a few fake-CLI tests:

- `auditedCodexVersions = {"0.160.0"}` and `auditedBoundedCodexModels =
{"gpt-5.5"}` are two independent sets. The model set is documented as audited
  "under `codex-cli` 0.160.0", but nothing binds a model to a version: adding a
  version to the first set silently inherits the second.
- The Claude worker has no audit. It admits every version `>= 2.1.259` with no
  ceiling, and every `anthropic:` model whose name matches a syntax pattern. Its
  guarantees are the flags it passes (`--tools ""`, `--restricted`, strict empty
  MCP configuration, …). ADR-0017 states that the adapter deliberately does not
  use `--help` as a capability oracle, so no probe checks that a newer Claude
  Code still honors them.
- Admitting a new version, model, feature or plan claim is a production-code
  change, a release and a manual re-verification ("re-verified by hand for each
  audited version", roadmap M12 follow-ups).
- Version, feature-listing, login, plan-claim, platform and probe failures are
  all `WORKER_UNAVAILABLE`, so they are indistinguishable to the operator.
- Dispatch provenance records the client version (`adapterVersion`) and the
  model selection. It does not record which audit admitted the run, what that
  audit asserted, or whether the configuration that ran is the one audited.
- The model gate exists twice, in the adapter and in `run.ts`.

The security-relevant guarantees of a worker depend on four things that move
independently: the client version, the provider-supplied model metadata (which
the Codex client fetches at session start and which "can change the
model-visible tools and the base instructions without any change of CLI
version"), the flags and configuration the adapter passes, and the output
protocol it parses. The current allowlists name one of the four.

> The Runtime admits an exact worker, version, model, configuration and protocol
> only for guarantees that reproducible evidence establishes and that an owner
> decision has accepted. Everything else is _unverified_, and unverified is never
> treated as safe.

## Position and boundaries

- **ADR-0017/0019** define the bounded worker and run-model selection. M24
  changes neither the execution contract nor the routing precedence; it replaces
  the source of the admit/refuse decision.
- **M12** owns the worker port and adapter substitution (M12-WORKER-PORT,
  M12-ADAPTERS, M12-ONBOARD). M24 does not deliver those. WC-05 extends the port
  additively and with a version marker (D7), and is reconciled with whatever M12
  has delivered when it starts. Runtime/version detection (M12-ONBOARD) says what
  is installed; admission says what may run.
- **M18** (SFC) confines the executor process. A confinement level is an
  `enforced` guarantee that M18 produces and M24 consumes; M24 never produces or
  raises one. WC-01 reuses the SFC vocabulary (requested / provider / effective)
  as required guarantees / audit-established guarantees / effective admitted set,
  and SFC-02 and SFC-07 reconcile names when they start.
- **M21** (registered in the Runtime as MAEC-01 … MAEC-12; its plan is not yet in
  the repository) delivers governed child execution. M24 defines the guarantee
  and mode that distinguish bounded execution from governed delegation, and
  records native client delegation as unsupported until Runtime admission exists
  (roadmap M12 follow-up on delegation).
- **M17** observes executor sessions. A hook or session never asserts a
  guarantee. Hook adapters are future consumers of the same contract; no hook
  audit is in scope.
- **M10** hardens against a hostile same-user process and provides signed
  approvals. M24 does not make the Runtime host a boundary against that process.
- **M22** (PostgreSQL authority): the registry is host-local and needs no parity;
  the per-run provenance migration (WC-05) does.
- **M23** (ADR-0036): the read-only bridge never exposes registration.
- **AWS-10-R2 / AWS-11-T5** consume admission as a read-only preflight and report
  `not_checked` when it was not evaluated.

Identifiers such as `M12-WORKER-PORT`, `AWS-10-R2`, `AWS-11-T5` and `MAEC-01`
refer to requirement and task records in the Runtime; their plan documents are
not all in the repository yet, so this plan links only to documents that are.

Non-goals: enabling any new version, model or worker; changing a current
allowlist, flag, admission rule or guarantee; automatic real-provider tests;
Windows worker support; hook-adapter audits; a general plugin system; replacing
controlled actions, grants or approvals; repository-editing execution.

## Gap analysis

| Dimension         | Codex today                                                             | Claude today                              | Target (ADR-0037)                                                                 |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Version           | exact set, one entry                                                    | floor `>= 2.1.259`, no ceiling            | exact version in the subject                                                      |
| Model             | exact set, independent of version                                       | syntax pattern only                       | exact model in the same subject                                                   |
| Configuration     | flags and `isolationConfig` in source; not part of the identity         | flags in source; not part of the identity | effective-configuration digest in the subject                                     |
| Capability probe  | `codex features list` compared with an audited state                    | none                                      | deterministic probes per worker, recorded as evidence                             |
| Provider metadata | not pinned; one drift (`multi_agent v2`) found and patched by hand      | not applicable                            | metadata dependencies per guarantee, drift refuses when it touches a required one |
| Output protocol   | strict JSONL parser, no declared version                                | JSON parser, no declared version          | named protocol id in the subject                                                  |
| Evidence          | comments, hand checks, fake CLI, one opt-in real-CLI replay             | none                                      | digest-addressed evidence bundles, sufficiency by risk tier                       |
| Authority         | source change and release                                               | source change (floor bump)                | operator decision over evidence, plan/approval-bound, revocable                   |
| Refusal           | `WORKER_UNAVAILABLE` for version, feature, login, plan and probe causes | `WORKER_UNAVAILABLE`                      | closed typed reasons naming the failed dimension                                  |
| Provenance        | client version                                                          | client version                            | basis, decision digest, generation, effective guarantees                          |
| Decision sites    | adapter and `run.ts`                                                    | adapter and `run.ts` (model syntax check) | one admission function                                                            |
| Delegation        | refused through knowledge of one model's metadata                       | not applicable (no tools)                 | explicit mode and guarantee namespace, unsupported until governed                 |
| Legacy            | allowlist is the audit                                                  | floor presented as support                | Claude floor carried as a labelled `legacy_policy`, never as certified            |

Non-CLI baseline: the gateway worker is admitted by provider descriptors and the
metered gateway, which the Runtime itself enforces. It is the reference for what
`enforced` means; its guarantees must be expressible in the same contract so a
role can require them uniformly.

## Summary of the design

ADR-0037 is normative. In short:

- the unit of admission is an exact subject `(worker, version, provider, model,
configurationProfile, outputProtocol, platform, mode)`; certification of one
  subject certifies no other;
- guarantees have four states (`enforced`, `verified`, `unverified`,
  `unsupported`) and four risk tiers; a client- or provider-declared restriction
  has weight zero; the evidence needed for `verified` rises with the tier;
- technical **evidence bundles** (what was observed) are separate from
  **certification decisions** (an owner accepts specific evidence for specific
  guarantees) and **revocations**; a digest proves integrity, not trust, and
  sufficiency is recomputed by a deterministic table;
- the host-local registry is content-addressed and immutable, changes through
  atomically published manifest generations, and is revocable;
- admission is one pure function with a closed reason set; drift in a metadata
  projection that a required guarantee depends on refuses new runs, drift
  elsewhere is advisory, and expiry is opt-in and can never prevail over a
  security check;
- bounded execution and governed delegation are separate modes; native client
  delegation is unsupported until governed;
- probes collect evidence and propose; only an operator decision certifies; live
  certification needs an explicit authorization per execution naming worker,
  version, model, credential and USD ceiling; CI never makes a paid call;
- baselines (`baseline_import` for the current Codex combination, `legacy_policy`
  for the Claude floor) reproduce today's behavior without being presented as
  certification.

## Requirements

Recorded in the Runtime as WC-R01 … WC-R14 under the M24 milestone.

| Id     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WC-R01 | No regression: baseline records reproduce every current admit/refuse decision of the Codex and Claude workers exactly, proved by a differential test over a version × model × run-parameter × feature matrix in shadow mode before cutover, apart from the enumerated mandatory refusals of ADR-0037 (drift, validity window, registry integrity).                                                                                                                                                                                                          |
| WC-R02 | Exact subject: worker, exact version, provider, exact model, effective-configuration digest, output protocol, platform and mode. No ranges and no implicit extension: certifying one subject certifies no other.                                                                                                                                                                                                                                                                                                                                            |
| WC-R03 | Guarantee taxonomy: four states and risk tiers; unknown capabilities are `unverified`; a client or provider declaration never raises a state; the Claude legacy policy is labelled `legacy_policy` and never presented as certified.                                                                                                                                                                                                                                                                                                                        |
| WC-R04 | Bounded single-agent execution and governed delegation are separate modes; native client delegation is unsupported absent Runtime admission.                                                                                                                                                                                                                                                                                                                                                                                                                |
| WC-R05 | Evidence proportional to risk: digest-addressed evidence bundles from named versioned suites, with a deterministic sufficiency table by tier; evidence is separate from the certification decision.                                                                                                                                                                                                                                                                                                                                                         |
| WC-R06 | Registration by data: a valid decision for an implemented configuration profile and output protocol is registered without production-code change; a new profile or protocol is code.                                                                                                                                                                                                                                                                                                                                                                        |
| WC-R07 | Authority: registration and revocation are operator-only, plan/approval-bound and audited; probes and live runs only propose; no Runtime-dispatched worker or tool has a path to registration, and the approval authentication class is recorded; a same-account process, including an external coding agent, is not distinguished from the operator until M10, so its separation is an operational rule; the same-user limit (M10) is documented, not claimed. The registry is host-local, content-addressed, immutable, atomically updated and revocable. |
| WC-R08 | Typed refusal diagnostics: closed reason set naming the failed dimension and the nearest decision, before dispatch, without secrets, with a table from each reason to the unchanged public code; public error codes preserved.                                                                                                                                                                                                                                                                                                                              |
| WC-R09 | Provenance: basis, decision digest, registry generation, observed-subject digest, effective guarantees and authentication class recorded per dispatch immutably; history reads `not recorded`; SQLite/PostgreSQL parity and a forward migration.                                                                                                                                                                                                                                                                                                            |
| WC-R10 | Automated offline probes: deterministic, credential-free, runnable in the standard suite and CI against a supplied binary, using a scripted provider endpoint; a skipped probe supports nothing.                                                                                                                                                                                                                                                                                                                                                            |
| WC-R11 | Live certification only under an explicit authorization per execution naming worker, exact version, provider, model, credential and a USD ceiling; never in standard tests or CI; evidence only.                                                                                                                                                                                                                                                                                                                                                            |
| WC-R12 | Release monitoring and recertification: CI and the monitor detect new Codex CLI and Claude Code releases and report compatibility; they enable nothing and need no credentials; a documented recertification procedure covers the triggers.                                                                                                                                                                                                                                                                                                                 |
| WC-R13 | Drift and revocation: metadata drift affecting a required guarantee refuses new runs with a typed reason; informational drift is advisory; decisions can be revoked or superseded; expiry is opt-in and never overrides security checks.                                                                                                                                                                                                                                                                                                                    |
| WC-R14 | Parity: the Claude and Codex guarantee matrices are published with an evidence class per cell; WC-07 evaluates the unproven Claude guarantees and proposes a transition to uniform admission; any change of Claude admission is a separate owner decision.                                                                                                                                                                                                                                                                                                  |

## Delivery graph and tasks

Recorded in the Runtime as WC-01 … WC-08.

| Task  | Deliverable                                                                                                                                                                                                   | Requirements                    | Depends on                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| WC-01 | Capability Admission Contract: gap analysis, ADR-0037 (Proposed), plan and roadmap alignment. Documentation only; the domain types are implemented in WC-02 and WC-05                                         | R02 R03 R04 R05 R07 R08 R13 R14 | none                                |
| WC-02 | Versioned Audit Registry: domain types, catalogue, record schemas and digest, port, host-local adapter, manifest generations, baseline records, revocation, operator plan/approve/apply command, audit events | R02 R05 R06 R07 R13             | WC-01 accepted                      |
| WC-03 | Automated Compatibility Probes: scripted-endpoint harness generalized from the `apply_patch` oracle, probe suites per worker, drift observation feasibility, evidence emitter, proposals                      | R05 R10 R13                     | WC-01 accepted                      |
| WC-04 | Live Behavioral Certification: authorization gate, dedicated credential handling, suite and evidence bundle                                                                                                   | R05 R11                         | WC-02, WC-03; per-run authorization |
| WC-05 | Runtime Admission Integration: single `admit`, additive versioned port extension, baseline records, shadow then cutover, `run.ts` duplicate removed, provenance migration                                     | R01 R02 R08 R09 R13             | WC-02, WC-03                        |
| WC-06 | CI Compatibility Matrix and release monitoring: detection of new Codex CLI and Claude Code releases, report artifact, recertification procedure tooling; enables nothing                                      | R10 R12                         | WC-03                               |
| WC-07 | Claude/Codex Parity Assessment: guarantee matrix per cell, evaluation of unproven Claude guarantees, proposed transition to uniform admission                                                                 | R03 R14                         | WC-03, WC-04                        |
| WC-08 | Operator documentation, rollout gates and milestone exit                                                                                                                                                      | R01 … R14                       | WC-05, WC-06, WC-07                 |

```text
WC-01 ──► WC-02, WC-03
WC-02 ──► WC-04, WC-05
WC-03 ──► WC-04, WC-05, WC-06, WC-07
WC-04 ──► WC-07
WC-05, WC-06, WC-07 ──► WC-08
```

WC-02 and WC-03 both feed WC-04 and WC-05; WC-03 alone feeds WC-06 and, with
WC-04, WC-07; WC-05, WC-06 and WC-07 feed WC-08. The list above and the
"Depends on" column of the table are the same graph.

WC-02 onward start only after ADR-0037 is accepted by the owner. WC-04 also needs
a separate authorization that names worker, version, provider, model, credential
and USD ceiling; it is never started by a milestone run.

### Recertification procedure

Specified in ADR-0037 decision 8. A new client version, a changed configuration
digest, an observed metadata drift, a new routed model, a protocol change, a
revoked or invalidated decision, a suite correction and (if opted in) expiry
each open a recertification: detect → report the unaudited subject and its
nearest decision → run the offline suite → request a live authorization if the
tier requires it → assemble the proposed decision → owner review → publish a new
manifest generation → verify in shadow. The previous version keeps its decision
until the owner revokes or supersedes it; for a subject that needs an exact
certification the new version stays refused until its own decision exists. The
labelled Claude `legacy_policy` is the one exception: a newer Claude version
that satisfies its predicate stays admitted for implicit dispatch until WC-07's
proposed transition is decided. WC-06 supplies the detection and report, WC-02 the
registration, WC-08 the operator documentation.

### Rollout without regression

1. _Shadow_: WC-05 evaluates the registry beside the legacy allowlists; the
   legacy decision stays authoritative; any unexplained disagreement fails the
   differential test. The mandatory refusals of ADR-0037 that the allowlists lack
   (metadata drift touching a required guarantee, the validity window and the
   registry-integrity refusals) are listed as expected, justified differences.
2. _Cutover_: only when baseline records reproduce every current decision apart
   from those expected differences. From then the registry decides. A revocation
   or one of those mandatory refusals is the way to refuse something newly; a
   decision is the only way to admit.
3. _Claude_: the version floor is carried as `legacy_policy` and is not tightened
   by M24 up to WC-06. WC-07 supplies the evidence for a separate decision.
4. _Never_: automatic enablement of a detected version, a silent downgrade of a
   guarantee, a substitution of one worker for another, or a decision written by
   a probe run.

## Decisions

Owner decisions of 2026-10-16:

| Id  | Decision                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | M24 is an autonomous milestone, distinct from M12, M17, M18 and M21.                                                                                                                                                                         |
| D2  | Host-local, content-addressed registry with immutable records, verifiable provenance, owner-approved registration, revocation and atomic updates; evidence separated from the certification decision; a hash does not prove trustworthiness. |
| D3  | The Claude Code legacy policy is not modified now; WC-07 evaluates the unproven guarantees and proposes a transition; the legacy behavior is never represented as certified.                                                                 |
| D4  | Purely informational metadata drift stays advisory; drift relevant to a required guarantee invalidates admission for new runs with a typed refusal; time-based expiry may be opt-in and never prevails over security checks.                 |
| D5  | Live tests only with explicit authorization per execution, model, version and USD budget; no paid call in CI.                                                                                                                                |
| D6  | ADR-0037 (ADR-0036 belongs to M23 and is Accepted); no historical renumbering.                                                                                                                                                               |
| D7  | Port extensions in WC-05 are additive, versioned and compatible with M12.                                                                                                                                                                    |

Open, to be resolved with the acceptance of ADR-0037 (details and
recommendations in the ADR):

| Id  | Question                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | A required T1 guarantee whose metadata dependency cannot be observed: admit with disclosure, or refuse.                                                                |
| O2  | Confirm that `legacy_policy` is the single labelled exception to refusing uncertified subjects that require bounded guarantees, and only for implicit legacy dispatch. |
| O3  | Approve the evidence sufficiency table by risk tier.                                                                                                                   |
| O4  | Accept `local_operator` approvals until M10 provides signed approvals, recorded as such.                                                                               |
| O5  | Initial guarantee catalogue, frozen in WC-02.                                                                                                                          |
| O6  | Registry persistence: content-addressed files or a dedicated host-level SQLite store, given AGENTS.md; to be settled before acceptance.                                |

## Exit

A Codex and a Claude combination are admitted only through the registry, with a
basis that is visible as `certified`, `baseline_import` or `legacy_policy`; the
baseline records reproduce all current decisions; a newly registered decision for
an implemented profile admits a combination with no source change, and an
unregistered, mismatched, revoked, drifted or unverified one is refused before
dispatch with a reason naming the dimension; probes run offline and in CI; live
certification has run once under an explicit authorization and its evidence is
attached; release monitoring and the recertification procedure are in operation;
provenance shows the admitting decision; the parity assessment is published;
operator documentation matches tested behavior.
