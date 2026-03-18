---
trigger: when_referenced
---
# Planner Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `task-create` | `task-create.md` | Create task files |
| `task-management` | `task-management.md` | Manage task lifecycle |
| `project-analysis` | `project-analysis.md` | Analyze project context |
| `review-document-multisector` | `review-document-multisector.md` | Plan document review |

## Skill Usage Patterns

### task-create

**When Used:**
- Creating new task files
- Breaking down features into tasks
- Defining task details

**How Used:**
- Create task file with proper format
- Define acceptance criteria
- Set priority and dependencies

### task-management

**When Used:**
- Moving tasks between states
- Tracking task progress
- Managing task lifecycle

**How Used:**
- Move tasks between TODO/WIP/REVIEW/DONE
- Update task status
- Track completion

### project-analysis

**When Used:**
- Understanding project context
- Estimating based on existing work
- Identifying dependencies

**How Used:**
- Analyze project structure
- Identify existing patterns
- Map dependencies

## Skills NOT Used

Planner does NOT use:
- `run-tests` - Testing is QA responsibility
- `generate-tests` - Testing is QA responsibility
- `refactor-safe` - Implementation is Developer responsibility
- `security-check` - Security is Security Specialist responsibility
- `generate-migration` - Database work is Developer responsibility

## Skill Invocation

Planner invokes skills for planning and tracking:

```markdown
1. Analyze requirements
2. Invoke project-analysis (if existing project)
3. Invoke task-create (for each task)
4. Invoke task-management (to track progress)
5. Update task board
6. Report status
```
