# Development Domain Pack (reference artifact)

`manifest.json` is the development Domain Pack,
`org.ai-office.development@0.2.0`, a schema-1 manifest under the
[Domain Pack contract](../domain-pack-contracts/README.md). It is a committed
reference artifact. GP-10A defined the four software development roles
(`architect`, `developer`, `reviewer`, `qa`), one agent per role, the five
task types and the role capabilities as ID-only labels. GP-10B-1 adds the
four development workflows, `delivery`, `bugfix`, `discovery` and `release`:
each has the title and description of the legacy pipeline of the same ID, one
task type and its ordered stages, each a stage ID and a role.

The package is data only. Nothing in the Runtime reads it, no catalog
registers it and no project is bound to it. Projects keep running on their
office manifest, its pipelines, their Runtime roles and their Runtime agents;
the legacy defaults in `agents/` and the default office manifest are
unchanged, and nothing was removed from the legacy path. The anti-goal of
GP-10B-1 stands: the pack must not become authoritative for Runtime execution
without a separately approved task.

Tests prove **expressible-subset parity**: for a project that holds the
legacy defaults and is bound to this pack through a catalog a test supplies,
the roles, agents, task types and workflows of the resolved configuration
equal those of the legacy development profile. For workflows that is the
pipeline ID, name and description, the ordered stages by ID and role, and one
route per workflow. It covers only what schema 1 can express, and it is not
execution parity; that is the Runtime task
`a45ddb12-3159-4b60-9b8b-c26516720834`.

`outside-pack-vocabulary.json` lists the legacy fields the pack does not
carry in full. Each entry states what the pack delivers of the field, what
remains as residue and the task that owns the residue next. The legacy route
`maintenance -> delivery` is residue, as are stage names, objectives and
checks, and every enforcement, approval and separation setting. Prompts were
not delivered: the pack has no prompt, no role guidance and no knowledge
entry.

See the GP-10A and GP-10B-1 sections of the
[M16 plan](../../docs/development/generic-core-domain-packs.md).
