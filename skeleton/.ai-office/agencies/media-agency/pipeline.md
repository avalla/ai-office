---
agency: media-agency
---

# Media Agency Pipeline

## Standard Video/Movie Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MEDIA AGENCY PIPELINE                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  00_router ──► 01_create_project ──► 10_ceo_prd (Treatment)        │
│      │              │                      │                         │
│      │              ▼                      ▼                         │
│      │         PM defines            CEO greenlights                │
│      │         scope/timeline         concept                        │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              05_planner                       │
│      │                              30_plan_tasks                     │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              25_design_ui                      │
│      │                              (storyboard/art direction)       │
│      │                                      │                        │
│      │              ┌───────────────────────┼───────────────────────┐│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │        27_video_create        26_audio_create        29_image_create│
│      │              │                       │                       ││
│      │              ▼                       ▼                       ▼│
│      │        Footage/Edit            Music/VO/Mix           Posters/Stills │
│      │              └───────────────────────┼───────────────────────┘│
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              50_qa_validate                   │
│      │                              (technical QC)                   │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              60_review_merge                  │
│      │                              (editorial signoff)              │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              70_release                       │
│      │                              (distribution)                   │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              90_postmortem_memory             │
│      │                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

## Feature Movie Pipeline

```
Development → Pre-production → Production → Post-production → Delivery
```

### Pre-production

```
Treatment → Script Lock → Storyboard → Shot List → Production Plan
```

### Post-production

```
Edit Assembly → Rough Cut → Fine Cut → Color/Audio Master → Final Export
```

## Fast-Track Pipeline (Single Video)

```
Router → PM (Brief) → Video Creator (Draft) → QA (QC) → Reviewer → Delivery
```

## Parallel Production

| Phase | Parallel Workflows |
|-------|-------------------|
| Production | Video + Audio + Image creation |
| Finalization | QA (technical) + Reviewer (editorial/brand) |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| Treatment Approved | CEO confirms | Treatment document |
| Storyboard Locked | Designer confirms | Storyboard + shot list |
| Rough Cut Ready | Video creator completes | Rough cut export |
| Final QC Pass | QA confirms | QC report |
| Release Ready | Reviewer + PM confirm | Distribution package |

---

Updated: 2026-03-09
