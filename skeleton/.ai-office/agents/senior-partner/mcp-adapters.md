---
trigger: when_referenced
---
# Senior Partner MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Italian legal databases, Cassazione rulings, statutory reference, legal journals, opposing party public records |
| `sequential-thinking` | `sequential-thinking` | Multi-factor legal risk analysis, settlement strategy evaluation, complex strategy decision-making |

## Adapter Usage Patterns

### fetch

When Used:
- Verify specific Cassazione precedent before approving a legal argument
- Look up current text of code provisions referenced in submitted documents
- Research judicial approach of a specific court or judge on a question
- Access Ordine degli Avvocati ethics opinions for professional conduct questions
- Review opposing party public records (company registry, real estate, etc.)

### sequential-thinking

When Used:
- Evaluating multiple strategy options against legal merit, risk, and client goals
- Settlement negotiation trade-off analysis
- Risk assessment for novel legal issues with no clear precedent
- Multi-party conflict of interest analysis

## Adapters NOT Used

Senior Partner does NOT use:
- `supabase` — Database operations are delegated to Practice Manager
- `snyk` — Security scanning is out of scope
- `playwright` — UI testing is out of scope
- `runcomfy` — Creative generation is out of scope
- `freecad` — 3D modeling is out of scope

## Adapter Constraints

- Adapter usage is selective — Partner reviews documents, not researches them from scratch
- Research is delegated to Associate Attorney; Partner uses fetch for targeted verification only
- No direct client data processing via adapters
