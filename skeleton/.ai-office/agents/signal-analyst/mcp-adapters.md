---
trigger: when_referenced
---
# Signal Analyst MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `fetch` | `fetch` | Fetch exchange API docs, OHLCV data endpoints, funding rate feeds, market research, academic papers on indicator design |
| `sequential-thinking` | `sequential-thinking` | Multi-step signal hypothesis reasoning, regime analysis, walk-forward result interpretation, overfitting diagnosis |
| `supabase` | `supabase` | Query historical trade logs, validate signal metric schema, check PnL attribution data |

## Adapter Usage Patterns

### fetch

When Used:
- Research indicator behaviour on target asset (BTC, ETH, altcoins)
- Fetch exchange-specific documentation (funding rate reset schedule, tick size, min order size)
- Access academic or quantitative finance references for signal validation methodology
- Research market microstructure characteristics of target timeframe
- Fetch recent news or macro events to contextualise regime shifts

### sequential-thinking

When Used:
- Step-by-step signal hypothesis design (prevent rushing to indicator combination)
- Walk-forward result analysis: distinguish overfitting from genuine regime change
- Parameter sensitivity trade-off reasoning
- Multi-regime compatibility assessment
- Deciding between conflicting indicator signals

### supabase

When Used:
- Query historical backtest results and PnL logs for comparative analysis
- Validate that signal metric definitions match what is tracked in production
- Cross-reference live signal performance against backtest expectations

## Adapters NOT Used

Signal Analyst does NOT use:
- `freecad` — 3D modeling is out of scope
- `snyk` — Security scanning belongs to Security agent
- `playwright` — UI/E2E testing belongs to QA
- `runcomfy` — Creative asset generation is out of scope
- `stitch` — UI design is out of scope

## Adapter Constraints

- No direct exchange API calls for live data ingestion (use fetch for reference only)
- No authority to trigger live trades or order placement
- No ownership of production database schemas
