# Legal Domain Pack (reference artifact)

`manifest.json` is a schema-1 reference pack (v0.2.0). Its original
`matter-workflow` declares intake, research, drafting, citation review and
human approval roles and stages, along with artifacts, evidence, a validator
reference, knowledge guidance, governance policy and an optional
read-operation need; it is unchanged since v0.1.0.

v0.2.0 adds three practice-area workflows alongside it, each under its own
`taskType`, reusing the same roles, artifacts, evidence, knowledge, capability
and validator entries, and each demonstrating a different governance stress
point from the M15 "Legal reference vertical" roadmap text:

- `civil-matter-workflow`: intake → research → draft → citation-review →
  **filing-approval** — a renamed, independently-approved final gate modelling
  the irreversible external action of filing with a court.
- `criminal-matter-workflow`: intake → **deadline-check** (new
  `deadline-clerk` role) → research → draft → citation-review →
  human-approval — an early, approved gate modelling statutory-deadline
  criticality, with the final approval requiring a different agent from both
  the draft and the deadline check.
- `labor-matter-workflow`: intake → **conciliation** (new `conciliator` role)
  → research → draft → citation-review → human-approval — an approved gate
  modelling a mandatory conciliation attempt before litigation.

These entries are data only: they do not register an adapter, grant access,
approve a matter, open the closed software `officeTaskKinds` list, or run a
Runtime pipeline. See `docs/development/generic-core-domain-packs.md` (the
practice-area-depth record) for the scope and non-goals of this addition, and
`docs/development/m16-5-domain-pack-runtime-activation-scope.md` for what
would still be needed before any of this executes.

The pack is exercised through a test-supplied local catalog. It is not
registered in the production catalog, no project adopts it, and it offers no
legal service or filing integration. See the
[Domain Pack contract](../domain-pack-contracts/README.md) and the
[M16 plan](../../docs/development/generic-core-domain-packs.md).
