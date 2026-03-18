---
trigger: when_referenced
---
# Security Specialist Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `45_security_pentest` | `45_security_pentest.md` | Penetration testing workflow |

## Workflow Responsibilities

### 45_security_pentest

**Purpose:** Comprehensive security assessment

**Steps:**
1. Define security scope
2. Run automated scans (Snyk, etc.)
3. Manual penetration testing
4. Document findings
5. Classify by severity
6. Recommend remediations
7. Track resolution

**Outputs:**
- Pentest report
- Vulnerability list with severity
- Remediation recommendations
- Security clearance status

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `50_qa_validate` | Security clearance provided |
| `70_release` | Security approved for release |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Security-sensitive code ready |
| `20_arch_adr` | Architecture security review |
| `60_review_merge` | Security concerns in PR |

## Document Ownership

Security Specialist owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Pentest Report | `docs/qa/<slug>-pentest.md` | Security findings |
| Security Advisories | Within pentest report | Vulnerability details |

## Security Gates

Security Specialist holds veto authority for:

| Gate | Condition |
|------|-----------|
| Release | Critical unpatched vulnerabilities |
| Auth Feature | Authentication bypass risk |
| Data Feature | PII exposure risk |
| Integration | Third-party security risk |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Architect | Security architecture design |
| Developer | Security fix implementation |
| QA | Security test integration |
| Release Manager | Release security clearance |
