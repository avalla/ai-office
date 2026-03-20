---
trigger: when_referenced
---
# Practice Manager MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fee schedule references, billing rate benchmarks, Italian legal billing standards, Ordine degli Avvocati administrative rules |
| `supabase` | `supabase` | Case billing records, time tracking data, invoice history, client contact information |

## Adapter Usage Patterns

### fetch

When Used:
- Research Italian legal billing standards and IVA rules for legal services
- Look up Ordine degli Avvocati administrative requirements
- Verify court fee schedules (contributo unificato) for filing cost estimates
- Reference practice management templates and procedures

### supabase

When Used:
- Query billable hours and generate invoice data
- Retrieve case status for client reporting
- Update client contact records and calendar entries
- Pull matter profitability data for Partner reporting

## Adapters NOT Used

Practice Manager does NOT use:
- `sequential-thinking` — Complex legal analysis belongs to attorneys
- `snyk` — Security scanning is out of scope
- `playwright` — UI testing is out of scope
- `runcomfy` — Creative generation is out of scope
- `freecad` — 3D modeling is out of scope

## Adapter Constraints

- No authority to approve billing rates (Partner decides)
- No authority to make legal or strategic decisions
- Focused on administrative operations, scheduling, and financial administration only
