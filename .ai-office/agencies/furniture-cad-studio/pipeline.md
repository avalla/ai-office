---
agency: furniture-cad-studio
---

# Furniture CAD Studio Pipeline

## Standard Pipeline

```
┌────────────────────────────────────────────────────────────┐
│          FURNITURE CAD STUDIO STANDARD PIPELINE             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  00_router ──► 10_brief_intake ──► 15_concept_design       │
│      │              │                      │               │
│      │              ▼                      ▼               │
│      │          PM captures            Designer creates     │
│      │          client brief           concept sketches     │
│      │                                      │               │
│      │                                      ▼               │
│      │                              20_structural_review    │
│      │                                      │               │
│      │                                      ▼               │
│      │                              Architect reviews       │
│      │                              joinery and loads       │
│      │                                      │               │
│      │                                      ▼               │
│      │                              05_planner              │
│      │                              30_plan_tasks           │
│      │                                      │               │
│      │              ┌───────────────────────┤               │
│      │              │                       │               │
│      │              ▼                       ▼               │
│      │         35_materials            40_cad_model         │
│      │              │                       │               │
│      │              ▼                       ▼               │
│      │         Material Specifier      CAD Modeler builds    │
│      │         curates palette         FreeCAD model        │
│      │              │                       │               │
│      │              └───────────────────────┤               │
│      │                                      │               │
│      │                                      ▼               │
│      │                              50_qa_validate          │
│      │                                      │               │
│      │                                      ▼               │
│      │                              QA validates            │
│      │                              dimensions, exports     │
│      │                                      │               │
│      │                                      ▼               │
│      │                              60_mfg_specs            │
│      │                                      │               │
│      │                                      ▼               │
│      │                              Reviewer writes         │
│      │                              cut lists, tolerances   │
│      │                                      │               │
│      │                                      ▼               │
│      │                              70_deliver              │
│      │                                      │               │
│      │                                      ▼               │
│      │                              Release Manager         │
│      │                              packages deliverables   │
│      │                                      │               │
│      │                                      ▼               │
│      │                              90_archive_memory       │
│      │                                      │               │
│      │                                      ▼               │
│      │                              Ops archives project     │
│      │                                      │               │
└────────────────────────────────────────────────────────────┘
```

## Concept Iteration Pipeline (Pre-CAD)

When the client brief needs concept exploration before committing to CAD:

```
Router → PM (Brief) → Designer (2–3 Concepts) → CEO (Select) → Architect (Feasibility)
    → [Standard Pipeline from structural review onwards]
```

## Revision Pipeline (Post-Delivery Feedback)

```
PM (Change Request) → Designer (Assess Impact) → Developer (Model Update)
    → QA (Re-validate) → Reviewer (Update Specs) → Release Manager (Re-deliver)
```

## Parallel Workflows

| Phase | Parallel Workflows |
|-------|-------------------|
| Modeling Phase | CAD Modeler (geometry) + Material Specifier (palette) |
| Delivery Prep | QA (final model check) + Reviewer (spec finalization) |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| Brief Approved | PM submits, CEO approves | `<slug>-brief.md` |
| Concept Signed Off | Designer completes, CEO approves | `<slug>-concept.md` with sketches/references |
| Structural Review Done | Architect completes | `<slug>-structural.md` ADR |
| CAD Model Ready | Developer completes | `.FCStd` file + STEP/STL exports |
| Materials Specified | Material Specifier completes | `<slug>-materials.md` |
| QA Cleared | QA completes validation | QA report + dimension check log |
| Manufacturing Specs Done | Reviewer completes | `<slug>-specs.md` |
| Delivery Package Ready | Release Manager assembles | All exports + docs |

---

Updated: 2026-03-19
