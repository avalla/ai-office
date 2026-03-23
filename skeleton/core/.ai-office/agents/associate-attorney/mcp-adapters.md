---
trigger: when_referenced
---
# Associate Attorney MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Italian legal databases (Ius Online, CECA), statutory texts, Cassazione rulings, legal journals, GDPR resources |
| `sequential-thinking` | `sequential-thinking` | Multi-step legal argument construction, case theory development, strategy trade-off analysis |

## Adapter Usage Patterns

### fetch

When Used:
- Case law research: retrieve Cassazione, Corte d'Appello, and Tribunale decisions
- Statutory lookup: Codice Civile, Codice di Procedura Civile, Codice Penale sections
- GDPR and data protection regulation reference
- Ordine degli Avvocati ethics opinions
- Academic legal commentary and doctrine (dottrina)
- Opposing party public records or company registry lookups

### sequential-thinking

When Used:
- Building a structured legal argument across multiple code references and precedents
- Evaluating multiple legal theories for a case and selecting the strongest
- Analysing procedural options and their strategic implications
- Drafting a complex contract clause sequence with dependency logic
- Risk assessment: identifying strongest counter-arguments before drafting

## Adapters NOT Used

Associate Attorney does NOT use:
- `supabase` — Database operations are out of scope
- `snyk` — Security scanning is out of scope
- `playwright` — UI testing is out of scope
- `runcomfy` — Creative generation is out of scope
- `freecad` — 3D modeling is out of scope

## Adapter Constraints

- No authority to make final legal or strategic decisions (defers to Senior Partner)
- No authority to communicate legal strategy directly to clients without Partner clearance
- Research outputs go to Partner for strategy selection, not directly to client
