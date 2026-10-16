# ADR-0037: Worker compatibility and capability admission

- Status: Proposed (WC-01). It becomes Accepted only by an owner decision
  recorded in a later change; WC-02 onward do not start before then.
- Date: 2026-10-16
- Scope: M24 — Worker Compatibility & Capability Admission (WC-R01–WC-R14),
  specified by WC-01
- Owner decisions recorded: D1–D7 of the M24 plan were decided on 2026-10-16
  (D2 with conditions, D4 modified, D6 as ADR-0037); see the matrix at the end.
- Related: [ADR-0017](ADR-0017-bounded-external-worker.md),
  [ADR-0019](ADR-0019-agent-model-routing.md),
  [ADR-0003](ADR-0003-authenticate-controlled-action-approvals.md),
  [ADR-0029](ADR-0029-executor-confinement-and-filesystem-trust-boundary.md),
  [ADR-0036](ADR-0036-coordination-bridge-boundary-protocol-trust.md).
  Companion plan: [M24 plan](../development/worker-compatibility-admission.md).

## Context

ADR-0017 admits an external worker through restrictions the client itself
applies, and ADR-0019 pins the model of a run. Today the decision whether a
client version and a model may run is made by constants in adapter source:

- the Codex worker holds `auditedCodexVersions` (`0.160.0`) and
  `auditedBoundedCodexModels` (`gpt-5.5`) as two independent sets, so a model is
  not bound to the version under which it was audited;
- the Claude worker admits every version `>= 2.1.259`, with no ceiling, and
  every `anthropic:` model whose name matches a syntax pattern; its guarantees
  are the flags it passes, and no probe checks that a newer client still honors
  them;
- the model gate is repeated in `run.ts`;
- every refusal is `WORKER_UNAVAILABLE`, whatever the cause;
- dispatch provenance records the client version and the model selection, not
  what admitted the run.

The guarantees of a worker depend on four things that change independently: the
client version, the model metadata the provider supplies (the Codex client
fetches it at session start, and one recorded drift made `spawn_agent`
executable for `gpt-5.5` without any version change), the configuration the
adapter passes, and the output protocol it parses. Admitting a new combination
is a code change plus a manual re-verification.

## Decision

### 1. The unit of admission is an exact subject

An _admission subject_ is the exact tuple
`(worker, clientVersion, provider, model, configurationProfile,
outputProtocol, platform, mode)`:

- `worker` is a stable adapter identity (`codex-cli`, `claude-code`, …);
- `clientVersion` is the exact version string the client reports; there are no
  ranges, and a version that does not parse is not a subject;
- `provider` and `model` are the exact pair of the run's persisted selection;
- `configurationProfile` is an id plus the digest of the _effective_
  configuration the adapter constructs: argument vector template, feature and
  configuration overrides, environment construction, sandbox mode and the rules
  by which a login is admitted. The adapter computes the digest at admission
  time, so a change to a flag in source changes the subject instead of silently
  inheriting an audit. Per-run parameters not enumerated by the audit (for
  example reasoning efforts) are outside the certification; an audit lists the
  parameter values it covers;
- `outputProtocol` is a named, versioned parser contract;
- `platform` is the operating-system family the evidence was produced on;
- `mode` is `bounded_single_agent` or `governed_delegation` (decision 6).

Certification of one subject certifies no other. A new version, a new model, a
changed configuration, a new protocol version, another platform or another mode
is a different subject that needs its own evidence and its own decision. No rule
copies, ranges over or inherits from another subject; "supersedes" is an
explicit link that moves attention, never admission.

### 2. Guarantees, states and risk tiers

A _guarantee_ is a named, versioned property of an execution, from a catalogue
that is part of the contract and changes only through reviewed code. A record
can assert only catalogue ids; an unknown id makes the record invalid.

Each catalogue entry has a definition, a **risk tier** and zero or more
**metadata dependencies** (the provider-supplied model metadata projections the
guarantee relies on):

| Tier | Consequence of failure                                                        | Examples                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | Host or credential compromise, unobserved side effects, unobserved delegation | no host write, no shell or process execution, no native sub-agent execution, no managed-workspace login, credential not refreshed or changed, MCP/plugin surface closed |
| T2   | Loss of provenance or control of cost and output                              | one routed model recorded, closed tool surface, strict output protocol, bounded cancellation                                                                            |
| T3   | Reduced fidelity or avoidable cost                                            | stable usage reporting, bounded retry behavior                                                                                                                          |
| T4   | Informational                                                                 | documented limitations                                                                                                                                                  |

The initial catalogue is derived from what the bounded Codex worker documents
under "What the bounded Codex worker guarantees" and "What it does not
guarantee" in the agent runtime guide, plus filesystem read confidentiality (a
confinement level that M18 produces). WC-02 freezes it as data with the
contract version.

Every assessment has exactly one state:

| State         | Meaning                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enforced`    | The Runtime, or an OS or container boundary it builds, prevents the violation independently of the client. The Runtime's own code and M18 confinement levels are the only sources.                                             |
| `verified`    | Evidence of sufficient class for the tier shows the property for this exact subject. The client, the provider or the metadata could change it without the Runtime noticing, unless a drift observation covers it (decision 5). |
| `unverified`  | No sufficient evidence, evidence only declared, evidence stale or unknown. Every capability not mentioned by a record is `unverified`.                                                                                         |
| `unsupported` | Known not to hold, or not expressible for the subject.                                                                                                                                                                         |

Ordering for satisfaction: `enforced` satisfies a requirement for `verified`;
`verified` does not satisfy a requirement for `enforced`; `unverified` and
`unsupported` satisfy nothing. A state is never inferred from another guarantee.
A restriction a client or provider _declares_ (a flag, a help text, a model
card, documentation) is evidence of kind `declared` and never raises a state
above `unverified`.

### 3. Evidence, and the separation of evidence from decision

Technical evidence and the decision to certify are different records of
different authority.

**Evidence bundle** (technical, immutable, content-addressed). Produced by a
named probe suite or certification run. It records the subject it observed, the
suite id and version, the harness identity (source revision), the environment
(platform, client binary identity where obtainable), per-probe outcomes
(`pass`, `fail`, `inconclusive`, `skipped`) with bounded secret-free
observations, the metadata projections observed with their digests, the
producer kind and the time. A skipped or inconclusive probe supports nothing.
An evidence bundle states what was observed. It carries no approval and no
conclusion about trust.

Evidence kinds, weakest first:

1. `declared`: client or provider statements, flags, help, documentation. Weight
   zero.
2. `static`: inspection of configuration, of a feature listing or of source.
3. `behavioral_scripted`: the real client binary exercised against a scripted
   local provider endpoint with fixtures, including adversarial metadata
   variants, observing server-side what the client advertises, calls and
   refuses.
4. `behavioral_live`: the real client against the real provider under an
   explicit authorization (decision 8).
5. `runtime_enforced`: tests of Runtime or OS enforcement.
6. `historical_manual`: checks done by hand before this contract existed, used
   only by a baseline import (decision 9) and always labelled so.

**Sufficiency by tier** is a deterministic table owned by the contract, not a
judgment of the approver or of a model. The minimum for `verified`:

| Tier | Minimum evidence                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `behavioral_scripted` including at least one adversarial fixture for the guarantee, and, when the guarantee has a metadata dependency, either a drift observation covering that projection (decision 5) or `behavioral_live` confirmation of the projection |
| T2   | `behavioral_scripted`, or `static` evidence that fully determines the property                                                                                                                                                                              |
| T3   | `static` or stronger                                                                                                                                                                                                                                        |
| T4   | any kind except `declared`                                                                                                                                                                                                                                  |

An approver cannot lower the table for a decision; changing it is a change to the
contract.

**Certification decision** (authority, immutable, content-addressed). A
statement that a named approver accepts specific evidence for specific
guarantees of one subject. It contains the subject, the digests of the evidence
bundles relied on, the asserted state per guarantee with the sufficiency rule
that justifies it, metadata dependency declarations (projection id, audited
digest, whether drift is `observable`), the parameter and platform scope,
accepted limitations, validity (`notBefore` and an optional `expiresAt`), the
`supersedes` link, and the approval: approver identity, the authentication class
of the approval and a reference to the approval evidence.

**Revocation** (append-only, content-addressed). Names a decision digest, a
reason code (`evidence_invalidated`, `metadata_drift`, `defect_found`,
`superseded`, `operator_withdrawn`), the effective time and the approver. A
record is never deleted or edited; revocation takes effect for new admissions
immediately and never rewrites the provenance of past runs.

**A digest proves integrity, not trustworthiness.** Trust comes from three
independent checks, all deterministic: the decision's evidence satisfies the
tier table for every asserted state (recomputed at registration and at load, not
read from the record); the approval is of the authentication class the registry
accepts; and the evidence was produced by harness code and not by the worker
under test or a model's own statement. A record that fails any check is ignored
with a diagnostic and never admits.

The authentication class of an approval is what the Runtime can establish. Until
the cryptographic approval of ADR-0003 (M10) exists, approval is a
`local_operator` approval: a plan hash bound to the exact record, an explicit
local approval and an audit entry, with the limit ADR-0003 and ADR-0014 state: a
process running as the same user is not distinguished from the operator. The
class is recorded in every decision and every provenance record; admission can
require a stronger class once one exists. This ADR does not claim more.

### 4. The registry

A host-local registry, because the facts describe the clients installed on one
host and the Runtime has no host-level database; PostgreSQL authority is
unaffected.

- **Layout.** Objects (evidence bundles, decisions, revocations) are files named
  by digest under an owner-only directory in the Runtime home, created
  exclusively and never rewritten. A _manifest_ lists the active set.
- **Atomic update.** A change writes its objects first, then publishes a new
  manifest by writing a temporary file and renaming it over the previous one.
  The manifest carries a generation number and the digest of the previous
  manifest. A reader sees either the old complete set or the new complete set.
  Concurrent registrations are serialized, and a registration states the
  generation it was planned against; a mismatch is refused, never merged.
  The chain of manifests makes reordering and silent removal evident; it does
  not make them impossible for a process that can write the directory (see
  decision 7).
- **Loading.** At Runtime start, and on an explicit reload between schedules, the
  registry is read into an immutable snapshot after verifying every digest,
  every sufficiency check and every approval class. An unreadable manifest
  admits nothing (`registry_unreadable`); an invalid object is excluded and
  reported; a valid snapshot stays in force until a verified newer one replaces
  it.
- **Revocation** is a new record in a new generation. Removing trust is always
  allowed to the operator; adding trust always needs a decision.
- **Baseline.** The current Codex allowlist entry and the current Claude policy
  are carried as reviewed in-repository records of basis `baseline_import` and
  `legacy_policy` (decisions 9 and 10), so behavior is reproduced without a
  second code path. Only baseline records may ship in source; every other
  decision lives in the registry.

### 5. Admission and drift

Admission is one pure application function:

`admit(requirements, mode, observedSubject, observedMetadata, snapshot, policy) →
admitted(basis, decision, effective guarantees, advisories) | refused(reasons)`.

`requirements` are the guarantees a role, stage or pack requests, plus the named
set the mode implies (`bounded_profile`, decision 6). A request grants nothing.
Adapters report the observed subject and metadata and consume the result; they
no longer decide, and the decision is made once, before dispatch and before any
login is read.

Steps, in this order, each deterministic:

1. Platform support; an unsupported platform refuses.
2. Select decisions whose subject equals the observed subject in every field. If
   none: refuse `no_matching_audit` and report the _nearest_ decision by number
   of differing dimensions with the differing dimensions named
   (`version_mismatch`, `model_mismatch`, `configuration_mismatch`,
   `protocol_mismatch`, `platform_mismatch`, `mode_mismatch`) and expected and
   observed values.
3. Exclude revoked decisions (`audit_revoked`) and, where a decision opted in to
   expiry, expired ones (`evidence_expired`).
4. Drift. For each required guarantee, every metadata dependency is compared
   with the audited projection digest. A mismatch refuses
   (`metadata_drift_invalidates_guarantee`) for new runs of that subject. A
   difference in a projection no _required_ guarantee depends on is an advisory
   diagnostic and refuses nothing. A dependency declared `unobservable` cannot be
   compared: admission proceeds and discloses the unobservable dependency in
   the result and the provenance (open decision O1).
5. Each required guarantee must be satisfied by the asserted state
   (`guarantee_unverified`, `guarantee_unsupported`).

Expiry is opt-in per decision and is evaluated only as part of step 3. It can
only add a refusal; it never admits what steps 2 to 5 refuse, and it never
overrides a drift or revocation result. A time-based condition therefore cannot
prevail over a security check in either direction.

Reasons are a closed set: `no_matching_audit`, the six `*_mismatch` values,
`audit_revoked`, `evidence_expired`, `metadata_drift_invalidates_guarantee`,
`guarantee_unverified`, `guarantee_unsupported`, `mode_unsupported`,
`probe_failed`, `registry_unreadable`. A refusal carries its reasons, the nearest
decision and bounded, secret-free detail. The public error codes
(`WORKER_UNAVAILABLE`, `WORKER_MODEL_UNSUPPORTED`, …) stay at the boundary for
compatibility; the reasons are added diagnostics.

### 6. Bounded execution and governed delegation

`mode` is part of the subject, so the two are certified separately and one never
implies the other.

- `bounded_single_agent`: one process, one model, no child execution the Runtime
  cannot see. It implies the named guarantee set `bounded_profile@1` (the T1
  guarantees that ADR-0017 and the agent runtime guide describe: no host
  modification, no shell or process execution, no native sub-agent execution, no
  managed-workspace login, credential unchanged, MCP and plugin surface closed),
  plus `single_routed_model_recorded`.
- `governed_delegation`: child executions the Runtime creates, identifies,
  routes, budgets, fences and can cancel (M21). It has its own guarantee
  namespace (child identity and parentage, model routing per child, aggregated
  budget, bounded depth and fan-out, policy narrowing, cancellation and failure
  propagation). Until the governed child-execution contract exists the mode
  refuses with `mode_unsupported` for every worker.
- Native client delegation is not a mode. It is a capability recorded as
  `unsupported` for `bounded_single_agent` subjects (the client can start
  children outside the run's provenance) and is admitted only by Runtime
  admission under `governed_delegation`.

### 7. Authority and self-certification

- Registration and revocation are operator-only Runtime commands. They are not
  an agent tool, a controlled action, a connector, a routing or run option, or
  anything the read-only Coordination Bridge (ADR-0036) exposes.
- A registration follows plan, local approval bound to the plan hash, apply, and
  is audited. A probe run, a live certification and a baseline importer produce
  evidence and a _proposed_ decision; none can approve one. An agent may run the
  probe suite, as it may run any test; what it produces is a proposal that an
  operator must plan and approve.
- A worker or model cannot supply evidence about itself: evidence is produced by
  harness code the worker under test does not control.
- **Limit.** The Runtime is not a boundary against another process of the same
  user. That process can write the registry directory, or the Runtime home. The
  protection is that no _Runtime-mediated_ path lets an agent certify itself,
  and that the manifest chain, digests and re-verification make tampering
  evident to a later verifier. Tamper-resistance against a hostile same-user
  process, and signed approvals, are M10 scope and are not claimed.

### 8. Probes, live certification, monitoring and recertification

- **Compatibility probes** (WC-03) are deterministic, offline, credential-free,
  and run in the standard suite and in CI against a supplied binary, using a
  scripted local provider endpoint. They can collect evidence and propose a
  decision; they cannot approve.
- **Live certification** (WC-04) runs only with an explicit authorization per
  execution naming the worker, exact version, provider and model, the
  credential and a USD ceiling. It is never started by CI, by a milestone run or
  by a probe, and never registers anything. Absent that authorization nothing
  calls a paid provider.
- **Release monitoring** (WC-06) watches new releases of Codex CLI and Claude
  Code and the installed binaries, and reports them as unaudited subjects with a
  compatibility report. It enables nothing.
- **Recertification** is a procedure with these triggers: a new client version
  detected or installed; a changed configuration digest (an adapter change);
  an observed metadata drift; a new model entering routing; an output-protocol
  change; a revoked or invalidated decision; a suite correction that
  invalidates earlier evidence; and, if a decision opts in, expiry. Steps:
  detect; report the subject and its nearest decision; run the offline suite
  and collect evidence; where tier T1 requires it, request a per-run live
  authorization; assemble the proposed decision; owner review; approve or
  reject; publish a new manifest generation; verify admission in shadow before
  relying on it. The previous version's decision keeps admitting the previous
  version until it is revoked or superseded by the owner; the new version stays
  refused until its own decision exists.

### 9. Baseline import and no regression

The Codex combination now allowed (`codex-cli` `0.160.0`, `gpt-5.5`, the current
configuration) is imported as a `baseline_import` decision whose evidence is of
kind `historical_manual`, referencing the recorded oracle fixture and the
documented findings, with the limitations the agent runtime guide already states
(including that filesystem read confidentiality is unsupported). It reproduces
today's behavior; it is not presented as a fresh certification, and
`baseline_import` satisfies a required guarantee only if the import record lists
that guarantee.

WC-05 introduces the registry in _shadow mode_: the legacy allowlists keep
deciding, the registry result is computed beside them, and any disagreement is a
defect found by a differential test over a version × model × feature matrix.
Cutover happens only when no disagreement remains. Registry data can only make a
decision stricter than the allowlist after cutover through an operator's
revocation, never looser without a decision. This ADR and WC-01 change no
allowlist and no admission rule.

### 10. The legacy Claude policy is not a certificate

The version floor of the Claude worker is represented as a record of basis
`legacy_policy`: every guarantee `unverified`, with the flags the adapter passes
listed as `declared` evidence. It exists so that WC-05 reproduces today's
behavior, and it is shown as what it is in diagnostics, provenance and the parity
assessment. The Claude admission rules are not modified by M24 up to WC-06. WC-07
evaluates each unproven guarantee explicitly and proposes the transition to
uniform admission; any change of the Claude rules is a separate owner decision
after it.

`legacy_policy` is the single permitted exception to the refusal of
uncertified subjects that require bounded guarantees, and only because of the
owner's decision D3 (open decision O2 asks to confirm this reading). It
satisfies the implicit legacy dispatch only: it never satisfies a guarantee that
a role, stage or pack requests explicitly, and no role does so today.

### 11. Provenance

Each dispatch records, immutably and with SQLite and PostgreSQL parity (the
migration is WC-05, not this decision): the admission basis (`certified`,
`baseline_import`, `legacy_policy`), the decision digest and registry
generation, the digest of the observed subject, the effective guarantee set (id
and state), the approval authentication class, and the advisories and disclosed
unobservable dependencies. Earlier runs read as `not recorded`, never guessed.
Provenance never contains registry paths, credentials or raw probe output.

## Alternatives considered

- **Extend the allowlists.** Smallest diff; keeps evidence in comments and
  registration a release, keeps version and model unbound, and cannot express
  per-guarantee state or drift.
- **A database-backed registry.** Gives an audit trail and project-level
  authority but describes host facts with project storage, needs a host-level
  store the Runtime does not have, and pulls in the PostgreSQL authority work
  (M22). Revisit only if audits must be shared between hosts.
- **Trust the client's own capability listing.** Rejected by ADR-0017 for Claude
  and insufficient for Codex: tools derive from provider metadata the listing
  does not show.
- **One signed audit record combining evidence and approval.** Simpler, but an
  approval over a record that contains its own evidence invites treating a
  matching hash as trust. Separating them lets evidence be re-verified,
  re-used by a later decision and judged by a deterministic sufficiency rule.
- **Version ranges for newer clients.** Rejected: the recorded drift and the
  Claude floor show that a newer client or metadata can break a property with no
  signal.
- **Fold into M12 or M18.** M12 is a large unstarted scope and M18 confines the
  process; M18's confinement level is an `enforced` input to this contract, not
  a model of worker admission.

## Relationship to other work

- **M18 (SFC-02, SFC-07).** Requested / provider / effective maps to
  required guarantees / audit-established guarantees / effective admitted set.
  A confinement level is one `enforced` guarantee family that M18 produces;
  M24 never produces or raises one. The two admission functions share
  vocabulary and provenance conventions; SFC-02 and SFC-07 reconcile the names
  when they start. Confinement admission remains `WORKER_UNAVAILABLE` before
  dispatch.
- **M12 (M12-WORKER-PORT).** `WorkerRuntime.inspect()` returns only a version.
  WC-05 extends the port additively and with a version marker so that existing
  adapters and M12 remain compatible (D7).
- **M21 (MAEC-01, MAEC-07).** Supplies the governed child-execution contract
  that `governed_delegation` waits for; M24 does not deliver it.
- **M17.** An executor session never asserts a guarantee.
- **AWS-10-R2 / AWS-11-T5.** Consume admission as a read-only preflight and
  report `not_checked` when it was not evaluated.
- **M10.** Same-user tamper-resistance and signed approvals.

## Open decisions

| Id  | Question                                                                                                                                                                                          | Recommendation                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | A required T1 guarantee whose metadata dependency is `unobservable`: admit with disclosure, or refuse                                                                                             | Admit with disclosure for the imported baseline to avoid a regression; WC-03 determines whether the dependency can be observed, and refusal can then be made the rule for new decisions |
| O2  | Confirm that D3 plus the instruction to keep refusing uncertified subjects that require bounded guarantees mean: `legacy_policy` is the one labelled exception, for implicit legacy dispatch only | Confirm                                                                                                                                                                                 |
| O3  | Approve the evidence sufficiency table (T1 needs scripted adversarial evidence plus drift observation or live confirmation of metadata)                                                           | Approve as the baseline of WC-02                                                                                                                                                        |
| O4  | Accept `local_operator` approvals until M10, recorded as such                                                                                                                                     | Accept, with the class visible everywhere and a policy hook to require a stronger one later                                                                                             |
| O5  | Initial guarantee catalogue contents                                                                                                                                                              | Freeze in WC-02 from the documented guarantees, reviewed by the owner                                                                                                                   |

## Decision gates for WC-02 onward

WC-02 may start only after this ADR is accepted. It must confirm the catalogue,
record schemas and canonical digest, the manifest and generation protocol, the
operator command shape, and where the pure function, the registry port and the
snapshot live (types in `packages/domain`, port and admission in
`packages/application`, the file registry in an infrastructure package, with the
dependency direction unchanged).

## Owner decisions of 2026-10-16

| Id  | Decision                                                                                                                                                                                         | Where it lands             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| D1  | M24 is autonomous, distinct from M12, M17, M18, M21                                                                                                                                              | Plan                       |
| D2  | Host-local, content-addressed, immutable, owner-approved, revocable, atomic registry; evidence separated from decision; a hash does not prove trust                                              | Decisions 3, 4, 7          |
| D3  | Claude legacy policy unchanged; WC-07 evaluates unproven guarantees and proposes a transition; legacy is never shown as certified                                                                | Decision 10                |
| D4  | Informational drift is advisory; drift relevant to a required guarantee invalidates admission for new runs with a typed refusal; time-based expiry is opt-in and never overrides security checks | Decision 5                 |
| D5  | Live tests only with an explicit authorization per execution, model, version and USD budget; no paid call in CI                                                                                  | Decision 8                 |
| D6  | ADR-0037, because ADR-0036 belongs to M23 and is Accepted; no historical renumbering                                                                                                             | This file                  |
| D7  | Port extensions in WC-05 are additive, versioned and compatible with M12                                                                                                                         | Relationship to other work |

## Consequences and exclusions

This is a proposed boundary, not an implemented one. Operators gain a
registration and recertification step per new client version, and lose the
ability to run an unaudited newer client by accident. It does not make the
Runtime host a same-user boundary, replace controlled actions, grants or
approvals, deliver governed delegation, change model routing or enable any
worker, version or model. It adds no production code, performs no paid call and
modifies no worker, routing or local configuration.
