---
trigger: when_referenced
---
# Scalper MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `sequential-thinking` | `sequential-thinking` | Scenario-based execution trade-off analysis |
| `fetch` | `fetch` | Research market structure patterns and execution references |
| `supabase` | `supabase` | Validate telemetry schema and KPI collection assumptions |

## Adapter Usage Patterns

### sequential-thinking

When Used:
- Compare execution strategies under different volatility regimes
- Evaluate fallback logic and circuit-breaker thresholds

### fetch

When Used:
- Gather reference patterns for execution safeguards
- Benchmark operational practices for high-volatility environments

### supabase

When Used:
- Define telemetry and monitoring data model assumptions
- Check metric dimensions needed for execution QA

## Adapters NOT Used

Scalper does NOT use:
- `snyk` - Security scanning belongs to Security Specialist
- `playwright` - E2E UI testing belongs to QA
- `runcomfy` - Creative asset generation is out of scope
- `revenuecat` - Billing execution belongs to product/revenue owners

## Adapter Constraints

- No direct live trading or fund execution authority
- No ownership of production code deployment
- Focused on strategy-to-implementation execution rules
