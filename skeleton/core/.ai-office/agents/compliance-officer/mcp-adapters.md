---
trigger: when_referenced
---
# Compliance Officer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Italian legal codes, GDPR text, Garante decisions, Ordine degli Avvocati ethics opinions, Cassazione compliance rulings |
| `sequential-thinking` | `sequential-thinking` | Multi-factor compliance analysis, conflicting code interpretation resolution, GDPR lawful basis assessment |

## Adapter Usage Patterns

### fetch

When Used:
- Retrieve current text of Codice Civile, Procedura Civile, and special statutes
- Look up Garante per la protezione dei dati personali decisions and guidelines
- Access Ordine degli Avvocati Codice Deontologico Forense
- Check Cassazione rulings on specific compliance questions
- Verify current limitation periods for specific causes of action
- Look up contributo unificato (court fee) schedules for filing cost verification

### sequential-thinking

When Used:
- Resolving conflicting code provisions affecting a document
- Step-by-step GDPR lawful basis analysis for documents containing personal data
- Multi-factor professional ethics analysis (conflict of interest with multiple parties)
- Calculating limitation period with suspension/interruption events

## Adapters NOT Used

Compliance Officer does NOT use:
- `supabase` — Database operations are out of scope
- `snyk` — Security scanning is out of scope
- `playwright` — UI testing is out of scope
- `runcomfy` — Creative generation is out of scope
- `freecad` — 3D modeling is out of scope

## Adapter Constraints

- No authority to make final strategic decisions (defers to Senior Partner)
- Research and analysis outputs feed compliance certificate only
- Does not communicate compliance findings directly to clients
