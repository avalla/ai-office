# Bundled agent profiles

Start with four delivery roles and add specialists when the work needs a distinct
responsibility. More roles are useful only when their handoffs reduce uncertainty
or provide a necessary independent assessment; they need not appear in every
pipeline.

## Core office

The four core profiles live in `agents/`. The fourteen specialist profiles live
in the separate [`agent-catalog/`](../agent-catalog/) directory. Each profile has
one canonical source directory; the default sync does not traverse the catalog.

| Agent ID | Runtime role key | Owns | Main handoff |
| --- | --- | --- | --- |
| `architect` | `software-architect` | Technical boundaries, alternatives, and implementation design | Design, invariants, plan, acceptance criteria |
| `developer` | `software-developer` | Scoped implementation and regression coverage | Patch, validation evidence, limitations |
| `reviewer` | `code-reviewer` | Independent correctness and architecture assessment | Prioritized findings and recommendation |
| `qa` | `quality-assurance` | Observable acceptance behavior and regression verification | Criterion-by-criterion results and reproducible defects |

Each directory contains a role-specific `system.md` with a method, expected
handoff, and responsibility boundaries. Product analysis refines the intended
outcome; architecture translates it into technical acceptance. Review evaluates
the change and its reasoning; QA independently exercises observable behavior.
Neither replaces the other.

## Optional specialists

| Agent ID | Runtime role key | Involve when | Main handoff |
| --- | --- | --- | --- |
| `product` | `product-analyst` | User needs, scope, priorities, or acceptance behavior are unclear | Problem, scenarios, scope, measurable acceptance |
| `designer` | `product-designer` | User journeys, interaction states, or accessibility need design | Flow, state specification, interaction and accessibility checks |
| `security` | `security-reviewer` | Authorization, secrets, untrusted input, or high-impact effects change | Threat assessment, evidenced findings, mitigations |
| `researcher` | `technical-researcher` | A bounded evidence or feasibility gap blocks a decision | Sourced comparison, experiments, recommendation and uncertainty |
| `release` | `release-engineer` | Packaging, rollout, runtime configuration, or recovery changes | Readiness evidence, rollout and recovery procedures |

## Exploratory specialists

These profiles bring a different investigative approach while retaining concrete
deliverables and the same authority boundaries as other agents.

| Agent ID | Runtime role key | Involve when | Main handoff |
| --- | --- | --- | --- |
| `hacker` | `adversarial-tester` | Assumptions about inputs, ordering, state, or trust need active challenge | Minimal reproductions, challenged assumptions, regression suggestions |
| `mad-scientist` | `experimental-scientist` | An unconventional idea needs a bounded feasibility experiment | Hypothesis, baseline, reproducible prototype evidence, adoption questions |
| `devil-advocate` | `design-challenger` | A consequential plan needs its strongest assumptions challenged | Fair counterargument, prioritized objections, falsification checks |
| `chaos-gremlin` | `resilience-tester` | Failures, retries, interrupted work, or restarts threaten invariants | Bounded fault matrix, recovery evidence, regression scenarios |
| `code-archaeologist` | `code-historian` | Obscure code or compatibility behavior needs its rationale recovered | Source-linked history, surviving constraints, change checklist |
| `radical-minimalist` | `simplification-analyst` | Configuration, dependencies, or abstractions may carry unnecessary complexity | Evidenced subtraction candidates, compatibility risks, verification plan |
| `alien-user` | `usability-outsider` | A journey assumes vocabulary or knowledge a first-time user lacks | Journey log, observed obstacles, focused usability corrections |
| `forensic-detective` | `incident-investigator` | An incident or unexplained state needs reconstruction from evidence | Timeline, competing hypotheses, causal evidence, corrective actions |
| `future-keeper` | `evolvability-reviewer` | A durable choice creates maintenance or compatibility obligations | Maintenance scenarios, exit risks, small safeguards, reassessment triggers |

The Hacker searches for counterexamples; the Security Reviewer assesses security
impact and mitigations. The Mad Scientist tests novel mechanisms; the Researcher
synthesizes available evidence and the Architect decides system fit. Involve them
for a specific question, with a resource budget and stopping condition. Their
names convey investigative style, not broader permissions or automatic dispatch.

Examples: ask the Hacker whether duplicate and reordered requests violate a task
invariant in a local fixture; ask the Mad Scientist whether a different data
representation can reduce a measured bottleneck under the same test workload.
No exploratory role is a required stage for routine delivery.

Use these responsibility boundaries when selecting among adjacent roles:

- **Devil's Advocate (Avvocato del diavolo)** challenges the argument for a plan;
  the Architect owns the design and the Reviewer assesses an implemented change.
- **Chaos Gremlin (Gremlin del caos)** injects controlled faults and observes
  recovery; the Hacker explores counterexamples more broadly and the Release
  Engineer owns operational readiness.
- **Code Archaeologist (Archeologo del codice)** reconstructs design history;
  the Researcher investigates options and the Forensic Detective reconstructs
  incident events.
- **Radical Minimalist (Minimalista radicale)** proposes evidenced subtraction;
  the Developer performs assigned changes and the Architect preserves system fit.
- **Alien User (Utente alieno)** simulates an unfamiliar user's journey; the
  Designer specifies improvements and QA verifies behavior. This simulation is
  not a substitute for research with actual users.
- **Forensic Detective (Detective forense)** explains an observed incident from
  evidence; the Chaos Gremlin creates controlled experiments and the Developer
  implements corrective changes.
- **Keeper of the Future (Custode del futuro)** identifies maintenance obligations
  and useful reassessment triggers; the Architect decides current structure and
  the Release Engineer addresses the immediate rollout.

## Choosing specialists

For example, unclear feature scope benefits from product analysis before design;
a new interaction may need a designer before implementation; a changed trust
boundary warrants security assessment; a risky rollout warrants release planning.
These are workflow design suggestions, not automatic dispatch rules. Current
pipelines are sequential; conditional specialist routing is not implemented.

Keep database, performance, frontend/backend, and documentation expertise within
the existing roles until recurring project needs justify a dedicated specialist.
Do not add a manager agent to duplicate Runtime orchestration or operator
decisions.

## What the files do today

- `agent.yaml` is validated and synchronized by the existing agent-definition
  loader. Synchronizing `agents/` registers and enables only the four core agents
  on a fresh project. Specialists require deliberately synchronizing
  `agent-catalog/` or a selected subset as described below.
- Every synchronized definition becomes an enabled operational agent. Once
  synchronized, a specialist can be directly scheduled on a task without an
  active pipeline even if it is absent from the office manifest. Synchronization
  does not start a run or grant controlled-action authority.
- Sync is an upsert, not replacement or revocation: synchronizing the core set
  again does not disable or remove previously synchronized specialists. This
  layout change also does not disable specialists registered using the earlier
  sync-all layout of this PR.
- `system.md` is authored behavioral guidance. The current loader reads only
  `agent.yaml`: it does not load, persist, version, or inject these Markdown
  profiles into an executor. A host can read them explicitly as role guidance;
  automatic worker context assembly remains future work.
- YAML capabilities, tool names, and model policies are descriptive metadata.
  They do not install tools, select an operational worker, grant access, or
  guarantee that an executor enforces the listed budgets. Actual resources,
  grants, admission policy, and controlled-action checks govern execution.
- YAML versions describe the loaded definitions. Editing a companion Markdown
  profile alone does not create a versioned Runtime instruction snapshot.
- Office manifest roles are a separate organizational configuration. The default
  manifest retains the four core roles and its existing routing. To route a
  pipeline stage to a specialist, propose its purpose, responsibilities, and a
  stage referencing that manifest role, validate the complete manifest, and apply it
  through the Runtime after confirmation. For enforced assignment, the manifest
  role ID and stage `roleId` must match the Runtime role key in the tables above,
  not the agent ID. The default manifest's short role IDs are guidance defaults;
  resolving their pre-existing mismatch with Runtime role keys is a separate
  follow-up before enforced real-worker pipelines. This PR does not redesign
  that contract. An office revision changes routing, not basic run eligibility.
- Role prose and recommendations never authorize a side effect or establish
  reviewer independence. Runtime identity, provenance, configured pipeline
  policy, and controlled-action approvals remain authoritative.

## Synchronizing the core set or selected specialists

From the distribution checkout, target the intended running Runtime and project:

```bash
# Normal/default bundled set: four core agents.
ai-office agent:sync --project <project-id> --directory agents

# Deliberately register and enable all fourteen specialists as well.
ai-office agent:sync --project <project-id> --directory agent-catalog
```

For a smaller selection, stage just the chosen YAML definitions in a temporary
directory with the same one-directory-per-agent layout, then sync that directory:

```bash
selection_dir=$(mktemp -d)
mkdir -p "$selection_dir/hacker" "$selection_dir/mad-scientist"
cp agent-catalog/hacker/agent.yaml "$selection_dir/hacker/agent.yaml"
cp agent-catalog/mad-scientist/agent.yaml "$selection_dir/mad-scientist/agent.yaml"
ai-office agent:sync --project <project-id> --directory "$selection_dir"
```

These are disposable selection inputs, not additional maintained definitions.
The Runtime records the YAML source path as provenance; it does not need the
temporary files to execute an already synchronized definition. Future syncs
should stage from the canonical catalog again. Review `agent:list --project
<project-id>` after sync to see the registered, enabled agents. Relative directory
arguments are resolved by the invoking client. For isolated source development,
use the documented development Runtime and `bun run cli --` entry point.

See [agent runtime](../docs/development/agent-runtime.md) for current execution
limits and [pipeline enforcement](../docs/development/pipeline-enforcement.md)
for persisted assignments and gates.
