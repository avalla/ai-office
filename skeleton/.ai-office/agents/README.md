# Agents

AI Office agent profiles, competencies, and capabilities.

## Structure

Each agent has its own folder containing:

| File | Purpose |
|------|---------|
| `personality.md` | Core personality traits and behavioral patterns |
| `competencies.md` | Skills, abilities, and areas of expertise |
| `triggers.md` | Conditions that activate this agent |
| `workflows.md` | Associated workflows this agent executes |
| `skills.md` | Internal skills (`.ai-office/skills/`) this agent uses |
| `mcp-adapters.md` | External MCP adapters this agent can leverage |

Software and MCP proposal baseline for all agents:

- `.ai-office/software-mcp-proposals.md` (Agent-Level Proposal Matrix)

## Agent Index

### Orchestration Layer

| Agent | Role | Folder |
|-------|------|--------|
| **Router** | Request routing, workflow orchestration | `router/` |

### Executive Layer

| Agent | Role | Folder |
|-------|------|--------|
| **CEO** | Strategic direction, final decisions | `ceo/` |
| **PM** | Requirements, roadmap, stakeholder communication | `pm/` |

### Design Layer

| Agent | Role | Folder |
|-------|------|--------|
| **UX Researcher** | User research, usability testing | `ux-researcher/` |
| **Designer** | UI design, design systems | `designer/` |

### Creative Layer

| Agent | Role | Folder |
|-------|------|--------|
| **Audio Creator** | Sound design, music, voice production | `audio-creator/` |
| **Video Creator** | Video production, motion graphics | `video-creator/` |
| **Image Creator** | Image generation, photography, graphics | `image-creator/` |
| **Game Developer** | Game development, interactive experiences | `game-developer/` |
| **Culture Hacker** | Cultural signal analysis and trend synthesis | `culture-hacker/` |
| **Provocation Director** | Bold concept direction and narrative disruption | `provocation-director/` |

### Technical Layer

| Agent | Role | Folder |
|-------|------|--------|
| **Architect** | System design, technology decisions | `architect/` |
| **Tokenomics Strategist** | Token economy design, incentive modeling | `tokenomics-strategist/` |
| **Developer** | Implementation, coding, debugging | `developer/` |
| **Scalper** | Execution strategy and risk-limit rule design | `scalper/` |
| **Signal Analyst** | Signal design, indicator selection, backtest review | `signal-analyst/` |
| **Security** | Security assessment, penetration testing | `security/` |

### Legal & Compliance Layer

| Agent | Role | Folder |
|-------|------|--------|
| **Senior Partner** | Final approval authority, case strategy, client escalation | `senior-partner/` |
| **Associate Attorney** | Legal research, document drafting, day-to-day client contact | `associate-attorney/` |
| **Compliance Officer** | Italian law verification, GDPR, professional ethics, deadline calculation | `compliance-officer/` |
| **Paralegal** | Document formatting, court filing preparation, deadline tracking | `paralegal/` |
| **Practice Manager** | Billing, calendar management, client administration, firm operations | `practice-manager/` |

### Quality Layer

| Agent | Role | Folder |
|-------|------|--------|
| **QA** | Quality assurance, testing strategy | `qa/` |
| **Reviewer** | Code review, standards enforcement | `reviewer/` |

### Operations Layer

| Agent | Role | Folder |
|-------|------|--------|
| **Planner** | Project planning, task breakdown | `planner/` |
| **Release Manager** | Release coordination, deployment | `release-manager/` |
| **Ops** | Postmortem, learning capture | `ops/` |

## Usage

Agents are activated by:
1. **Workflow trigger** - Workflow explicitly invokes an agent
2. **Slash command** - User invokes agent directly (e.g., `/router`)
3. **Context reference** - Cascade references agent profile for guidance

## Communication

Agents communicate through:
- **Primary:** Project artifacts (`.ai-agency/docs/`)
- **Secondary:** Memory system (decision logs, patterns)
- **Escalation:** Router → Planner → CEO

---

Updated: 2026-03-20
