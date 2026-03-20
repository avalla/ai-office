---
trigger: when_referenced
---
# Paralegal MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Italian court formatting standards, procedural rules, filing requirements, document templates |

## Adapter Usage Patterns

### fetch

When Used:
- Look up court-specific formatting requirements (Tribunale, Corte d'Appello, Cassazione)
- Verify Italian legal document structure standards (Codice di Procedura Civile references)
- Research court filing submission procedures and deadlines
- Retrieve boilerplate language for standard document sections

## Adapters NOT Used

Paralegal does NOT use:
- `sequential-thinking` — Complex legal reasoning belongs to attorneys
- `supabase` — Database operations are out of scope
- `snyk` — Security scanning is out of scope
- `playwright` — UI testing is out of scope
- `runcomfy` — Creative generation is out of scope

## Adapter Constraints

- No authority to make legal decisions or interpretations
- No access to live court filing systems (prepares documents for attorney submission)
- Focused on document preparation and administrative coordination only
