# Office manifest contract

Create a strict JSON document matching schema version `1`. The runtime rejects unknown fields, invalid references, duplicate identifiers, and multiple default pipelines for the same task kind.

## Shape

```json
{
  "schemaVersion": 1,
  "provenance": {
    "host": "codex",
    "skill": "ai-office",
    "skillVersion": "1"
  },
  "project": {
    "mission": "A concrete statement of why the project exists",
    "goals": ["Current measurable outcome"],
    "constraints": ["Constraint that must remain true"],
    "preferences": ["Working or technology preference"],
    "permissionPreferences": ["read_files", "modify_files", "run_tests"]
  },
  "office": {
    "name": "Project office",
    "roles": [
      {
        "id": "developer",
        "title": "Developer",
        "purpose": "Implement approved changes",
        "responsibilities": ["Change code", "Maintain focused tests"]
      }
    ]
  },
  "pipelines": [
    {
      "id": "delivery",
      "name": "Delivery",
      "description": "Default delivery workflow",
      "defaultFor": ["feature", "bugfix", "maintenance"],
      "enforcement": "guidance",
      "stages": [
        {
          "id": "implement",
          "name": "Implement",
          "roleId": "developer",
          "objective": "Produce the smallest verified change",
          "checks": ["Relevant tests pass"],
          "requiresApproval": false,
          "capabilities": ["filesystem.read", "filesystem.write"],
          "requiresDifferentAgentFrom": []
        }
      ]
    }
  ]
}
```

Identifiers use lowercase kebab-case and are stable across revisions. A pipeline stage's `roleId` must reference a role in the same manifest.

Pipelines default to `"enforcement": "guidance"` when the field is absent.
Set `"enforcement": "enforced"` only when every stage explicitly declares its
capability operation names. These names restrict the agent's ordinary grants;
they never create a grant. `requiresDifferentAgentFrom` may reference only
earlier stages and is enforced from stable runtime agent identities.
`requiresIndependentApproval` is optional and, when true, requires
`requiresApproval` and prevents the assigned stage agent from deciding the
gate.

Allowed task kinds are `feature`, `bugfix`, `maintenance`, `research`, and `release`. Each kind can occur in `defaultFor` at most once across all pipelines.

Allowed permission preferences are `read_files`, `modify_files`, `run_tests`, `run_shell`, `install_dependencies`, `create_branches`, `create_commits`, and `network_access`. They record user intent only. They never create capability grants or authorize an operation.

Set `provenance.host` to the current host adapter, such as `codex` or `claude`. Keep `skill` equal to `ai-office` and use `skillVersion` `1` for this contract.

Keep goals, responsibilities, stages, and checks concrete. Do not invent business requirements from repository metadata; ask the user when a decision would materially change the office.

For normal skill operation, serialize the complete proposal and pass that exact
JSON to `ai-office office:validate --manifest <json>`. After user confirmation,
pass the same validated serialization to `ai-office office:apply --project
<projectId> --manifest <json>`. A draft file is optional derived working state,
not project or runtime authority.
