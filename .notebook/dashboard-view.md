# Dashboard View
> Project filters and milestone visualization

Entry: `apps/dashboard/src/ui/app.ts:renderRoute()`
Flow: project query → `ProjectDetail` → `projectViewModel()` → `renderProject()` → browser DOM.

Task filters: URL-backed search, operational status, persisted numeric priority, current agent, unassigned, and pagination. The `active` status view is the default and excludes failed, completed, and cancelled tasks; `all` and exact statuses reveal terminal work. Controls are restored during live refresh.

Navigation: project overview, tasks, milestones, requirements, and agents use separate hash routes under `#/projects/:id`. `renderProject()` keeps the shared project header/navigation while selecting one section body; task query state remains URL-backed.

Milestones: `ProjectDetail.milestones` provides persisted milestone summaries and requirement counts. The dashboard filters milestone rows client-side by their actual status and shows verified/total progress.

Limitation: `TaskOperationalState.milestone` is unavailable with reason `task_milestone_link_not_modelled`; do not present milestone-task associations as facts.

Updated: 2026-09-25
