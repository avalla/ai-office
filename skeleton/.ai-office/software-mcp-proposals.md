# Software and MCP Proposals Matrix

Standard proposal baseline for the AI Office at three levels:

1. Company (AI Office)
2. Agency (all implemented agencies)
3. Agent (all active agent roles)

Use this matrix as the reference when creating or updating agencies and agents.

## Company-Level Proposal (AI Office)

### Proposed Software Baseline

- Windsurf IDE + Cascade
- Git + GitHub
- Node.js/Bun runtime (project-dependent)
- Supabase (data/auth/analytics where applicable)
- GitHub Actions (CI checks)
- Markdown docs + project runbooks

### MCP Adapter Baseline

These are the only adapters referenced by at least one active agency. No other adapters are installed by default.

| Adapter | Used by agencies | Purpose |
|---------|-----------------|---------|
| `fetch` | All | External documentation and market research |
| `supabase` | software-studio, lean-startup | Database, auth, storage, and telemetry operations |
| `mcp-playwright` | software-studio, lean-startup, creative-agency, game-studio, media-agency | Browser automation and E2E validation |
| `snyk` | software-studio, lean-startup, penetration-test-agency | Security scanning (SAST/SCA/container/IaC) |
| `lighthouse` | software-studio, lean-startup, creative-agency, media-agency | Performance, accessibility, and SEO audits |
| `sequential-thinking` | game-studio, software-studio, lean-startup, penetration-test-agency | Structured analysis and decision support |
| `stitch` | creative-agency, media-agency | AI-powered UI and visual design generation |
| `runcomfy` | creative-agency, media-agency | AI image and video generation |
| `ios-simulator` | software-studio, creative-agency, game-studio, penetration-test-agency, media-agency | iOS app and game testing / mobile preview |
| `postgresql` | software-studio | Direct database access when Supabase abstraction is insufficient |
| `freecad` | furniture-cad-studio | 3D CAD modeling, parametric geometry, boolean operations, STEP/STL export |

## Agency-Level Proposal Matrix

| Agency | Proposed Software | Core MCP Adapters | Optional MCP Adapters |
|--------|-------------------|-------------------|-----------------------|
| Software Studio | TypeScript, React/Vite or Next.js, Node/Bun, Supabase, GitHub Actions | `supabase`, `mcp-playwright`, `snyk`, `lighthouse`, `fetch` | `sequential-thinking`, `postgresql` |
| Creative Agency | Design tooling, media editors, asset pipelines, content CMS | `stitch`, `runcomfy`, `fetch` | `mcp-playwright`, `lighthouse` |
| Game Studio | Game engine toolchain, asset pipeline, telemetry backend | `fetch`, `sequential-thinking` | `supabase`, `mcp-playwright` |
| Lean Startup | Lightweight web stack, analytics, rapid deployment tooling | `supabase`, `mcp-playwright`, `fetch` | `lighthouse`, `snyk`, `sequential-thinking` |
| Penetration Test Agency | Security scanners, threat modeling docs, reporting suite | `snyk`, `fetch` | `sequential-thinking`, `supabase` |
| Media Agency | Video/audio/image production tools, publishing pipeline | `runcomfy`, `stitch`, `fetch` | `mcp-playwright`, `lighthouse` |
| Italian Legal Studio | Markdown docs, case management, legal research | `fetch`, `sequential-thinking` | `supabase` |
| Furniture CAD Studio | FreeCAD (headless), Git, Markdown docs | `freecad`, `fetch`, `sequential-thinking` | `runcomfy`, `stitch` |
| Crypto Scalping Studio | Python/TypeScript, CCXT, Supabase, TradingView | `supabase`, `fetch`, `sequential-thinking` | `mcp-playwright`, `postgresql` |



## Agent-Level Proposal Matrix

| Agent | Proposed Software | Core MCP Adapters | Optional MCP Adapters |
|-------|-------------------|-------------------|-----------------------|
| Router | Workflow/status docs tooling | `sequential-thinking` | `fetch` |
| CEO | Strategy docs, KPI dashboards | `sequential-thinking`, `fetch` | `supabase` |
| PM | PRD/planning docs, roadmap tracking | `sequential-thinking`, `fetch` | `supabase`, `mcp-playwright` |
| UX Researcher | Research synthesis tooling | `fetch`, `mcp-playwright` | `sequential-thinking` |
| Designer | UI design systems and prototyping tools | `stitch`, `fetch` | `runcomfy`, `mcp-playwright` |
| Audio Creator | Audio editing/production tools | `runcomfy`, `fetch` | `stitch` |
| Video Creator | Video production and motion tooling | `runcomfy`, `fetch` | `stitch`, `mcp-playwright` |
| Image Creator | Image generation/editing toolchain | `runcomfy`, `fetch` | `stitch` |
| Game Developer | Game development toolchain | `sequential-thinking`, `fetch` | `supabase` |
| Culture Hacker | Trend/culture analysis tooling | `fetch`, `sequential-thinking` | `mcp-playwright` |
| Provocation Director | Creative concept and direction tooling | `sequential-thinking`, `stitch`, `runcomfy` | `fetch` |
| Architect | Architecture modeling/docs | `sequential-thinking`, `fetch` | `supabase` |
| Tokenomics Strategist | Economic modeling, KPI modeling, scenario analysis | `fetch`, `sequential-thinking`, `supabase` | `postgresql` |
| Developer | IDE/runtime/test stack, CI integration | `supabase`, `mcp-playwright`, `snyk`, `fetch` | `sequential-thinking`, `postgresql` |
| Scalper | Execution rule modeling, telemetry definition | `sequential-thinking`, `fetch`, `supabase` | `postgresql` |
| Signal Analyst | Indicator design, signal validation, backtest review, regime analysis | `fetch`, `sequential-thinking`, `supabase` | `postgresql` |
| Security | Security testing and vuln management tooling | `snyk`, `fetch` | `sequential-thinking`, `supabase` |
| QA | Test frameworks, validation harnesses | `mcp-playwright`, `lighthouse`, `fetch` | `supabase`, `sequential-thinking` |
| Reviewer | Code review and quality gate tooling | `fetch`, `sequential-thinking` | `snyk` |
| Planner | Planning and task orchestration docs | `sequential-thinking`, `fetch` | `supabase` |
| Release Manager | Release automation and rollout tracking | `fetch`, `supabase` | `mcp-playwright`, `lighthouse` |
| Ops | Postmortem analytics and reliability tracking | `supabase`, `fetch`, `sequential-thinking` | `postgresql` |

## Governance Notes

- If a new agency is added, append one row in the agency matrix.
- If a new agent is added, append one row in the agent matrix.
- Keep this matrix aligned with `.ai-office/office-config.md`, `.ai-office/agencies/`, and `.ai-office/agents/`.
- Agency-specific `config.md` files remain the source of truth for project-level adapter usage.

---

Updated: 2026-03-19
