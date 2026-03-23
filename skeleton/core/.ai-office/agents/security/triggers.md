---
trigger: when_referenced
---
# Security Specialist Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/45_security_pentest` | Run penetration test |

### Workflow Events

| Event | Action |
|-------|--------|
| Pre-release security scan | Full security audit |
| New authentication feature | Security review |
| External API integration | Security assessment |
| Data handling changes | Privacy review |

## Secondary Triggers

### Context-Based

- Developer implements security-sensitive code
- Architect designs authentication system
- Release Manager prepares deployment
- User reports security concern

### Escalation-Based

- Snyk reports critical vulnerability
- Developer finds suspicious code
- External security report received
- Compliance audit required

## Activation Conditions

### Required For

- **Pre-release Security Scan** - All releases require security clearance
- **Authentication Features** - All auth-related code
- **Data Handling** - All PII/sensitive data handling
- **External Integrations** - All third-party API integrations

### Optional For

- Architecture design (consulted for security implications)
- PRD review (consulted for security requirements)
- Code review (spot-check for security)

## Trigger Examples

### Example 1: Pre-release

```
Release Manager: "Preparing release v1.2.0"
Security Specialist: Runs full security audit, provides clearance or blocks
```

### Example 2: Auth Feature

```
Developer: "Implementing OAuth login"
Security Specialist: Reviews implementation, tests for vulnerabilities
```

### Example 3: Critical Vuln

```
Snyk: "Critical vulnerability in dependency X"
Security Specialist: Assesses impact, coordinates fix, tracks resolution
```
