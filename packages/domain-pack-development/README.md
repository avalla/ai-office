# Development Domain Pack (reference artifact)

`manifest.json` is the development Domain Pack,
`org.ai-office.development@0.3.0`, a schema-1 manifest under the
[Domain Pack contract](../domain-pack-contracts/README.md). It is a committed
reference artifact. GP-10A defined the four software development roles
(`architect`, `developer`, `reviewer`, `qa`), one agent per role, the five
task types and the role capabilities as ID-only labels. GP-10B-1 added the
four development workflows, `delivery`, `bugfix`, `discovery` and `release`.
GP-10B-2 (second pull request) adds the descriptive vocabulary and the
prompts that the contract extension made expressible:

- each role carries the `responsibilities` of the office role of the same ID;
- each workflow stage carries a `title` (the legacy stage name), an
  `objective` and `checks`;
- the `delivery` workflow routes `maintenance` as well as `feature`
  (`additionalTaskTypes`), so all five legacy routes are in the pack;
- four guidance prompts, `architect-guidance`, `developer-guidance`,
  `reviewer-guidance` and `qa-guidance`, whose `text` is the exact bytes of
  `agents/<id>/system.md`; each agent names the guidance prompt of its role;
- six reference prompts with the static text of the generated instruction
  contract (the per-pipeline lines are derived and are not prompts) and one
  reference prompt with the system message of `requirement:validate`.

`knowledge`, `policies`, `artifactTypes`, `evidenceTypes` and `validators`
stay empty.

The package is data only. Nothing in the Runtime reads it, no catalog
registers it and no project is bound to it. Projects keep running on their
office manifest, its pipelines, their Runtime roles and their Runtime agents;
the legacy defaults in `agents/` and the default office manifest are
unchanged, no instruction file is generated from a prompt of the pack, no
prompt is sent to a provider, and nothing was removed from the legacy path.
The anti-goal stands: the pack must not become authoritative for Runtime
execution without a separately approved task.

Tests prove **expressible-subset parity**: for a project that holds the
legacy defaults and is bound to this pack through a catalog a test supplies,
the roles, agents, task types and workflows of the resolved configuration
equal those of the legacy development profile. That is the pipeline ID, name
and description, the ordered stages by ID, role, title, objective and checks,
the role responsibilities and the full route set. On the shipped defaults the
guidance prompts equal `agents/<id>/system.md` and the guidance digest of the
legacy profile, the instruction-contract prompts equal the output of the
instruction builder for a manifest without constraints, and the assessment
prompt equals the system message that `requirement:validate` sends. It covers
only what schema 1 can express, and it is not execution parity; that is the
Runtime task `a45ddb12-3159-4b60-9b8b-c26516720834`.

`outside-pack-vocabulary.json` lists the legacy fields that are not carried in
full. Each entry states what the pack delivers of the field, what remains as
residue (`null` when the pack carries the whole field) and the task that owns
it. The seven fields that GP-10B-2 owned are delivered. Pipeline
`enforcement` and every stage approval, capability and separation setting
remain with the policy task GP-25, `tools` with GP-10C, and the Runtime role
name, version, model policy, limits, capability order and agent enablement
with the execution parity task.

See the GP-10A, GP-10B-1 and "GP-10B-2 PR 2 development pack 0.3.0" sections
of the [M16 plan](../../docs/development/generic-core-domain-packs.md).
