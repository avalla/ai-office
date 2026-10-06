# Development Domain Pack (reference artifact)

`manifest.json` is the development Domain Pack,
`org.ai-office.development@0.1.0`, a schema-1 manifest under the
[Domain Pack contract](../domain-pack-contracts/README.md). GP-10A defines it
as a committed reference artifact: it describes the four software development
roles (`architect`, `developer`, `reviewer`, `qa`), one agent per role, the
five task types and the role capabilities as ID-only labels.

The package is data only. Nothing in the Runtime reads it, no catalog
registers it and no project is bound to it. Projects keep running on their
office manifest, their Runtime roles and their Runtime agents; the legacy
defaults in `agents/` and the default office manifest are unchanged.

Tests prove **expressible-subset parity**: for a project that holds the
legacy defaults and is bound to this pack through a catalog a test supplies,
the roles, agents and task types of the resolved configuration equal those of
the legacy development profile. That covers only what schema 1 can express.
`outside-pack-vocabulary.json` lists the legacy fields it cannot express, each
with the task that owns it next. It is not execution parity.

See the GP-10A section of the
[M16 plan](../../docs/development/generic-core-domain-packs.md).
