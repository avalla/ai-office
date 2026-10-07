# Manufacturing Domain Pack (reference artifact)

`manifest.json` is a schema-1 reference pack for a production-order workflow.
It declares planning, execution, inspection, deviation and supervisor approval
as definitions, with evidence and provenance schemas, governance policy,
knowledge guidance, an optional operation need and a validator reference.

The pack is exercised through a test-supplied local catalog. It is not
registered in the production catalog, and no project adopts it. A capability
or policy declaration grants no authority: the existing controlled-action
gateway still requires a separate grant and approval where applicable. The
pack does not run a Runtime pipeline, validate a real inspection or perform
MES, ERP, OPC-UA or PLC writes.

The `deviation` stage is a required review point in this declarative workflow;
the definition layer does not express a conditional branch. Supervisor approval
must be independent of execution, inspection and deviation review.

See the [Domain Pack contract](../domain-pack-contracts/README.md) and the
[M16 plan](../../docs/development/generic-core-domain-packs.md).
