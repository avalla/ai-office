---
agency: penetration-test-agency
---

# Penetration Test Agency Pipeline

## Standard Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                   PENETRATION TEST AGENCY PIPELINE                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  00_router ──► 01_create_project ──► 10_ceo_prd (Scope/ROE)        │
│      │              │                      │                         │
│      │              ▼                      ▼                         │
│      │         PM sets scope         CEO approves engagement         │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              20_arch_adr                      │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              Threat model + attack surface    │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              05_planner                       │
│      │                              30_plan_tasks                     │
│      │                                      │                        │
│      │                                      ▼                        │
│      │                              45_security_pentest              │
│      │                                      │                        │
│      │                         Findings require fixes?               │
│      │                        ┌──────────────┴──────────────┐        │
│      │                        │                             │        │
│      │                        ▼                             ▼        │
│      │                 40_dev_implement                50_qa_validate │
│      │                 (remediation)                   (verify)       │
│      │                        │                             │        │
│      │                        └──────────────┬──────────────┘        │
│      │                                       ▼                       │
│      │                               60_review_merge                 │
│      │                                       │                       │
│      │                                       ▼                       │
│      │                               70_release (report delivery)    │
│      │                                       │                       │
│      │                                       ▼                       │
│      │                               90_postmortem_memory            │
│      │                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

## Rapid Assessment Pipeline

For short engagements with predefined scope:

```
Router → PM (Scope) → Security (Pentest) → QA (Retest) → Reviewer → Delivery
```

## Compliance-Oriented Pipeline

For PCI/ISO/SOC2 aligned assessments:

```
Scope + Controls Mapping → Technical Tests → Findings Matrix → Remediation Validation → Attestation Package
```

## Parallel Workstreams

| Phase | Parallel Workflows |
|-------|-------------------|
| Discovery | Architect (threat model) + Security (recon) |
| Remediation | Developer (fixes) + Security (retest prep) |
| Finalization | QA (evidence check) + Reviewer (risk signoff) |

## Checkpoints

| Checkpoint | Trigger | Required Artifacts |
|------------|---------|-------------------|
| Scope Locked | PM confirms ROE | Scope/ROE document |
| Threat Model Ready | Architect completes | ADR threat model |
| Findings Published | Security completes test round | Pentest report |
| Retest Cleared | Security + QA pass | Retest evidence |
| Delivery Approved | Reviewer + CEO pass | Executive + technical report |

---

Updated: 2026-03-09
