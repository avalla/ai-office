---
agency: furniture-cad-studio
name: Furniture CAD Studio
description: Furniture design and CAD modeling studio
custom: true
---

# Furniture CAD Studio Configuration

## Overview

Full-service furniture design studio for conceiving, modeling, and specifying bespoke and production furniture. Covers the complete design-to-manufacturing workflow: brief intake, concept sketching, parametric CAD modeling in FreeCAD, material and finish specification, structural review, and manufacturing documentation delivery.

## Agent Roster

### Active Agents (10)

| Layer | Agents | Active |
|-------|--------|--------|
| Orchestration | Router | ✅ |
| Executive | CEO, PM | ✅ |
| Design | Designer | ✅ |
| Creative | Image Creator | ✅ |
| Technical | Architect, Developer | ✅ |
| Quality | QA, Reviewer | ✅ |
| Operations | Planner, Release Manager, Ops | ✅ |

### Agent Assignments

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **Design Director** | CEO | Creative vision, client approval, final sign-off |
| **Project Manager** | PM | Brief capture, scope, timeline, client liaison |
| **Furniture Designer** | Designer | Concept sketches, proportioning, aesthetic direction |
| **CAD Modeler** | Developer | FreeCAD parametric modeling, boolean ops, STEP/STL export |
| **Structural Reviewer** | Architect | Structural integrity review, joinery design, load analysis |
| **Material Specifier** | Image Creator | Material palettes, finish samples, render references |
| **Manufacturing Spec Writer** | Reviewer | Cut lists, tolerances, joinery details, supplier notes |
| **Quality Controller** | QA | Model validation, dimension checking, spec completeness |
| **Project Planner** | Planner | Milestone breakdown, dependency tracking |
| **Delivery Manager** | Release Manager | Package deliverables, version archive, handoff |

## Workflow Pipeline

```
Router → PM (Brief) → CEO (Approve) → Designer (Concept) → Architect (Structural Review)
    → Developer (CAD Model) → Image Creator (Materials + Renders) → QA (Validate)
    → Reviewer (Manufacturing Specs) → Release Manager (Deliver) → Ops (Archive)
```

## Quality Gates

| Gate | Required Approvals |
|------|-------------------|
| Brief Approval | CEO |
| Concept Sign-off | CEO, PM |
| Structural Review | Architect |
| CAD Model Approval | Designer, QA |
| Material Sign-off | Designer, CEO |
| Manufacturing Spec Review | Reviewer, QA |
| Final Delivery | CEO, Release Manager |

## Proposed Software Stack

| Software | Purpose |
|----------|---------|
| FreeCAD (headless via MCP) | Parametric 3D solid modeling and boolean operations |
| STEP / IGES / STL export | Interoperability with CNC, laser cut, and 3D print workflows |
| Markdown + runbook docs | Brief, concept, spec, and delivery documentation |
| Git | Version control for FreeCAD files and documentation |

## MCP Adapters

### Core (All Projects)

| Adapter | Usage |
|---------|-------|
| `freecad` | 3D modeling: create_box, create_cylinder, create_sphere, boolean_operation, save_document, list_objects, execute_python_script |
| `fetch` | Material research, supplier lookups, FreeCAD API documentation |
| `sequential-thinking` | Complex structural decisions, joinery trade-off analysis |

### Optional (Project-Specific)

| Adapter | When to Use |
|---------|-------------|
| `runcomfy` | AI-generated concept renders and material mood boards |
| `stitch` | Client presentation layouts |

## Project Templates

### Furniture Piece (Single Item)

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<slug>-brief.md
│   │   ├── concept/<slug>-concept.md
│   │   ├── adr/<slug>-structural.md
│   │   ├── materials/<slug>-materials.md
│   │   └── manufacturing/<slug>-specs.md
│   └── tasks/
├── cad/
│   ├── <slug>.FCStd
│   ├── export/
│   │   ├── <slug>.step
│   │   ├── <slug>.stl
│   │   └── <slug>-parts/
│   └── renders/
├── references/
│   └── images/
└── README.md
```

### Furniture Collection (Multi-item Suite)

```
your-project/
├── .ai-office/
│   ├── docs/
│   │   ├── brief/<collection>-brief.md
│   │   └── manufacturing/<collection>-specs.md
│   └── tasks/
├── cad/
│   ├── chair/
│   ├── table/
│   ├── sideboard/
│   └── shared-parts/
├── deliverables/
│   ├── step/
│   ├── stl/
│   └── pdf-drawings/
└── README.md
```

## Iteration Limits

| Loop | Max Iterations | Escalation |
|------|---------------|------------|
| CAD Model ↔ QA | 3 | Architect |
| Concept ↔ Client Feedback | 3 | CEO |
| Manufacturing Spec ↔ Review | 2 | PM |

## Quality Thresholds

| Metric | Target |
|--------|--------|
| Dimensional Accuracy | ±0.5 mm on primary dimensions |
| Model Completeness | All parts exported and named |
| Spec Coverage | 100% of joinery and material details documented |
| Structural Sign-off | Architect approval required |
| Client Approval | CEO sign-off required before delivery |

---

Updated: 2026-03-19
