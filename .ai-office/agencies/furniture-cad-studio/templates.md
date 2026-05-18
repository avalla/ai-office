---
agency: furniture-cad-studio
---

# Furniture CAD Studio Templates

## Client Brief Template

```markdown
# Brief: [Furniture Piece Name]

## Client
[Client name / internal project]

## Piece Description
What is the piece? (chair, table, shelving unit, etc.)

## Intended Use
Where and how will it be used? (dining, office, outdoor, retail display)

## Dimensions (Approximate)
- Overall width: mm
- Overall depth: mm
- Overall height: mm
- Seat height (if applicable): mm

## Style Direction
- Style references: [links or descriptions]
- Aesthetic keywords: (minimal, brutalist, organic, industrial, etc.)

## Materials (Preferred or Constrained)
- Primary material: (oak, walnut, steel, plywood, etc.)
- Finish: (oil, lacquer, powder coat, raw, etc.)
- Constraints: (no formaldehyde, FSC certified, etc.)

## Joinery Preference
- Visible or concealed?
- Demountable or permanent?
- Structural notes:

## Quantity
- Prototype units: X
- Production run (if applicable): X

## Manufacturing Method
- CNC router
- Hand craft
- Laser cut
- Welded steel frame
- Other:

## Deadline
- Concept approval: YYYY-MM-DD
- CAD complete: YYYY-MM-DD
- Manufacturing handoff: YYYY-MM-DD

## Budget Envelope
[Optional: target unit cost or overall budget]

## Reference Images
[Links or file paths to reference images]
```

## Concept Document Template

```markdown
# Concept: [Furniture Piece Name]

## Brief Reference
`<slug>-brief.md`

## Selected Direction
Description of the chosen design direction.

## Proportioning Rationale
Why these dimensions? What ergonomic or spatial logic applies?

## Joinery Approach
- Primary joinery method:
- Secondary/accent joinery:
- Structural strategy summary:

## Material Palette
| Element | Material | Finish |
|---------|----------|--------|
| Primary structure | | |
| Secondary elements | | |
| Hardware | | |

## Sketch / Reference Images
[File paths or embedded images]

## Approval Status
- [ ] Designer approved
- [ ] CEO approved
- [ ] Client approved
```

## Structural Review ADR Template

```markdown
# ADR: Structural Design — [Furniture Piece Name]

## Status
Proposed | Accepted | Rejected

## Context
What structural challenges does this piece present?

## Decision
What structural approach is being adopted?

## Load Analysis
| Load Type | Expected Load | Safety Factor | Pass/Fail |
|-----------|--------------|---------------|-----------|
| Static (seated/surface load) | kg | 3× | |
| Dynamic (impact, vibration) | | | |
| Cantilever/overhang | | | |

## Joinery Details
| Joint | Location | Method | Notes |
|-------|----------|--------|-------|
| | | | |

## Options Considered

### Option 1: [Name]
- Pros:
- Cons:

### Option 2: [Name]
- Pros:
- Cons:

## Consequences
Structural commitments and constraints this decision imposes on the CAD model.

## References
- Industry standard: EN 1335 (office chairs), EN 527 (desks), etc.
```

## Materials Specification Template

```markdown
# Materials: [Furniture Piece Name]

## Brief Reference
`<slug>-brief.md`

## Primary Material
- Species/grade/alloy:
- Supplier:
- Certification: (FSC, PEFC, etc.)
- Unit cost estimate:

## Secondary Materials
| Element | Material | Supplier | Notes |
|---------|----------|----------|-------|
| | | | |

## Hardware
| Component | Spec | Supplier | Qty per unit |
|-----------|------|----------|-------------|
| | | | |

## Finish Schedule
| Surface | Finish | Process | Notes |
|---------|--------|---------|-------|
| | | | |

## Render References
[File paths to render outputs or material swatches]

## Approval Status
- [ ] Designer approved
- [ ] CEO approved
```

## Manufacturing Specification Template

```markdown
# Manufacturing Spec: [Furniture Piece Name]

## Model Reference
`cad/<slug>.FCStd`

## Export Files
| File | Format | Purpose |
|------|--------|---------|
| `<slug>.step` | STEP AP214 | CNC machining |
| `<slug>.stl` | STL | 3D printing/reference |
| `<slug>-parts/*.step` | STEP | Individual components |

## Cut List

| Part | Material | L (mm) | W (mm) | T (mm) | Qty | Notes |
|------|----------|--------|--------|--------|-----|-------|
| | | | | | | |

## Tolerances

| Feature | Tolerance | Notes |
|---------|-----------|-------|
| Overall dimensions | ±1.0 mm | |
| Joinery mortise/tenon | ±0.3 mm | |
| Hole positions | ±0.5 mm | |

## Assembly Sequence
1. Step 1
2. Step 2
3. ...

## Joinery Notes
[Detailed notes on each joint type, glue specification, fastener specification]

## Finish Application Notes
[Process sequence, drying times, coats]

## Quality Checks
- [ ] All dimensions match approved CAD model
- [ ] All joinery fits within tolerance
- [ ] Finish applied per schedule
- [ ] Hardware installed and functional

## Delivery Package Contents
- [ ] `.FCStd` source file
- [ ] STEP exports (assembly + individual parts)
- [ ] STL exports
- [ ] Cut list (this document)
- [ ] Materials spec
- [ ] Assembly diagram (PDF or image)
```

## CAD Modeling Session Log Template

```markdown
# CAD Session Log: [Furniture Piece Name]

## Date
YYYY-MM-DD

## FreeCAD Version
[version]

## Objects Created / Modified

| Object Name | Type | Dimensions | Notes |
|-------------|------|------------|-------|
| | | | |

## Boolean Operations

| Operation | Object 1 | Object 2 | Result | Notes |
|-----------|----------|----------|--------|-------|
| | | | | |

## Scripts Executed
List any `execute_python_script` calls with brief descriptions.

## Files Saved
| Filename | Path | Format |
|----------|------|--------|
| | | |

## Issues Encountered
[Any FreeCAD errors or workarounds]

## Next Steps
[What remains to be modeled]
```

---

Updated: 2026-03-19
