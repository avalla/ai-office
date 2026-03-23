# Agencies

Pre-configured agency templates for different project types.

## What is an Agency?

An **Agency** is a pre-configured team of agents with optimized workflows for a specific type of project. Each agency defines:

- **Agent Roster** - Which agents are active
- **Workflow Pipeline** - How agents interact
- **Quality Gates** - Required approvals
- **MCP Adapters** - Available tools
- **Project Templates** - Starting artifacts

Software and MCP proposal baseline for all agencies:

- `.ai-office/software-mcp-proposals.md` (Agency-Level Proposal Matrix)

## Available Agencies

| Agency | Focus | Best For |
|--------|-------|----------|
| **Software Studio** | Full-stack web/mobile apps | SaaS, web apps, APIs |
| **Creative Agency** | Media & content production | Marketing, videos, graphics |
| **Game Studio** | Game development | Games, interactive experiences |
| **Lean Startup** | Rapid MVP development | Startups, prototypes |
| **Penetration Test Agency** | Offensive security testing | Pentests, remediation validation, security audits |
| **Media Agency** | Video and movie production | Short films, movies, video campaigns |
| **Italian Legal Studio** | Italian law firm workflows | Italian legal practices, law firms |
| **Furniture CAD Studio** | Furniture design and CAD modeling | Furniture designers, makers, manufacturers |
| **Crypto Scalping Studio** | Scalping strategy development and signal services | Crypto traders, signal service providers |

## How to Use

### 1. Select Agency

Choose an agency that matches your project type:

```markdown
Project: E-commerce platform
→ Use: Software Studio
```

### 2. Reference Agency Config

The agency config is used by Router to set up the project:

```
Router reads agency config → Initializes project with agency settings
```

### 3. Customize (Optional)

Override agency defaults for project-specific needs:

- Add/remove agents
- Modify workflows
- Adjust quality gates

## Agency Structure

Each agency folder contains:

| File | Purpose |
|------|---------|
| `config.md` | Agency configuration (agents, workflows, gates) |
| `pipeline.md` | Agent interaction pipeline |
| `templates.md` | Project templates and starting artifacts |

## Creating Custom Agencies

To create a custom agency:

1. Copy an existing agency folder
2. Modify `config.md` for your needs
3. Update `pipeline.md` for your workflow
4. Add project templates in `templates.md`

## Agency Selection Guide

| Project Type | Recommended Agency |
|--------------|-------------------|
| Web application | Software Studio |
| Mobile app | Software Studio |
| Marketing campaign | Creative Agency |
| Video production | Creative Agency |
| Movie or short film production | Media Agency |
| Penetration testing engagement | Penetration Test Agency |
| Game | Game Studio |
| MVP / Prototype | Lean Startup |
| Italian law firm | Italian Legal Studio |
| Furniture design / CAD | Furniture CAD Studio |
| Crypto trading / signals | Crypto Scalping Studio |

---

Updated: 2026-03-20
